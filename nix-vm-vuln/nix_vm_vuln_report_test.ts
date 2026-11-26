import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { renderVulnerabilityReport, VulnerabilityScan } from "./nix_vm_vuln.ts";
import { report } from "./nix_vm_vuln_report.ts";

const scan = VulnerabilityScan.parse({
  scannedAt: "2026-11-26T03:04:05.000Z",
  host: "192.0.2.10",
  sshUser: "jimmykeech",
  hostname: "guest",
  osName: "NixOS",
  osVersion: "26.05",
  nixosVersion: "26.05.20260101.abc",
  nixpkgsRevision: "0123456789abcdef",
  kernel: "6.6.52",
  system: "x86_64",
  currentSystem: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-nixos-system-guest-26.05",
  storePathCount: 4,
  packageCount: 2,
  queriedCount: 2,
  inventoryTruncated: false,
  queryTruncated: false,
  findingCount: 1,
  findingsTruncated: false,
  counts: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 },
  findings: [{
    id: "CVE-2024-5535",
    aliases: [],
    packageName: "openssl",
    installedVersion: "3.0.13",
    queriedVersion: "3.0.13",
    severity: "high",
    confidence: "version-match",
    ecosystem: "Debian:12",
    summary: "openssl memory corruption",
    url: "https://osv.dev/vulnerability/CVE-2024-5535",
    fixedIn: "3.0.14",
  }],
  feedErrors: [],
});

Deno.test("report reads the stored scan and skips other behavior types", async () => {
  const content = new TextEncoder().encode(JSON.stringify(scan));
  const rendered = await report.execute({
    scope: "method",
    modelType: "@jamesakeech/nix-vm-vuln-scan",
    modelId: "guest",
    executionStatus: "succeeded",
    dataHandles: [{
      name: "scan",
      specName: "vulnerabilityScan",
      version: 1,
    }],
    dataRepository: {
      getContent: () => Promise.resolve(content),
    },
  });
  assertStringIncludes(rendered.markdown, "CVE-2024-5535");
  assertStringIncludes(rendered.markdown, "jimmykeech@192.0.2.10");
  assertEquals(rendered.json.status, "succeeded");

  const other = await report.execute({
    scope: "method",
    modelType: "@jamesakeech/vault-audit-trail",
    executionStatus: "succeeded",
    dataHandles: [],
  });
  assertEquals(other.json.applicable, false);
});

Deno.test("report describes a failed scan without inventing findings", async () => {
  const rendered = await report.execute({
    scope: "method",
    modelType: "@jamesakeech/nix-vm-vuln-scan",
    executionStatus: "failed",
    errorMessage: "SSH scan failed: Permission denied",
    dataHandles: [],
  });
  assertStringIncludes(rendered.markdown, "did not finish");
  assertStringIncludes(rendered.markdown, "Permission denied");
  assertEquals(rendered.json.status, "failed");
  assertEquals(renderVulnerabilityReport(scan).json.findingCount, 1);
});
