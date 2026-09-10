# @jamesakeech/gitlab-work-items

Create, read, update, and delete GitLab project issues, tasks, and incidents.
Manage their labels, open/closed state, and direct parent relationships. Reads
preserve full Markdown descriptions, actual types, and pagination status.

This generic Swamp model accepts the GitLab host and project as arguments. It
does not require a specific description template or software factory.

## Install and use

Install the package, then create and run a model:

```sh
swamp extension pull @jamesakeech/gitlab-work-items
swamp model create @jamesakeech/gitlab-work-items gitlab-reader \
  --global-arg host=gitlab.example.com \
  --global-arg 'token=${{ vault.get("gitlab", "TOKEN") }}'
swamp model method run gitlab-reader list_work_items \
  --input project=group/project --input type=task
swamp model method run gitlab-reader get_work_item \
  --input project=group/project --input iid=42
```

Create the `gitlab` vault and store its `TOKEN` secret before running the
methods. To use an unpublished checkout, register the `gitlab-work-items`
directory with
`swamp extension source add /path/to/swamp-extensions/gitlab-work-items` in your
Swamp repository instead of pulling from the registry.

## Methods

| Method                    | Result                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `list_work_items`         | Work items with types, descriptions, labels, URLs, state, timestamps, and explicit pagination status. |
| `get_work_item`           | One work item's full details and optional parent/child hierarchy.                                     |
| `create_work_item`        | Create an issue, task or incident.                                                                    |
| `update_work_item`        | Update title, description, state and label deltas in one request.                                     |
| `update_work_item_labels` | Add/remove specific labels while preserving other labels.                                             |
| `close_work_item`         | Close an item and optionally update labels in the same request.                                       |
| `reopen_work_item`        | Reopen an item and optionally update labels in the same request.                                      |
| `set_work_item_parent`    | Link to a parent in the same project, or remove the parent.                                           |
| `delete_work_item`        | Permanently delete a work item after checking its global ID.                                          |

CRUD uses the REST Issues API. Hierarchy reads and parent updates use GraphQL.
Item creation and parent linking are separate operations, each with its own
result. An existing item can be linked after creation without repeating
creation.

## Configuration

Global arguments:

- `host`: HTTPS hostname, with an optional port; for example
  `gitlab.example.com`. Do not include a scheme or path. Subpath installations
  are not supported.
- `token`: a sensitive Swamp vault reference. Reads require `read_api` or `api`;
  mutations require `api` and a project role permitted to perform the operation.
  A project access token can limit access to one project. Deletion permissions
  depend on the GitLab version, role and item ownership; GitLab enforces them.

The client rejects redirects and bounds each HTTP request to 15 seconds. It
fails on HTTP or GraphQL errors, including rate limits. It does not
automatically retry. Errors retain HTTP status codes and omit provider response
bodies and transport details that could contain secrets.

## Arguments

All methods require `project`, such as `group/project`.

`list_work_items` accepts:

- `type`: `all` (default), `issue`, `task`, or `incident`.
- `state`: `all` (default), `opened`, or `closed`.
- `page`: starting page; default `1`.
- `perPage`: records per page, from `1` to `100`; default `100`.
- `maxPages`: request limit, from `1` to `100`; default `10`.
- `labels`: optional array of required label names; all must match.

`get_work_item` requires the project-scoped numeric `iid`. It also accepts:

- `includeHierarchy`: default `true`.
- `perPage`: children per page, from `1` to `100`; default `100`.
- `maxPages`: hierarchy request limit, from `1` to `100`; default `10`.
- `after`: resume from a previously returned hierarchy `nextCursor`.

Null descriptions become empty strings. Other Markdown text is returned
unchanged. The `all` filter preserves other issue types returned by GitLab; it
is not an inventory of every possible GitLab work-item type, such as epics.

### Mutation arguments

`create_work_item` requires `title`. It accepts `type` (`issue` by default,
`task`, or `incident`), `description`, and an initial `labels` array.

Updates require the project-scoped `iid`. `update_work_item` accepts `title`,
`description`, `state` (`opened` or `closed`), `addLabels`, and `removeLabels`.
An empty description clears the description. Omitted fields remain unchanged. At
least one change is required. Item type conversion is not exposed.

Description writes reject lines that look like GitLab quick actions, such as
`/close` or `/relabel`, before any request. This prevents content edits from
executing additional commands. The check is conservative and also rejects such
lines inside fenced code blocks; use inline code for literal command examples.

`update_work_item_labels` accepts `addLabels` and `removeLabels` arrays.
`close_work_item` and `reopen_work_item` accept the same optional label arrays.
Label deltas use GitLab's `add_labels` and `remove_labels`; they do not replace
the whole label set. Unknown added names can create project labels. Label names
must be unique, nonblank, and contain no commas or newlines. The same label
cannot be added and removed in one request. Use the exact label names returned
by GitLab. A mutation is acknowledged only when the response contains the
requested additions and excludes the removals.

