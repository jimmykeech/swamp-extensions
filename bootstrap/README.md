# @jamesakeech/bootstrap

Bootstrap a project for any agent with native Swamp integration, including
Claude, Pi, and Codex. Create an accepted architecture control plane and one
Swamp software-factory instance per work item.

The agent designs the project and writes its documents. The extension snapshots
the accepted configuration, prepares isolated factory definitions, and checks
that verification evidence matches the work item's baseline and source digest.
It reuses `@swamp/software-factory`; it does not implement another factory
engine.

## Install and use

Use the project's selected agent and its native Swamp skills. Check the
installed CLI before initializing a new repository:

```sh
swamp help repo init
```

If `.swamp.yaml` is absent, run the following inside the project repository.
Replace `<selected-tool>` with the chosen tool ID, such as `claude`, `pi`, or
`codex`, when supported by the installed CLI:

```sh
swamp repo init --tool <selected-tool>
swamp extension pull @jamesakeech/bootstrap
```

Swamp supports built-in integrations and configured custom tools. Its
[`tools` configuration](https://swamp-club.com/manual/reference/repository-configuration#tools)
controls native instruction and skill locations. Current Swamp documentation
includes [Pi integration](https://swamp-club.com/manual/how-to/ai-agents/pi),
but older CLIs may not include it. Bootstrap does not install or upgrade the
agent or Swamp itself.

For an existing Swamp repository, keep its current tool enrollments. Pull the
extension without reinitializing. If another integration is needed, inspect
`swamp help repo upgrade` and preserve the full existing tool list and its order
when adding it. Do not use forced reinitialization. Verify that the active agent
can load both bundled skills from its native skill location.

Then select the `bootstrap` skill using your agent's native skill mechanism, or
ask:

> Use the bootstrap skill to configure this project for agentic coding with
> Swamp factories.

The bundled skill conducts the design conversation, uses the personal working
profile, and guides validation and explicit baseline acceptance. It installs and
configures suitable existing runner extensions for the project's real checks. It
also writes a Git-owned `docs/bootstrap/baseline.json` acceptance pointer and a
separate validation transcript. These are not inputs to their own baseline
digest.

The default project configuration is `docs/bootstrap/project.json`. See the
[configuration reference](.agents/skills/bootstrap/references/project-spec.md)
for the required seven document roles and a complete Deno example. See the
[working profile](.agents/skills/bootstrap/references/personal-policy.md) for
the starting policy. Architecture and language choices remain project-specific.

`agentTool` records the baseline's chosen default agent. It does not restrict
which Swamp-integrated agent can drive a factory. Instruction and skill paths
come from the project's actual native setup, not a fixed `AGENTS.md` or
`.agents/skills` layout. Bootstrap validates the listed project files; Swamp and
the agent remain responsible for native integration and skill discovery.

## Lifecycle

```text
Project: inspect → design → check → validate preview → accept → readiness
Item:    intake → create/validate/bind definitions → activate → start or resume
Factory: import context → plan → review → implement → verify → review → ready
                                      ↑ bounded rework ───────────────┘
```

Each item receives a distinct factory model, verification workflow, and
check-model names. Shared configuration lives in accepted templates, not shared
execution instances. A single `swamp serve` can expose these definitions; this
extension does not start or configure a server.

## Controller methods

Create one controller with
`swamp model create @jamesakeech/bootstrap project-bootstrap`. Its optional
`globalArguments.specPath` selects the project JSON file.

| Method                                    | Purpose                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `inspect`                                 | Inspect bootstrap entry points without editing project files.                   |
| `check`                                   | Capture and structurally validate a complete candidate baseline.                |
| `preview`                                 | Return ID-free candidate definitions for concrete CLI validation.               |
| `accept`                                  | Record explicit acceptance of the unchanged baseline digest.                    |
| `intake`                                  | Reserve or resume a stable work-item identity and its assembly.                 |
| `bind`                                    | Check the actual Swamp-created IDs and definitions against the assembly.        |
| `activate`                                | Reserve a non-overlapping workspace before coding.                              |
| `context`                                 | Retrieve the item's pinned control-plane snapshot.                              |
| `source_digest`                           | Hash the explicit source roots, including paths and file contents.              |
| `begin_verification`, `seal_verification` | Check baseline, definitions, workspace, and source identity around real checks. |
| `readiness`                               | Separate accepted configuration from current operational verification.          |
| `release`                                 | Release a terminal or never-started item's workspace and retain its history.    |

For example, after drafting the configuration and its documents:

```sh
swamp model method run project-bootstrap check --json
swamp model method run project-bootstrap preview --json
swamp data get project-bootstrap preview --json
```

Use the [bootstrap skill](.agents/skills/bootstrap/SKILL.md) for the required
validation, acceptance, and binding steps. Use
[bootstrap-factory](.agents/skills/bootstrap-factory/SKILL.md) to drive an
accepted item. The controller does not allocate IDs: the agent creates
definitions through the normal Swamp CLI and preserves the IDs it returns.

## Readiness, safety, and scope

- Configuration readiness means the accepted files remain unchanged. Acceptance
  requires the agent to validate concrete preview definitions and installed
  versions. Its actor and validation references are audit attestations, not
  authenticated proof.
- Operational verification requires a successful dedicated verification workflow
  and matching current source identity. Empty projects remain unverified until
  their first implementation supplies the real source and tests. Source files
  outside configured `sourcePaths` are not covered by the digest.
- Work-item identity uses project, provider, scope, and reference. A retry
  resumes the original baseline and binding. New baselines apply to new items.
  Automatic migration, arbitrary stage editing, and history reset are not part
  of this release.
- Only one controller is supported per repository. Workspaces must already exist
  inside that repository and contain the pinned control-plane files. Concurrent
  items require non-overlapping workspaces. Bootstrap does not provision
  worktrees or agents.
- Local intake works without a tracker. Remote provider configuration records an
  existing integration's read method. The agent invokes it; bootstrap does not
  poll, create issues, or synchronize tracker state.
- The model does not overwrite project documents. The agent preserves manual
  edits and Swamp-managed sections in every selected instruction file. Accepted
  instructions and skills must be real files inside the repository, including
  when an agent normally loads global skills. Keep secrets out of snapshots.
  File checks reject symlinks and private paths but do not replace a
  content-level secret review.
- Review and cycle limits use the native factory engine. Reaching `ready` does
  not authorize pushing, publishing, deploying, or changing external systems.

## Dependencies and attribution

This release targets `@swamp/software-factory` **2026.06.24.1**. Record
bootstrap, the factory engine, runner extensions, and any tracker integration
with their exact versions in the project baseline. Verify installed versions
before acceptance.

The control-plane approach is inspired by Equal Experts'
[bootstrap control-plane prompt](https://github.com/EqualExperts/llm-toolkit/blob/main/prompts/00-bootstrap-control-plane.md).
The implementation is independent of `@mesgme/control-plane`. The factory
behavior uses the official
[Swamp software factory](https://swamp-club.com/extensions/@swamp/software-factory).

Licensed under the [MIT License](LICENSE.md).

## Development validation

Run the focused tests from this directory with the project's Deno runtime:

```sh
deno test --allow-read --allow-write bootstrap_test.ts readiness_test.ts files_test.ts templates_test.ts
```

`smoke_test.ts` is an opt-in real CLI test. Use an isolated initialized fixture
repository named `bootstrap-smoke.*`. Install the pinned factory and Deno
runner, source-load this extension, and create `project-bootstrap`. Then run:

```sh
BOOTSTRAP_SMOKE_REPO=/absolute/path/to/bootstrap-smoke.fixture \
  deno test --allow-read --allow-write --allow-env --allow-run smoke_test.ts
```

The smoke test creates project documents, two workspaces, definitions, and run
data in that fixture. It runs real tests through the official runner. It does
not publish or change an issue tracker. Never point it at a working project.
