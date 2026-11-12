# MongoDB Datastore

A MongoDB datastore for shared Swamp repositories and multiple `swamp serve`
instances. Published by James A. Keech Collective.

Forked from
[keeb/swamp-mongodb-datastore](https://github.com/keeb/swamp-mongodb-datastore)
at commit `9fde8a9`, with the upstream MIT license and copyright retained. This
fork adds namespace-aware synchronization, managed configuration refresh, server
heartbeats, and run ownership. Source is maintained in
[jimmykeech/swamp-extensions](https://github.com/jimmykeech/swamp-extensions/tree/main/mongodb-datastore).
This directory was imported from standalone fork commit `ed902e8`.

## Requirements

- MongoDB 4.0+ configured as a replica set. A single-node replica set is
  supported.
- Swamp CLI with extension support.
- A separate namespace for each repository.

## Setup

Install the extension in your Swamp repository:

```sh
swamp extension pull @jamesakeech/mongodb-datastore
```

Set `MONGO_PASSWORD` in the environment or the repository's gitignored `.env`
file:

```dotenv
MONGO_PASSWORD=YOUR_PASSWORD
```

Configure both the provider namespace and Swamp's core namespace:

```sh
swamp datastore setup extension @jamesakeech/mongodb-datastore \
  --namespace my-repo --hydration-strategy full \
  --config '{"uri":"mongodb://mongo.example.com:27017/?replicaSet=rs0&authSource=admin","username":"swamp-user","passwordEnv":"MONGO_PASSWORD","database":"swamp","tenantId":"my-org","namespace":"my-repo"}'
swamp datastore config migrate
```

For shared servers, deploy the same repository marker, including `repoId`, and
the same database, tenant, and namespace configuration to each host. Supply
credentials and install the extension separately on every host. Keep each host's
`SWAMP_HOME` cache and extension index local; do not copy
`.swamp/_extension_catalog.db*` between repository directories.

For a different repository, use a different `repoId` and namespace. Repositories
can share the same MongoDB database.

Large existing `.swamp/` trees can exhaust memory during setup migration. Use
`--skip-migration` when you intend to repopulate data through workflows.

## Configuration

These fields belong to `datastore.config` in `.swamp.yaml` or the setup
command's `--config` JSON.

| Field              | Required | Default          | Purpose                                           |
| ------------------ | -------- | ---------------- | ------------------------------------------------- |
| `uri`              | Yes      | —                | Replica-set URI; supply authentication separately |
| `username`         | Yes      | —                | MongoDB username                                  |
| `namespace`        | Yes      | —                | Repository collection namespace                   |
| `passwordEnv`      | No       | `MONGO_PASSWORD` | Environment variable containing the password      |
| `database`         | No       | `swamp`          | MongoDB database                                  |
| `tenantId`         | No       | `default`        | Tenant identifier; cannot contain `_r_`           |
| `defaultLockTtlMs` | No       | `30000`          | Lock lifetime in milliseconds                     |
| `maxPoolSize`      | No       | `20`             | Maximum connections in the shared process pool    |
| `maxIdleTimeMS`    | No       | `60000`          | Idle connection timeout in milliseconds           |

Collections use the prefix `t_<tenantId>_r_<namespace>`:

- `_locks`: distributed locks with heartbeat renewal.
- `_paths`: file metadata and deletion markers.
- `_blobs`: content-addressed file bytes, deduplicated by SHA-256.
- `_control`: server heartbeats and atomic run claims.

Coordination reads use the primary with majority read concern. Writes use
majority write concern. Managed configuration shares models and workflows.
Scoped pulls include the core namespace so executions can read previous output
versions.

## Maintenance

Create the companion maintenance model using a vaulted password:

```sh
swamp vault create local_encryption datastore-vault
swamp vault put datastore-vault MONGO_PASSWORD
swamp model create @jamesakeech/mongodb-datastore/maintenance datastoreMaintenance \
  --global-arg uri='mongodb://mongo.example.com:27017/?replicaSet=rs0&authSource=admin' \
  --global-arg username=swamp-user \
  --global-arg 'password=${{ vault.get("datastore-vault", "MONGO_PASSWORD") }}' \
  --global-arg database=swamp --global-arg tenantId=my-org
```

| Method      | Purpose                                                          |
| ----------- | ---------------------------------------------------------------- |
| `inventory` | Report paths, tombstones, blobs, disk use, and idle time         |
| `sweep`     | Prune old tombstones and unreferenced blobs; defaults to dry run |
| `compact`   | Return reusable database space to the filesystem                 |

Methods target all namespaces for the configured tenant by default. Set
`namespaces` to limit the scope.

```sh
swamp model method run datastoreMaintenance inventory
swamp model method run datastoreMaintenance sweep
swamp model method run datastoreMaintenance sweep --input dryRun=false \
  --input 'namespaces=["my-repo"]'
swamp model method run datastoreMaintenance compact
```

The bundled workflow runs inventory, sweep, and compact in sequence:

```sh
swamp workflow run @jamesakeech/datastore-maintenance
```

**The workflow sets `dryRun: false` and deletes eligible data.** Review a
standalone sweep dry run and retain backups before running it. Some inherited
maintenance operations suppress database errors, so inspect reports as well as
command status.

Maintenance constraints:

- `graceMinutes` defaults to 60. It protects newly uploaded blobs before their
  path records are written. The global lock alone does not prevent this race.
- Blobs written before version `2026.08.19.1` lack `createdAt` and have no age
  protection. The method skips blob collection when an active namespace has only
  these older blobs. Stop writers or use `skipBlobs=true` when that protection
  is insufficient; inspect `blobsSkipped` and `skipReason` in results.
- `tombstoneDays` defaults to 30 and must exceed the longest gap between peer
  syncs. A peer offline longer than this window must be bootstrapped again
  before it pushes, or it can restore deleted files.
- `compact` uses `force: true` and can slow concurrent operations. Run it during
  a quiet period. Collections below `minReusableMb` (default: 1) are skipped.
- Output version retention remains Swamp's responsibility. Configure output
  `garbageCollection` and schedule `swamp data gc`; datastore maintenance only
  reclaims the resulting remote space.

A pull skips paths whose blobs are missing. The owning host can re-upload them
on its next full walk. Do not tombstone those paths to repair missing blobs:
that would delete the host's local copies on its next pull.

## Limits and security

- Locks do not fence writes after a lost heartbeat. Set `defaultLockTtlMs` above
  the longest critical section, with margin. Compatibility tests do not
  establish safe failover during network partitions.
- Sync timestamps use client clocks. Keep host clocks synchronized.
- Local vault secrets and host-local SQLite catalogs, WAL/SHM files, and staging
  files are excluded from sync. Provision credentials on each host or use a
  suitable shared vault provider.
- **Versions through `2026.05.25.1` synchronized local vault keys and
  ciphertext.** If you used those versions, rotate every affected secret and
  remove remote `secrets/*` path records and their associated blobs. Upgrading
  prevents further sync but does not remove previously uploaded data.
- Swamp core issues affect managed `model.edit` propagation
  ([#2108](https://swamp-club.com/lab/2108)) and `data.get` definition
  resolution ([#2109](https://swamp-club.com/lab/2109)). This extension does not
  patch core.
- Passive `data.query` on another running server can remain stale because core
  background polling does not request runtime synchronization. Cold startup and
  the next scoped execution refresh relevant data.

## Development

From the repository root, validate packaging with:

```sh
swamp extension push mongodb-datastore/manifest.yaml --dry-run --json
```

Choose a new version before publishing another release. Contributor notes:
[CLAUDE.md](CLAUDE.md) and [SWAMP.md](SWAMP.md).

For MongoDB queries inside workflows, see the separate
[`@keeb/mongodb`](https://github.com/keeb/swamp-mongodb) model extension.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
