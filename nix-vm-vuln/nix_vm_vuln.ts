/**
 * Read-only inventory of a running NixOS VM and a vulnerability report.
 *
 * The VM is only asked to list the booted system closure. Advisory data is
 * fetched on the runner from OSV.dev and the NixOS GitHub security advisories.
 *
 * @module
 */
import { z } from "npm:zod@4.1.12";

export const nixVmVulnScanType = "@jamesakeech/nix-vm-vuln-scan";
export const nixVmVulnReportName = "@jamesakeech/nix-vm-vuln-report";

const maxFindings = 200;
const maxFeedErrors = 8;
const maxStorePaths = 5000;
const osvBatchSize = 100;

const outputSuffixes = new Set([
  "bin",
  "data",
  "debug",
  "dev",
  "devdoc",
  "doc",
  "info",
  "lib",
  "man",
  "manpages",
  "out",
]);

const skippedNames = new Set([
  "builder",
  "hook",
  "patch",
  "setup",
  "source",
  "stdenv",
  "unknown",
]);

const severityRank = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
} as const;

export const Severity = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
]);
export const Confidence = z.enum([
  "nixpkgs-advisory",
  "nix-advisory",
  "version-match",
]);

export const Finding = z.object({
  id: z.string().min(1).max(64),
  aliases: z.array(z.string().max(64)).max(8),
  packageName: z.string().min(1).max(80),
  installedVersion: z.string().min(1).max(80),
  queriedVersion: z.string().min(1).max(80),
  severity: Severity,
  confidence: Confidence,
  ecosystem: z.string().max(64),
  summary: z.string().max(300),
  url: z.string().max(300),
  fixedIn: z.string().max(80),
});

export const VulnerabilityScan = z.object({
  scannedAt: z.string().datetime(),
  host: z.string().min(1).max(253),
  sshUser: z.string().min(1).max(32),
  hostname: z.string().min(1).max(253),
  osName: z.string().max(120),
  osVersion: z.string().max(120),
  nixosVersion: z.string().max(120),
  nixpkgsRevision: z.string().max(64),
  kernel: z.string().max(120),
  system: z.string().max(32),
  currentSystem: z.string().min(1).max(240),
  storePathCount: z.number().int().nonnegative(),
  packageCount: z.number().int().nonnegative(),
  queriedCount: z.number().int().nonnegative(),
  inventoryTruncated: z.boolean(),
  queryTruncated: z.boolean(),
  findingCount: z.number().int().nonnegative(),
  findingsTruncated: z.boolean(),
  counts: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
  findings: z.array(Finding).max(maxFindings),
  feedErrors: z.array(z.string().max(200)).max(maxFeedErrors),
});

export type SeverityName = z.infer<typeof Severity>;
export type FindingRecord = z.infer<typeof Finding>;
export type VulnerabilityScanRecord = z.infer<typeof VulnerabilityScan>;

export interface SshTarget {
  host: string;
  sshUser: string;
  port: number;
  identityFile: string;
}

export interface PackageRef {
  name: string;
  installedVersion: string;
  queriedVersion: string;
}

export interface OsvQuery extends PackageRef {
  matchName: string;
  ecosystem?: string;
}

export interface Inventory {
  hostname: string;
  kernel: string;
  system: string;
  currentSystem: string;
  osName: string;
  osVersion: string;
  nixosVersion: string;
  nixpkgsRevision: string;
  storePaths: string[];
  inventoryTruncated: boolean;
}

export interface FeedResult<T> {
  value: T;
  errors: string[];
}

export interface ScanDeps {
  readInventory: (target: SshTarget, signal: AbortSignal) => Promise<string>;
  queryOsv: (
    queries: OsvQuery[],
    signal: AbortSignal,
  ) => Promise<FeedResult<Array<unknown | undefined>>>;
  githubAdvisories: (
    owner: string,
    repo: string,
    signal: AbortSignal,
  ) => Promise<FeedResult<unknown[]>>;
}

export interface ScanContext {
  globalArgs: unknown;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger?: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warning?: (message: string, fields?: Record<string, unknown>) => void;
  };
}

export const GlobalArgs = z.object({
  host: z.string().default(""),
  sshUser: z.string().default("jimmykeech"),
  port: z.number().int().min(1).max(65535).default(22),
  identityFile: z.string().default(""),
});

export const Args = z.object({
  maxPackages: z.number().int().min(1).max(1000).default(500),
});

