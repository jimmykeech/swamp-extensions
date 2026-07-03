# @jamesakeech/audiobookshelf

A [swamp](https://github.com/swamp-club/swamp) extension for monitoring a
self-hosted [Audiobookshelf](https://www.audiobookshelf.org) server. It reads
state directly from the Audiobookshelf REST API — libraries, audiobooks and
podcasts, listening progress, listening session history, and aggregate listening
statistics. Read-only — this type never mutates server state.

## Setup

Generate an API key in Audiobookshelf (**Settings → Users → your user → API
Keys**, requires Audiobookshelf v2.17+) and store it in a vault (the `apiKey`
argument is sensitive, so a literal value is rejected):

```sh
swamp vault create local_encryption audiobookshelf
swamp vault put audiobookshelf ABS_API_KEY="<your-api-key>"
```

## `@jamesakeech/audiobookshelf`

| Method      | Captures                                                                |
| ----------- | ----------------------------------------------------------------------- |
| `libraries` | every library on the server (name, media type, provider, folder count)  |
| `items`     | every audiobook/podcast across every library (metadata, duration, size) |
| `progress`  | media progress for the API key's user (in-progress and finished items)  |
| `sessions`  | recent listening sessions for the API key's user (`limit`, default 50)  |
| `stats`     | aggregate listening stats: total time, daily breakdown, top items       |

`items` fans out over every library in a single execution rather than looping
per-library method calls.

```sh
swamp model create @jamesakeech/audiobookshelf abs \
  --global-arg baseUrl=https://abs.example.com \
  --global-arg "apiKey=\${{ vault.get('audiobookshelf', 'ABS_API_KEY') }}"

swamp model method run abs libraries    # discover libraries
swamp model method run abs items        # discover audiobooks/podcasts
swamp model method run abs progress     # listening progress per item
swamp model method run abs sessions --input limit=100
swamp model method run abs stats        # aggregate listening stats
```

## Notes

- Errors throw with the HTTP status before any data is written; the vaulted
  `apiKey` is masked in output.
- `items` and `progress` reflect the state of the API key's own library
  visibility and listening history, respectively — not other users' data.
- `sessions` fetches a single page (`itemsPerPage=<limit>`), most recent first,
  as reported by the server. Every session record carries a `truncated` field —
  `true` when the server reports more sessions than `limit` fetched, so a higher
  `limit` is needed to see the rest.

## License

MIT — see [LICENSE.md](LICENSE.md) for details.
