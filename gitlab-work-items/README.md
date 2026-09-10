# @jamesakeech/gitlab-work-items

Read GitLab project issues, tasks, and incidents for work-item intake. Preserve
their full Markdown descriptions and actual types. Retrieve parent and child
references through the work-item hierarchy API.

This generic Swamp model accepts the GitLab host and project as arguments. It
does not require a specific description template or software factory.

## Install and use

The initial package is prepared for publication. After it is published:

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

Create the `gitlab` vault and store its `TOKEN` secret before running the methods.
To use an unpublished checkout, register the `gitlab-work-items` directory with
`swamp extension source add /path/to/swamp-extensions/gitlab-work-items` in your
Swamp repository instead of pulling from the registry.

## Methods

| Method            | Result                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `list_work_items` | Work items with types, descriptions, labels, URLs, state, timestamps, and explicit pagination status. |
| `get_work_item`   | One work item's full details and optional parent/child hierarchy.                                     |

Both methods are read-only. They use the REST Issues API for details and types.
Hierarchy uses a GraphQL query. No GraphQL mutations or tracker writes are
exposed.

## Configuration

Global arguments:

- `host`: HTTPS hostname, with an optional port; for example
  `gitlab.example.com`. Do not include a scheme or path. Subpath installations
  are not supported.
- `token`: a sensitive Swamp vault reference to a token with GitLab API read
  access to the project. For a personal access token, use `read_api`.

The reader rejects redirects and bounds each HTTP request to 15 seconds. It
fails on HTTP or GraphQL errors, including rate limits. It does not
automatically retry. Errors retain HTTP status codes and omit provider response
bodies and transport details that could contain secrets.

## Arguments

Both methods require `project`, such as `group/project`.

`list_work_items` accepts:

- `type`: `all` (default), `issue`, `task`, or `incident`.
- `state`: `all` (default), `opened`, or `closed`.
- `page`: starting page; default `1`.
- `perPage`: records per page, from `1` to `100`; default `100`.
- `maxPages`: request limit, from `1` to `100`; default `10`.

`get_work_item` requires the project-scoped numeric `iid`. It also accepts:

- `includeHierarchy`: default `true`.
- `perPage`: children per page, from `1` to `100`; default `100`.
- `maxPages`: hierarchy request limit, from `1` to `100`; default `10`.
- `after`: resume from a previously returned hierarchy `nextCursor`.

Null descriptions become empty strings. Other Markdown text is returned
unchanged. The `all` filter preserves other issue types returned by GitLab; it
is not an inventory of every possible GitLab work-item type, such as epics.

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

The two native resource schemas are `workItems` and `workItem`. Instance names
use a hash of the query identity. Use the returned data handles to find outputs.
Resources expire after one hour and retain ten versions. Each resource includes
the request parameters, fetch timestamp, and duration; it never includes the
token.

## Local verification

```sh
# Run from this extension's directory.
DENO_TLS_CA_STORE=mozilla ~/.swamp/deno/deno test --no-config --node-modules-dir=none client_test.ts
DENO_TLS_CA_STORE=mozilla ~/.swamp/deno/deno check --no-config --node-modules-dir=none model.ts
```

Tests mock HTTP requests and use synthetic fixtures. Live validation uses the
native methods in an isolated Swamp repository with an encrypted vault.

## API references

- [GitLab Issues API](https://docs.gitlab.com/api/issues/)
- [GitLab GraphQL API](https://docs.gitlab.com/api/graphql/)
- [GitLab token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)