/** Fixed remote script. It contains no caller data and only reads the booted closure. */
export const inventoryScript = [
  "set -u",
  "printf '%s\\n' NIX-VM-SCAN/1",
  "if [ ! -e /run/current-system ]; then",
  "  printf '%s\\n' error=not-nixos",
  "  exit 3",
  "fi",
  "if ! command -v nix-store >/dev/null 2>&1; then",
  "  printf '%s\\n' error=no-nix-store",
  "  exit 4",
  "fi",
  "current=$(readlink -f /run/current-system) || { printf '%s\\n' error=no-current-system; exit 5; }",
  "printf 'hostname=%s\\n' \"$(cat /proc/sys/kernel/hostname 2>/dev/null || printf unknown)\"",
  "printf 'kernel=%s\\n' \"$(uname -r 2>/dev/null || printf unknown)\"",
  "printf 'system=%s\\n' \"$(uname -m 2>/dev/null || printf unknown)\"",
  "printf 'current_system=%s\\n' \"$current\"",
  'if [ -r "$current/nixos-version" ]; then',
  '  nixos_line=$(head -n 1 "$current/nixos-version")',
  "  printf 'nixos_version=%s\\n' \"$nixos_line\"",
  "fi",
  "if [ -r /etc/os-release ]; then",
  "  . /etc/os-release",
  "  printf 'os_name=%s\\n' \"${NAME-}\"",
  "  printf 'os_id=%s\\n' \"${ID-}\"",
  "  printf 'os_version=%s\\n' \"${VERSION_ID-}\"",
  "fi",
  "if command -v nixos-version >/dev/null 2>&1; then",
  "  json=$(nixos-version --json 2>/dev/null | tr -d '\\n' || true)",
  "  printf 'nixos_json=%s\\n' \"$json\"",
  "fi",
  "printf '%s\\n' ---packages---",
  'nix-store -qR "$current" | head -n 5001',
  "printf '%s\\n' ---end---",
  "",
].join("\n");

const currentSystemPattern =
  /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9.+_-]{1,180}$/;

export function sshTargetAllowed(user: string, host: string): boolean {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(user) &&
    (host === "localhost" || ipv4(host) || hostname(host));
}

export function identityAllowed(path: string): boolean {
  return path === "" ||
    (/^\/[A-Za-z0-9._+/-]{1,200}$/.test(path) && !path.includes(".."));
}

export function targetErrors(target: SshTarget): string[] {
  const errors: string[] = [];
  if (!target.host) errors.push("host is required");
  else if (!sshTargetAllowed(target.sshUser, target.host)) {
    errors.push("SSH target is not a host name");
  }
  if (!identityAllowed(target.identityFile)) {
    errors.push("SSH identity path is not allowed");
  }
  if (
    !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
  ) {
    errors.push("SSH port is not allowed");
  }
  return errors;
}

/** Arguments for one read-only SSH command. The remote script arrives on stdin. */
export function sshCommandArgs(target: SshTarget): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(target.port),
  ];
  if (target.identityFile) {
    args.push("-i", target.identityFile, "-o", "IdentitiesOnly=yes");
  }
  args.push("--", `${target.sshUser}@${target.host}`, "bash", "-s");
  return args;
}

export function normalizeVersion(version: string): string {
  const match = version.match(/^(.*\..*)-(\d+)$/);
  return match ? match[1] : version;
}

export function versionInRange(version: string, range: string): boolean {
  const text = range.trim();
  if (!text) return true;
  const parts = text.split(",").map((part) => part.trim()).filter((part) =>
    part.length > 0
  );
  if (parts.length === 0) return true;
  for (const part of parts) {
    const match = part.match(/^(<=|>=|<|>|=|==)\s*([0-9][0-9A-Za-z.+_-]*)$/);
    if (!match) return true;
    const operator = match[1] === "==" ? "=" : match[1];
    const compared = compareVersions(version, match[2]);
    if (operator === "=" && compared !== 0) return false;
    if (operator === "<" && compared >= 0) return false;
    if (operator === "<=" && compared > 0) return false;
    if (operator === ">" && compared <= 0) return false;
    if (operator === ">=" && compared < 0) return false;
  }
  return true;
}

