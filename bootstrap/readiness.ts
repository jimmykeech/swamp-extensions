/** Render the controller's exact readiness result, including failure status. @module */

interface ReportContext {
  modelType: string;
  modelId: string;
  methodName: string;
  executionStatus: string;
  dataHandles: { name: string; specName: string; version: number }[];
  dataRepository: {
    getContent(
      type: string,
      id: string,
      name: string,
      version: number,
    ): Promise<Uint8Array | null>;
  };
}

/** Readiness is based on the current execution, never stale model output. */
export const report = {
  name: "@jamesakeech/bootstrap/readiness",
  description:
    "Report configuration acceptance separately from verified operation.",
  scope: "method" as const,
  labels: ["bootstrap", "readiness"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const handle = context.dataHandles.find((entry) =>
      entry.specName === "readiness"
    );
    if (!handle || context.executionStatus !== "succeeded") {
      return {
        markdown:
          `Bootstrap readiness was not established by this ${context.executionStatus} execution.`,
        json: { established: false, executionStatus: context.executionStatus },
      };
    }
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) {
      throw new Error("Readiness output from this execution is unavailable.");
    }
    const value = JSON.parse(new TextDecoder().decode(raw)) as Record<
      string,
      unknown
    >;
    const configured = value.configurationReady === true;
    const verified = value.operationallyVerified === true;
    return {
      markdown: `# Bootstrap readiness\n\nConfiguration: ${
        configured ? "accepted and current" : "not ready"
      }.\n\nOperation: ${
        verified
          ? "verified against the current baseline and source"
          : "not verified"
      }.\n\nNext step: ${
        !configured
          ? "resolve the controller's recorded blockers"
          : !verified
          ? "complete a small work item through its verification workflow"
          : "continue with the next authorized work item"
      }.\n`,
      json: value,
    };
  },
};
