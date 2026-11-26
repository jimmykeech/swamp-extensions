# @jamesakeech/ansible

Run existing Ansible playbooks from swamp. Each run records a status and
per-host `PLAY RECAP` totals for use in workflows.

## Install

```sh
swamp extension pull @jamesakeech/ansible
```

## Setup

Install `ansible-playbook` on the machine running swamp. Make the playbook,
inventory, roles, and SSH credentials available there.

```sh
swamp model create @jamesakeech/ansible site \
  --global-arg workdir=/srv/infra \
  --global-arg playbook=ansible/site.yml \
  --global-arg inventoryPath=ansible/inventory.yml \
  --global-arg remoteUser=admin \
  --global-arg privateKeyPath=/home/admin/.ssh/id_ed25519

swamp model method run site check
swamp model method run site check --input limit=web01
swamp model method run site apply --input tags='["docker"]'
```

`workdir` and `playbook` are required. Playbook and inventory paths are relative
to `workdir`. Set `ansibleBin` to use a different executable. The
`playbook-present` check verifies the playbook and executable before a run.

Use `inventoryContent` as a method input to supply YAML or INI inventory,
including inventory built from model data. It overrides `inventoryPath` for that
run.

## Methods and results

| Method  | Action                                                 |
| ------- | ------------------------------------------------------ |
| `check` | Run `ansible-playbook --check --diff` to detect drift. |
| `apply` | Run the playbook to apply changes.                     |

Both methods accept `limit`, `tags`, `skipTags`, `extraVars`,
`inventoryContent`, `verbosity` (0–4), and `timeoutSec` (default 1800; maximum
21600).

| Status      | Meaning                                                |
| ----------- | ------------------------------------------------------ |
| `compliant` | Check mode reported no changes.                        |
| `drift`     | Check mode reported changes.                           |
| `unchanged` | Apply mode made no changes.                            |
| `applied`   | Apply mode made changes.                               |
| `failed`    | A host failed, was unreachable, or the command failed. |

A failed run records its result and then throws, which fails the workflow step.
Results include `hosts`, aggregate `totals`, and output tails. For example:

```cel
data.latest("site", "run-check-ansible-site.yml").attributes.status
data.latest("site", "run-apply-ansible-site.yml").attributes.totals.changed
```

## Secrets

Supply `vaultPassword`, `becomePassword`, and `privateKey` through vault
expressions. These values go into temporary files with mode `0600`, inside a
`0700` directory removed after the run. Secret values are not passed in command
arguments. `privateKey` takes precedence over `privateKeyPath`.

Captured output redacts these secrets only when they contain at least six
characters. Shorter values and secrets supplied through other inputs are not
covered by this redaction.

## Limitations

- Check mode depends on the playbook's check-mode support and idempotency. Tasks
  that explicitly disable check mode can still make changes.
- Runs without a `PLAY RECAP` have no per-host details. The exit code alone
  determines `unchanged` or `failed`.
- Output is returned after completion. `stdoutTail` retains the last 64 KiB.
- Timeout sends `SIGTERM`; an SSH child process can outlive the timeout.

## License

[MIT](LICENSE.md).