export function parseStorePath(
  path: string,
): { name: string; installedVersion: string } | null {
  const match = path.match(/^\/nix\/store\/[a-z0-9]{32}-(.+)$/);
  if (!match) return null;
  const raw = stripOutput(match[1]);
  if (
    raw.startsWith("nixos-system-") || raw.startsWith("nixos-") ||
    raw.startsWith("unit-")
  ) return null;
  const bits = raw.split("-");
  let versionStart = -1;
  for (let index = 1; index < bits.length; index++) {
    if (/^\d/.test(bits[index])) {
      versionStart = index;
      break;
    }
  }
  if (versionStart < 0) return null;
  const name = bits.slice(0, versionStart).join("-");
  const installedVersion = bits.slice(versionStart).join("-");
  if (
    !packageNameAccepted(name) ||
    !/^\d[A-Za-z0-9.+_-]{0,79}$/.test(installedVersion)
  ) return null;
  return { name, installedVersion };
}

export function collectPackages(paths: string[]): PackageRef[] {
  const seen = new Set<string>();
  const packages: PackageRef[] = [];
  for (const path of paths) {
    const parsed = parseStorePath(path);
    if (!parsed || parsed.name === "linux") continue;
    const queriedVersion = normalizeVersion(parsed.installedVersion);
    const key = `${parsed.name}\0${queriedVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({
      name: parsed.name,
      installedVersion: parsed.installedVersion,
      queriedVersion,
    });
  }
  packages.sort((left, right) =>
    left.name.localeCompare(right.name) ||
    left.installedVersion.localeCompare(right.installedVersion)
  );
  return packages;
}

export function kernelPackage(kernel: string): PackageRef | null {
  const version = kernel.match(/^(\d+\.\d+(?:\.\d+)?)/)?.[1];
  if (!version) return null;
  return {
    name: "linux",
    installedVersion: kernel.slice(0, 80),
    queriedVersion: version,
  };
}

export function osvQueries(
  packages: PackageRef[],
  kernel: string,
  maxPackages: number,
): { queries: OsvQuery[]; queryTruncated: boolean } {
  const queryTruncated = packages.length > maxPackages;
  const queries = packages.slice(0, maxPackages).map((pkg) =>
    toQuery(pkg, pkg.name)
  );
  const kernelRef = kernelPackage(kernel);
  if (kernelRef) queries.push(toQuery(kernelRef, "Kernel", "Linux"));
  return { queries, queryTruncated };
}

/** Parse the line protocol printed by {@link inventoryScript}. */
export function parseInventory(text: string): Inventory {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "NIX-VM-SCAN/1");
  if (start < 0) throw new Error("VM did not return a Nix scan inventory");
  const fields = new Map<string, string>();
  let index = start + 1;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line === "---packages---") {
      index++;
      break;
    }
    if (line.startsWith("error=")) {
      throw new Error(inventoryError(line.slice(6)));
    }
    const split = line.indexOf("=");
    if (split > 0) fields.set(line.slice(0, split), line.slice(split + 1));
  }
  const storePaths: string[] = [];
  let sawEnd = false;
  for (; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "---end---") {
      sawEnd = true;
      break;
    }
    if (!line.startsWith("/nix/store/")) continue;
    storePaths.push(line.slice(0, 300));
    if (storePaths.length > maxStorePaths) break;
  }
  const currentSystem = field(fields, "current_system", 240);
  if (!currentSystemPattern.test(currentSystem)) {
    throw new Error("VM returned an unexpected system closure path");
  }
  const revision = revisionOf(
    field(fields, "nixos_json", 2000),
    field(fields, "nixos_version", 120),
  );
  return {
    hostname: hostnameOf(field(fields, "hostname", 253)),
    kernel: field(fields, "kernel", 120) || "unknown",
    system: systemOf(field(fields, "system", 32)),
    currentSystem,
    osName: field(fields, "os_name", 120),
    osVersion: field(fields, "os_version", 120),
    nixosVersion: revision.nixosVersion,
    nixpkgsRevision: revision.nixpkgsRevision,
    storePaths,
    inventoryTruncated: !sawEnd || storePaths.length > maxStorePaths,
  };
}

export function findingsFromOsv(
  queries: OsvQuery[],
  slots: Array<unknown | undefined>,
): FindingRecord[] {
  const findings: FindingRecord[] = [];
  for (let index = 0; index < queries.length; index++) {
    const query = queries[index];
    const slot = record(slots[index]);
    const vulns = slot ? array(slot.vulns) : [];
    for (const vuln of vulns) {
      const body = record(vuln);
      if (!body) continue;
      const finding = findingFromOsv(query, body);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

export function findingsFromGithub(
  packages: PackageRef[],
  payload: unknown,
  source: "nixpkgs" | "nix",
): FindingRecord[] {
  if (!Array.isArray(payload)) return [];
  const findings: FindingRecord[] = [];
  for (const item of payload) {
    const advisory = record(item);
    if (!advisory) continue;
    const id = clean(advisory.ghsa_id, 64);
    if (!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(id)) continue;
    const summary = clean(advisory.summary, 300) ||
      clean(advisory.description, 300);
    const severity = labelSeverity(advisory.severity) ?? "unknown";
    const url = advisoryUrl(id, advisory.html_url);
    const aliases = aliasList(advisory.cve_id ? [advisory.cve_id] : [], id);
    const vulnerabilities = array(advisory.vulnerabilities);
    if (vulnerabilities.length === 0) {
      const text = `${summary} ${clean(advisory.description, 2000)}`;
      for (const pkg of packages) {
        if (!proseMatch(text, pkg.name, source)) continue;
        findings.push(finding({
          id,
          aliases,
          pkg,
          severity,
          confidence: source === "nix" ? "nix-advisory" : "nixpkgs-advisory",
          ecosystem: source === "nix" ? "NixOS/nix" : "NixOS/nixpkgs",
          summary,
          url,
          fixedIn: "",
        }));
      }
      continue;
    }
    for (const pkg of packages) {
      const match = vulnerabilities.find((entry) =>
        vulnerabilityMatches(entry, pkg)
      );
      if (!match) continue;
      const body = record(match);
      findings.push(finding({
        id,
        aliases,
        pkg,
        severity,
        confidence: source === "nix" ? "nix-advisory" : "nixpkgs-advisory",
        ecosystem: source === "nix" ? "NixOS/nix" : "NixOS/nixpkgs",
        summary,
        url,
        fixedIn: clean(body?.patched_versions, 80),
      }));
    }
  }
  return findings;
}

export function assembleScan(input: {
  now: Date;
  target: SshTarget;
  inventory: Inventory;
  packageCount: number;
  queries: OsvQuery[];
  queryTruncated: boolean;
  findings: FindingRecord[];
  feedErrors: string[];
}): VulnerabilityScanRecord {
  const unique = dedupeFindings(input.findings);
  unique.sort((left, right) =>
    severityRank[left.severity] - severityRank[right.severity] ||
    left.packageName.localeCompare(right.packageName) ||
    left.id.localeCompare(right.id)
  );
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const item of unique) counts[item.severity] += 1;
  return VulnerabilityScan.parse({
    scannedAt: input.now.toISOString(),
    host: input.target.host,
    sshUser: input.target.sshUser,
    hostname: input.inventory.hostname,
    osName: input.inventory.osName,
    osVersion: input.inventory.osVersion,
    nixosVersion: input.inventory.nixosVersion,
    nixpkgsRevision: input.inventory.nixpkgsRevision,
    kernel: input.inventory.kernel,
    system: input.inventory.system,
    currentSystem: input.inventory.currentSystem,
    storePathCount: input.inventory.storePaths.length,
    packageCount: input.packageCount,
    queriedCount: input.queries.length,
    inventoryTruncated: input.inventory.inventoryTruncated,
    queryTruncated: input.queryTruncated,
    findingCount: unique.length,
    findingsTruncated: unique.length > maxFindings,
    counts,
    findings: unique.slice(0, maxFindings),
    feedErrors: input.feedErrors.slice(0, maxFeedErrors),
  });
}

/** Markdown and JSON for one stored scan. Version matches are cross-catalog candidates. */
export function renderVulnerabilityReport(scan: VulnerabilityScanRecord): {
  markdown: string;
  json: Record<string, unknown>;
} {
  const lines = [
    "# Nix VM vulnerability report",
    "",
    `Scanned \`${scan.sshUser}@${scan.host}\` at ${scan.scannedAt}. The booted system is \`${scan.currentSystem}\`.`,
    "",
    "Version matches come from OSV.dev. OSV has no Nix ecosystem, so a match means the same package name and version are vulnerable in another catalog. Advisories published on NixOS/nixpkgs and NixOS/nix are listed separately.",
    "",
    "| | |",
    "| --- | --- |",
    `| Hostname | ${cell(scan.hostname)} |`,
    `| NixOS | ${cell(scan.nixosVersion)} |`,
    `| Nixpkgs | ${cell(scan.nixpkgsRevision)} |`,
    `| Kernel | ${cell(scan.kernel)} |`,
    `| Architecture | ${cell(scan.system)} |`,
    `| Store paths | ${scan.storePathCount} |`,
    `| Packages | ${scan.packageCount} |`,
    `| Queried | ${scan.queriedCount} |`,
    `| Findings | ${scan.findingCount} |`,
    "",
    "| Severity | Count |",
    "| --- | --- |",
    `| critical | ${scan.counts.critical} |`,
    `| high | ${scan.counts.high} |`,
    `| medium | ${scan.counts.medium} |`,
    `| low | ${scan.counts.low} |`,
    `| unknown | ${scan.counts.unknown} |`,
    "",
  ];
  const notes = scanNotes(scan);
  if (notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }
  lines.push("## Findings", "");
  if (scan.findings.length === 0) {
    lines.push(
      "No matching vulnerabilities for the packages that were queried.",
    );
  } else {
    lines.push(
      `Showing ${scan.findings.length} of ${scan.findingCount}, highest severity first.`,
      "",
      "| Severity | Package | Installed | Advisory | Confidence | Summary |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const item of scan.findings) {
      const link = item.url ? `[${cell(item.id)}](${item.url})` : cell(item.id);
      lines.push(
        `| ${item.severity} | ${cell(item.packageName)} | ${
          cell(item.installedVersion)
        } | ${link} | ${item.confidence} | ${cell(item.summary)} |`,
      );
    }
  }
  if (scan.feedErrors.length > 0) {
    lines.push("", "## Feed", "");
    for (const error of scan.feedErrors) lines.push(`- ${cell(error)}`);
  }
  lines.push("");
  return {
    markdown: lines.join("\n"),
    json: {
      applicable: true,
      status: "succeeded",
      findingCount: scan.findingCount,
      counts: scan.counts,
      scan,
    },
  };
}

