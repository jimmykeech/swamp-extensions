# @jamesakeech/bootstrap

Configure a project for a Swamp-integrated agent and create one software factory
per work item. Bootstrap snapshots accepted architecture, instructions, skills,
and check definitions. It then checks verification evidence against that
baseline and the item's source digest.

The agent writes the project documents and drives the workflow. Bootstrap uses
`@swamp/software-factory`; it does not run coding agents itself.

This checkout contains the older Bootstrap implementation. The **Optional
factory features** section describes the newer published package based on
**2026.09.11.1**, including `bootstrap-agent`; those features are absent from
this checkout. Install the published extension to use them. References to
agent-policy and delivery guidance refer to installed skills, not files in this
checkout.

## Setup

Use the project's selected agent and native Swamp integration. For a repository
without `.swamp.yaml`, check the installed CLI's supported tools, then
initialize:

```sh
swamp help repo init
swamp repo init --tool <selected-tool>
swamp extension pull @jamesakeech/bootstrap
```

Replace `<selected-tool>` with a supported tool ID, such as `claude` or `codex`.
Bootstrap does not install or upgrade Swamp or the agent.

For an existing Swamp repository, pull the extension without reinitializing. If
another integration is needed, inspect `swamp help repo upgrade` and preserve
all existing tool enrollments and their order. Verify that the active agent can
load the bundled skills from its native skill location.

## Start with your agent

Ask your agent:

> Use the bootstrap skill to configure this project for agentic coding with
> Swamp factories.

The bootstrap skill (in the installed Bootstrap skills) guides these steps:

1. Discover the project, users, first useful version, and constraints. It reuses
   existing information, asks one missing question at a time, and saves progress
   in `docs/bootstrap/brief.md`.
2. Confirm the architecture approach. Domain-driven design is the recommended
   default, but requires your choice. The agent creates or reuses project-local
   architecture and review skills for the selected approach.
3. Agree on factory stages, skills, checks, reviews, approvals, and rework
   limits. The agent records the design in `docs/bootstrap/factory.md`.
4. Write the project configuration and documents, validate concrete factory and
   workflow definitions, and request explicit acceptance of the baseline digest.
5. Create a work item with its own factory, verification workflow, check-model
   names, and reserved workspace.

Drafts are not accepted baselines. Interrupted setup resumes from saved
progress; accepted projects and existing work items do not repeat onboarding.
New work items use the latest accepted template. Existing items keep their
pinned template.

Use bootstrap-factory (in the installed Bootstrap skills) to drive or resume an
accepted item through the default lifecycle:

```text
import context → plan → plan review → implement → verify → code review → ready
                    ↑ bounded rework ─────────────────────────────┘
```

Factory customization can add stage instructions, skills, sequential specialist
reviews, checks, and approval gates. It cannot remove or reorder required
stages, replace them with executable definitions, or bypass review and
verification. Reviews are interactive by default; explicit dispatch selects an
independent reviewer.

## Configuration

Create one controller per repository:

```sh
swamp model create @jamesakeech/bootstrap project-bootstrap
```

Its optional `globalArguments.specPath` selects the project configuration; the
default is `docs/bootstrap/project.json`. See these bundled references:

- Project specification (in the installed Bootstrap skills): seven required
  document roles and a complete Deno example.
- Architecture (in the installed Bootstrap skills): architecture selection and
  project skill generation.
- Factory design (in the installed Bootstrap skills): supported customization
  fields and examples.
- Working profile (in the installed Bootstrap skills): starting working
  agreements.

`agentTool` records the default agent; any Swamp-integrated agent can drive the
factory. Instruction and skill paths follow the project's native setup.
Bootstrap validates listed files, while Swamp and the agent handle integration
and skill discovery.

The agent writes an acceptance pointer to `docs/bootstrap/baseline.json` and a
separate validation transcript. Both stay outside the baseline document
inventory to avoid including their own digest.

## Controller methods

| Method                                    | Purpose                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `inspect`                                 | Report discovery or configuration status without editing project files.         |
| `check`                                   | Capture and structurally validate a candidate baseline.                         |
| `preview`                                 | Return candidate definitions without IDs for concrete CLI validation.           |
| `accept`                                  | Record explicit acceptance of the unchanged baseline digest.                    |
| `intake`                                  | Reserve or resume a work-item identity and assembly.                            |
| `bind`                                    | Check actual Swamp-created IDs and definitions against the assembly.            |
| `activate`                                | Reserve a non-overlapping workspace before coding.                              |
| `context`                                 | Retrieve the item's pinned baseline snapshot.                                   |
| `source_digest`                           | Hash configured source paths and file contents.                                 |
| `begin_verification`, `seal_verification` | Check baseline, definitions, workspace, and source identity around real checks. |
| `readiness`                               | Report configuration acceptance separately from operational verification.       |
| `release`                                 | Release a terminal or never-started item's workspace; retain its history.       |

After the configuration and documents are complete:

```sh
swamp model method run project-bootstrap check --json
swamp model method run project-bootstrap preview --json
swamp data get project-bootstrap preview --json
```

Follow the bootstrap skill for validation, acceptance, and binding. The agent
creates definitions through the Swamp CLI and preserves its allocated IDs.

`inspect` returns `status`, `nextQuestion`, `issues`, and `acceptedBaselineId`:

