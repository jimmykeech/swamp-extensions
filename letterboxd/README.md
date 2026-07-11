# @jamesakeech/letterboxd

Read-only monitoring of a single user's **[Letterboxd](https://letterboxd.com)**
film diary via their **public RSS feed** — no API key, no login.

Letterboxd's official API is invite-only, but every public account publishes an
RSS feed of recent activity at `letterboxd.com/<username>/rss/`. This model
parses that feed's diary entries and writes one **`diaryEntry`** record per
logged film watch:

- watched date, star rating (or unrated), **liked** and **rewatch** flags
- film title & year, **TMDB id** (to cross-reference other sources)
- the Letterboxd URL, poster image, and review text (when present)

### Why this exists

Letterboxd is where you log films you watch **out in the world — cinema trips,
festivals, a friend's place** — as opposed to what a home media server records.
The RSS feed carries no venue field, so this simply captures whatever you log to
your diary; pair it with a server-based watch history for the full picture.

## Rolling window — run it on a schedule

The RSS feed only exposes the **most recent ~50 activity items** (and it
interleaves list activity, which this model skips). Letterboxd offers no way to
page back through older history via RSS, so `sync_diary` **accumulates**: each
watch is written under a stable id (`d-<watchId>`), so re-runs update in place
and nothing already captured is lost. Run it regularly to build a durable diary.

## Setup

No vault or credentials — just point it at a public username:

```bash
swamp model create @jamesakeech/letterboxd letterboxd \
  --global-arg username=YOUR_LETTERBOXD_USERNAME
```

> The account must be **public** for its RSS feed to be readable.

## Method

| Method       | What it does                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| `sync_diary` | Fetch the RSS feed and record each diary film watch. One `diaryEntry` per watch. |

Arguments: `limit` (max watches to record, default 50, max 200) and `sinceDate`
(only record watches on/after a `YYYY-MM-DD`).

```bash
# Record the current window of diary watches
swamp model @jamesakeech/letterboxd method run sync_diary letterboxd

# Only watches logged in 2026
swamp model @jamesakeech/letterboxd method run sync_diary letterboxd --arg sinceDate=2026-01-01
```

## Querying the data

```bash
# Everything you rated 4+ stars
swamp data query letterboxd.diaryEntry 'attributes.rating >= 4'

# Films you liked, newest first
swamp data query letterboxd.diaryEntry 'attributes.liked == true' \
  --order-by attributes.watchedDate --desc
```

## Notes & limits

- **Read-only, no credentials.** The feed is public.
- **Rolling window.** Only recent activity is exposed — schedule `sync_diary` so
  it accumulates. History older than your first sync's window can't be recovered
  via RSS.
- **List activity is skipped** — only film watches (diary entries) are recorded.
- **Private accounts** don't publish a readable RSS feed; `sync_diary` will fail
  with `HTTP 404`/`403` if the username is wrong or the account is private.
- **User-Agent matters.** Letterboxd blocks unknown agents, so the default UA
  keeps a `Mozilla/5.0` prefix. Override with the `userAgent` arg if needed.

## License

MIT — see [LICENSE.md](LICENSE.md).
