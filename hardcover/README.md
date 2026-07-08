# @jamesakeech/hardcover

Read-only monitoring of a single user's **[Hardcover](https://hardcover.app)**
reading activity via the
[Hardcover GraphQL API](https://docs.hardcover.app/api/getting-started/).

It pulls three things:

- **profile** — your Hardcover user (id, username, name, total book count).
- **book** — every book in your tracked library, one record per entry, with its
  shelf status (Want to Read / Currently Reading / Read / Did Not Finish),
  rating, review flag, author(s), page count, release year and read dates.
- **read** — every reading session, one record per entry, with start/finish
  dates and progress (page-based for print, seconds for audiobooks).

Unlike streaming APIs, Hardcover exposes your **full** persistent history, so
each `sync_*` run re-pulls the complete state and writes idempotent records
keyed by the Hardcover row id — re-runs update in place instead of duplicating.
Run it on a schedule to keep the local copy fresh and to capture reads as they
finish. The API is rate-limited to **60 requests/minute**; this type paginates
in pages of 100 and stays well under that.

## Setup

1. **Get an API token.** Sign in at [hardcover.app](https://hardcover.app), open
   your account settings, and click **Hardcover API** — the token is shown at
   the top of the page. Keep it private (it can modify your account) and note it
   **expires ~yearly, resetting on Jan 1**.

2. **Store it in a vault** (never inline the token):

   ```bash
   swamp vault create local_encryption hardcover
   swamp vault set hardcover HARDCOVER_API_TOKEN
   # paste the token when prompted (the leading "Bearer " is optional)
   ```

3. **Create the model**, sourcing the token from the vault:

   ```bash
   swamp model create @jamesakeech/hardcover hardcover \
     --arg apiToken='${{ vault.get("hardcover", "HARDCOVER_API_TOKEN") }}'
   ```

## Methods

| Method       | What it does                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `whoami`     | Fetch your profile (id, username, name, book count). Use it to verify the token. One `profile`. |
| `sync_books` | Pull your whole tracked library; one `book` per entry. `--arg statusId=` limits to one shelf.   |
| `sync_reads` | Pull all your reading sessions; one `read` per entry (start/finish dates, progress).            |

Shelf `statusId` values: **1** Want to Read, **2** Currently Reading, **3**
Read, **5** Did Not Finish.

```bash
# Verify the token
swamp model @jamesakeech/hardcover method run whoami hardcover

# Sync the whole library, then all reads
swamp model @jamesakeech/hardcover method run sync_books hardcover
swamp model @jamesakeech/hardcover method run sync_reads hardcover

# Just the "Currently Reading" shelf
swamp model @jamesakeech/hardcover method run sync_books hardcover --arg statusId=2
```

## Querying the data

```bash
# Everything you've finished, highest-rated first
swamp data query hardcover.book 'attributes.statusId == 3' \
  --order-by attributes.rating --desc

# Reads finished this year
swamp data query hardcover.read 'attributes.finishedAt >= "2026-01-01"'
```

## Notes & limits

- **Read-only.** No method mutates Hardcover state.
- **Rate limit:** 60 req/min. A full-library sync is a handful of paginated
  requests; schedule syncs minutes apart, not seconds.
- **Token expiry:** tokens expire ~yearly and reset Jan 1 — refresh the vault
  value when `whoami` starts returning `HTTP 401 Unable to verify token`.
- **Beta API:** Hardcover notes the API is still in flux and may change.

## License

MIT — see [LICENSE.md](LICENSE.md).
