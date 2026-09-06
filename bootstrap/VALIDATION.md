# Validation

## 2026.09.06.6 — local factory customization update

- Controller/template/readiness tests: 13 passed, 0 failed. Custom settings
  reach preview, accepted snapshots, new-item assemblies, and pinned context.
  Missing specialist skill inventory and changed approval subjects fail.
  Existing items retain their original templates. Omitted customization and an
  explicit unchanged base produce identical factory definitions.
- Template regression checks custom review ordering, fresh subject-linked
  findings, critical/high rework, cycle bounds, scoped skills, protected
  verification, and final plan/delivery approvals. Unsupported graph fields,
  name collisions, and executable prompt expressions are rejected.
- Real CLI lifecycle test: 1 passed, 0 failed in approximately 3 minutes. The
  isolated fixture uses source-loaded bootstrap `.6`, official factory engine
  `2026.06.24.1`, and Deno runner `2026.08.23.1`. Preview and both item
  factories passed native factory/workflow validation. A custom plan review
  exercised blocking findings, rework, fresh re-review, and required plan
  approval. A custom code review required both its own sign-off and final
  delivery approval. Both dedicated workflows ran actual Deno tests and reached
  ready through source-bound evidence. Duplicate intake, pinned context, and
  stale baseline acceptance checks also passed. Expected method failures
  retrieved their generated reports.
- Both bundled skills passed `quick_validate.py`. An independent two-turn
  onboarding exercise first outlined the project factory and waited for a
  choice. It then saved the requested accessibility review and plan approval,
  generated a stage-specific Claude-layout skill, and preserved pending runner
  validation. The resulting factory/policy fragments passed the actual schemas.
  The main agent inspected the settings, outline, brief, inventory, and skill.
  These were controlled agent exercises, not live Claude/Pi sessions or a
  deployed web application's accessibility validation.
- Type checking passed for changed production code and tests. The complete
  reference example parses, pins `.6`, and inventories the factory outline.
- Mechanical and independent adversarial review found no blocking issue before
  runtime tests. The final documentation clarifies that inspection cannot
  confirm factory choices; a new project completes that conversation first.
- Package dry-run passed with the current content-bound review and no warnings.
  The archive includes the new factory-design reference. No Git push, PR update,
  or registry publication was performed for this change.

Commands run from `bootstrap/`, using `/Users/jimmykeech/.swamp/deno/deno` as
the Deno executable:

```sh
deno check bootstrap.ts bootstrap_test.ts templates_test.ts
deno test --allow-read --allow-write bootstrap_test.ts templates_test.ts readiness_test.ts
BOOTSTRAP_SMOKE_REPO=/Users/jimmykeech/Develop/bootstrap-smoke-custom.CrDqgx \
  deno test --allow-read --allow-write --allow-env --allow-run smoke_test.ts
```

Package check from the repository root:

```sh
swamp extension push bootstrap/manifest.yaml --dry-run --json
```

## 2026.09.06.5 — published architecture-choice update

- Focused controller/report tests: 8 passed, 0 failed. The new regression pins a
  custom non-DDD decision and review skill through candidate capture,
  acceptance, intake, and context retrieval. Every interactive factory stage
  receives both selected project skills.
- Both bundled skills passed skill-creator structural validation. The complete
  reference JSON passed `ProjectSchema`, lists both skills in its document
  inventory, and pins the current bootstrap version.
- Independent skill exercise produced separate DDD and user-defined
  functional-core draft skills and ADRs in an isolated directory. Inspection
  confirmed domain lending invariants for the DDD case and the user's exact
  transform/I/O/CLI boundaries without domain classes or repositories for the
  custom case. Both review skills retain the factory findings format and scope
  read-only rules to reviews. An unresolved choice stopped at the DDD-or-other
  question without choosing an architecture.
- These were controlled agent exercises, not live Claude/Pi native sessions.
  Live agent discovery and a complete baseline-to-delivery run with generated
  architecture skills remain unverified.
- The updated lifecycle smoke fixture passed type checking. Its new review skill
  file has valid frontmatter. The full lifecycle was not rerun because
  controller method behavior and factory execution templates did not change.
- Pre-test review found no remaining blocker. It corrected the driver guidance
  to load pinned project skills after context import while loading the bundled
  driver separately. The `.5` no-op upgrade retains existing arguments and
  accepted baselines; no required architecture field was introduced.
- Local package dry-run passed with no warnings and a current content-bound
  review. It includes the new architecture-choice reference in the bootstrap
  skill bundle.
- Registry publication: public stable `@jamesakeech/bootstrap@2026.09.06.5`.
  Swamp format/lint and package dry-run passed with no warnings. The quality
  check earned all 12 client-checkable points. The registry confirmed `.5` as
  latest stable.