/** Inventory one VM and store the scan. Connection failures throw before any write. */
export async function runScan(
  rawArgs: unknown,
  context: ScanContext,
  deps: ScanDeps = liveDeps,
  now = new Date(),
): Promise<{ dataHandles: { name: string }[] }> {
  const globals = GlobalArgs.safeParse(context.globalArgs ?? {});
  if (!globals.success) throw new Error(schemaError(globals.error.issues));
  const args = Args.safeParse(rawArgs ?? {});
  if (!args.success) throw new Error(schemaError(args.error.issues));
  const target: SshTarget = {
    host: globals.data.host,
    sshUser: globals.data.sshUser,
    port: globals.data.port,
    identityFile: globals.data.identityFile,
  };
  const errors = targetErrors(target);
  if (errors.length > 0) throw new Error(errors[0]);

  const signal = context.signal ?? AbortSignal.timeout(180_000);
  const stdout = await deps.readInventory(
    target,
    AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  );
  const inventory = parseInventory(stdout);
  const packages = collectPackages(inventory.storePaths);
  const selected = osvQueries(
    packages,
    inventory.kernel,
    args.data.maxPackages,
  );
  const matchSet = kernelPackage(inventory.kernel)
    ? [...packages, kernelPackage(inventory.kernel)!]
    : packages;
  const feedSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  const osv = selected.queries.length === 0
    ? { value: [], errors: [] }
    : await settled(
      () => deps.queryOsv(selected.queries, feedSignal),
      [] as Array<unknown | undefined>,
      "OSV query failed",
    );
  const nixpkgs = await settled(
    () => deps.githubAdvisories("NixOS", "nixpkgs", feedSignal),
    [] as unknown[],
    "GitHub advisories for NixOS/nixpkgs failed",
  );
  const nix = await settled(
    () => deps.githubAdvisories("NixOS", "nix", feedSignal),
    [] as unknown[],
    "GitHub advisories for NixOS/nix failed",
  );
  const findings = [
    ...findingsFromOsv(selected.queries, osv.value),
    ...findingsFromGithub(matchSet, nixpkgs.value, "nixpkgs"),
    ...findingsFromGithub(matchSet, nix.value, "nix"),
  ];
  const scan = assembleScan({
    now,
    target,
    inventory,
    packageCount: packages.length + (kernelPackage(inventory.kernel) ? 1 : 0),
    queries: selected.queries,
    queryTruncated: selected.queryTruncated,
    findings,
    feedErrors: [...osv.errors, ...nixpkgs.errors, ...nix.errors],
  });
  context.logger?.info(
    "Scanned {host}: {packageCount} packages, {findingCount} findings",
    {
      host: target.host,
      packageCount: scan.packageCount,
      findingCount: scan.findingCount,
    },
  );
  for (const error of scan.feedErrors) {
    context.logger?.warning?.("Vulnerability feed failed: {error}", { error });
  }
  const handle = await context.writeResource(
    "vulnerabilityScan",
    "scan",
    scan as unknown as Record<string, unknown>,
  );
  return { dataHandles: [handle] };
}

