# Architecture choice and project skills

Use this reference after discovering the project's purpose and constraints, and
before drafting or deliberately changing its architecture. The active agent
conducts the conversation and creates the files. The controller does not select
a philosophy or generate skill text.

## Establish the choice

Recommend domain-driven design (DDD) when the project has no selected approach.
Explain the recommendation in the project's terms and offer another approach.
Wait for a choice before writing design-specific skills. "Use the default" is a
choice; silence or "not sure" is not. For uncertainty, explain the main
trade-off and ask one focused question. Keep the interview short.

The user may select, combine, or describe principles. Examples include DDD,
hexagonal/ports-and-adapters, layered architecture, vertical slices, and a
functional core with an imperative shell. These are not all competing choices:
DDD describes domain modelling, while a boundary style can complement it. Ask
which parts the user intends when a combination is ambiguous. Do not confuse a
philosophy with deployment: a modular monolith or microservices is a separate
decision.

Reuse an explicit existing choice. When repository conventions already define an
approach, retain it unless the user requests a change. Resolve disagreement
between the conversation and project documents before drafting replacements.
Accepted projects and existing work items keep their pinned design; a change
uses the existing new-baseline acceptance process, not an automatic migration.

Record the chosen approach, rationale, applicable boundaries, trade-offs, and
explicit exclusions in the draft brief. Put the authoritative decision and
alternatives in the foundation ADR, and summarize it in `spec.decisions`. Do not
add an `architecture` property to project JSON: its schema is strict. The
existing decision and document inventory pin the choice in the baseline.

## Apply the selected principles

For DDD, establish the project's domain vocabulary, responsibilities, and
boundaries. Document business invariants and where they are enforced. Define
entities, value objects, aggregates, repositories, or domain services only where
the domain needs them. Give concrete dependency rules between domain logic,
application coordination, and external adapters. Keep framework and persistence
details out of domain rules. Use the actual selected language and toolchain.

Scale the structure to the first useful version. DDD does not automatically
require microservices, event sourcing, CQRS, event buses, or a class hierarchy.
For a small project, explain the cost of extra structure instead of inventing
domain complexity to justify the default.

For another approach, derive its actual module boundaries, dependency rules,
state and side-effect ownership, test seams, and review criteria. Use project
examples, not DDD text with a new heading. Do not introduce aggregates,
repositories, or other DDD requirements unless the agreed combination needs
them. For user-defined principles, clarify only ambiguities that change these
rules. Record the intended precedence when combined principles conflict.

## Create the corresponding skills

Use the project's native repository-local skill root. Create or deliberately
update these skills; reuse equivalent existing skills when they already serve
the selected approach:

- `project-architecture`: guide design, planning, and implementation. State the
  chosen philosophy and rationale, actual module paths and responsibilities,
  allowed and forbidden dependencies, domain or state invariants, and a small
  correct/incorrect example in the selected language. Include test guidance and
  the procedure for proposing an exception or design change.
- `project-architecture-review`: review plans and code against those same
  decisions. Give concrete checks for boundary violations, misplaced logic or
  side effects, and tests of the agreed invariants. Findings need file or plan
  evidence, impact, and a suggested correction. Use the factory's existing
  findings format and severity rules. Review stages stay read-only; route fixes
  through their existing rework transitions.

Each `SKILL.md` needs a matching `name` and a specific `description`. Scope the
review skill to review work: the factory lists project skills on every
interactive stage, which must not turn implementation into a read-only stage.
Keep instructions actionable and project-specific. Link longer examples or rules
as local references rather than duplicating them in both skills. Do not copy a
generic upstream DDD skill or require an extra agent-specific plugin.

Add both selected skill names to `spec.skills`. List the implementation skill
file with role `architecture-skill` and the review skill with role
`review-guidance` in `spec.documents`. Include all supporting references needed
by either skill, with their applicable role. Retain the seven required roles and
existing useful documents. Link these skills from the native project
instructions so work outside a factory uses the same decisions.

Before asking for baseline acceptance, check that the ADR, conventions, design
documents, both skills, and review guidance agree. Exercise each skill on one
representative design/change example to check that its rules match the choice.
Confirm native loading, reference resolution, document inventory, and the
preview's `work.skills` entries. Record these results in the existing validation
transcript. Structural `check` alone cannot judge philosophical consistency.

Factory stages use these accepted skill contents, not a newly installed generic
default. Selecting a philosophy is not approval of the final baseline and does
not authorize external actions.
