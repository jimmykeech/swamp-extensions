# Project specification

The controller reads `docs/bootstrap/project.json` unless `specPath` selects
another project-relative JSON file. It hashes this file, the listed documents,
and generated factory/verification templates into one baseline. Keep secrets out
of these files.

## Required control plane

Include at least one document for each role. Paths must be unique. Do not list
the project JSON itself; the controller adds it to the snapshot automatically.

| Role                 | Suggested path                                 | Required purpose                                                          |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `instructions`       | `AGENTS.md`                                    | Project working agreements outside the Swamp-managed section.             |
| `conventions`        | `docs/conventions.md`                          | Existing toolchain, commands, layout, naming, and targeted validation.    |
| `system-context`     | `docs/architecture/L1-system-context.md`       | Users, scope, external systems, and trust boundaries.                     |
| `containers`         | `docs/architecture/L2-containers.md`           | Runtime components, responsibilities, dependencies, and deployment shape. |
| `decision`           | `docs/adr/0001-project-foundation.md`          | Decision, alternatives, reasons, and consequences.                        |
| `architecture-skill` | `.agents/skills/project-architecture/SKILL.md` | Enforceable boundaries and small examples in the selected language.       |
| `review-guidance`    | `docs/review-guidance.md`                      | Project-specific plan and code review criteria.                           |

Every entry in `skills` must identify a real `.agents/skills/<name>/SKILL.md`
listed in `documents`. Include supporting skill references when the work depends
on them; use their applicable role. The bundled `bootstrap-factory` skill is
loaded separately by generated stages. Do not put generic upstream skills in the
project list unless their files are deliberately part of the accepted snapshot.

After validating a candidate, store the transcript at
`docs/bootstrap/validation-<baselineId>.md`. After acceptance, write
`docs/bootstrap/baseline.json` as a Git-owned pointer with the acceptance
details, dependency versions, and template generator version. Do not include
either file in `documents`; they refer to the digest and would create a circular
hash dependency. The authoritative execution snapshot remains
`baseline-<baselineId>` in Swamp data.

Files must be nonempty UTF-8, at most 1 MiB each, and free of the unfinished
`__BOOTSTRAP_DRAFT__` marker. Symlinks, parent traversal, absolute document
paths, `.git`, `.swamp`, vault directories, environment files, and dependency
directories are rejected. This is a safety check, not a comprehensive secret
scanner. Review document contents before accepting them into Swamp data.

Do not include executable vault expressions or credential-valued check fields in
snapshots. Swamp can evaluate stored vault references when data is read or
passed into another method. Keep authentication on an existing integration model
or in its provider-native environment. Document symbolic vault/key names as
plain text, not executable expressions. A runner that requires credentials
inside its snapshotted arguments is not supported by this release.

## Complete Deno example

This example configures a small arithmetic module. Replace its product purpose,
decisions, and documents with the project's real design. The seven referenced
files must exist and contain reviewed project-specific content before `check`
succeeds.

```json
{
  "schemaVersion": 1,
  "projectId": "arithmetic-example",
  "title": "Arithmetic example",
  "purpose": "Provide a small typed arithmetic module with deterministic unit tests.",
  "agentTool": "codex",
  "documents": [
    { "role": "instructions", "path": "AGENTS.md" },
    { "role": "conventions", "path": "docs/conventions.md" },
    {
      "role": "system-context",
      "path": "docs/architecture/L1-system-context.md"
    },
    { "role": "containers", "path": "docs/architecture/L2-containers.md" },
    { "role": "decision", "path": "docs/adr/0001-project-foundation.md" },
    {
      "role": "architecture-skill",
      "path": ".agents/skills/project-architecture/SKILL.md"
    },
    { "role": "review-guidance", "path": "docs/review-guidance.md" }
  ],
  "decisions": [
    "Keep arithmetic pure and independent of I/O; expose one typed module.",
    "Use Deno's built-in test runner for the initial verification check."
  ],
  "skills": ["project-architecture"],
  "dependencies": [
    { "name": "@jamesakeech/bootstrap", "version": "2026.09.06.2" },
    { "name": "@swamp/software-factory", "version": "2026.06.24.1" },
    { "name": "@swamp/deno-runner", "version": "2026.08.23.1" }
  ],
  "issueIntegration": {
    "provider": "local",
    "scope": "arithmetic-example"
  },
  "policy": {
    "materialDecisions": "explicit-approval",
    "externalActions": "explicit-approval",
    "requirePlanApproval": false,
    "requireDeliveryApproval": false,
    "maxCycles": 3
  },
  "verification": {
    "sourcePaths": ["src", "tests", "deno.json"],
    "checks": [
      {
        "name": "unit-tests",
        "modelType": "@swamp/deno-runner",
        "methodName": "run",
        "globalArgs": { "version": "2.7.5" },
        "inputs": {
          "args": ["test", "tests/sum_test.ts"],
          "workingDir": "__WORKSPACE__",
          "inheritEnv": false
        },
        "command": "deno test tests/sum_test.ts"
      }
    ]
  }
}
```