async function readVmInventory(
  target: SshTarget,
  signal: AbortSignal,
): Promise<string> {
  // swamp-quality-ignore deno-command
  const command = new Deno.Command("ssh", {
    args: sshCommandArgs(target),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal,
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(inventoryScript));
  } finally {
    await writer.close();
  }
  const result = await child.output();
  const stdout = new TextDecoder().decode(result.stdout);
  if (stdout.includes("NIX-VM-SCAN/1")) return stdout.slice(0, 3_000_000);
  const stderr = clean(new TextDecoder().decode(result.stderr), 300);
  throw new Error(
    stderr
      ? `SSH scan failed: ${stderr}`
      : `SSH scan failed with status ${result.code}`,
  );
}

async function queryOsv(
  queries: OsvQuery[],
  signal: AbortSignal,
): Promise<FeedResult<Array<unknown | undefined>>> {
  const slots: Array<unknown | undefined> = queries.map(() => undefined);
  const errors: string[] = [];
  for (let offset = 0; offset < queries.length; offset += osvBatchSize) {
    const batch = queries.slice(offset, offset + osvBatchSize);
    let payload: unknown;
    try {
      payload = await postOsv(batch, signal);
    } catch (error) {
      errors.push(cleanError(error, "OSV query failed"));
      break;
    }
    const results = array(record(payload)?.results);
    if (results.length !== batch.length) {
      errors.push("OSV returned a different number of results than queries");
      break;
    }
    for (let index = 0; index < batch.length; index++) {
      slots[offset + index] = results[index];
    }
  }
  return { value: slots, errors };
}

