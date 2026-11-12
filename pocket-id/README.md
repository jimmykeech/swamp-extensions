# @jamesakeech/pocket-id

Read-only monitoring for a [Pocket ID](https://pocket-id.org) instance. Collect
health, users, OIDC clients, groups, API keys, and audit activity. The full sync
reports findings for missing passkeys, client configuration, and key expiry.

## Setup

Create an API key in **Settings → Admin → API Keys**. Its owner must be an admin
for inventory and activity syncs; `health` also accepts a non-admin key.

```sh
swamp extension pull @jamesakeech/pocket-id
swamp vault create local_encryption pocket-id
swamp vault put pocket-id API_KEY
swamp model create @jamesakeech/pocket-id id \
  --global-arg baseUrl=https://id.example.com \
  --global-arg 'apiKey=${{ vault.get("pocket-id", "API_KEY") }}' \
  --global-arg instanceLabel=id
swamp model method run id health
swamp model method run id sync
```

Use the Pocket ID root URL for `baseUrl`, without a subpath. Optional global
arguments are `instanceLabel` (default `pocket-id`) and `requestTimeoutSec`
(default `30`, per HTTP request).

## Methods

| Method         | Output                                                                              | Access        |
| -------------- | ----------------------------------------------------------------------------------- | ------------- |
| `health`       | Reachability, key owner and admin status, version checks                            | Any valid key |
| `syncActivity` | Health, an `activity` rollup, and individual `auditEvent` records                   | Admin         |
| `sync`         | All activity data, plus `instance`, `user`, `client`, `group`, and `apiKey` records | Admin         |

`health` reports probe failures as data. Check `reachable`, `apiAuthenticated`,
`apiKeyIsAdmin`, and `errors` before a sync. Full sync adds paginated inventory
requests and a passkey request per user. Use `syncActivity` between full syncs
when only sign-in activity is needed.

## Sync arguments

Both sync methods accept:

| Argument           | Default | Purpose                                        |
| ------------------ | ------- | ---------------------------------------------- |
| `windowDays`       | `30`    | Audit history window, read newest first.       |
| `maxAuditEvents`   | `2000`  | Maximum events to read.                        |
| `writeAuditEvents` | `true`  | Store individual events as well as the rollup. |

`sync` also accepts:

| Argument                  | Default | Purpose                                                |
| ------------------------- | ------- | ------------------------------------------------------ |
| `includeAuditEvents`      | `true`  | Collect activity and derive usage findings.            |
| `includePasskeys`         | `true`  | Collect per-user passkeys and derive passkey findings. |
| `apiKeyExpiryWarningDays` | `14`    | Key expiry warning threshold.                          |
| `accessTokenMaxMinutes`   | `60`    | Access-token lifetime warning threshold.               |

```sh
swamp model method run id syncActivity --input windowDays=7
swamp model method run id sync --input includePasskeys=false
```

## Findings and data

Read findings and health in CEL:

```text
data.latest("id", "instance").attributes.findings
data.latest("id", "instance").attributes.criticalFindingCount
data.latest("id", "health").attributes.apiKeyIsAdmin
data.latest("id", "activity").attributes.byDay
```

Findings have stable codes and are ordered by severity:

| Severity                                        | Codes                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Critical                                        | `no-admin`, `admin-without-passkey`, `public-client-without-pkce`                                                          |
| Critical for the syncing key; otherwise warning | `api-key-expiring`                                                                                                         |
| Warning                                         | `user-without-passkey`, `update-available`, `long-lived-access-token`, `signin-from-multiple-countries`, `api-key-expired` |
| Information                                     | `sole-admin`, `unused-client`, `empty-group`, `api-key-never-used`                                                         |

`criticalFindingCount` and `warnFindingCount` support workflow checks. Disabled
or failed collection does not mean a clean result: check `passkeysCollected`,
`activityCollected`, and `usersWithUnknownPasskeys`. Unknown numeric values use
`-1`; missing strings use `""`.

## Limitations

- When `activity.truncated` is true, the event cap was reached. Rollup counts
  are lower bounds; increase `maxAuditEvents` for a larger result.
- Stored audit events persist across syncs and can outlive server retention.
  Activity summaries and `lastSignInAt` cover only the requested window.
- Client activity joins on client name. Renaming a client can disconnect its
  earlier activity. User activity joins on user ID.
- Older servers without the admin passkey endpoint expose only the API key
  owner's passkeys. Other users remain unknown, rather than passkey-free.
- Missing version or token-lifetime data suppresses the corresponding findings.
  An empty version does not establish that the server is current.
- API key records cover only the authenticating account. Custom claim values are
  omitted; only their keys are collected.
- Inventory pagination can also be incomplete. Check run warnings before
  treating absent findings as proof that no issue exists.

## Troubleshooting

- **401:** refresh a wrong, expired, or revoked API key.
- **403:** run `health` and check `apiKeyOwner` and `apiKeyIsAdmin`.
- **404 on `/healthz`:** check that `baseUrl` points to Pocket ID's root URL.
- **Slow sync:** disable passkey collection to remove per-user requests.
- **429:** the client retries up to three times using `Retry-After`; persistent
  failures require reducing request load.

## Development

Run from the repository root:

```sh
~/.swamp/deno/deno check pocket-id/pocket_id.ts
~/.swamp/deno/deno test --allow-net pocket-id/pocket_id_test.ts
```

## License

MIT — see [LICENSE.md](LICENSE.md).
