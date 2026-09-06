# Bootstrap implementation review

Reviewed against the pinned `@swamp/software-factory@2026.06.24.1` source. This
is an implementation review, not an authenticated approval system.

## Guided onboarding update — 2026.09.06.4

Mechanical review completed before controller tests:

- Schema-write conformance: PASS. Inspection writes all eight declared fields
  through the existing schema-validated emitter.
- Truncation honesty: PASS. Diagnostics group issues by fixed schema fields;
  they do not return partial file contents. File limits still throw.
- Instance consistency: PASS. Only the existing `inspection` instance changes.
- Field coverage: PASS. Status, question, issues, accepted baseline pointer,
  presence flags, specification path, and next action have producing paths.

Dimensional review:

- Credentials and secrets: PASS. Neither raw JSON errors nor unknown field
  names/values enter inspection output. Draft guidance excludes secrets.
- Logging: PASS. Entry and completion logs omit project content.
- Error handling: PASS. Only missing files and JSON syntax failures become
  expected discovery/configuration states. Unsafe paths and other I/O failures
  still fail before persistence.
- Testing completeness: PASS. The focused regression covers first-run states,
  unchanged files, strict-check rejection, safe reads, and accepted-state
  resume. Runtime results and behavioral-test limits are recorded in
  VALIDATION.md.
- Idempotency and resilience: PASS. Inspection writes no project file,
  candidate, registry, or acceptance. The skill resumes a draft or accepted
  baseline without repeating known questions.
- API contracts: Not applicable. No HTTP integration was added.
- Resource management: PASS. Existing bounded reads close file handles.
- Published surface: PASS. Native-agent examples and draft instructions contain
  no credentials or infrastructure identifiers.
- Schema strictness: PASS. Inspection has explicit routing fields. Project and
  acceptance schemas remain strict; tolerant discovery does not weaken `check`.
- Lifetime and garbage collection: PASS. Existing resource policies are
  unchanged.
- CRUD completeness: Not applicable. No external CRUD resource is managed.
- Pre-flight checks: PASS. Snapshot, approval, binding, and verification guards
  are unchanged. `ready-for-check` explicitly does not mean accepted or valid.
- Instance names: PASS. Inspection does not allocate factories or work items.
- Data access: PASS. Accepted-state detection reads the registry through Swamp's
  resource API. The active agent retrieves accepted context through Swamp data.
- Version upgrades: PASS. The `.4` no-op preserves the unchanged `specPath`
  arguments and does not migrate accepted baselines.

Independent review found no blocking issue. The native agent conducts the
interview; the CLI returns routing data and never launches an interactive agent.

## Agent-neutral update — 2026.09.06.3

- Mechanical schema/write conformance, truncation, instance consistency, and
  field coverage: PASS. Inspection retains its declared boolean fields and now
  derives instruction presence from the configured inventory.
- Credentials/secrets, logging, error handling, and resource management: PASS.
  Instruction and skill files still pass through bounded, project-local reads.
  Existing path, symlink, and secret rejection remain in place.
- Idempotency, schema strictness, lifetime/GC, pre-flight guards, instance
  names, and data access: PASS. No execution ownership or baseline mutation was
  added.
- Published surface: PASS. Agent-neutral examples use native setup discovery.
  Native enrollment remains Swamp's responsibility rather than a duplicate
  hard-coded integration registry inside bootstrap.
- Version upgrades: PASS. The `.3` no-op retains `specPath`. Widening
  `agentTool` preserves existing Codex configurations. Real CLI retrieval
  confirmed an older baseline and its original dependency pin remain readable.
- Testing: PASS. Six focused controller/report tests passed, including six
  native-layout cases. A source-loaded Claude fixture passed `inspect` and
  `check` without `AGENTS.md`. Both updated skill validators passed.
- API contracts and CRUD completeness: Not applicable. No HTTP integration or
  external CRUD operation was added.

Independent review found no blocking issue. Native agent sessions and Pi
installation were not exercised; see VALIDATION.md for the exact boundaries.

The sections below record the original implementation and `.2` corrections.

## Mechanical checks

- Schema-write conformance: PASS. Every output passes its declared Zod schema
  before persistence.
- Truncation honesty: PASS. Snapshot limits throw. No partial snapshot is
  reported as complete.
- Instance consistency: PASS. Baselines, reservations, context, digests, and
  verification records use distinct names.
