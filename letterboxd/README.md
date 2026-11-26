# @jamesakeech/letterboxd

Read a public [Letterboxd](https://letterboxd.com) film diary through RSS. No
credentials are required. Each logged watch becomes a `diaryEntry` with its
date, rating, liked and rewatch flags, title, year, TMDB ID, poster, and review
when available.

## Install

```sh
swamp extension pull @jamesakeech/letterboxd
```

## Setup

```bash
swamp model create @jamesakeech/letterboxd letterboxd \
  --global-arg username=YOUR_LETTERBOXD_USERNAME
```

The account must be public. Optional global arguments are `baseUrl` and
`userAgent`; keep the default User-Agent's `Mozilla/5.0` prefix if you override
it.

## Sync the diary

```bash
swamp model method run letterboxd sync_diary
swamp model method run letterboxd sync_diary --input sinceDate=2026-01-01
```

`sync_diary` accepts `limit` (default 50, maximum 200) and `sinceDate` (include
watches on or after `YYYY-MM-DD`). It skips list activity and stores watches
under stable IDs, so repeated runs update existing records.

The feed contains only recent activity and cannot retrieve older pages. Run
syncs regularly to accumulate history. Increasing `limit` cannot recover entries
that have left the feed.

## Inspect data

Use `swamp data list letterboxd` to find entries, then
`swamp data get letterboxd <data-name>` to read one.

## License

MIT — see [LICENSE.md](LICENSE.md).