async function postOsv(
  queries: OsvQuery[],
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({
      queries: queries.map((query) =>
        query.ecosystem
          ? {
            version: query.queriedVersion,
            package: { name: query.matchName, ecosystem: query.ecosystem },
          }
          : {
            version: query.queriedVersion,
            package: { name: query.matchName },
          }
      ),
    }),
    signal,
  });
  if (!response.ok) throw new Error(`OSV returned ${response.status}`);
  return await response.json();
}

async function githubAdvisories(
  owner: string,
  repo: string,
  signal: AbortSignal,
): Promise<FeedResult<unknown[]>> {
  const advisories: unknown[] = [];
  const errors: string[] = [];
  let url: string | null =
    `https://api.github.com/repos/${owner}/${repo}/security-advisories?per_page=100&state=published`;
  for (let page = 0; page < 3 && url; page++) {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "swamp-nix-vm-vuln-scan",
        "x-github-api-version": "2022-11-28",
      },
      signal,
    });
    if (!response.ok) {
      errors.push(
        `GitHub advisories for ${owner}/${repo} returned ${response.status}`,
      );
      return { value: advisories, errors };
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      errors.push(`GitHub advisories for ${owner}/${repo} were not a list`);
      return { value: advisories, errors };
    }
    advisories.push(...body);
    const next = nextUrl(response.headers.get("link"));
    if (!next && page < 2) return { value: advisories, errors };
    url = next;
  }
  if (url) errors.push(`GitHub advisories for ${owner}/${repo} were truncated`);
  return { value: advisories, errors };
}

const liveDeps: ScanDeps = {
  readInventory: readVmInventory,
  queryOsv,
  githubAdvisories,
};

function toQuery(
  pkg: PackageRef,
  matchName: string,
  ecosystem?: string,
): OsvQuery {
  return ecosystem ? { ...pkg, matchName, ecosystem } : { ...pkg, matchName };
}

async function settled<T>(
  fn: () => Promise<FeedResult<T>>,
  empty: T,
  label: string,
): Promise<FeedResult<T>> {
  try {
    return await fn();
  } catch (error) {
    return { value: empty, errors: [cleanError(error, label)] };
  }
}

function findingFromOsv(
  query: OsvQuery,
  vuln: Record<string, unknown>,
): FindingRecord | null {
  const id = clean(vuln.id, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id)) return null;
  const affected = matchingAffected(vuln, query);
  if (!affected) return null;
  const ecosystem = clean(record(affected.package)?.ecosystem, 64);
  return finding({
    id,
    aliases: aliasList(array(vuln.aliases), id),
    pkg: query,
    severity: severityOf(vuln, affected),
    confidence: "version-match",
    ecosystem,
    summary: clean(vuln.summary, 300) || clean(vuln.details, 300),
    url: `https://osv.dev/vulnerability/${id}`,
    fixedIn: fixedVersion(affected),
  });
}

