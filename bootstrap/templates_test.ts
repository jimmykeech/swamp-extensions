import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { FactorySchema } from "./schema.ts";
import {
  createFactoryArguments,
  type FactoryTemplateOptions,
} from "./templates.ts";

type Gate = { type: string; config: Record<string, unknown> };
type Stage = {
  id: string;
  maxCycles?: number;
  work?: {
    skills?: string[];
    systemPrompt?: string;
    context?: { inject: string[] };
    workflow?: { name: string; inputs: Record<string, unknown> };
  };
  artifacts?: { name: string; schema?: Record<string, unknown> }[];
  transitions?: { name: string; to: string; gates: Gate[] }[];
};

const options: FactoryTemplateOptions = {
  bootstrapModel: "project-bootstrap",
  workItem: "local-example-1",
  baselineId: "baseline-example",
  workflowName: "verify-local-example-1",
  contextPaths: ["AGENTS.md", "docs/conventions.md"],
  skills: ["project-architecture"],
  maxCycles: 3,
  requirePlanApproval: false,
  requireDeliveryApproval: true,
};

function stages(value: FactoryTemplateOptions = options): Stage[] {
  return createFactoryArguments(value).stages as Stage[];
}

function stage(id: string, value: FactoryTemplateOptions = options): Stage {
  const result = stages(value).find((item) => item.id === id);
  ok(result, `Missing stage: ${id}`);
  return result;
}

Deno.test("factory pins context and per-work-item verification identity", () => {
  const first = stage("verification");
  const second = stage("verification", {
    ...options,
    workItem: "local-example-2",
    workflowName: "verify-local-example-2",
  });
  equal(first.work?.workflow?.name, "verify-local-example-1");
  equal(second.work?.workflow?.name, "verify-local-example-2");
  equal(first.work?.workflow?.inputs.workItem, "local-example-1");
  equal(second.work?.workflow?.inputs.workItem, "local-example-2");
  equal(first.work?.workflow?.inputs.baselineId, options.baselineId);
  const verified = first.transitions?.find((item) => item.name === "pass");
  deepStrictEqual(
    verified?.gates.find((gate) => gate.type === "workflow-succeeded")?.config,
    {
      workflow: options.workflowName,
      requireStepOutputs: ["evidence-verification-seal"],
    },
  );
  for (const id of ["planning", "plan-review", "implementing", "code-review"]) {
    ok(stage(id).work?.context?.inject.includes("project-context"));
  }
});

