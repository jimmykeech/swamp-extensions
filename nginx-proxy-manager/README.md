# @jamesakeech/nginx-proxy-manager

Manage an [Nginx Proxy Manager](https://nginxproxymanager.com) instance from
swamp: read the whole configuration into addressable resources, and create,
update, enable, disable and delete every object type it exposes.

One model instance represents one NPM installation. That grouping is forced by
the API rather than chosen — authentication is instance-wide, and NPM's objects
reference each other by numeric id (a proxy host names its certificate and
access list by id), so a model that owned a single host could not resolve its
own dependencies.

## Install

```bash
swamp extension pull @jamesakeech/nginx-proxy-manager
swamp model create @jamesakeech/nginx-proxy-manager npm-edge
```

## Configure

`baseUrl` is the **admin interface**, port 81 by default — not one of the sites
NPM proxies. Keep the password in a vault; it is never written to a resource,
but an inline password lands in the model definition and therefore in git.

```yaml
globalArguments:
  baseUrl: http://192.0.2.5:81
  identity: admin@example.com
  secret: ${vault.homelab.npm-admin-password}
  instanceLabel: edge
  requestTimeoutSec: 30
```

`requestTimeoutSec` covers a single HTTP call. Raise it well past the default
before a DNS-01 certificate request — issuance blocks while certbot waits for
the challenge record to propagate.

## Read the instance

```bash
swamp model @jamesakeech/nginx-proxy-manager method run sync npm-edge
```

`sync` writes one resource per object rather than one list, so a single host is
addressable from CEL without post-processing:

| Spec              | Instance name           | Holds                                   |
| ----------------- | ----------------------- | --------------------------------------- |
| `instance`        | `instance`              | Version, counts, and the health rollup  |
| `proxyHost`       | `proxy-host-<id>`       | Domains, upstream, TLS, locations       |
| `redirectionHost` | `redirection-host-<id>` | Domains, target, HTTP status            |
| `deadHost`        | `dead-host-<id>`        | Domains parked on a 404                 |
| `stream`          | `stream-<id>`           | Listening port and forward target       |
| `accessList`      | `access-list-<id>`      | Address rules and basic-auth usernames  |
| `certificate`     | `certificate-<id>`      | Provider, domains, `daysUntilExpiry`    |
| `change`          | `change-<method>`       | Outcome of the last run of that method  |

The `instance` resource carries what only a whole-instance read can tell you:

- `certificatesExpired` and `certificatesExpiringWithin30d` — the two are
  counted separately, so an already-dead certificate never hides inside
  "expiring soon".
- `hostsWithoutCertificate` — enabled proxy hosts still serving plain HTTP.
- `domainsServedByMultipleHosts` — a domain configured on two hosts is served
  by whichever config nginx loads first. `sync` logs a warning for these.

```bash
swamp data get npm-edge instance --json

# Certificates about to lapse
swamp data query 'modelName == "npm-edge" && specName == "certificate" &&
  content.daysUntilExpiry < 14' --select content.niceName

# Hosts that are turned off
swamp data query 'modelName == "npm-edge" && specName == "proxyHost" &&
  content.enabled == false' --select content.domainNames
```

## Change the instance

Every `apply*` method is idempotent. Without an explicit `id` it matches an
existing object by its natural key and updates it in place, falling back to
creation — so re-running a workflow converges rather than piling up duplicates.

| Method                 | Matches on                | Creates when no match     |
| ---------------------- | ------------------------- | ------------------------- |
| `applyProxyHost`       | exact set of domain names | a new proxy host          |
| `applyRedirectionHost` | exact set of domain names | a new redirection host    |
| `applyDeadHost`        | exact set of domain names | a new dead host           |
| `applyStream`          | incoming port             | a new stream              |
| `applyAccessList`      | list name                 | a new access list         |

```bash
swamp model @jamesakeech/nginx-proxy-manager method run applyProxyHost npm-edge \
  --arg domainNames='["media.example.com"]' \
  --arg forwardHost=192.0.2.20 \
  --arg forwardPort=8096 \
  --arg certificateId=4 \
  --arg sslForced=true
```

Each `apply*` re-reads the object afterwards and writes it as a resource, so
the id of something just created is available without a second `sync`:

```
data.latest("npm-edge", "change-applyProxyHost").attributes.id
```

**Changing the domain set** of an existing host means the match key no longer
matches, and a second host would be created. Pass `id` to update in place
instead. The same applies to renaming an access list.

**Access list users are replaced, not merged.** NPM hashes passwords and never
returns them, so the `accessList` resource carries usernames only, and every
`applyAccessList` must resend the complete user set — anyone omitted is dropped.

### Enable, disable, delete

Both dispatch on a `kind` and take a list of ids, so a batch is one fan-out
call. Running one method per id would contend on the model lock for no gain.

```bash
swamp model @jamesakeech/nginx-proxy-manager method run setEnabled npm-edge \
  --arg kind=proxyHost --arg ids='[3,4]' --arg enabled=false

swamp model @jamesakeech/nginx-proxy-manager method run delete npm-edge \
  --arg kind=stream --arg ids='[7]'
```

`setEnabled` covers `proxyHost`, `redirectionHost`, `deadHost` and `stream` —
access lists and certificates have no enabled flag. `delete` covers all six.

> Verify ids against a fresh `sync` before deleting. **NPM reuses ids after
> deletion**, so an id read from a stale resource can remove a different
> object than the one you meant.

A successful delete also removes the object's swamp resource, so inventory does
not keep ghosts. A fan-out where some ids succeed and others fail reports
`action: "partial"` on the change record — never the successful action, so a
guard written as `action == "deleted"` cannot fire on a half-done batch.

### Certificates

```bash
# HTTP-01 — needs port 80 reachable from the public internet
swamp model @jamesakeech/nginx-proxy-manager method run requestCertificate npm-edge \
  --arg domainNames='["jellyfin.example.com"]' \
  --arg letsencryptEmail=me@example.com

# DNS-01 — the only route to a wildcard, and to hosts with no inbound port 80
swamp model @jamesakeech/nginx-proxy-manager method run requestCertificate npm-edge \
  --arg domainNames='["*.example.com"]' \
  --arg letsencryptEmail=me@example.com \
  --arg dnsChallenge=true \
  --arg dnsProvider=cloudflare \
  --arg dnsProviderCredentials="$(cat ~/.secrets/cloudflare.ini)"
```

`requestCertificate` reuses an existing Let's Encrypt certificate covering
exactly the same domains rather than reissuing, so a scheduled workflow does
not burn ACME rate limit. Pass `force: true` to override.

`renewCertificate` takes a list of ids. `uploadCertificate` installs an
externally issued certificate from PEM files on the machine running swamp — if
the upload is rejected, the half-created record is removed rather than left
behind to collide with a retry.

## Pre-flight check

`instance-reachable` runs before every mutating method: it logs in and reports
an unreachable host separately from rejected credentials, so a failure names
the actual problem. It is labelled `live` — skip it offline with
`--skip-check-label live`.

## Notes and limits

- **Enabled state is a second call.** NPM ignores `enabled` on the object body
  and only honours its `/enable` and `/disable` endpoints, so `apply*` sets it
  afterwards, and only when the current state differs.
- **TLS to the admin API.** Deno's `fetch` will not accept a self-signed
  certificate. Point `baseUrl` at plain HTTP on the internal network (the usual
  NPM deployment), or give the admin interface a certificate that chains to a
  trusted root.
- **Older NPM builds.** A collection the instance does not expose is reported
  as empty with a warning rather than failing the sync, and `certificate_id` is
  omitted from stream writes when unset, since stream TLS only arrived in 2.10.
- **Not covered:** users, permissions, settings, audit log, and the default
  site configuration.

## Development

```bash
~/.swamp/deno/deno check nginx_proxy_manager.ts
~/.swamp/deno/deno test --allow-net --allow-read .
```

## License

MIT — see [LICENSE.md](LICENSE.md).
