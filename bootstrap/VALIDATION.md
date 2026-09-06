# Validation — 2026.09.06.2

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
