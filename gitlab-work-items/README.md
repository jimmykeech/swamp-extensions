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

## Delivery integration

> The delivery methods below are available in the published package. Their
> implementation is not present in this GitHub checkout. Pull the package to use
> them; registering this checkout provides only the work-item methods above.

The published package includes the following additional methods. Inspect their
full schemas with:

```sh
swamp model type describe @jamesakeech/gitlab-work-items --json
```

| Method                   | Purpose                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `get_project_settings`   | Read canonical project identity, default branch, and auto-close settings. |
| `get_merge_request`      | Read an MR's identity, source/result SHAs, and visible pipeline.          |
| `merge_merge_request`    | Merge an exact source SHA or reconcile a previous attempt.                |
| `list_notes`             | Read work-item or MR notes with pagination status.                        |
| `create_note`            | Create or reconcile a note using a content-bound key.                     |
| `inspect_delivery`       | Read the item, requirements digest, and auto-close setting.               |
| `record_triage`          | Record an explicit human decision and apply triage labels.                |
| `sync_factory_stage`     | Apply the native factory stage and effective lane labels.                 |
| `prepare_delivery`       | Freeze the reviewed source, MR, verification, and requirements subject.   |
| `publish_merge_approval` | Publish the exact native decision on the MR and link the item.            |
| `merge_approved`         | Merge the approved SHA and confirm the result.                            |
| `complete_delivery`      | Validate shipment evidence, record completion, and confirm closure.       |
| `reopen_delivery`        | Invalidate the prior subject, record rollback, and reopen the item.       |

Direct merge calls require `project`, MR `iid`, global `expectedId`, and
`expectedSourceSha`. Set `mode=reconcile` after an uncertain write to read back
state without another merge request. Note calls use `kind=work_item` or
`kind=merge_request`. Creation requires `expectedId`, `body`, and a stable
`reconciliationKey`; `mode=reconcile` does not post again. Incomplete note scans
block creation and confirmation. Increase `maxPages` when needed.

### Factory setup and approval

The package depends on `@jamesakeech/bootstrap` and `@swamp/software-factory`.
Factory delivery requires a matching Bootstrap delivery implementation;
installing Bootstrap alone does not establish compatibility. Use an accepted
configuration with `factory.delivery` set to
`{"mode":"codex","modelName":"<model-name>"}`.

Use one pinned coordinator model for each item's journals. Per-model locking
does not protect against independent writers. Use the bare GitLab hostname and
canonical project path. Tracker scope is `<host>/<project>` and its reference is
the decimal IID. Factory mutations require the expected global item ID;
factory-linked calls also require the Bootstrap controller name and opaque
`workItem` key. That key is not the GitLab IID.

Triage requires the current requirements digest, human actor, original decision
reference, timestamp, lane, and reason. Labels do not establish human approval.
After review, `prepare_delivery` checks committed Git HEAD and accepted source
inventory and returns `approvalNote`. Present the subject and evidence to the
human, then pass the exact note to the native `delivery-approval` decision.
Publish its original `decisionReference`, advance the native `deliver`
transition, and call `merge_approved`. A renewed decision requires renewed
publication.

### Evidence, retries, and rollback

`complete_delivery` validates explicit attestations and reads GitLab merge and
closure state. It does not deploy services or independently verify deployment
claims. Application receipts must cover the approved services, resulting merged
SHA, active deployment IDs, release journals, and passing readiness and behavior
checks. Repository-only receipts require passed source checks and a
no-deployment reason. Parents require their own acceptance evidence, all current
direct children closed, and a receipt reference per child. Incidents also
require recovery evidence.

Coordinator writes persist intent first. After failure, retry the same method
and inputs. Once dispatch has an unknown outcome, only read reconciliation is
allowed. An unresolved operation cannot produce a shipment receipt. Inspect the
operation record and provider state; do not erase journals or redeploy to repair
tracker state.

Rollback invalidates the approved subject before tracker writes. A pending
success receipt becomes failure; a terminal shipped run stays historical.
Recovery needs fresh reviewed work and approval, with a linked follow-up
reservation when the original run is terminal. Old shipment evidence cannot
close the reopened item.

Delivery read/write resources retain data for 90 days. `factoryDelivery`
journals have infinite lifetime and retain 20 versions per instance. They are
local records: export native run evidence before repository loss.

## License

MIT — see [LICENSE.md](LICENSE.md).
