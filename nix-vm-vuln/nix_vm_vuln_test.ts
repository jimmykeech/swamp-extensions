import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  assembleScan,
  collectPackages,
  Finding,
  findingsFromGithub,
  findingsFromOsv,
  inventoryScript,
  kernelPackage,
  normalizeVersion,
  osvQueries,
  parseInventory,
  parseStorePath,
  renderVulnerabilityReport,
  runScan,
  sshCommandArgs,
  targetErrors,
  versionInRange,
  VulnerabilityScan,
  type FindingRecord,
  type OsvQuery,
  type SshTarget,
} from "./nix_vm_vuln.ts";

const closure = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-nixos-system-guest-26.05";
const target: SshTarget = {
  host: "192.0.2.10",
  sshUser: "jimmykeech",
  port: 22,
  identityFile: "",
};

function store(hashChar: string, name: string): string {
  return `/nix/store/${hashChar.repeat(32)}-${name}`;
}

function inventoryText(): string {
  return [
    "login motd",
    "NIX-VM-SCAN/1",
    "hostname=guest",
    "kernel=6.6.52",
    "system=x86_64",
    `current_system=${closure}`,
    "os_name=NixOS",
    "os_version=26.05",
    "nixos_version=26.05",
    'nixos_json={"nixosVersion":"26.05.20260101.abc","nixpkgsRevision":"0123456789abcdef"}',
    "---packages---",
    store("b", "openssl-3.0.13"),
    store("c", "openssl-3.0.13-bin"),
    store("d", "glibc-2.40-66"),
    store("e", "nixos-system-guest-26.05"),
    store("f", "source"),
    "---end---",
  ].join("\n");
}

function finding(index: number, severity: "critical" | "low"): FindingRecord {
  const id = `CVE-2024-${String(index).padStart(4, "0")}`;
  return Finding.parse({
    id,
    aliases: [],
    packageName: "openssl",
    installedVersion: "1.0.0",
    queriedVersion: "1.0.0",
    severity,
    confidence: "version-match",
    ecosystem: "Debian:13",
    summary: "sample",
    url: `https://osv.dev/vulnerability/${id}`,
    fixedIn: "",
  });
}