function matchingAffected(
  vuln: Record<string, unknown>,
  query: OsvQuery,
): Record<string, unknown> | null {
  const names = new Set([
    query.matchName.toLowerCase(),
    query.name.toLowerCase(),
  ]);
  for (const entry of array(vuln.affected)) {
    const body = record(entry);
    const name = clean(record(body?.package)?.name, 80).toLowerCase();
    if (body && names.has(name)) return body;
  }
  return null;
}

function vulnerabilityMatches(entry: unknown, pkg: PackageRef): boolean {
  const body = record(entry);
  const name = clean(record(body?.package)?.name, 80);
  if (!body || name.toLowerCase() !== pkg.name.toLowerCase()) return false;
  return versionInRange(
    pkg.queriedVersion,
    clean(body.vulnerable_version_range, 200),
  );
}

function proseMatch(
  text: string,
  name: string,
  source: "nixpkgs" | "nix",
): boolean {
  if (name.length < 4 && !(source === "nix" && name === "nix")) return false;
  const words = text.toLowerCase().split(/[^a-z0-9.+_-]+/);
  return words.includes(name.toLowerCase());
}

function finding(input: {
  id: string;
  aliases: string[];
  pkg: PackageRef;
  severity: SeverityName;
  confidence: z.infer<typeof Confidence>;
  ecosystem: string;
  summary: string;
  url: string;
  fixedIn: string;
}): FindingRecord {
  return Finding.parse({
    id: input.id,
    aliases: input.aliases,
    packageName: input.pkg.name,
    installedVersion: input.pkg.installedVersion,
    queriedVersion: input.pkg.queriedVersion,
    severity: input.severity,
    confidence: input.confidence,
    ecosystem: input.ecosystem,
    summary: input.summary,
    url: input.url,
    fixedIn: input.fixedIn,
  });
}

function severityOf(
  vuln: Record<string, unknown>,
  affected: Record<string, unknown>,
): SeverityName {
  const fromDb = labelSeverity(record(vuln.database_specific)?.severity);
  if (fromDb) return fromDb;
  const ecosystem = record(affected.ecosystem_specific);
  const fromEcosystem = labelSeverity(ecosystem?.urgency) ??
    labelSeverity(ecosystem?.severity);
  if (fromEcosystem) return fromEcosystem;
  for (const item of array(vuln.severity)) {
    const score = record(item)?.score;
    if (typeof score === "string") {
      const fromVector = severityFromCvss(score);
      if (fromVector !== "unknown") return fromVector;
    }
  }
  return "unknown";
}

function severityFromCvss(vector: string): SeverityName {
  const body = vector.match(/^CVSS:3\.[01]\/(.+)$/);
  if (!body) return "unknown";
  const metrics = new Map<string, string>();
  for (const part of body[1].split("/")) {
    const split = part.split(":");
    if (split.length === 2) metrics.set(split[0], split[1]);
  }
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.get("AV") ?? ""];
  const ac = { L: 0.77, H: 0.44 }[metrics.get("AC") ?? ""];
  const ui = { N: 0.85, R: 0.62 }[metrics.get("UI") ?? ""];
  const scope = metrics.get("S");
  const confidentiality = { H: 0.56, L: 0.22, N: 0 }[metrics.get("C") ?? ""];
  const integrity = { H: 0.56, L: 0.22, N: 0 }[metrics.get("I") ?? ""];
  const availability = { H: 0.56, L: 0.22, N: 0 }[metrics.get("A") ?? ""];
  if (
    av === undefined || ac === undefined || ui === undefined ||
    confidentiality === undefined ||
    integrity === undefined || availability === undefined ||
    (scope !== "U" && scope !== "C")
  ) return "unknown";
  const privileges =
    (scope === "C"
      ? { N: 0.85, L: 0.68, H: 0.5 }
      : { N: 0.85, L: 0.62, H: 0.27 })[
        metrics.get("PR") ?? ""
      ];
  if (privileges === undefined) return "unknown";
  const iss = 1 - (1 - confidentiality) * (1 - integrity) * (1 - availability);
  const impact = scope === "U"
    ? 6.42 * iss
    : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  if (impact <= 0) return "unknown";
  const raw = scope === "U"
    ? Math.min(impact + 8.22 * av * ac * privileges * ui, 10)
    : Math.min(1.08 * (impact + 8.22 * av * ac * privileges * ui), 10);
  const score = Math.ceil(raw * 10 - 1e-9) / 10;
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "unknown";
}

function fixedVersion(affected: Record<string, unknown>): string {
  for (const range of array(affected.ranges)) {
    for (const event of array(record(range)?.events)) {
      const fixed = clean(record(event)?.fixed, 80);
      if (fixed) return fixed;
    }
  }
  return "";
}

