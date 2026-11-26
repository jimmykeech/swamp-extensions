# @jamesakeech/nginx-proxy-manager

Manage an [Nginx Proxy Manager](https://nginxproxymanager.com) instance from
[swamp](https://github.com/swamp-club/swamp). Read inventory, manage hosts and
access lists, and issue or upload TLS certificates. Use one model per NPM
instance.

## Setup

```sh
swamp extension pull @jamesakeech/nginx-proxy-manager
swamp model create @jamesakeech/nginx-proxy-manager npm-edge
swamp model edit npm-edge
```

Set these global arguments. `baseUrl` must point to the admin interface, usually
port 81. Store the admin password in a vault.

```yaml
globalArguments:
  baseUrl: http://192.0.2.5:81
  identity: admin@example.com
  secret: ${{ vault.get('homelab', 'npm-admin-password') }}
  instanceLabel: edge
  requestTimeoutSec: 30
```

`instanceLabel` is optional. `requestTimeoutSec` defaults to 30 seconds per HTTP
request. Increase it for DNS-01 certificate issuance.

## Read inventory

```sh
swamp model method run npm-edge sync
swamp data get npm-edge instance --json
```

`sync` writes one resource per object:

| Spec              | Instance name           |
| ----------------- | ----------------------- |
| `instance`        | `instance`              |
| `proxyHost`       | `proxy-host-<id>`       |
| `redirectionHost` | `redirection-host-<id>` |
| `deadHost`        | `dead-host-<id>`        |
| `stream`          | `stream-<id>`           |
| `accessList`      | `access-list-<id>`      |
| `certificate`     | `certificate-<id>`      |
| `change`          | `change-<method>`       |

The `instance` resource reports expired certificates, certificates expiring
within 30 days, enabled proxy hosts without certificates, and duplicate domain
assignments.

## Methods

| Method                                                    | Purpose                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `sync`                                                    | Read inventory and instance health                          |
| `applyProxyHost`, `applyRedirectionHost`, `applyDeadHost` | Create or update a host, matched by its exact domain set    |
| `applyStream`                                             | Create or update a stream, matched by incoming port         |
| `applyAccessList`                                         | Create or update an access list, matched by name            |
| `setEnabled`                                              | Enable or disable hosts or streams by `kind` and `ids`      |
| `delete`                                                  | Delete objects of any supported `kind` by `ids`             |
| `requestCertificate`                                      | Request a Let's Encrypt certificate using HTTP-01 or DNS-01 |
| `renewCertificate`                                        | Renew certificates by `ids`                                 |
| `uploadCertificate`                                       | Upload a certificate from local PEM files                   |

```sh
swamp model method run npm-edge applyProxyHost \
  --input 'domainNames=["media.example.com"]' \
  --input forwardHost=192.0.2.20 --input forwardPort=8096 \
  --input certificateId=4 --input sslForced=true

swamp model method run npm-edge setEnabled \
  --input kind=proxyHost --input 'ids=[3,4]' --input enabled=false
```

Each `apply*` method updates a matching object or creates it when absent, then
writes the resulting resource. Pass `id` when changing a host's domain set or an
access list's name to avoid creating a second object.

Access list users are replaced as a complete set. Resend all users and passwords
with `applyAccessList`; the stored resource contains usernames only.

Batch methods report `action: partial` when only some targets succeed.
Successful deletions also remove the corresponding swamp resources. Run `sync`
and verify IDs before deleting: NPM can reuse deleted IDs.

## Certificates

```sh
swamp model method run npm-edge requestCertificate \
  --input 'domainNames=["media.example.com"]' \
  --input letsencryptEmail=me@example.com
```

HTTP-01 requires public access to port 80. For DNS-01, set `dnsChallenge=true`,
`dnsProvider`, and `dnsProviderCredentials`. Use DNS-01 for wildcard
certificates or hosts without inbound port 80.

`requestCertificate` reuses an existing Let's Encrypt certificate with the same
exact domain set. Set `force=true` to reissue it.

## Limits

- Mutating methods run the `instance-reachable` pre-flight check. It has the
  `live` label; skip it with `--skip-check-label live` when needed.
- The admin API must use a trusted TLS certificate or HTTP on an internal
  network. Self-signed TLS certificates are not supported.
- Collections unavailable on older NPM versions produce a warning and empty
  results.
- Users, permissions, settings, audit logs, and default site configuration are
  not managed.

## Development

```sh
~/.swamp/deno/deno check nginx_proxy_manager.ts
~/.swamp/deno/deno test --allow-net --allow-read .
```

## License

MIT — see [LICENSE.md](LICENSE.md).