- Field coverage: PASS. Declared fields have producing paths. Empty acceptance
  and bindings represent explicit candidate and reserved states.

## Universal dimensions

- Credentials and secrets: PASS. No credentials are collected. Executable vault
  expressions are rejected before snapshot persistence, including decoded JSON
  strings. Authentication stays outside the baseline. Private paths and symlinks
  are rejected.
- Logging: PASS. Methods log operations and completion without document contents
  or credential values.
- Error handling: PASS. Validation precedes writes. Acceptance writes its
  immutable snapshot before updating the registry pointer.
- Testing completeness: PASS. Eleven focused tests passed after the packaging
  correction. The opt-in real-engine lifecycle test also passed, with distinct
  factory/workflow IDs, duplicate intake, actual Deno tests, cross-item gate
  isolation, pinned context, and stale approval rejection.
- Idempotency and resilience: PASS after corrections. Repeated intake returns
  the same reservation. Bind refuses replacement IDs. Pre-start workspace
  reservations can be released.
- API contracts: Not applicable to HTTP. No model makes HTTP requests. Pinned
  factory source contracts were inspected directly.
- Resource management: PASS. File handles close on failure. Reads and source
  traversal are bounded.
- Published surface: PASS. Examples contain no infrastructure identifiers or
  credentials.

## Model and report dimensions

- Schema strictness: PASS. Explicit project/resource fields; only check
  arguments and native factory definitions intentionally accept JSON objects.
- Lifetime and garbage collection: PASS. Accepted baselines use separate
  immutable names. Registry history is bounded; its current record retains all
  reservations.
- CRUD completeness: Not applicable. This controller records configuration and
  execution mappings. It does not manage an external CRUD resource.
- Pre-flight checks: PASS. Mutating operations validate baseline identity, file
  hashes, definition bindings, or workspace state in their method bodies.
- Instance names: PASS after correction. Work-item IDs remain below the pinned
  engine's slug-rewrite threshold.
- Data access: PASS. Own state uses readResource; factory/workflow evidence uses
  the Swamp data repository and run-scoped query API.
- Version upgrades: PASS. The 2026.09.06.2 packaging/report correction uses a
  pure no-op argument upgrade. The configuration schema is unchanged. Existing
  baselines retain their dependency versions; new baselines pin the new version.
- Report provenance: PASS. Readiness reads the exact factory evidence version
  from the successful workflow run and compares its work item, baseline, and
  current source digest.

## Corrections from independent review

1. Shortened work-item IDs because the engine rewrites names longer than 48
   characters. Explicit identity comparison detects a reservation-key collision.
2. Allowed release of an activated reservation when factory start has not
   created state.
3. Added lexical source-path validation before baseline acceptance. Source files
   can be absent in an empty project, but unsafe paths cannot be accepted.
4. Replaced independent latest-seal lookup with exact workflow-run-owned factory
   evidence in readiness checks.
5. Real CLI execution showed that global arguments are merged into method
   inputs. Method schemas strip those extra global keys; project and resource
   schemas remain strict.
6. Kept model, workflow, and supporting-check names within Swamp's 64-character
   limit. Supporting checks use unique indices rather than potentially long
   check labels.
7. Pinned YAML 2.8.3 after the package audit found the earlier parser vulnerable
   to excessive nesting. The patched dependency passes the audit.
8. Forward-tested the driving skills. Resume now selects the original registry
   scope before using an existing reservation, so changing the latest tracker
   scope cannot redirect a retry.
9. Fresh registry installation exposed a workflow filename collision. Moved both
   CLI-created workflow definitions to distinct manifest-relative root
   filenames. Their allocated IDs remain unchanged.
10. Enabled the registered readiness report on the controller. The CLI's
    `--report` flag filters enabled reports; it does not enable one by itself. A
    fresh `.2` registry installation validated both workflows and executed the
    report successfully. The focused regression also checks the unchanged
    argument upgrade.

## Explicit boundaries

The driving skill performs Swamp CLI scaffolding and validates preview
definitions before asking for acceptance. The acceptance reference is an audit
record, not proof of a trusted human identity or a sandbox boundary. The
controller does not execute arbitrary commands or create IDs. Verification uses
configured existing model types. Workspace isolation assumes one controller and
cooperative agents in one local repository. Remote/distributed allocation is not
supported in this release.
