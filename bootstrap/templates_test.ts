import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
  createFactoryArguments,
  type FactoryTemplateOptions,
} from "./templates.ts";

type Gate = { type: string; config: Record<string, unknown> };
type Stage = {
  id: string;
  maxCycles?: number;
  work?: {
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