function labelSeverity(value: unknown): SeverityName | null {
  if (typeof value !== "string") return null;
  const text = value.toLowerCase();
  if (text.includes("critical")) return "critical";
  if (text.includes("high")) return "high";
  if (text.includes("moderate") || text.includes("medium")) return "medium";
  if (text.includes("low")) return "low";
  return null;
}

function aliasList(values: unknown[], id: string): string[] {
  const aliases: string[] = [];
  for (const value of values) {
    const alias = clean(value, 64);
    if (alias === id || aliases.includes(alias)) continue;
    if (
      /^CVE-\d{4}-\d{4,}$/.test(alias) ||
      /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(alias)
    ) {
      aliases.push(alias);
    }
    if (aliases.length === 8) break;
  }
  return aliases;
}

function advisoryUrl(id: string, html: unknown): string {
  const url = clean(html, 300);
  if (
    /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/
      .test(url)
  ) return url;
  return `https://github.com/advisories/${id}`;
}

function dedupeFindings(findings: FindingRecord[]): FindingRecord[] {
  const seen = new Set<string>();
  const unique: FindingRecord[] = [];
  for (const item of findings) {
    const key = `${item.id}\0${item.packageName}\0${item.installedVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function revisionOf(
  json: string,
  fallback: string,
): { nixosVersion: string; nixpkgsRevision: string } {
  if (json.startsWith("{")) {
    try {
      const parsed = record(JSON.parse(json));
      const nixosVersion = clean(parsed?.nixosVersion, 120) || fallback;
      const revision = clean(parsed?.nixpkgsRevision, 64);
      return {
        nixosVersion,
        nixpkgsRevision: /^[0-9a-f]{4,64}$/.test(revision) ? revision : "",
      };
    } catch {
      // Fall through to the plain version file.
    }
  }
  return { nixosVersion: fallback, nixpkgsRevision: "" };
}

function inventoryError(code: string): string {
  if (code === "not-nixos") return "The host is not a running NixOS system";
  if (code === "no-nix-store") return "The host has no nix-store command";
  if (code === "no-current-system") {
    return "The host has no booted system closure";
  }
  return "VM scan failed";
}

function stripOutput(name: string): string {
  const parts = name.split("-");
  const last = parts[parts.length - 1];
  const previous = parts[parts.length - 2];
  if (
    parts.length >= 3 && outputSuffixes.has(last) && previous &&
    /^\d/.test(previous)
  ) {
    return parts.slice(0, -1).join("-");
  }
  return name;
}

function packageNameAccepted(name: string): boolean {
  return name.length >= 2 && name.length <= 80 && !skippedNames.has(name) &&
    /^[A-Za-z][A-Za-z0-9.+_-]*$/.test(name);
}

function compareVersions(left: string, right: string): number {
  const leftTokens = versionTokens(left);
  const rightTokens = versionTokens(right);
  const length = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < length; index++) {
    const a = leftTokens[index] ?? "0";
    const b = rightTokens[index] ?? "0";
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

function versionTokens(version: string): string[] {
  return version.split(/[.+_-]/).filter((part) => part.length > 0);
}

function scanNotes(scan: VulnerabilityScanRecord): string[] {
  const notes: string[] = [];
  if (scan.inventoryTruncated) {
    notes.push("The store-path listing was truncated.");
  }
  if (scan.queryTruncated) {
    notes.push("Only the first packages, in name order, were sent to OSV.");
  }
  if (scan.findingsTruncated) {
    notes.push("The stored findings are the highest-severity slice.");
  }
  return notes;
}

function cell(value: string): string {
  return value.replace(/[\r\n|]/g, " ").trim();
}

function ipv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function hostname(host: string): boolean {
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
    .test(host);
}

function hostnameOf(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value) ? value : "unknown";
}

function systemOf(value: string): string {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : "unknown";
}

function field(fields: Map<string, string>, key: string, max: number): string {
  return clean(fields.get(key) ?? "", max);
}

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    text += code <= 0x1f || code === 0x7f ? " " : char;
  }
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function schemaError(issues: { message: string }[]): string {
  return clean(issues[0]?.message, 200) || "SSH target is incomplete";
}

function cleanError(error: unknown, label: string): string {
  const message = error instanceof Error ? error.message : label;
  return clean(message, 200) || label;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nextUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match && match[1].startsWith("https://api.github.com/")) {
      return match[1];
    }
  }
  return null;
}
