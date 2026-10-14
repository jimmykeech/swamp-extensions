# @jamesakeech/gitlab-work-items

Create, read, update, and delete GitLab project issues, tasks, and incidents.
Manage labels, state, and direct parent relationships. Reads preserve Markdown
descriptions and report pagination status.

## Setup

Store a GitLab token in a vault, then create the model:

```sh
swamp extension pull @jamesakeech/gitlab-work-items
swamp vault create local_encryption gitlab
swamp vault put gitlab TOKEN
swamp model create @jamesakeech/gitlab-work-items gitlab-reader \
  --global-arg host=gitlab.example.com \
  --global-arg 'token=${{ vault.get("gitlab", "TOKEN") }}'
swamp model method run gitlab-reader list_work_items \
  --input project=group/project --input type=task
swamp model method run gitlab-reader get_work_item \
  --input project=group/project --input iid=42
```

`host` must be an HTTPS hostname with an optional port, without a scheme or
path. Subpath installations are unsupported. Reads require `read_api` or `api`
token scope. Writes require `api` and a project role allowed to perform the
operation.

For a local checkout, replace the pull command with
`swamp extension source add /path/to/swamp-extensions/gitlab-work-items`.

## Methods

All methods require `project`, such as `group/project`. Methods targeting an
existing item also require its project-scoped `iid`.

| Method                    | Arguments and result                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `list_work_items`         | List items with optional type, state, and label filters.                |
| `get_work_item`           | Read one item and its optional parent/child hierarchy.                  |
| `create_work_item`        | Required `title`; optional `type`, `description`, and `labels`.         |
| `update_work_item`        | Change `title`, `description`, `state`, `addLabels`, or `removeLabels`. |
| `update_work_item_labels` | Apply `addLabels` and `removeLabels` arrays.                            |
| `close_work_item`         | Close an item; optionally apply label changes.                          |
| `reopen_work_item`        | Reopen an item; optionally apply label changes.                         |
| `set_work_item_parent`    | Set `parentIid` within the same project, or `null` to unlink.           |
| `delete_work_item`        | Permanently delete an item; requires its global `expectedId`.           |

Creation defaults to `type=issue`; `task` and `incident` are also supported.
Creation and parent linking are separate calls. Updates preserve omitted fields;
an empty description clears it. Type conversion is unsupported.

## Filters and pagination

`list_work_items` accepts:

- `type`: `all` (default), `issue`, `task`, or `incident`.
- `state`: `all` (default), `opened`, or `closed`.
- `labels`: array of required label names; all must match.
- `page`: starting page, default `1`.
- `perPage`: page size, default `100`, range `1–100`.
- `maxPages`: request limit, default `10`, range `1–100`.

Check `pagination.complete`. If false, resume from `nextPage` with the same
filters and page size, then combine the results. `type=all` includes types
returned by the Issues API; it does not list all GitLab work-item types or
epics.

`get_work_item` accepts `includeHierarchy` (default `true`), `perPage` and
`maxPages` with the same defaults, and an `after` cursor. Hierarchy status is:

- `available`: direct parent and children, with `complete` and `nextCursor`.
  Resume incomplete results with `after=nextCursor` and combine children.
- `unavailable`: the required GraphQL widget is absent; this is not an empty
  hierarchy.
- `not-requested`: hierarchy was disabled.

Pagination completion is not an atomic snapshot. Visibility depends on token
permissions. Links and descendants beyond direct children are not traversed.

## Write behavior

- Description writes reject possible GitLab quick-action lines, including inside
  fenced code blocks. Use inline code for literal commands such as `/close`.
- Label changes preserve unrelated labels. Names must be unique, nonblank, and
  contain no commas or newlines. Do not add and remove the same label in one
  call. Unknown added names can create project labels.
- Updates and parent changes accept optional `expectedId` to verify the global
  ID before writing. This does not prevent concurrent edits.
- Deletion requires `expectedId` and sends the target's `updated_at` as
  `If-Unmodified-Since`. HTTP 412 stops deletion; only HTTP 204 confirms
  success. Use closure to retain history.
- Requests time out after 15 seconds and do not follow redirects or retry. After
  an uncertain write result, inspect GitLab before retrying: the write may have
  succeeded. Repeating creation can produce duplicates. A failed local result
  write cannot roll back a GitLab change.

## Data

Reads return `workItems` or `workItem`. Writes return `workItemMutation`,
`workItemParent`, or `workItemDeletion`. Use the returned data handles; writes
do not refresh earlier read snapshots. Resources expire after one hour and
retain ten versions.

## Development

Run from this extension's directory:

```sh
DENO_TLS_CA_STORE=mozilla ~/.swamp/deno/deno test --no-config --node-modules-dir=none client_test.ts client_mutations_test.ts model_test.ts
DENO_TLS_CA_STORE=mozilla ~/.swamp/deno/deno check --no-config --node-modules-dir=none model.ts
```

Tests mock HTTP requests. Live write tests require an approved disposable
target.

## License

MIT — see [LICENSE.md](LICENSE.md).
