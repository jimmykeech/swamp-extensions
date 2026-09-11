# Swamp extensions

[Swamp](https://github.com/swamp-club/swamp) extensions maintained by the James
A. Keech Collective under the `@jamesakeech` namespace.

## Extensions

Each extension has its own README with setup, configuration, and usage details.

| Extension                                                  | Purpose                                                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@jamesakeech/ansible`](ansible/)                         | Check and apply existing Ansible playbooks with structured per-host results.                                                                                   |
| [`@jamesakeech/audiobookshelf`](audiobookshelf/)           | Read libraries, listening progress, sessions, and statistics from Audiobookshelf.                                                                              |
| [`@jamesakeech/bootstrap`](bootstrap/)                     | Set up reviewed project architecture and isolated Swamp software factories.                                                                                    |
| [`@jamesakeech/esxi`](esxi/)                               | Collect read-only VM inventory from standalone VMware ESXi hosts.                                                                                              |
| [`@jamesakeech/fly`](fly/)                                 | Monitor Fly.io applications and machines, and take volume snapshots.                                                                                           |
| [`@jamesakeech/forgejo-code`](forgejo-code/)               | Read repository trees and source files through `@shrug/forgejo`.                                                                                               |
| [`@jamesakeech/gitlab-work-items`](gitlab-work-items/)     | Manage GitLab issues, tasks, incidents, labels, and parent links.                                                                                              |
| [`@jamesakeech/hardcover`](hardcover/)                     | Read Hardcover library, reading activity, and sessions.                                                                                                        |
| [`@jamesakeech/jellyfin-playback`](jellyfin-playback/)     | Read playback activity and watch history through `@keeb/jellyfin`.                                                                                             |
| [`@jamesakeech/letterboxd`](letterboxd/)                   | Read film diary entries from a public Letterboxd RSS feed.                                                                                                     |
| [`@jamesakeech/mongodb-datastore`](mongodb-datastore/)     | Store shared Swamp repository data in MongoDB with namespace-aware sync and server coordination. Requires a replica set; see its README for known limitations. |
| [`@jamesakeech/nginx-proxy-manager`](nginx-proxy-manager/) | Manage proxy hosts, streams, access lists, and TLS certificates.                                                                                               |
| [`@jamesakeech/omada`](omada/)                             | Monitor TP-Link Omada sites and devices, detect configuration changes, and run device operations.                                                              |
| [`@jamesakeech/pocket-id`](pocket-id/)                     | Read Pocket ID health, users, OIDC clients, groups, API keys, and audit activity.                                                                              |
| [`@jamesakeech/spotify`](spotify/)                         | Read recent listening activity, top artists, and top tracks with OAuth helpers.                                                                                |
| [`@jamesakeech/technitium`](technitium/)                   | Manage Technitium DNS zones, records, filtering, backups, and clusters.                                                                                        |

## Installation

Run this command inside your Swamp repository, replacing the package name with
one from the catalog:

```sh
swamp extension pull @jamesakeech/mongodb-datastore
```

Follow the extension's README for credentials, service requirements, and
configuration.

## Development

Each extension lives in its own directory with a self-contained `manifest.yaml`.
Manifest paths are relative to that directory (`paths.base: manifest`).

Use Deno to run the tests and checks for the extension you change. For example,
from the repository root:

```sh
deno test --allow-net fly/
deno fmt --check fly/
deno lint fly/
```

Check the extension's README and Deno configuration for additional permissions,
dependencies, or live service requirements.

Build and validate a package without publishing it:

```sh
swamp extension push fly/manifest.yaml --dry-run --json
```

## License

This repository is licensed under the [MIT License](LICENSE). Extension
directories retain their own license and copyright notices, including
[the MongoDB datastore's upstream attribution](mongodb-datastore/LICENSE.txt).
