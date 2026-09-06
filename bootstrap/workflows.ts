/** Deterministic verification DAGs. Swamp allocates IDs at installation time. @module */
import type { Project } from "./schema.ts";

/** Replace complete sentinel values only; never interpolate arbitrary text or CEL. */
export function substitute(
  value: unknown,
  replacements: Record<string, string>,
): unknown {
  if (typeof value === "string") return replacements[value] ?? value;
  if (Array.isArray(value)) {
    return value.map((entry) => substitute(entry, replacements));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, entry],
      ) => [key, substitute(entry, replacements)]),
    );
  }
  return value;
}

/** Build an ID-free verification template from accepted check definitions. */
export function createVerificationTemplate(
  project: Project,
): Record<string, unknown> {
  const input = {
    workItem: "${{ inputs.workItem }}",
    baselineId: "${{ inputs.baselineId }}",
    expectedDigest: "${{ inputs.expectedDigest }}",
  };
  const steps: Record<string, unknown>[] = [{
    name: "begin",
    task: {
      type: "model_method",
      modelIdOrName: "__BOOTSTRAP_MODEL__",
      methodName: "begin_verification",
      inputs: input,
    },
  }];
  let previous = "begin";
  for (const check of project.verification.checks) {
    steps.push({
      name: check.name,
      dependsOn: [{ step: previous, condition: { type: "succeeded" } }],
      task: {
        type: "model_method",
        modelType: check.modelType,
        modelName: `__CHECK_${check.name}__`,
        methodName: check.methodName,
        globalArgs: check.globalArgs,
        inputs: check.inputs,
      },
    });
    previous = check.name;
  }
  steps.push({
    name: "seal",
    dependsOn: [{ step: previous, condition: { type: "succeeded" } }],
    task: {
      type: "model_method",
      modelIdOrName: "__BOOTSTRAP_MODEL__",
      methodName: "seal_verification",
      inputs: input,
    },
  });
  // The engine requires evidence owned by the factory and written in THIS run.
  steps.push({
    name: "record",
    dependsOn: [{ step: "seal", condition: { type: "succeeded" } }],
    task: {
      type: "model_method",
      modelIdOrName: "__FACTORY_NAME__",
      methodName: "record_evidence",
      inputs: {
        workItem: "${{ inputs.workItem }}",
        name: "verification-seal",
        payload: "__SEAL_EXPRESSION__",
      },
    },
  });
  return {
    name: "__VERIFY_WORKFLOW__",
    description:
      "Run accepted checks for one work item and bind evidence to its source digest and baseline.",
    inputs: {
      properties: {
        workItem: { type: "string", enum: ["__WORK_ITEM__"] },
        baselineId: { type: "string", enum: ["__BASELINE_ID__"] },
        expectedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["workItem", "baselineId", "expectedDigest"],
    },
    jobs: [{ name: "verify", steps }],
  };
}
