# @jamesakeech/fly

Monitor Fly.io organisations and apps through the Fly Machines API. The
extension also creates volume snapshots. It does not deploy apps or require
`flyctl` at runtime.

## Install

```sh
swamp extension pull @jamesakeech/fly
```

## Setup

Store a Fly API token in a swamp vault. The sensitive `apiToken` argument
requires a vault expression. Use a token with access to the organisation or app
and write access for snapshot creation.

```sh
swamp vault create local_encryption fly
swamp vault put fly FLY_API_TOKEN="<your-api-token>"

swamp model create @jamesakeech/fly/org fly-org \
  --global-arg orgSlug=personal \
  --global-arg "apiToken=\${{ vault.get('fly', 'FLY_API_TOKEN') }}"

swamp model create @jamesakeech/fly/app fly-app \
  --global-arg appName=my-app \
  --global-arg "apiToken=\${{ vault.get('fly', 'FLY_API_TOKEN') }}"

swamp model method run fly-org status
swamp model method run fly-app volumes
```

The org model requires `orgSlug` and `apiToken`. The app model requires
`appName` and `apiToken`.

## Organisation methods: `@jamesakeech/fly/org`

| Method   | Result                                                                |
| -------- | --------------------------------------------------------------------- |
| `apps`   | All apps in the organisation, with IDs, machine counts, and networks. |
| `status` | Per-app machine counts, running and unhealthy counts, and images.     |

`status` records an inaccessible app as `reachable: false` with its error and
continues with the other apps.

## App methods: `@jamesakeech/fly/app`

| Method      | Action                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `status`    | Read machine states, regions, images, and health checks.               |
| `volumes`   | Read volume size, region, attachment, retention, and disk usage.       |
| `events`    | Read machine lifecycle events, including starts, exits, and OOM kills. |
| `snapshots` | List snapshots across all app volumes.                                 |
| `snapshot`  | Create a snapshot for every volume, or one optional `volumeId`.        |

```sh
swamp model method run fly-app snapshot
```

`snapshot` does not delete existing snapshots. Its `volumes-present` check has
the `live` label; skip it with `--skip-check-label live`. If some snapshot
requests fail, the method throws and reports successful requests. Those
snapshots remain.

Fly can report volume block statistics as zero, so treat `usedPercent` as an
estimate.

## License

[MIT](LICENSE.md).
