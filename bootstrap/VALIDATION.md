# Validation

## 2026.09.06.4 — local guided-onboarding update

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
- Local package build:
  `swamp extension push bootstrap/manifest.yaml --dry-run
  --json` passed with
  a current content-bound review and no warnings. The archive includes both
  skills, two workflows, one controller, and one report.
- Not pushed or published. The published release remains `.3`. Factory execution
  templates did not change, so the full two-item lifecycle was not rerun.

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
