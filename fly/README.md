# @jamesakeech/fly

A [swamp](https://github.com/swamp-club/swamp) extension for monitoring Fly.io
organisations and applications. It reads state directly from the
[Fly Machines REST API](https://docs.machines.dev) — it never wraps `flyctl` and
does not deploy.

Two model types:

- **`@jamesakeech/fly/org`** — discover and monitor every app in an org.
- **`@jamesakeech/fly/app`** — monitor one app in depth and take volume
  snapshots.

## Setup

Store a Fly API token in a vault (the `apiToken` argument is sensitive, so a
literal value is rejected):

```sh
swamp vault create local_encryption fly
swamp vault put fly FLY_API_TOKEN="$(fly auth token)"
```

## Org type — `@jamesakeech/fly/org`

| Method   | Captures                                                         |
| -------- | ---------------------------------------------------------------- |
| `apps`   | every app in the org (id, machine count, network)                |
| `status` | per-app machine-state summary (count, running, unhealthy, image) |

`status` fans out over all apps and records an unreachable one as
`reachable: false` with its error, rather than failing the whole run.

```sh
swamp model create @jamesakeech/fly/org fly-org \
  --global-arg orgSlug=personal \
  --global-arg "apiToken=\${{ vault.get('fly', 'FLY_API_TOKEN') }}"

swamp model method run fly-org apps      # discover all apps
swamp model method run fly-org status    # summarize all apps
```

## App type — `@jamesakeech/fly/app`

| Method      | Kind  | Captures                                                 |
| ----------- | ----- | -------------------------------------------------------- |
| `status`    | read  | machines: state, region, running image, health checks    |
| `volumes`   | read  | volumes: size, region, attachment, retention, disk usage |
| `events`    | read  | per-machine lifecycle events: starts, exits, OOM kills   |
| `snapshots` | read  | every snapshot across the app's volumes                  |
| `snapshot`  | write | create a snapshot per volume (or a specific `volumeId`)  |

`snapshot` is additive (it never deletes) and runs a `live`-labelled
`volumes-present` pre-flight check, skippable with `--skip-check-label live`.

```sh
swamp model create @jamesakeech/fly/app fly-app \
  --global-arg appName=my-app \
  --global-arg "apiToken=\${{ vault.get('fly', 'FLY_API_TOKEN') }}"

swamp model method run fly-app status
swamp model method run fly-app snapshot   # back up every volume
```

## Notes

- Errors throw with the HTTP status before any data is written; the vaulted
  `apiToken` is masked in output.
- `usedPercent` comes from Fly's volume block stats, which the list endpoint can
  report as `0%` — treat disk usage as indicative.

## License

MIT — see [LICENSE.md](LICENSE.md) for details.