The runner's `version` is a global argument. `workingDir` belongs to method
inputs. The official runner reports a failed method on a nonzero command exit.
See its
[argument schema](https://github.com/swamp-club/swamp-extensions/blob/main/deno-runner/extensions/models/_lib/schemas.ts)
and
[run implementation](https://github.com/swamp-club/swamp-extensions/blob/main/deno-runner/extensions/models/deno_runner.ts).

For this example's first implementation, create these real files:

`deno.json`:

```json
{ "tasks": { "test": "deno test tests/sum_test.ts" } }
```

`src/sum.ts`:

```typescript
export function sum(left: number, right: number): number {
  return left + right;
}
```

`tests/sum_test.ts`:

```typescript
import { sum } from "../src/sum.ts";

Deno.test("sum adds positive and negative operands", () => {
  if (sum(2, 3) !== 5 || sum(-2, 3) !== 1) {
    throw new Error("Unexpected sum");
  }
});
```

Missing source paths are allowed during control-plane checking. They fail source
digesting and verification until the first implementation creates them. Do not
replace missing tests with a passing no-op.

## Verification contract

Select explicit source roots containing every file that can affect the check,
including tests, build configuration, and relevant lockfiles. Do not select `.`.
Unselected files are not covered by the source digest. Capture application
inputs, not generated output, installed dependencies, secrets, or Swamp's
runtime data. The snapshot includes paths and file content, so renames and
removals change it. It fails instead of truncating above 5,000 files, 10,000
entries, or 50 MiB.

Each check names an existing model type, method, global arguments, inputs, and a
human-readable command. Record its providing extension and exact version in
`dependencies`. Check names must be unique and cannot be `begin`, `seal`, or
`record`. Bootstrap and factory control methods cannot stand in for project
verification. Inspect runner semantics: a method that returns success while
reporting failed tests does not satisfy this contract.

Use `__WORKSPACE__` as a complete string where a runner expects its working
directory. Bootstrap substitutes it with the canonical workspace path. Embedded
forms such as `__WORKSPACE__/src` are not interpolated. Normal CEL inputs must
use supported Swamp syntax. Do not add bootstrap's other internal sentinel
values to project inputs.

Checks run sequentially in a dedicated workflow. Bootstrap checks the accepted
baseline, definitions, and source digest before and after them. The workflow
then records the successful seal on its own factory. The factory gate checks the
platform workflow result and that same-run output. Do not edit this generated
sequence.

## Issue integration and policy

`local` needs only a stable scope. Remote providers are `gitlab`, `github`,
`forgejo`, or `swamp`. They also require `modelName`, `readMethod`, `extension`,
and the extension's version in `dependencies`. Include the host and repository
identity in `scope`. Configure credentials on the existing tracker model through
Swamp vault references. The agent invokes its read method; bootstrap does not
poll or write to a tracker.

Routine plan and ready-stage approval gates are optional. Material decisions and
external actions still require explicit approval. `maxCycles` is 1–5; unresolved
critical or high findings require rework. Exhausted cycle limits need a human
decision, not an automatic override. Stages follow the shipped template in this
release.