| Status                  | Next step                                                    |
| ----------------------- | ------------------------------------------------------------ |
| `needs-details`         | Start or resume discovery using known details first.         |
| `needs-configuration`   | Continue configuration or recover the accepted snapshot.     |
| `ready-for-check`       | Complete architecture and factory choices, then run `check`. |
| `invalid-configuration` | Repair the reported issue without discarding history.        |

These are routing signals for the agent. The CLI does not conduct an interview,
and `ready-for-check` does not mean validation or acceptance has passed.

## Optional factory features

The published package includes these features. Use the installed `bootstrap`
skill's factory-design, agent-policy, and delivery references for exact schemas
and evidence contracts.

- **Independent and conditional reviews:** Review `execution` with
  `mode: "dispatch"` and a `skill` selects one independent reviewer and requires
  fresh completion evidence. Additional code reviews can use `when` for recorded
  path/impact assessment. Skipped reviews retain applicable approval
  requirements.
- **Fast lane:** `factory.fastLane` skips planning while retaining verification
  and final-approval policy. Intake requires a human `selection` with `lane`,
  `actor`, `reference`, and `reason`. Escalation returns the same run to
  standard planning and retains findings and history. Use controller `intake`
  directly for `selection`; the bundled intake workflow does not expose that
  input.
- **Stage models:** `agentPolicyPath` selects project-relative JSON with
  required `defaults.model` and `defaults.reasoningEffort`, plus fieldwise
  `stages` overrides. The driver launches one fresh agent per policy-enabled
  stage with pinned settings and records execution evidence. The
  `bootstrap-agent` skill handles delegated planning, implementation, and
  reviews; workers return results without mutating factory state. Unsupported
  host settings block execution without fallback. Host/model identity remains an
  attestation, not independent proof.
- **Protected delivery:** `factory.delivery` with `mode: "codex"`, `modelName`,
  and optional `instructions` adds `awaiting-approval → delivering → shipped`.
  It needs an external coordinator, a committed and verified `headSha`, and
  explicit human approval bound to the exact delivery subject. The workspace
  must be its Git worktree root. Covered source must match raw HEAD filenames
  and bytes; dirty, staged, untracked, or ignored covered files are rejected.
  Shipment needs merge evidence, applicable release and acceptance evidence, and
  confirmed item closure. Repository-only delivery needs no invented deployment.
  Bootstrap validates receipt consistency; the coordinator performs external
  operations and obtains provider readbacks. Incomplete or synthetic receipts
  cannot ship.

Policy selection does not approve an individual delivery. New policies require
validated baseline acceptance; existing items retain their pinned configuration.
Validate a real host-driven invocation before accepting reviewer or stage-model
execution. Bootstrap is not an unattended inference service.

## Limits and safety

- Configuration readiness confirms that accepted files remain unchanged.
  Acceptance requires concrete preview validation and installed-version checks.
  Actor and validation references are audit attestations, not authenticated
  proof.
- Operational verification requires a successful dedicated workflow and matching
  current source digest. Empty projects remain unverified until real source and
  tests exist. Files outside configured `sourcePaths` are not covered.
- Retries resume the original work-item baseline and binding. Automatic baseline
  migration, unrestricted graph editing, and history reset are not supported.
- Use one controller per repository. Workspaces must already exist inside it and
  contain the pinned baseline files. Concurrent items need non-overlapping
  workspaces. Bootstrap does not create worktrees or a `swamp serve` server. The
  native agent coordinates any configured worker dispatch.
- Local intake needs no tracker. Remote intake uses an existing integration's
  read method, invoked by the agent. Bootstrap does not poll or update tracker
  state.
- The model does not overwrite project documents. Preserve manual edits and
  Swamp-managed instruction sections. Accepted instructions and skills must be
  real files inside the repository. File checks reject symlinks and private
  paths; review file contents separately to keep secrets out of snapshots.
- Native factory review and cycle limits apply. Reaching `ready` does not
  authorize pushes, publishing, deployment, or other external changes.

## Dependencies and license

This release targets `@swamp/software-factory` **2026.06.24.1**. Record and
verify exact bootstrap, factory, runner, and tracker-extension versions before
baseline acceptance.

Inspired by Equal Experts'
[bootstrap control-plane prompt](https://github.com/EqualExperts/llm-toolkit/blob/main/prompts/00-bootstrap-control-plane.md).
The implementation is independent of `@mesgme/control-plane` and uses the
official
[Swamp software factory](https://swamp-club.com/extensions/@swamp/software-factory).

[MIT](LICENSE.md).

## Development validation

Run from this directory:

```sh
deno test --allow-read --allow-write bootstrap_test.ts readiness_test.ts files_test.ts templates_test.ts
```

The opt-in `smoke_test.ts` runs real CLI checks. Prepare an isolated,
initialized repository named `bootstrap-smoke.*`, install the pinned factory and
Deno runner, source-load this extension, and create `project-bootstrap`. Then
run:

```sh
BOOTSTRAP_SMOKE_REPO=/absolute/path/to/bootstrap-smoke.fixture \
  deno test --allow-read --allow-write --allow-env --allow-run smoke_test.ts
```

The smoke test writes documents, two workspaces, definitions, and run data in
the fixture. It does not publish or change a tracker. Never use a working
project as the fixture.

These tests cover this checkout, not newer published-only features.