Deno.test("factory customization adds bounded reviews and final approvals without replacing protected gates", () => {
  deepStrictEqual(
    createFactoryArguments({
      ...options,
      factory: { base: "bootstrap-default" },
    }),
    createFactoryArguments(options),
  );
  const customized: FactoryTemplateOptions = {
    ...options,
    requirePlanApproval: true,
    factory: {
      base: "bootstrap-default",
      stages: [{
        stage: "implementing",
        instructions: "Use focused boundary tests.",
        skills: ["project-testing"],
      }],
      reviews: [
        {
          id: "risk-review",
          after: "plan-review",
          instructions: "Review domain invariant risks.",
        },
        {
          id: "security-review",
          after: "code-review",
          instructions: "Review access control.",
          skills: ["project-security-review"],
          requireApproval: true,
        },
        {
          id: "usability-review",
          after: "code-review",
          instructions: "Review user-facing errors.",
        },
      ],
    },
  };
  deepStrictEqual(stages(customized).map((entry) => entry.id), [
    "import-context",
    "planning",
    "plan-review",
    "risk-review",
    "implementing",
    "verification",
    "code-review",
    "security-review",
    "usability-review",
    "ready",
    "aborted",
  ]);
  deepStrictEqual(stage("verification", customized), stage("verification"));
  const implementation = stage("implementing", customized);
  deepStrictEqual(implementation.work?.skills, [
    "bootstrap-factory",
    "project-architecture",
    "project-testing",
  ]);
  ok(
    implementation.work?.systemPrompt?.includes("Use focused boundary tests."),
  );
  ok(
    implementation.work?.systemPrompt?.includes(
      "security-review, usability-review",
    ),
  );
  deepStrictEqual(
    implementation.transitions,
    stage("implementing").transitions,
  );
  const acceptance = (id: string) =>
    stage(id, customized).transitions!.find((transition) =>
      transition.name === "accept"
    )!;
  for (const id of ["plan-review", "code-review"]) {
    equal(
      acceptance(id).gates.some((gate) => gate.type === "human-approval"),
      false,
    );
    ok(acceptance(id).gates.some((gate) => gate.type === "findings-clear"));
  }
  for (
    const [id, subject, target] of [["risk-review", "plan", "planning"], [
      "security-review",
      "change-summary",
      "implementing",
    ], ["usability-review", "change-summary", "implementing"]]
  ) {
    const review = stage(id, customized);
    equal(review.maxCycles, options.maxCycles);
    deepStrictEqual(review.artifacts, [{
      name: id,
      kind: "findings",
      reviews: subject,
    }]);
    equal(review.transitions![1].to, target);
    deepStrictEqual(review.transitions![1].gates.map((gate) => gate.type), [
      "artifact-fresh",
      "cel",
    ]);
    equal(acceptance(id).gates[0].config.recordedThisCycle, true);
    deepStrictEqual(acceptance(id).gates[1].config.blocking, [
      "critical",
      "high",
    ]);
  }
  deepStrictEqual(acceptance("risk-review").gates.at(-1), {
    type: "human-approval",
    config: { id: "plan-approval" },
  });
  deepStrictEqual(acceptance("security-review").gates.at(-1), {
    type: "human-approval",
    config: { id: "review-security-review-approval" },
  });
  deepStrictEqual(acceptance("usability-review").gates.at(-1), {
    type: "human-approval",
    config: { id: "delivery-approval" },
  });
  for (const id of ["security-review", "usability-review"]) {
    deepStrictEqual(
      acceptance(id).gates[2],
      stage("code-review").transitions![0].gates[2],
    );
  }
  equal(acceptance("security-review").to, "usability-review");
  equal(acceptance("usability-review").to, "ready");
  equal(
    stage("planning", customized).work?.skills?.includes(
      "project-security-review",
    ),
    false,
  );
  for (
    const invalid of [
      { base: "unknown" },
      {
        base: "bootstrap-default",
        stages: [{ stage: "verification", instructions: "Skip tests" }],
      },
      {
        base: "bootstrap-default",
        stages: [{
          stage: "planning",
          instructions: "${{ data.latest(self.name, 'state') }}",
        }],
      },
      {
        base: "bootstrap-default",
        stages: [{ stage: "planning", instructions: "__WORK_ITEM__" }],
      },
      {
        base: "bootstrap-default",
        stages: [{ stage: "planning", skills: ["project-testing"] }, {
          stage: "planning",
          instructions: "Duplicate",
        }],
      },
      {
        base: "bootstrap-default",
        reviews: [{
          id: "plan",
          after: "plan-review",
          instructions: "Name collision",
        }],
      },
      {
        base: "bootstrap-default",
        reviews: [{
          id: "risk-review",
          after: "plan-review",
          instructions: "Review",
        }, {
          id: "risk-review",
          after: "code-review",
          instructions: "Duplicate",
        }],
      },
      {
        base: "bootstrap-default",
        reviews: [{
          id: "risk-review",
          after: "plan-review",
          instructions: "Review",
          gates: [],
        }],
      },
    ]
  ) throws(() => FactorySchema.parse(invalid));
});

Deno.test("review and rework gates are fresh, conditional, and bounded", () => {
  for (const id of ["plan-review", "code-review"]) {
    const review = stage(id);
    equal(review.maxCycles, 3);
    const rework = review.transitions?.find((item) => item.name === "rework");
    deepStrictEqual(rework?.gates.map((gate) => gate.type), [
      "artifact-fresh",
      "cel",
    ]);
    equal(rework?.gates[0].config.recordedThisCycle, true);
    const expression = rework?.gates[1].config.expr;
    ok(
      typeof expression === "string" && expression.includes("!has(f.resolved)"),
    );
    const accept = review.transitions?.find((item) => item.name === "accept");
    ok(accept?.gates.some((gate) => gate.type === "findings-clear"));
  }
  for (const id of ["planning", "implementing"]) {
    const gate = stage(id).transitions?.[0].gates[0];
    equal(gate?.type, "artifact-fresh");
    equal(gate?.config.recordedThisCycle, true);
  }
  throws(
    () => createFactoryArguments({ ...options, maxCycles: 0 }),
    /positive integer/,
  );
});

Deno.test("routine approval is optional while delivery follows the accepted policy", () => {
  const acceptance = (
    id: string,
    value: FactoryTemplateOptions = options,
  ): Gate[] =>
    stage(id, value).transitions?.find((item) => item.name === "accept")
      ?.gates ?? [];
  equal(
    acceptance("plan-review").some((gate) => gate.type === "human-approval"),
    false,
  );
  equal(
    acceptance("code-review").some((gate) => gate.type === "human-approval"),
    true,
  );
  equal(
    acceptance("plan-review", { ...options, requirePlanApproval: true })
      .some((gate) => gate.type === "human-approval"),
    true,
  );
  equal(
    acceptance("code-review", { ...options, requireDeliveryApproval: false })
      .some((gate) => gate.type === "human-approval"),
    false,
  );
});
