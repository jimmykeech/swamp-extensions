# @jamesakeech/pocket-id

A [swamp](https://github.com/swamp-club/swamp) extension for observing a
[**Pocket ID**](https://pocket-id.org) instance — the passkey-based OIDC
provider.

Pocket ID is usually the front door to everything else in a homelab, which makes
it the one service where "probably fine" is not good enough. This extension is
**read-only** and exists to answer the questions its own UI cannot, because each
one spans two screens:

- **Which accounts cannot sign in?** Pocket ID authenticates with passkeys only.
  An account with no registered passkey can get in solely via an admin-minted
  one-time link. Users are on one screen; passkeys are on another.
- **Which public clients have PKCE disabled?** For a client that holds no
  secret, PKCE is the only thing between an intercepted authorization code and a
  working token.
- **Which clients does nobody use?** An OIDC client with no authorizations in a
  month is a callback URL and a secret you are still carrying.
- **Which API key expires next** — and is it the one this sync authenticates
  with?
- **Who signed in, from where?** Joined per user and per client, from the audit
  log.

Everything is scored once, at collection time, into `instance.findings` —
ordered most severe first, with a stable `code` a workflow can assert on.

One model type: **`@jamesakeech/pocket-id`**. One instance is one Pocket ID
installation, because an API key authenticates against the whole instance and
every interesting fact is cross-cutting.

## Three methods, three costs

| Method         | Requests                         | Needs admin | Writes                                                               |
| -------------- | -------------------------------- | ----------- | -------------------------------------------------------------------- |
| `health`       | 4                                | no          | `health`                                                             |
| `syncActivity` | 4 + one per 100 audit events     | yes         | `health`, `activity`, `auditEvent`×N                                 |
| `sync`         | the above + 4 + **one per user** | yes         | all of the above plus `instance`, `user`, `client`, `group`, `apiKey` |

`health` is cheap enough to poll on a schedule. It is the only method that needs
no admin rights, and it **reports failure as data rather than throwing** — a
probe that failed whenever the thing it probes is down would only ever report
its own success. Its two checks are ordered so each failure is unambiguous:

1. `GET /healthz` — no credentials. Fails ⇒ the host, container or reverse proxy
   is down.
2. `GET /api/users/me` — needs a valid key of any privilege level. Fails ⇒ the
   key is wrong, revoked or expired. Succeeds ⇒ `apiKeyOwner` names the account
   and `apiKeyIsAdmin` is read from that account's own `isAdmin`.

Admin rights are **read, not inferred from a 403** — cheaper, and a 403 could
always have been something else. A valid key whose owner is not an admin is by
far the most common way a first run goes wrong, and `health` names the account
so it is obvious which key to swap.

Both checks passing means `sync` will work.

## Setup

### 1. Create an API key

In Pocket ID: **Settings → Admin → API Keys → Add API Key**. Give it a name and
an expiry, then copy the key — it is shown once.

**The key's owner must be an admin.** Users, OIDC clients, groups and the audit
log all reject a non-admin key with 403. `health` names the owning account and
reports `apiKeyIsAdmin`, so it will tell you if you got this wrong.

### 2. Store the secret

```sh
swamp vault create local_encryption pocket-id
swamp vault put pocket-id API_KEY
```

### 3. Create the model

```sh
swamp model create @jamesakeech/pocket-id id \
  --global-arg baseUrl=https://id.example.com \
  --global-arg 'apiKey=${{ vault.get(pocket-id, API_KEY) }}' \
  --global-arg instanceLabel=id
```

`baseUrl` is the same origin the OIDC issuer uses — not a sub-path, and not a
site sitting behind Pocket ID.

### 4. Probe it, then sync

```sh
swamp model @jamesakeech/pocket-id method run health id
swamp model @jamesakeech/pocket-id method run sync id
```

## Reading the output

```sh
# Everything worth looking at, most severe first
swamp model get id --json | jq '.resource.instance.instance.attributes.findings'

# Is it up, is it current, is the key still good
swamp data get id --name health --json | jq '{reachable, apiKeyOwner, apiKeyIsAdmin, currentVersion, updateAvailable, errors}'

# Accounts that cannot sign in unaided
swamp data query id 'specName == "user" && passkeysCollected && passkeyCount == 0'

# Clients nobody authorized in the window
swamp data query id 'specName == "client" && activityCollected && authorizationCount == 0'

# Every sign-in from outside the LAN
swamp data query id 'specName == "auditEvent" && !internalNetwork && event == "SIGN_IN"'

# Daily event counts, gap-free, ready to plot
swamp data get id --name activity --json | jq '.byDay'
```

`instance.criticalFindingCount` and `warnFindingCount` are broken out so a
workflow can assert `== 0` without walking the findings array.

## Findings

| Code                             | Severity              | Raised when                                                       |
| -------------------------------- | --------------------- | ----------------------------------------------------------------- |
| `no-admin`                       | critical              | No enabled user has admin rights — the instance is unmanageable    |
| `admin-without-passkey`          | critical              | An enabled admin has no registered passkey                        |
| `public-client-without-pkce`     | critical              | A public client has PKCE disabled                                 |
| `api-key-expiring`               | critical if it is the syncing key, else warn | Expires within `apiKeyExpiryWarningDays` |
| `user-without-passkey`           | warn                  | An enabled non-admin has no registered passkey                     |
| `update-available`               | warn                  | The deployed version is numerically behind the latest              |
| `long-lived-access-token`        | warn                  | Access token lifetime exceeds `accessTokenMaxMinutes` (never raised when the release does not report lifetimes — they read `-1`, not `0`) |
| `signin-from-multiple-countries` | warn                  | One user signed in from more than one external country in the window |
| `api-key-expired`                | warn                  | Already past its expiry                                            |
| `sole-admin`                     | info                  | Exactly one enabled admin — a bus-factor note                      |
| `unused-client`                  | info                  | No authorizations inside the window                                |
| `empty-group`                    | info                  | No members, so any client restricted to it is unreachable          |
| `api-key-never-used`             | info                  | Created but never used                                             |

**An unasked question never comes back as a clean answer.** Run with
`includePasskeys=false` and the passkey findings are not raised at all rather
than raised against a count of zero; the affected fields report `-1` and
`passkeysCollected: false`. The same holds for `includeAuditEvents=false` and
everything derived from the audit log.

The same rule covers reads that *fail*. `instance.passkeyCount` totals only the
users whose passkeys were actually read, and is `-1` when none could be —
`usersWithUnknownPasskeys` names them, and `passkeysCollected` goes false so the
totals cannot be mistaken for complete. A user who could not be read never lands
in `usersWithoutPasskeys`, so a transient 404 can never invent a finding.

## Passkeys on older releases

`/api/users/:id/webauthn-credentials` — the admin endpoint for another account's
passkeys — did not exist before roughly Pocket ID 2.4. Those releases expose
only `/api/webauthn/credentials`, which returns the **authenticating account's
own** passkeys and nothing else.

`sync` handles this without configuration. It settles the question once, against
the API key owner's own id: that account certainly exists, so a 404 for *it*
proves the route is absent rather than the user — no error-message parsing. On
such an instance you get the key owner's real passkeys, every other account
reported as unknown, and a warning saying so.

## The audit log window

Pocket ID has **no date filter on any endpoint**. A bounded read is therefore
expressed as "sort newest-first and stop at the first event outside the window",
which is what this extension does — so `windowDays=1` over a year of history
costs one request, not a hundred.

Two knobs bound the cost:

- `windowDays` (default 30) — how far back to walk.
- `maxAuditEvents` (default 2000) — a hard ceiling, so a busy instance cannot
  turn one sync into hundreds of requests. When it is hit, `activity.truncated`
  is `true` and **every count in the rollup is a floor rather than a total**. The
  method logs a warning when this happens.

`writeAuditEvents=false` keeps the aggregate rollup and skips the per-event
fan-out.

Audit events are immutable, and `auditEvent` resources have an infinite
lifetime, so **polling `syncActivity` accumulates history that outlives Pocket
ID's own retention**. `activity.totalEventsOnServer` reports the log's full size
regardless of window, which is how you notice retention growing unbounded.

## Two joins worth knowing about

The audit log records a **client name**, not a client id, so per-client activity
is joined on name. Renaming a client orphans its history — the client's
`authorizationCount` resets and it may briefly show up as `unused-client`.

Per-user activity is joined on **user id**, which is stable across renames.

`lastSignInAt` is bounded by the window, not by the account's whole history: an
account last used two months ago reports `""` under a 30-day window, not its
real last sign-in.

## Scheduling it

A typical split — probe often, inventory nightly:

```yaml
# every 15 minutes
- id: probe
  model: id
  method: health
  assert: data.latest("id", "health").attributes.reachable

# nightly
- id: inventory
  model: id
  method: sync
  arguments:
    windowDays: 30
- id: gate
  assert: data.latest("id", "instance").attributes.criticalFindingCount == 0
```

## Instance names

User, group and audit-event ids are UUIDs and are used as-is. **OIDC client ids
are chosen by an admin** and may contain characters that are not safe in a
storage path, so they are slugged — and because `My App` and `my.app` both slug
to `my-app`, a hash of the original id is appended whenever slugging alters it.
Two clients therefore stay two resources, and each keeps the same name across
runs.

## What it deliberately does not do

- **No writes.** No creating users, rotating client secrets, or revoking
  sessions. Pocket ID is the thing everything else trusts; a mistake here logs
  people out of their whole stack.
- **No custom claim values.** Only claim *keys* are collected. A claim can carry
  anything, including things that should not land in a datastore.
- **No other users' API keys.** Pocket ID exposes no endpoint listing them, even
  to an admin, so `apiKey` resources cover only the account this model
  authenticates as. `instance.apiKeyCount` says so too.
- **No drift resource.** Every method here is a snapshot; swamp's own data
  versions hold the history.

## Troubleshooting

**`403` / "the API key's owner is not an admin"** — the key is valid but belongs
to a non-admin. Run `health`: it reports `apiAuthenticated: true` with
`apiKeyIsAdmin: false` and names the account in `apiKeyOwner`, which is the same
finding without the guesswork.

**`401` on a key that used to work** — Pocket ID API keys expire, and an expired
key is rejected exactly like a wrong one. `sync` writes an `apiKey` resource
carrying `daysUntilExpiry` and flags `isSelf` on the key it is using, so the
next expiry is visible before it bites.

**`GET /healthz returned HTTP 404`** — `baseUrl` is probably pointing at
something in front of Pocket ID, or at a sub-path. Pocket ID answers `/healthz`
with `204`.

**`currentVersion` is empty** — `/api/version/current` did not exist before
roughly Pocket ID 2.4, and returns `404 API endpoint not found` on older
releases. That is treated as "version unknown", not as an authentication
failure: `versionsComparable` goes `false`, `updateAvailable` stays `false`, and
no `update-available` finding is raised. The instance is healthy; it just cannot
say what it is.

**`latestVersion` is empty** — `/api/version/latest` makes Pocket ID call out to
the upstream release feed. An air-gapped instance fails it and is perfectly
healthy, with the same "no claim either way" result as above.

**Error messages have no `code`** — the stable `code` field on error bodies
landed in Pocket ID 2.13. Earlier releases answer `{"error": "..."}` only, so
the diagnosis falls back to the HTTP status. The hints are the same either way.

**`sync` is slow** — it is the per-user passkey read, which is one request per
user and the only N+1 here. Set `includePasskeys=false` for a fast inventory,
accepting that the passkey findings go unraised.

**`429 Too Many Requests`** — Pocket ID limits the API to 100 requests a second
with a burst of 300, and the per-user passkey loop can approach that on a large
directory against a local instance. A 429 is retried up to three times on the
server's own `Retry-After`, so this should not surface; if it does, the limit is
being hit by something else too.

**`accessTokenDurationMinutes` is `-1`** — the release does not report token
lifetimes (roughly pre-2.4). That is "not reported", not "zero minutes", and no
lifetime finding is raised from it.

## Development

```sh
~/.swamp/deno/deno check pocket-id/pocket_id.ts
~/.swamp/deno/deno test --allow-net pocket-id/pocket_id_test.ts
```

The client and both sync methods are tested against a loopback HTTP server
rather than a stubbed `fetch`, so assertions cover what goes on the wire — the
`X-API-Key` header, the `pagination[…]`/`sort[…]` query shape, and how many
pages a bounded audit window actually costs.

## License

MIT — see [LICENSE.md](LICENSE.md).