Updates and parent changes accept an optional `expectedId`, the global numeric
ID returned by a previous read. When supplied, the client checks the target
before writing. This identity check does not lock the item against concurrent
edits. GitLab's update API provides no general compare-and-swap guarantee here.

`set_work_item_parent` requires `iid` and `parentIid`. Set `parentIid` to the
parent's IID, or `null` to unlink. The client resolves actual global IDs from
the project and checks the relationship returned by GitLab. It does not move
items across projects or recursively change descendants.

`delete_work_item` requires `iid` and `expectedId`. It reads the target first,
checks its global ID, and sends its exact `updated_at` value as
`If-Unmodified-Since`. A `412` precondition failure stops deletion. This check
does not provide a transaction lock. Only GitLab's `204` acknowledgement
produces a successful deletion result; `404` does not prove deletion because
access can also affect visibility. Use closure to retain completed work and its
history.

### Factory lifecycle example

Label names are caller-defined. A factory can use the following policy:

1. A human reviews the outcome, scope, acceptance criteria, constraints and
   verification plan. Record that human approval in the factory.
2. Apply `triaged` only after that decision. Require the recorded approval
   before the factory starts work; a label alone is not proof of human approval.
3. As stages advance, add the current stage label and remove the factory's prior
   stage labels. Preserve `triaged` and unrelated project labels.
4. After completion and shipment verification, close the item and add a shipped
   label in the same request. A merged PR alone does not establish shipment.

These are factory rules. The generic extension executes explicit item
operations; it does not grant human approval or infer that a deployment
succeeded.

```sh
# After recorded human approval:
swamp model method run gitlab-reader update_work_item_labels \
  --input project=group/project --input iid=42 \
  --input 'addLabels=["triaged"]'

# Advance the factory while preserving other labels:
swamp model method run gitlab-reader update_work_item_labels \
  --input project=group/project --input iid=42 \
  --input 'addLabels=["factory:review"]' \
  --input 'removeLabels=["factory:planning","factory:building"]'

# After completion and verified shipment:
swamp model method run gitlab-reader close_work_item \
  --input project=group/project --input iid=42 \
  --input 'addLabels=["factory:shipped"]' \
  --input 'removeLabels=["factory:review","factory:verification"]'
```

These ordinary labels work without GitLab's paid scoped-label exclusivity.
Callers remove obsolete stage labels explicitly.

### Mutation failures and retries

Mutations do not retry automatically. Create is not an exactly-once operation.
If a write times out, returns a server error, or has an unreadable success
response, it may already have taken effect. Inspect the item or list results
before deciding whether to retry. In particular, repeating create can create a
duplicate. Swamp cannot roll back a GitLab write if storing its result later
fails.

## Completeness and relationships

List resources contain `pagination.complete`, `nextPage`, and `pagesFetched`.
When incomplete, repeat the request with the returned `nextPage`, keeping the
same filters and page size, and combine the results.

Detail resources distinguish three hierarchy states:

- `available`: contains `parent`, `children`, `complete`, `nextCursor`, and
  `pagesFetched`. An empty hierarchy is valid only in this state.
- `unavailable`: GitLab did not expose the required hierarchy widget. It
  includes a reason. Do not interpret this as an empty hierarchy.
- `not-requested`: `includeHierarchy` was false.

When hierarchy is available but incomplete, repeat the detail request with
`after` set to `nextCursor`, keeping the same project, IID, and page size.
Combine the children returned by each call.

`complete` means pagination finished from the requested page or cursor. It does
not establish an atomic snapshot. Records can change between requests, and
visibility depends on the token's permissions. Only direct parent/child
relationships are returned; links and arbitrary descendants are not traversed.

Read resources are `workItems` and `workItem`. Mutations return
`workItemMutation`, `workItemParent`, or `workItemDeletion`. Use each method's
returned data handles for its current result; earlier read snapshots are not
automatically rewritten after a mutation. Instance names use hashes of the
target or query identity. Resources expire after one hour and retain ten
versions. They include observation timestamps and duration, and never the token.

## Local verification

```sh
# Run from this extension's directory.
DENO_TLS_CA_STORE=mozilla ~/.swamp/deno/deno test --no-config --node-modules-dir=none client_test.ts client_mutations_test.ts model_test.ts
DENO_TLS_CA_STORE=mozilla ~/.swamp/deno/deno check --no-config --node-modules-dir=none model.ts
```

Tests mock HTTP requests and use synthetic fixtures, including the CRUD and
label/state paths. Live read validation uses native methods in an isolated Swamp
repository with an encrypted vault. Live writes require an explicitly approved
disposable target and an API token with write access.

## API references

- [GitLab Issues API](https://docs.gitlab.com/api/issues/)
- [GitLab GraphQL API](https://docs.gitlab.com/api/graphql/)
- [GitLab token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)
- [GitLab labels](https://docs.gitlab.com/user/project/labels/#scoped-labels)
- [GitLab permissions](https://docs.gitlab.com/user/permissions/#project-planning)
- [GitLab quick actions](https://docs.gitlab.com/user/project/quick_actions/)