- Fresh registry installation: passed in a separate Claude-only repository with
  no source links. Both bundled skills, the new architecture reference, and the
  updated project-spec reference matched the reviewed source exactly. Model
  creation selected `.5`; native `CLAUDE.md` was present and `AGENTS.md` was
  absent. This verifies packaging, not a live architecture interview.

Focused commands, run from `bootstrap/` with the installed Deno runtime:

```sh
deno test --allow-read --allow-write bootstrap_test.ts readiness_test.ts
deno check smoke_test.ts
```

## 2026.09.06.4 — published guided-onboarding update

- Focused controller/report tests: 7 passed, 0 failed. The new regression covers
  absent, blank, partial, draft, malformed, and non-object specifications. It
  checks first-question routing, no leaked raw diagnostics, unchanged project
  files, strict-check rejection, missing instructions, and unsafe/oversized/
  symlinked file rejection. Existing native-layout cases also verify accepted
  baselines suppress discovery when the project specification is missing.
- Fresh Swamp CLI fixture: `swamp repo init --tool claude`, source registration
  for models/reports, and model creation selected `.4`. `inspect` succeeded with
  `configured: false`, `acceptedBaselineId: null`, `status: needs-details`, and
  the expected first question. No project JSON was created. Native `CLAUDE.md`
  was present; `AGENTS.md` was absent.
- Independent skill exercise: an empty project received the first question; a
  README-backed project was asked only about remaining stack constraints; a
  saved Python project brief resumed its open hosting question. These were
  read-only simulated sessions, not live Claude or Pi sessions. Actual draft
  file persistence across a restarted native-agent session remains unverified.
- Bootstrap skill structural validation, changed-file formatting, and the
  complete reference JSON parsing passed. Independent adversarial review found
  no blocking issue before the controller tests ran.
- Local package build: the package dry-run passed with a current content-bound
  review and no warnings. The archive includes both skills, two workflows, one
  controller, and one report.
- Registry publication: public stable `@jamesakeech/bootstrap@2026.09.06.4`.
  Swamp format/lint checks passed. The quality check earned all 12
  client-checkable points, with no dependency audit warnings.
- Fresh registry installation: passed in a separate Claude-only repository with
  no source links. Both installed skills and the updated project-spec reference
  matched the reviewed source. Model creation selected `.4`; `inspect` returned
  `needs-details` and the expected first question. No project JSON or
  `AGENTS.md` was created. The registry confirmed `.4` as latest stable.
- Factory execution templates did not change, so the full two-item lifecycle was
  not rerun.

Focused command, run from `bootstrap/` with the installed Deno runtime:

```sh
deno test --allow-read --allow-write bootstrap_test.ts readiness_test.ts
```

Real first-run commands used the isolated repository
`/Users/jimmykeech/Develop/bootstrap-onboarding.VBtIoB`:

```sh
swamp model create @jamesakeech/bootstrap onboarding-bootstrap --json
swamp model method run onboarding-bootstrap inspect --json
swamp data get onboarding-bootstrap inspection --json
```

## 2026.09.06.3 — published agent-neutral update

- Focused controller/report tests: 6 passed, 0 failed. The new regression
  exercises Codex, Claude, Pi with two skill roots, a custom agent layout, and
  multiple instruction files. It covers inspection, missing required files and
  skills, acceptance, intake, and pinned context.
- Real CLI check: passed in a fresh `swamp repo init --tool claude` fixture.
  Source-loaded controller `inspect` and `check` accepted `CLAUDE.md` and
  `.claude/skills/project-architecture/SKILL.md` without `AGENTS.md`.
- Backward compatibility: the source-loaded controller at `.3` retrieved the
  original Codex work-item context, unchanged baseline ID, and original `.1`
  dependency pin from the earlier lifecycle fixture. No baseline was migrated.
- Both updated skills passed skill-creator validation. The documented project
  JSON example remained parseable. Extension format/lint and local package
  dry-run passed. The archive retains agent-neutral `extension/skills/` paths.
- Independent code review found no blocking issues. It confirmed unchanged
  snapshot safety and version-upgrade behavior.
- Registry publication: public stable `@jamesakeech/bootstrap@2026.09.06.3`.
  Publication checks earned all 12 client-checkable quality points and produced
  no dry-run warnings.
- Fresh registry installation: passed in a separate Claude-only repository
  without source links or `AGENTS.md`. Both bundled skills were installed under
  `.claude/skills` and matched the reviewed source. Both workflows were
  discovered. Model creation selected `.3`; `inspect` and the readiness report
  correctly reported an unconfigured project with no accepted baseline.

Focused command, run from `bootstrap/` with the installed Deno runtime:

```sh
deno test --allow-read --allow-write bootstrap_test.ts readiness_test.ts
```

