# @jamesakeech/spotify

A [swamp](https://github.com/swamp-club/swamp) extension for monitoring a single
user's [Spotify](https://spotify.com) listening activity via the
[Spotify Web API](https://developer.spotify.com/documentation/web-api). It reads
recently-played tracks and Spotify's own top-artists/top-tracks rankings.
Read-only — this type never mutates Spotify state.

## The one big caveat

**Spotify does not expose arbitrary listening history.** There is no "everything
I played last month" endpoint. What you get:

- **`recent_plays`** — only the **last ~50 plays** (a rolling window). To build
  real history you must run this **on a schedule and accumulate** — each play is
  written under a stable, idempotent instance name (`p-<unix-ms>`), so re-runs
  never duplicate. Pass `after` (Unix ms) to fetch only newer plays.
- **`top_artists` / `top_tracks`** — Spotify's own ranked lists over
  `short_term` (~4 weeks), `medium_term` (~6 months), or `long_term` (~1 year).
  Ranked, but no per-play timestamps, and there is **no top-albums endpoint** —
  album counts have to be aggregated from the accumulated `play` data.

## Setup

### 1. Create a Spotify app

At [developer.spotify.com](https://developer.spotify.com/dashboard) → **Create
app**. Note the **Client ID** and **Client Secret**, and under **Settings** add a
**Redirect URI** of `http://127.0.0.1:8888/callback` (or your own — it just has
to match the `redirectUri` argument). You do **not** need a server running there;
you only read the `code` out of the redirected URL.

### 2. Store secrets and create the model

```sh
swamp vault create local_encryption spotify
swamp vault put spotify SPOTIFY_CLIENT_SECRET="<your-client-secret>"

swamp model create @jamesakeech/spotify spotify \
  --global-arg clientId="<your-client-id>" \
  --global-arg "clientSecret=\${{ vault.get('spotify', 'SPOTIFY_CLIENT_SECRET') }}" \
  --global-arg redirectUri="http://127.0.0.1:8888/callback"
```

`refreshToken` is left empty for now — the data methods will refuse to run until
it is set, which is the next step.

### 3. One-time authorization

```sh
# Print the authorization URL, open it, approve access.
swamp model method run spotify authorize_url
swamp data get spotify current    # copy the `url`, open it in a browser

# After approving, the browser redirects to
#   http://127.0.0.1:8888/callback?code=<CODE>&state=...
# (the page may fail to load — that's fine, just copy <CODE> from the address bar)
swamp model method run spotify authorize --arg code="<CODE>"

# Read the refresh token and store it in the vault.
swamp data get spotify current    # copy the plaintext `token` value
swamp vault put spotify SPOTIFY_REFRESH_TOKEN="<refresh-token>"
swamp data delete spotify current --force   # remove the plaintext token once vaulted
```

Then wire the refresh token into the model:

```sh
swamp model edit spotify   # set refreshToken to ${{ vault.get('spotify', 'SPOTIFY_REFRESH_TOKEN') }}
```

## Methods

| Method          | Captures                                                                       |
| --------------- | ------------------------------------------------------------------------------ |
| `authorize_url` | one-time OAuth URL to open in a browser (needs only clientId + redirectUri)     |
| `authorize`     | exchanges the redirect `code` for a refresh token (plaintext, one-time record)  |
| `recent_plays`  | recently-played tracks — one `play` per track, keyed by play time (accumulate)  |
| `top_artists`   | top artists for a `timeRange` — one `topArtist` per artist, with rank/genres    |
| `top_tracks`    | top tracks for a `timeRange` — one `topTrack` per track, with rank/album        |

```sh
swamp model method run spotify recent_plays --arg limit=50
swamp model method run spotify top_artists --arg timeRange=short_term
swamp model method run spotify top_tracks  --arg timeRange=long_term
```

## Accumulating history

Run `recent_plays` on a schedule so plays build up over time. A minimal workflow:

```yaml
jobs:
  - name: spotify-pull
    steps:
      - name: recent
        model: spotify
        method: recent_plays
      - name: top-artists
        model: spotify
        method: top_artists
        arguments: { timeRange: short_term }
        dependsOn: [recent]
      - name: top-tracks
        model: spotify
        method: top_tracks
        arguments: { timeRange: short_term }
        dependsOn: [top-artists]
```

Run it every few hours (Spotify only keeps the last ~50 plays) to avoid gaps.

## Reading data with CEL

```text
data.latest("spotify", "play").attributes.primaryArtist
data.latest("spotify", "topArtist").attributes.name
data.latest("spotify", "topTrack").attributes.albumName
```

Artist / album / song counts for lists and dashboards come from aggregating the
accumulated `play` records (by `primaryArtist`, `albumName`, `trackName`).

## Notes

- All errors throw with the HTTP status before any data is written. Secrets
  (client secret, refresh token) are never logged. The `credential` record
  `authorize` writes holds the refresh token in **plaintext** on purpose — swamp
  auto-vaults sensitive outputs into an unreadable reference, so a one-time
  bootstrap value that you must copy out has to be plaintext. Delete it
  (`swamp data delete spotify current --force`) once it is in your vault.
- Scopes requested: `user-read-recently-played`, `user-top-read`.
- Every record carries a `truncated` flag — `true` when a pull returned a full
  page (for `recent_plays`, older plays may be unfetched — poll more often; for
  the top methods, Spotify reported more items than were returned).

## License

MIT — see [LICENSE.md](LICENSE.md) for details.
