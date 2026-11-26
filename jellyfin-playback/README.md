# @jamesakeech/jellyfin-playback

Read Jellyfin watch activity for dashboards and reports. Extends
[`@keeb/jellyfin`](https://github.com/keeb/swamp-jellyfin) and reuses its
`jellyfinUrl` and `jellyfinApiKey` arguments. The base extension is installed as
a dependency. Both methods are read-only.

## Install

```sh
swamp extension pull @jamesakeech/jellyfin-playback
```

## Methods

| Method              | Requirements              | Result                                                                                        |
| ------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `playback_sessions` | Playback Reporting plugin | One `playbackSession` per event, with timestamp, duration, client, and device                 |
| `watch_history`     | Jellyfin core API         | One `watchedItem` per user/item, with latest play date, play count, runtime, and external IDs |

Run these methods on an existing `@keeb/jellyfin` model:

```bash
swamp model method run my-jellyfin watch_history --input days=30
swamp model method run my-jellyfin playback_sessions --input days=30 --input limit=5000
```

Both methods default to the last 30 days and cover all users.
`playback_sessions` defaults to 5000 events. Install the **Playback Reporting**
plugin from Jellyfin's **Dashboard → Plugins** to use it.

## Data and limitations

- `playback_sessions` records actual session durations. If an event's
  `truncated` field is `true`, the result reached `limit`; increase it to
  retrieve older events.
- `watch_history` records only the latest play per user/item. It cannot measure
  individual sessions or partial plays. Bulk **mark as played** operations also
  change `LastPlayedDate`, so this data is unsuitable for daily or hourly
  watch-time charts.
- Resource instance names are `s-<rowid>` for sessions and `<userId>-<itemId>`
  for watched items.

## License

MIT — see [LICENSE.md](LICENSE.md).
