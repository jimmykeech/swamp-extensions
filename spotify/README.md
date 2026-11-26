# @jamesakeech/spotify

Read one user's Spotify listening activity with
[swamp](https://github.com/swamp-club/swamp). Collect recent plays and ranked
top artists and tracks. This extension does not change Spotify data.

Spotify provides only a rolling window of about 50 recent plays. Run
`recent_plays` regularly to build history before older plays leave that window.
Repeated pulls use stable `p-<unix-ms>` resource names to avoid duplicates.

## Setup

### Create the app and model

Create an app in the
[Spotify developer dashboard](https://developer.spotify.com/dashboard). Copy the
Client ID and Client Secret. Register `http://127.0.0.1:8888/callback` as a
Redirect URI, or use your own matching `redirectUri` value.

```sh
swamp extension pull @jamesakeech/spotify
swamp vault create local_encryption spotify
swamp vault put spotify SPOTIFY_CLIENT_SECRET="<your-client-secret>"
swamp model create @jamesakeech/spotify spotify \
  --global-arg clientId="<your-client-id>" \
  --global-arg 'clientSecret=${{ vault.get("spotify", "SPOTIFY_CLIENT_SECRET") }}' \
  --global-arg redirectUri=http://127.0.0.1:8888/callback
```

### Authorize once

```sh
swamp model method run spotify authorize_url
swamp data get spotify current
```

Open the returned `url` and approve access. Copy the `code` parameter from the
redirect URL. No local callback server is needed; the page can fail to load.

```sh
swamp model method run spotify authorize --input code="<CODE>"
swamp data get spotify current
swamp vault put spotify SPOTIFY_REFRESH_TOKEN="<token-from-current>"
swamp data delete spotify current --force
swamp model edit spotify
```

Set the model's `refreshToken` global argument to
`${{ vault.get('spotify', 'SPOTIFY_REFRESH_TOKEN') }}`. Data methods require
this value.

**The authorization result contains a plaintext refresh token.** Store it in the
vault and delete the `current` record as shown above. Requested scopes are
`user-read-recently-played` and `user-top-read`.

## Methods

| Method          | Output                                               |
| --------------- | ---------------------------------------------------- |
| `authorize_url` | OAuth URL in `authUrl`, instance `current`           |
| `authorize`     | Refresh token in `credential`, instance `current`    |
| `recent_plays`  | One `play` resource per play, keyed by timestamp     |
| `top_artists`   | Ranked `topArtist` resources, including genres       |
| `top_tracks`    | Ranked `topTrack` resources, including album details |

```sh
swamp model method run spotify recent_plays --input limit=50
swamp model method run spotify top_artists --input timeRange=short_term
swamp model method run spotify top_tracks --input timeRange=long_term
```

`recent_plays` accepts `after` as a Unix timestamp in milliseconds to request
newer plays. Schedule pulls frequently enough to stay within the rolling window;
missed older plays cannot be recovered through this API.

The top methods accept `short_term`, `medium_term`, or `long_term`. They return
Spotify's rankings without individual play timestamps. There is no top-albums
method; aggregate album counts from collected `play` records.

Listening and ranking resources include `truncated`. For recent plays, `true`
means a full page was returned and older plays may be missing. For rankings, it
means Spotify reported more items than were returned.

## License

MIT — see [LICENSE.md](LICENSE.md).
