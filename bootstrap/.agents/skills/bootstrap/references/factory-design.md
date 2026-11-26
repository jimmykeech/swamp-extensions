# Design the project factory

Read this after the project architecture and its skills are drafted, before
checking or accepting the baseline. The active native agent conducts this
conversation; the controller only validates and snapshots the resulting data.

## Outline, customise, then confirm

1. Read the conversation, `docs/bootstrap/brief.md`, project decisions, and any
   existing factory configuration. Reuse confirmed choices. An accepted baseline
   resumes its own template; do not restart factory design for an existing item.
2. Outline this starting lifecycle in terms of the actual project:

   ```text
   import context → plan → plan review → implement → verify → code review → ready
                          ↖ plan rework              ↖ implementation rework
   ```

   This is bootstrap's default profile on `@swamp/software-factory`, not a fixed
   lifecycle imposed by the generic engine. Explain each stage's responsibility,
   its artifact, which architecture skills it uses, the proposed real checks,
   and where work returns after failure. Explain the proposed approval settings
   and rework limit. Unknown runner details remain proposals, not validated
   facts.
3. Recommend project-specific changes only where the design justifies them. For
   example, propose a security review for an authentication boundary or an
   accessibility review for a user interface. Explain why each is useful. Then
   ask: **Would you like to keep this factory, or change its reviews, checks,
   stage guidance, skills, or approval points?** Wait for the answer. Do not
   silently choose the default or auto-accept your recommendations.
4. Resolve one material open choice at a time. Accept plain-language requests
   and "not sure"; recommend a proportionate option and ask whether to use it.
   Do not ask the user to write configuration. Search existing runner and
   tracker extensions and inspect their exact method schemas before configuring
   real integrations. Default to local work items when tracker choice is
   unresolved.
5. Record confirmed choices, rationale, unresolved questions, and the next step
   in the working brief. Distinguish proposed from confirmed choices. Save the
   project-owned outline in `docs/bootstrap/factory.md`, including the ordered
   stages, outputs, skill assignments, check commands, rework routes, approval
   points, and limits. Include that file in `documents` with role `decision`. It
   must not refer to its own baseline digest. On resume, ask only the next
   unresolved question; do not replace the saved custom design with the base.
6. Write the corresponding `factory`, `verification`, `policy`, and integration
   fields in the project JSON. Present the final outline and changes from the
   base, and obtain confirmation that it represents the user's choices. An
   explicit answer accepting an unchanged outline is sufficient; do not ask
   again. This confirms a proposed factory design, not baseline acceptance or
   permission to start coding or deliver externally.

Continue with `check`, `preview`, concrete Swamp validation, and explicit
acceptance of the complete baseline digest. Use the preview factory's `describe`
method to check the actual graph against the agreed outline. A saved diagram or
successful schema parse alone does not validate the factory.

## Supported configuration

`factory` is optional for compatibility. Omission preserves the previous default
template. For new onboarding, record `{"base":"bootstrap-default"}` when the
user selects the unchanged base. Do not infer confirmation from a missing field.

The agent can configure:

- `factory.stages`: up to four entries, one per `planning`, `plan-review`,
  `implementing`, or `code-review`. Each needs `instructions`, `skills`, or
  both. Instructions supplement the base contract; they do not replace it.
- `factory.reviews`: up to eight additional read-only review passes. Each has a
  unique lowercase hyphenated `id` of at most 48 characters, `after` set to
  `plan-review` or `code-review`, and concrete `instructions`. Optional `skills`
  add specialist guidance. Optional `requireApproval: true` adds a human gate
  named `review-<id>-approval`. Reviews at each insertion point run in listed
  order. They are sequential passes by the active driver, not automatically
  independent agents.
- `verification.checks`: the real ordered checks, through existing Swamp model
  methods. Inventory all source and build inputs in `sourcePaths` and record
  exact runner versions. The human-readable `command` does not execute a check.
- `policy.requirePlanApproval`, `policy.requireDeliveryApproval`, and
  `policy.maxCycles` (1–5). Plan and delivery sign-off follow the last review in
  their respective chains. Each work stage retains two dispatches per entry.

Example fragment to merge into the complete specification:

```json
{
  "factory": {
    "base": "bootstrap-default",
    "stages": [
      {
        "stage": "planning",
        "instructions": "Identify changes to account isolation and propose focused boundary tests."
      }
    ],
    "reviews": [
      {
        "id": "security-review",
        "after": "code-review",
        "instructions": "Review account isolation, access checks, and unsafe input handling against the verified change. Do not edit source.",
        "skills": ["project-security-review"],
        "requireApproval": true
      }
    ]
  }
}
```

`spec.skills` remain project-wide skills loaded at every interactive stage.
Stage/review `skills` are additional names loaded only for that stage. Create or
reuse their project-local native skill files and inventory those files and
needed references in `documents` under the appropriate existing role. For the
example, inventory `<native-skills-root>/project-security-review/SKILL.md` as
`review-guidance`; do not add it to `spec.skills` unless it belongs at every
stage. Include actual project boundaries, allowed and forbidden examples, and
actionable review criteria. The driver reads their accepted snapshot contents.

Custom instructions are plain text, at most 2,000 characters each. Use a pinned
skill for longer guidance. CEL expressions and internal bootstrap placeholders
are not allowed in instructions. Keep credentials out of both text and files.
IDs cannot reuse any base stage, artifact, or evidence name.

## Protected behavior

Additional reviews record the standard findings artifact under their stage ID.
Plan reviews review `plan`; code reviews review `change-summary`. Each requires
fresh findings against the current subject. Unresolved critical/high findings
return to `planning` or `implementing`, respectively. Rework reruns the complete
downstream chain, including real verification after implementation. Code reviews
retain the matching source-digest, work-item, and baseline check.

This interface does not remove or reorder base stages, replace their artifact
schemas or gates, disable real verification, add arbitrary executable stages,
change the agent's authority, or edit generated definitions directly. Explain
unsupported requests before offering the nearest supported design; do not claim
to implement them through prompt text. Deployment, publishing, and issue writes
still need separate explicit authorization.

Changing an accepted factory requires a new checked, preview-validated, accepted
baseline. New items receive that template. Existing items retain their original
template, identities, workspace, and history.
