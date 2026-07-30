# @jamesakeech/forgejo-code

Code-reading methods for the [`@shrug/forgejo`](https://github.com/shrugpw/swamp-forgejo)
model type. The base type covers a forge's *metadata* — repositories, issues,
pull requests, releases — but has no way to read what is actually committed.
This extension adds that, so a Forgejo or Gitea repository becomes a source
swamp can review, diff, and reason about.

No new global arguments: it reuses the `host` and `token` already configured on
the `@shrug/forgejo` model.

## Methods

- **list_tree** — recursive file inventory for a repo at a ref (path, type,
  size, blob SHA). Cheap. Run this first to see what a repo holds before pulling
  content.
- **get_file** — read one file's contents by path.
- **snapshot_code** — fan-out: walk the tree, filter by glob, and read every
  matching text file into a single `codebase` snapshot. One method run, one lock
  acquisition, one reviewable blob.

## Data

```
data.latest("forgejo", "tree__owner__repo").attributes.entries
data.latest("forgejo", "code__owner__repo").attributes.files
data.latest("forgejo", "file__owner__repo__terraform_main.tf").attributes.content
```

Instance names are prefixed per spec because instance names map directly to
storage paths — an unprefixed `owner__repo` would overwrite the base model's
`repo`/`issues` snapshots.

## Filtering

`snapshot_code` applies `include` globs (default `**`), then `exclude` globs on
top of a built-in list covering VCS internals, vendored trees, lockfiles,
Terraform state, and binary formats. `**` crosses `/`; `*` and `?` do not.

```bash
# Everything reviewable
swamp model method run forgejo snapshot_code --arg owner=me --arg repo=homelab

# Just the Terraform, including state files the defaults exclude
swamp model method run forgejo snapshot_code \
  --arg owner=me --arg repo=homelab \
  --arg include='["**/*.tf","**/*.tfvars"]'
```

## Caps

A snapshot is bounded on three axes so a large repo can't produce an unusable
data version: `max_files` (400), `max_file_bytes` (128 KiB, truncates), and
`max_total_bytes` (4 MB, stops). Files are read smallest-first, so a
budget-constrained run yields more files rather than fewer large ones. Anything
not read is listed in `skipped` with a reason (`excluded`, `not_included`,
`too_large`, `binary`, `missing`), and `truncated` is `true` when a cap bit.

## Known limitations

- Read-only. No commit, branch, or PR-writing paths.
- No rate-limit backoff — a `429` throws, same as the base type.
- Binary detection is a NUL-byte scan of the first 8 KiB, not content sniffing.
- `snapshot_code` reads a ref, not a diff; reviewing a change means snapshotting
  both refs and comparing.