Deno.test("the remote script is read-only shell", async () => {
  for (const banned of ["nixos-rebuild", "rm ", "mkfs", "reboot", "curl ", "wget ", "poweroff"]) {
    assertEquals(inventoryScript.includes(banned), false, banned);
  }
  assertStringIncludes(inventoryScript, 'nix-store -qR "$current"');
  const check = new Deno.Command("bash", {
    args: ["-n"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = check.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(inventoryScript));
  await writer.close();
  const result = await child.output();
  assertEquals(new TextDecoder().decode(result.stderr), "", "bash -n");
  assertEquals(result.success, true);
});

Deno.test("parses a booted closure and ignores outputs, sources, and the system path", () => {
  assertEquals(parseStorePath(store("b", "openssl-3.0.13-bin")), {
    name: "openssl",
    installedVersion: "3.0.13",
  });
  assertEquals(parseStorePath(store("e", "nixos-system-guest-26.05")), null);
  assertEquals(normalizeVersion("2.40-66"), "2.40");
  const inventory = parseInventory(inventoryText());
  assertEquals(inventory.hostname, "guest");
  assertEquals(inventory.nixpkgsRevision, "0123456789abcdef");
  assertEquals(inventory.currentSystem, closure);
  const packages = collectPackages(inventory.storePaths);
  assertEquals(packages.map((pkg) => `${pkg.name}@${pkg.installedVersion}->${pkg.queriedVersion}`), [
    "glibc@2.40-66->2.40",
    "openssl@3.0.13->3.0.13",
  ]);
  assertEquals(kernelPackage(inventory.kernel)?.queriedVersion, "6.6.52");
});

Deno.test("rejects a host that is not NixOS and a target that is not a host name", () => {
  let message = "";
  try {
    parseInventory("NIX-VM-SCAN/1\nerror=not-nixos\n");
  } catch (error) {
    message = (error as Error).message;
  }
  assertStringIncludes(message, "not a running NixOS system");
  assertEquals(targetErrors({ ...target, host: "evil;touch /tmp/x" }), ["SSH target is not a host name"]);
  assertEquals(targetErrors({ ...target, host: "" }), ["host is required"]);
  assertEquals(targetErrors({ ...target, identityFile: "../id_rsa" }), ["SSH identity path is not allowed"]);
  assertEquals(targetErrors(target), []);
  assertEquals(sshCommandArgs({ ...target, identityFile: "/tmp/id_rsa" }).slice(-4), [
    "--",
    "jimmykeech@192.0.2.10",
    "bash",
    "-s",
  ]);
  assertStringIncludes(sshCommandArgs(target).join(" "), "BatchMode=yes");
});

Deno.test("compares versions numerically and keeps an unparsed range", () => {
  assertEquals(versionInRange("1.10", "< 1.9"), false);
  assertEquals(versionInRange("1.9", "< 1.10"), true);
  assertEquals(versionInRange("3.0.13", ">= 1.0.0, < 3.0.14"), true);
  assertEquals(versionInRange("3.0.14", ">= 1.0.0, < 3.0.14"), false);
  assertEquals(versionInRange("1.2.3", "before 1.2"), true);
});

Deno.test("keeps an OSV match only when the package name agrees", () => {
  const queries: OsvQuery[] = [
    {
      name: "openssl",
      matchName: "openssl",
      installedVersion: "3.0.13",
      queriedVersion: "3.0.13",
    },
    {
      name: "linux",
      matchName: "Kernel",
      installedVersion: "6.6.52",
      queriedVersion: "6.6.52",
      ecosystem: "Linux",
    },
  ];
  const findings = findingsFromOsv(queries, [
    {
      vulns: [{
        id: "CVE-2024-2222",
        summary: "wrong package",
        affected: [{ package: { ecosystem: "PyPI", name: "not-openssl" } }],
      }],
    },
    {
      vulns: [{
        id: "CVE-2024-3333",
        summary: "kernel overflow",
        aliases: ["GHSA-abcd-efgh-ijkl"],
        severity: [{
          type: "CVSS_V3",
          score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        }],
        affected: [{
          package: { ecosystem: "Linux", name: "Kernel" },
          ranges: [{ type: "ECOSYSTEM", events: [{ fixed: "6.6.53" }] }],
        }],
      }],
    },
  ]);
  assertEquals(findings.map((item) => item.id), ["CVE-2024-3333"]);
  assertEquals(findings[0].severity, "critical");
  assertEquals(findings[0].packageName, "linux");
  assertEquals(findings[0].fixedIn, "6.6.53");
  assertEquals(findings[0].aliases, ["GHSA-abcd-efgh-ijkl"]);
});

Deno.test("matches NixOS advisories by package range and skips a fixed version", () => {
  const packages = collectPackages([
    store("b", "openssl-3.0.13"),
    store("d", "glibc-2.40-66"),
  ]);
  const findings = findingsFromGithub(packages, [
    {
      ghsa_id: "GHSA-w5j5-2jpq-3cv3",
      cve_id: "CVE-2026-1000",
      html_url: "https://github.com/advisories/GHSA-w5j5-2jpq-3cv3",
      summary: "openssl parsing bug",
      severity: "medium",
      vulnerabilities: [{
        package: { ecosystem: "nixpkgs", name: "openssl" },
        vulnerable_version_range: "< 3.0.14",
        patched_versions: "3.0.14",
      }],
    },
    {
      ghsa_id: "GHSA-aaaa-bbbb-cccc",
      summary: "glibc too new for this range",
      severity: "low",
      vulnerabilities: [{
        package: { name: "glibc" },
        vulnerable_version_range: ">= 3.0.0",
      }],
    },
    {
      ghsa_id: "GHSA-dddd-eeee-ffff",
      summary: "The qemu builder is local",
      description: "no package metadata",
      severity: "high",
      vulnerabilities: [],
    },
  ], "nixpkgs");
  assertEquals(findings.map((item) => `${item.packageName}:${item.id}`), ["openssl:GHSA-w5j5-2jpq-3cv3"]);
  assertEquals(findings[0].confidence, "nixpkgs-advisory");
  assertEquals(findings[0].fixedIn, "3.0.14");
  assertEquals(packages[1].name, "openssl");
});

Deno.test("stores the highest-severity slice and renders it", () => {
  const inventory = parseInventory(inventoryText());
  const findings = [finding(1, "low"), finding(2, "critical")];
  for (let index = 3; index <= 202; index++) findings.push(finding(index, "low"));
  const selected = osvQueries(collectPackages(inventory.storePaths), inventory.kernel, 1);
  const scan = assembleScan({
    now: new Date("2026-11-26T00:00:00.000Z"),
    target,
    inventory,
    packageCount: 3,
    queries: selected.queries,
    queryTruncated: selected.queryTruncated,
    findings,
    feedErrors: ["OSV returned 429"],
  });
  assertEquals(scan.findingCount, 202);
  assertEquals(scan.findingsTruncated, true);
  assertEquals(scan.findings.length, 200);
  assertEquals(scan.findings[0].severity, "critical");
  assertEquals(scan.counts.critical, 1);
  assertEquals(scan.queryTruncated, true);
  VulnerabilityScan.parse(scan);
  const rendered = renderVulnerabilityReport(scan);
  assertStringIncludes(rendered.markdown, "OSV has no Nix ecosystem");
  assertStringIncludes(rendered.markdown, "CVE-2024-0002");
  assertStringIncludes(rendered.markdown, "Showing 200 of 202");
  assertEquals(rendered.json.findingCount, 202);
});

Deno.test("scans with injected SSH and feeds, and writes one resource", async () => {
  let queried = 0;
  let written: unknown;
  const result = await runScan({ maxPackages: 10 }, {
    globalArgs: target,
    writeResource: (_spec, name, data) => {
      written = data;
      return Promise.resolve({ name });
    },
    logger: { info: () => {}, warning: () => {} },
  }, {
    readInventory: () => Promise.resolve(inventoryText()),
    queryOsv: (queries) => {
      queried = queries.length;
      const slots = queries.map((query) => {
        if (query.name !== "openssl") return { vulns: [] };
        return {
          vulns: [{
            id: "CVE-2024-5535",
            summary: "openssl memory corruption",
            database_specific: { severity: "HIGH" },
            affected: [{
              package: { ecosystem: "Debian:12", name: "openssl" },
              ranges: [{ events: [{ fixed: "3.0.14" }] }],
            }],
          }],
        };
      });
      return Promise.resolve({ value: slots, errors: [] });
    },
    githubAdvisories: (_owner, repo) => {
      if (repo === "nix") return Promise.reject(new Error("GitHub returned 503"));
      return Promise.resolve({
        value: [{
          ghsa_id: "GHSA-w5j5-2jpq-3cv3",
          summary: "openssl parsing bug",
          severity: "medium",
          html_url: "https://github.com/advisories/GHSA-w5j5-2jpq-3cv3",
          vulnerabilities: [{
            package: { name: "openssl" },
            vulnerable_version_range: "< 3.0.14",
            patched_versions: "3.0.14",
          }],
        }],
        errors: [],
      });
    },
  }, new Date("2026-11-26T03:04:05.000Z"));
  const scan = VulnerabilityScan.parse(written);
  assertEquals(result.dataHandles, [{ name: "scan" }]);
  assertEquals(queried, 3);
  assertEquals(scan.host, "192.0.2.10");
  assertEquals(scan.nixosVersion, "26.05.20260101.abc");
  assertEquals(scan.findingCount, 2);
  assertEquals(scan.findings.map((item) => `${item.severity}:${item.id}`), [
    "high:CVE-2024-5535",
    "medium:GHSA-w5j5-2jpq-3cv3",
  ]);
  assertEquals(scan.feedErrors, ["GitHub returned 503"]);
});

Deno.test("does not write a scan when SSH fails or the host is not NixOS", async () => {
  let writes = 0;
  const context = {
    globalArgs: target,
    writeResource: () => {
      writes += 1;
      return Promise.resolve({ name: "scan" });
    },
  };
  await assertRejects(
    () => runScan({}, context, unavailable("connection refused"), new Date("2026-11-26T00:00:00.000Z")),
    Error,
    "connection refused",
  );
  await assertRejects(
    () =>
      runScan({}, context, {
        ...unavailable(""),
        readInventory: () => Promise.resolve("NIX-VM-SCAN/1\nerror=not-nixos\n"),
      }, new Date("2026-11-26T00:00:00.000Z")),
    Error,
    "not a running NixOS system",
  );
  await assertRejects(
    () => runScan({}, { ...context, globalArgs: { ...target, host: "bad host" } }, unavailable(""), new Date()),
    Error,
    "not a host name",
  );
  assertEquals(writes, 0);
});

function unavailable(message: string) {
  return {
    readInventory: () => Promise.reject(new Error(message)),
    queryOsv: () => Promise.resolve({ value: [], errors: [] }),
    githubAdvisories: () => Promise.resolve({ value: [], errors: [] }),
  };
}
