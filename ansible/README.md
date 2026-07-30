# @jamesakeech/ansible

Run an existing Ansible playbook as a swamp model method.

This is deliberately not a replacement for Ansible. Roles, plays, templates and
vars stay exactly where they are; what this adds is a typed, CEL-referenceable
step so provisioning a machine and converging it can live in one workflow DAG
instead of two systems joined by a shell script.

## Methods

| Method | Behaviour |
| --- | --- |
| `check` | `ansible-playbook --check --diff`. Never mutates. |
| `apply` | Runs the playbook for real. |

Both parse the `PLAY RECAP` into per-host tallies and derive a single status:

| Status | Meaning |
| --- | --- |
| `compliant` | check mode, `changed=0` everywhere — the host already matches |
| `drift` | check mode, something would change |
| `unchanged` | apply mode, nothing needed doing |
| `applied` | apply mode, changes were made |
| `failed` | any host failed or was unreachable, or a non-zero exit |

`compliant` is the useful one. It is a machine-readable answer to *"does this
host already match its declaration?"*, which makes it a gate for safely adopting
a machine that was built by hand — run `check`, require `compliant`, and only
then trust the definition.

A `failed` status **throws**, so the workflow step fails rather than letting a
DAG proceed as if an unconverged host were ready.

## Data

```
data.latest("site", "run-check-ansible-site.yml").attributes.status
data.latest("site", "run-apply-ansible-site.yml").attributes.totals.changed
data.latest("site", "run-check-ansible-site.yml").attributes.hosts
```

`hosts` is an array of `{ host, ok, changed, unreachable, failed, skipped,
rescued, ignored }` — per-host, so a workflow can react to one bad host rather
than a single boolean.

## Inventory from model data

`inventoryContent` takes an inventory as a string, written to a temp file for the
run. That lets a workflow build inventory from whatever swamp already knows —
addresses discovered by a hypervisor model, say — rather than shelling out to a
script that scrapes `tofu output`:

```yaml
- model: '@jamesakeech/ansible'
  method: check
  inputs:
    inventoryContent: |
      all:
        hosts:
          cwa01:
            ansible_host: 10.10.120.146
```

Use `inventoryPath` instead when a checked-in inventory file is what you want.

## Secrets

`vaultPassword` and `becomePassword` are marked sensitive and are **never placed
in argv**, because argv is readable by any local user via the process list:

- `vaultPassword` → a `0600` temp file passed to `--vault-password-file`
- `becomePassword` → injected as `ansible_become_password` in a `0600` extra-vars
  file passed as `-e @file`

Both live in a `0700` temp directory removed in a `finally`, so an exception
mid-run does not leave secrets behind. There is a test asserting the cleanup
actually happens.

## Quickstart

```bash
swamp vault put homelab ansible-vault-password
swamp vault put homelab sudo-password

swamp model create @jamesakeech/ansible site \
  --global-arg workdir=/srv/infra-cwa \
  --global-arg playbook=ansible/site.yml \
  --global-arg inventoryPath=ansible/inventory.yml \
  --global-arg remoteUser=jamesk \
  --global-arg privateKeyPath=/root/.ssh/id_ed25519 \
  --global-arg vaultPassword='${{ vault.get(homelab, ansible-vault-password) }}' \
  --global-arg becomePassword='${{ vault.get(homelab, sudo-password) }}'

swamp model method run site check
swamp model method run site check --arg limit=cwa01
swamp model method run site apply --arg tags='["docker"]'
```

## Pre-flight

The `playbook-present` check verifies the playbook exists under `workdir` and
that `ansibleBin --version` succeeds, so a typo in a path fails before any host
is contacted.

## Requirements

`ansible-playbook` must be on the swamp host — this shells out to it rather than
reimplementing anything. On a `swamp serve` host that means installing Ansible,
making the playbook source available, and providing an SSH key the managed hosts
authorise.

## Known limitations

- Status comes from the `PLAY RECAP`, so a playbook that never reaches a recap
  (syntax error, missing inventory) reports `failed` with the stderr tail rather
  than a structured per-task explanation.
- `stdoutTail` keeps the last 64 KiB; a chatty playbook loses its earlier output.
  Raise verbosity only when needed.
- No streaming — output is captured and returned when the run ends. Long plays
  look silent until they finish.
- `timeoutSec` sends `SIGTERM`; a wedged SSH child may outlive it.
- Ansible's own idempotency determines whether `check` is trustworthy. A play
  using `command`/`shell` without `changed_when` will report drift forever.
