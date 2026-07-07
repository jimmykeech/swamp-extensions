# @jamesakeech/jellyfin-playback

A [swamp](https://github.com/swamp-club/swamp) extension that adds
**watch-activity** methods to the [`@keeb/jellyfin`](https://github.com/keeb/swamp-jellyfin)
model type. The base type covers library inventory, audit, and identification;
this adds the data needed to build watch-time dashboards. Read-only — neither
method mutates server state.

This extends `@keeb/jellyfin`, so that extension is a dependency and is pulled
automatically alongside this one.

## Methods

| Method              | Source                                      | Captures                                                                          |
| ------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `playback_sessions` | Playback Reporting **plugin** (accurate)    | one `playbackSession` per event — item, type, client, device, duration, timestamp |
| `watch_history`     | Jellyfin **core API** (no plugin, fallback) | one `watchedItem` per user/item — most-recent play, play count, runtime           |

- `playback_sessions(days=30, limit=5000)` runs a read-only SQL query against the
  plugin's `PlaybackActivity` table via `POST /user_usage_stats/submit_custom_query`.
  It is the accurate source (real durations, hour-of-day, per-device). Requires
  the **Playback Reporting** plugin installed on the server (Dashboard → Plugins).
- `watch_history(days=30)` fans out over **all** users via
  `/Users/{id}/Items?IsPlayed=true` and needs no plugin — it works immediately.
  Caveat: `LastPlayedDate` is set to a single timestamp by bulk "mark as played",
  so it cannot back an honest daily/hourly time-series; use it for
  series-rotation and per-user aggregates only.

## Setup

The methods reuse the `@keeb/jellyfin` model's `jellyfinUrl` / `jellyfinApiKey`
global arguments — no extra configuration. On a model instance of that type:

```sh
swamp model method run my-jellyfin watch_history --arg days=30
swamp model method run my-jellyfin playback_sessions --arg days=30 --arg limit=5000
```

## Reading data with CEL

```text
data.latest("my-jellyfin", "playbackSession").attributes.playDurationSeconds
data.latest("my-jellyfin", "watchedItem").attributes.lastPlayedDate
```

## Notes

- Errors throw with the HTTP status before any data is written; the vaulted
  `jellyfinApiKey` is never logged.
- `playback_sessions` throws a descriptive error on `404` — the hint to install
  the Playback Reporting plugin.
- `days` and `limit` are integer-coerced before the SQL is built, so the
  interpolated query is injection-safe.
- Every `playbackSession` carries a `truncated` field — `true` when the pull hit
  the `limit` cap (older events dropped), so a higher `limit` is needed to see
  the rest.

## License

MIT — see [LICENSE.md](LICENSE.md) for details.
