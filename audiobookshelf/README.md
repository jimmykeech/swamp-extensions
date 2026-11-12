# @jamesakeech/audiobookshelf

Read libraries, media, and listening activity from an Audiobookshelf server. All
methods are read-only and use the REST API.

## Install

```sh
swamp extension pull @jamesakeech/audiobookshelf
```

## Setup

Create an Audiobookshelf API key and store it in a swamp vault. The sensitive
`apiKey` argument requires a vault expression.

```sh
swamp vault create local_encryption audiobookshelf
swamp vault put audiobookshelf ABS_API_KEY="<your-api-key>"

swamp model create @jamesakeech/audiobookshelf abs \
  --global-arg baseUrl=https://abs.example.com \
  --global-arg "apiKey=\${{ vault.get('audiobookshelf', 'ABS_API_KEY') }}"

swamp model method run abs libraries
swamp model method run abs sessions --input limit=100
```

Both `baseUrl` and `apiKey` are required. Use a base URL without a trailing
slash.

## Methods

| Method      | Result                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| `libraries` | Accessible libraries, media types, providers, and folder counts.                        |
| `items`     | Audiobooks and podcasts across accessible libraries, with metadata, duration, and size. |
| `progress`  | In-progress and finished items for the API key's user.                                  |
| `sessions`  | Recent listening sessions for that user; `limit` defaults to 50, maximum 500.           |
| `stats`     | Total listening time, daily totals, and top items for that user.                        |

`sessions` fetches one page, most recent first. Each record has
`truncated: true` when more sessions exist than were fetched. Increase `limit`
to fetch more, up to 500. Library access and listening activity follow the API
key's permissions and user identity.

## License

[MIT](LICENSE.md).
