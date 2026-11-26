# @jamesakeech/technitium

Manage [Technitium DNS Server](https://technitium.com/dns/) with
[swamp](https://github.com/swamp-club/swamp): zones, records, blocking, cache,
diagnostics, settings backups, and cluster membership. Use one model per DNS
server, including a separate model for each cluster node.

## Setup

```sh
swamp extension pull @jamesakeech/technitium
swamp model create @jamesakeech/technitium dns-primary
swamp model edit dns-primary
```

Set the model's global arguments:

```yaml
globalArguments:
  baseUrl: http://192.0.2.10:5380
  apiToken: ${{ vault.get('homelab', 'technitium-api-token') }}
```

Prefer an IP address when the managed server would otherwise resolve its own
name. The API token needs permission for each method; cluster methods require
**Administration**. Cluster authentication changes replicate between nodes with
a short delay.

```sh
swamp model method run dns-primary zone_list
swamp model method run dns-primary record_list --input zone=example.com
```

## Methods

| Area        | Methods                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Zones       | `zone_list`, `zone_create`, `zone_delete`, `zone_enable`, `zone_disable`                                                         |
| Records     | `record_list`, `record_get`, `record_ensure`, `record_add`, `record_update`, `record_delete`                                     |
| Settings    | `settings_get`, `settings_backup`, `settings_restore`, `web_service_set_tls`, `dnssec_validation_set`                            |
| Blocking    | `blocking_get_settings`, `blocking_set_state`, `blocking_temporary_disable`, `blocking_set_lists`, `blocking_force_update_lists` |
| Allow list  | `allowed_add`, `allowed_delete`, `allowed_list`, `allowed_flush`                                                                 |
| Block list  | `blocked_add`, `blocked_delete`, `blocked_list`, `blocked_flush`                                                                 |
| Cache       | `cache_list`, `cache_delete`, `cache_flush`                                                                                      |
| Diagnostics | `client_resolve`, `logs_query`, `dashboard_stats`                                                                                |
| Cluster     | `cluster_state`, `cluster_init`, `cluster_join`                                                                                  |

## Ensure DNS records

`record_ensure` creates missing records, updates changed values or TTLs, and
leaves matching records unchanged. It accepts a list and reports `created`,
`updated`, or `unchanged` per record.

```sh
swamp model method run dns-primary record_ensure \
  --input zone=example.com \
  --input 'records=[{"domain":"app.example.com","type":"A","ttl":300,"rData":{"ipAddress":"192.0.2.20"}}]'
```

Each record requires `domain`, `type`, and `rData`; `ttl` is optional.
`multiValued` defaults to `false`, which updates an existing record of the same
type at that name. Set it to `true` to add a value while keeping sibling
records, such as round-robin addresses or multiple MX records.

`rData` accepts the server's read or write field names. Type-specific mapping
handles differences for TLSA, SSHFP, and URI records. `record_add` fails if the
record exists; `record_update` fails if it is absent. Use `record_ensure` for
repeatable workflows.

## Backup and cluster limits

`settings_backup` includes all sections by default, including `dnsSettings` and
`logSettings`. A restored backup still requires these node-specific steps:

- Restore the TLS listener settings with `web_service_set_tls`.
- Restore or replace the web service certificate. If its key changes, update any
  TLSA records that pin the old key.
- Restore cluster membership with `cluster_init` and `cluster_join`.

`cluster_state` reports the local node's view. Query each node when diagnosing a
cluster.

**`cluster_init` creates a new shared secret.** Existing secondary nodes must
rejoin afterward. `cluster_join` requires the primary's username and password,
not an API token. Its `primaryNodeUrl` must use the primary's domain name.

A joining node cannot contain a catalog zone. Remove the secondary's
`SecondaryCatalog` copy before joining; preserve the primary's `Catalog` zone.
Cluster leave and secondary removal operations are not exposed.

## Verification status

The implementation follows the Technitium v15.4 API and UI source. Live checks
covered record operations, settings reads and backups, cluster state, blocking
settings reads, allow/block lists, cache listing and deletion, DNS resolution,
dashboard statistics, and the missing-log-app error path.

Live validation did not cover all state-changing methods in this extension,
including restore, TLS changes, cluster initialization and joining, zone
creation and enablement, cache flushing, blocking changes, and DNSSEC validation
changes. Test these on a disposable server before production use.

## License

MIT — see [LICENSE.md](LICENSE.md).
