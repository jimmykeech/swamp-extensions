# @jamesakeech/forgejo-code

Read files and snapshot code from Forgejo or Gitea repositories. Extends
[`@shrug/forgejo`](https://github.com/shrugpw/swamp-forgejo) and reuses its
`host` and `token` arguments. All methods are read-only.

## Install

```sh
swamp extension pull @jamesakeech/forgejo-code
```

## Methods

All methods require `owner` and `repo`. The optional `ref` accepts a branch,
tag, or commit SHA and defaults to `HEAD`.

| Method          | Result                                               | Additional arguments                          |
| --------------- | ---------------------------------------------------- | --------------------------------------------- |
| `list_tree`     | Recursive file inventory with paths, sizes, and SHAs | `max_entries` (default 5000)                  |
| `get_file`      | One file's contents                                  | Required `path`; `max_bytes` (default 500000) |
| `snapshot_code` | Matching text files in one `codebase` record         | Filters and limits below                      |

Run these methods on an existing `@shrug/forgejo` model:

```bash
swamp model method run forgejo list_tree --input owner=me --input repo=homelab
swamp model method run forgejo get_file \
  --input owner=me --input repo=homelab --input path=README.md
swamp model method run forgejo snapshot_code \
  --input owner=me --input repo=homelab --input include='["**/*.tf","**/*.tfvars"]'
```

## Snapshot filters and limits

`include` defaults to `["**"]`. `exclude` adds patterns to built-in exclusions
for VCS files, vendor directories, lockfiles, Terraform state, and binary
formats. Set `no_default_excludes=true` to disable the built-in exclusions. `**`
matches across directories; `*` and `?` do not.

Snapshots read smaller files first. Defaults are 400 files (`max_files`), 131072
bytes per file (`max_file_bytes`), and 4000000 bytes total (`max_total_bytes`).
Check `skipped` for omitted files and `truncated` for incomplete snapshots.

## Data

```text
data.latest("forgejo", "tree__owner__repo").attributes.entries
data.latest("forgejo", "code__owner__repo").attributes.files
data.latest("forgejo", "file__owner__repo__terraform_main.tf").attributes.content
```

## Limitations

- Snapshots capture one ref. To review changes, capture and compare both refs.
- Binary detection checks for NUL bytes in the first 8 KiB.
- HTTP 429 responses fail the run; there is no rate-limit retry.

## License

MIT — see [LICENSE.md](LICENSE.md).
