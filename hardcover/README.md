# @jamesakeech/hardcover

Read a user's [Hardcover](https://hardcover.app) profile, tracked books, and
reading sessions through its GraphQL API. All methods are read-only.

## Install

```sh
swamp extension pull @jamesakeech/hardcover
```

## Setup

Get a token from **Account settings → Hardcover API**, then store it in a vault.
The leading `Bearer` prefix is optional.

```bash
swamp vault create local_encryption hardcover
swamp vault put hardcover HARDCOVER_API_TOKEN
swamp model create @jamesakeech/hardcover hardcover \
  --global-arg apiToken='${{ vault.get("hardcover", "HARDCOVER_API_TOKEN") }}'
```

## Methods

| Method       | Result                                                                    | Optional arguments     |
| ------------ | ------------------------------------------------------------------------- | ---------------------- |
| `whoami`     | One `profile` with user details and book count                            | None                   |
| `sync_books` | One `book` per library entry, with shelf, rating, authors, and read dates | `statusId`, `maxBooks` |
| `sync_reads` | One `read` per reading session, with dates and page or audiobook progress | `maxReads`             |

```bash
swamp model method run hardcover whoami
swamp model method run hardcover sync_books
swamp model method run hardcover sync_reads
```

`statusId` filters books by shelf: `1` Want to Read, `2` Currently Reading, `3`
Read, or `5` Did Not Finish. Omit limits to sync all books or reads.

Each sync fetches the selected history and updates records by Hardcover ID.
Schedule syncs to keep the local data current. If authentication fails, refresh
the token in the vault.

## Inspect data

Use `swamp data list hardcover` to find records, then
`swamp data get hardcover <data-name>` to read one.

## License

MIT — see [LICENSE.md](LICENSE.md).