The pre-publication controller checks used the source-loaded model. The later
installation check used the published `.3` package. Native skill discovery is
the agent/Swamp integration's responsibility. No live Claude, Pi, or other
coding-agent session was launched. The installed Swamp CLI's tool list predates
native Pi support; the Pi layouts were tested at the controller boundary. The
full two-item lifecycle was not rerun because factory execution and verification
templates did not change.

## 2026.09.06.2 — published release validation

Platform: Swamp `20260828.231706.0-sha.ca29674e`, macOS arm64. Factory engine:
`@swamp/software-factory@2026.06.24.1`. Verification runner:
`@swamp/deno-runner@2026.08.23.1`, running Deno 2.7.5.

## Results

- Type checking: passed for the controller, report, helpers, and tests.
- Focused tests: 11 passed, 0 failed, including vault-expression rejection,
  report activation, and configuration-preserving version upgrades.
- Real Swamp CLI smoke test: 1 passed, 0 failed, approximately 111 seconds.
- Extension format/lint checks: passed.
- Local quality score: all 12 client-checkable points earned. Repository
  verification remains registry-side.
- Dependency audit: passed, no warnings with YAML 2.8.3.
- Both bundled skills: skill-creator structural validation passed.
- Independent implementation and skill-forward reviews: corrected findings
  recorded in REVIEW.md.
- Registry publication: public stable `@jamesakeech/bootstrap@2026.09.06.2`.
- Fresh registry installation: passed, with no source links. Both packaged
  workflows were discovered and validated with zero warnings. The installed
  readiness report ran successfully and correctly reported no accepted baseline.
- Existing controller upgrade: a real source-loaded controller upgraded from
  `2026.09.06.1` to `2026.09.06.2` and retained its baseline and both item
  records.

The real-engine test validated and accepted a complete baseline before intake.
Concurrent duplicate intake returned the same reservation. Two items received
different model IDs and workflow IDs and used separate workspaces. Both ran real
positive/negative-operand arithmetic tests. Item B completed verification after
item A, before A advanced. Both native verification gates passed. Both factories
completed review and reached a terminal ready stage. Their workspaces released
without deleting history. Readiness reported current verified operation.

Verification workflow runs:

- Item A: `962f94a4-7e26-434e-8f36-22edfe78a861`.
- Item B: `c141dbab-8c46-4e1a-8cc0-ec78a07b7515`.

Changing an accepted document then caused stale acceptance to fail and
configuration readiness to become false. The existing item's retrieved context
still matched its original baseline. Unit tests also covered unsafe paths,
symlinks, source additions/deletions/renames/binary changes, baseline revision
pinning, and exact report-version reads.

The lifecycle test ran before the final packaging/report correction. The final
release passed all eleven focused tests and the fresh-install checks. The
correction did not change factory templates, workflow contents, or resource
schemas. The first published version, `2026.09.06.1`, is superseded by `.2`:
fresh installation exposed colliding workflow filenames and a report that was
registered but not enabled. The corrected archive was inspected before publish.

## Reproduction commands

From `bootstrap/`, using the installed Deno runtime:

```sh
deno test --allow-read --allow-write bootstrap_test.ts readiness_test.ts files_test.ts templates_test.ts
```

The opt-in lifecycle test uses the isolated fixture setup documented in README:

```sh
BOOTSTRAP_SMOKE_REPO=/absolute/path/to/bootstrap-smoke.fixture \
  deno test --allow-read --allow-write --allow-env --allow-run smoke_test.ts
```

From the extension repository root:

```sh
swamp extension fmt bootstrap/manifest.yaml --check --json
swamp extension quality bootstrap/manifest.yaml --json
swamp extension push bootstrap/manifest.yaml --dry-run --json
```

Fresh-install checks ran in a separate empty fixture repository:

```sh
swamp repo init --tool codex --json
swamp extension pull @jamesakeech/bootstrap@2026.09.06.2 --json
swamp workflow search --json
swamp workflow validate @jamesakeech/bootstrap/check --json
swamp workflow validate @jamesakeech/bootstrap/intake --json
swamp model create @jamesakeech/bootstrap installed-bootstrap --json
swamp model method run installed-bootstrap readiness --report @jamesakeech/bootstrap/readiness --json
```

Assertions confirmed both expected workflow names, successful report execution,
`configurationReady: false`, `operationallyVerified: false`, and the blocker
`No accepted baseline`.

## Limits

No remote tracker, remote worker, or distributed datastore was exercised.
Source-directory allocation assumes one local controller and cooperative agents.
Architecture prose and explicit acceptance remain agent/human work. The shipped
lifecycle test calibrates mechanics; it does not prove an agent's architecture
or code-review judgment on an arbitrary project.
