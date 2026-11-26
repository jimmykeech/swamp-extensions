/**
 * Render the Nix VM vulnerability scan as markdown and JSON.
 *
 * @module
 */
import {
  nixVmVulnScanType,
  renderVulnerabilityReport,
  VulnerabilityScan,
} from "./nix_vm_vuln.ts";

interface ScanHandle {
  name: string;
  specName?: string;
  version?: number;
  attributes?: Record<string, unknown>;
}

interface ReportContext {
  scope: string;
  modelType?: string;
  modelId?: string;
  executionStatus?: string;
  errorMessage?: string;
  dataHandles?: ScanHandle[];
  dataRepository?: {
    getContent: (
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
}

function notApplicable(): { markdown: string; json: Record<string, unknown> } {
  return {
    markdown: "Nix VM vulnerability report applies to a nix-vm-vuln-scan run.",
    json: { applicable: false },
  };
}

function failed(
  message: string,
): { markdown: string; json: Record<string, unknown> } {
  let error = "";
  for (const char of message) {
    const code = char.codePointAt(0) ?? 0;
    error += code <= 0x1f ? " " : char;
  }
  error = error.trim().slice(0, 500);
  return {
    markdown:
      `# Nix VM vulnerability report\n\nThe scan did not finish.\n\n${error}\n`,
    json: { applicable: true, status: "failed", error },
  };
}

async function loadScan(context: ReportContext): Promise<unknown | null> {
  const handle = context.dataHandles?.find((item) =>
    item.specName === "vulnerabilityScan" || item.name === "scan"
  );
  if (!handle) return null;
  if (context.dataRepository && context.modelType && context.modelId) {
    const bytes = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
    if (bytes) return JSON.parse(new TextDecoder().decode(bytes));
  }
  return handle.attributes ?? null;
}

/** Method-scope markdown and JSON report for one stored scan. */
export const report = {
  name: "@jamesakeech/nix-vm-vuln-report",
  description:
    "Summarize a NixOS VM vulnerability scan, with severity counts and advisory links.",
  scope: "method" as const,
  labels: ["security", "nix"],
  execute: async (context: ReportContext) => {
    const handle = context.dataHandles?.find((item) =>
      item.specName === "vulnerabilityScan" || item.name === "scan"
    );
    const ours = context.modelType === nixVmVulnScanType;
    if (!ours && !handle) return notApplicable();
    if (context.executionStatus === "failed") {
      return failed(context.errorMessage ?? "");
    }
    let payload: unknown;
    try {
      payload = await loadScan(context);
    } catch {
      return failed("The stored scan could not be read.");
    }
    if (!payload) return failed("The scan stored no inventory.");
    const parsed = VulnerabilityScan.safeParse(payload);
    if (!parsed.success) {
      return failed("The stored scan did not match the report schema.");
    }
    return renderVulnerabilityReport(parsed.data);
  },
};
