import { z } from "npm:zod@4";

// Drive an existing Ansible playbook from swamp. The point is not to replace
// Ansible — it is to make a playbook run a typed, CEL-referenceable step in a
// swamp workflow, so provisioning and convergence live in one DAG.
//
// `check` runs with `--check --diff` and never mutates: `changed=0` across every
// host is the "this host already matches its declaration" gate that makes
// adopting an existing machine safe. `apply` runs for real.
//
// Inventory can be supplied as content rather than a path, so a workflow can
// build it from model data via CEL instead of shelling out to a render script.

// ── Recap parsing (pure) ──────────────────────────────────────────────────────

/** Per-host task tallies from Ansible's PLAY RECAP. */
export const HostRecapSchema = z.object({
  host: z.string(),
  ok: z.number(),
  changed: z.number(),
  unreachable: z.number(),
  failed: z.number(),
  skipped: z.number(),
  rescued: z.number(),
  ignored: z.number(),
});

/** Per-host tallies for one playbook run. */
export type HostRecap = z.infer<typeof HostRecapSchema>;

// PLAY RECAP lines look like:
//   web01   : ok=12  changed=3  unreachable=0  failed=0  skipped=2  rescued=0  ignored=0
// Older cores omit the trailing counters, so everything after `failed` is optional.
const RECAP_LINE =
  /^(\S+)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)(?:\s+skipped=(\d+))?(?:\s+rescued=(\d+))?(?:\s+ignored=(\d+))?/;

/**
 * Extract per-host tallies from playbook stdout.
 *
 * Only lines after `PLAY RECAP` are considered — task output can contain text
 * that otherwise matches, and a false positive here would corrupt the status
 * that callers gate on.
 */
export function parseRecap(stdout: string): HostRecap[] {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.includes("PLAY RECAP"));
  if (start === -1) return [];

  const hosts: HostRecap[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = RECAP_LINE.exec(line.trim());
    if (!m) continue;
    hosts.push({
      host: m[1],
      ok: Number(m[2]),
      changed: Number(m[3]),
      unreachable: Number(m[4]),
      failed: Number(m[5]),
      skipped: Number(m[6] ?? 0),
      rescued: Number(m[7] ?? 0),
      ignored: Number(m[8] ?? 0),
    });
  }
  return hosts;
}

/** Outcome of a run, derived from the recap. */
export const StatusSchema = z.enum([
  "compliant",
  "drift",
  "applied",
  "unchanged",
  "failed",
]);

/** The single outcome a caller gates on. */
export type Status = z.infer<typeof StatusSchema>;

/**
 * Derive a single status from per-host tallies.
 *
 * `check` mode distinguishes compliant from drift; `apply` mode distinguishes
 * unchanged from applied. Any failure or unreachable host wins outright — a run
 * that half-succeeded is not a pass, and treating it as one is how silent
 * partial convergence happens.
 */
export function deriveStatus(
  mode: "check" | "apply",
  hosts: HostRecap[],
  exitCode: number,
): Status {
  if (hosts.length === 0) return exitCode === 0 ? "unchanged" : "failed";
  const bad = hosts.some((h) => h.failed > 0 || h.unreachable > 0);
  if (bad || exitCode !== 0) return "failed";
  const changed = hosts.reduce((n, h) => n + h.changed, 0);
  if (mode === "check") return changed > 0 ? "drift" : "compliant";
  return changed > 0 ? "applied" : "unchanged";
}

/** Sum a field across hosts. */
function total(hosts: HostRecap[], key: keyof HostRecap): number {
  return hosts.reduce((n, h) => n + (h[key] as number), 0);
}

// ── Global arguments ──────────────────────────────────────────────────────────

/**
 * Model global arguments: where the playbook lives, how to reach the managed
 * hosts, and the two secrets that must never reach argv.
 */
export const GlobalArgsSchema = z.object({
  workdir: z.string().describe(
    "Directory ansible-playbook runs in — the checkout root, so ansible.cfg and relative role paths resolve.",
  ),
  playbook: z.string().describe(
    "Playbook path relative to workdir, e.g. ansible/site.yml.",
  ),
  inventoryPath: z.string().optional().describe(
    "Inventory path relative to workdir. Omit when supplying inventoryContent per run.",
  ),
  privateKeyPath: z.string().optional().describe(
    "Path to an SSH private key already on the swamp host. Not itself a secret — a path. Use privateKey to supply the key material from a vault instead.",
  ),
  privateKey: z.string().optional().meta({ sensitive: true }).describe(
    "SSH private key material (PEM). Written to a 0600 temp file for the run, so a serve host needs no key on disk. Takes precedence over privateKeyPath.",
  ),
  remoteUser: z.string().optional().describe("SSH user (ansible -u)."),
  vaultPassword: z.string().optional().meta({ sensitive: true }).describe(
    "Ansible Vault password. Written to a 0600 temp file for --vault-password-file, never passed in argv.",
  ),
  becomePassword: z.string().optional().meta({ sensitive: true }).describe(
    "sudo password. Passed via a 0600 extra-vars file as ansible_become_password, never in argv.",
  ),
  ansibleBin: z.string().default("ansible-playbook").describe(
    "Path to the ansible-playbook binary.",
  ),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

// ── Method arguments ──────────────────────────────────────────────────────────

const RunArgs = z.object({
  limit: z.string().optional().describe(
    "Restrict the run to a host subset (ansible --limit).",
  ),
  tags: z.array(z.string()).default([]).describe("Only run these tags."),
  skipTags: z.array(z.string()).default([]).describe("Skip these tags."),
  extraVars: z.record(z.string(), z.unknown()).default({}).describe(
    "Extra vars, passed via a temp file rather than argv.",
  ),
  inventoryContent: z.string().optional().describe(
    "Inline inventory (YAML or INI), written to a temp file. Lets a workflow build inventory from model data via CEL instead of a render script.",
  ),
  verbosity: z.number().int().min(0).max(4).default(0).describe(
    "Number of -v flags.",
  ),
  timeoutSec: z.number().int().positive().max(21600).default(1800).describe(
    "Kill the run after this many seconds.",
  ),
});

// ── Runtime context ───────────────────────────────────────────────────────────

type Logger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warning?: (msg: string, meta?: Record<string, unknown>) => void;
};

type Context = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  writeResource: (
    specName: string,
    instance: string,
    data: unknown,
  ) => Promise<unknown>;
  logger: Logger;
};

/** Filesystem-safe instance-name fragment. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(
    0,
    100,
  );
}

/**
 * Build the argv for a run.
 *
 * Exported so tests can assert the exact flags — in particular that `check`
 * always carries `--check`, and that no secret is ever placed in argv.
 */
export function buildArgs(
  mode: "check" | "apply",
  g: z.infer<typeof GlobalArgsSchema>,
  a: z.infer<typeof RunArgs>,
  paths: {
    inventory?: string;
    vaultPasswordFile?: string;
    extraVarsFile?: string;
    privateKeyFile?: string;
  },
): string[] {
  const args: string[] = [g.playbook];
  if (mode === "check") args.push("--check", "--diff");
  if (paths.inventory) args.push("-i", paths.inventory);
  if (g.remoteUser) args.push("-u", g.remoteUser);
  // Materialised key material wins over a path, so a vault-supplied key beats a
  // stale one left on disk.
  const keyFile = paths.privateKeyFile ?? g.privateKeyPath;
  if (keyFile) args.push("--private-key", keyFile);
  if (paths.vaultPasswordFile) {
    args.push("--vault-password-file", paths.vaultPasswordFile);
  }
  if (paths.extraVarsFile) args.push("-e", `@${paths.extraVarsFile}`);
  if (a.limit) args.push("--limit", a.limit);
  if (a.tags.length) args.push("--tags", a.tags.join(","));
  if (a.skipTags.length) args.push("--skip-tags", a.skipTags.join(","));
  if (a.verbosity > 0) args.push("-" + "v".repeat(a.verbosity));
  return args;
}

/** Trim captured output so a chatty playbook can't bloat a data version. */
function tail(
  s: string,
  maxBytes = 65536,
): { text: string; truncated: boolean } {
  if (s.length <= maxBytes) return { text: s, truncated: false };
  return { text: s.slice(s.length - maxBytes), truncated: true };
}

/**
 * Strip known secret values out of captured output before it is persisted.
 *
 * Ansible can echo extra-vars at high verbosity, and this model stores a tail of
 * stdout as model data — so without this, a run with `verbosity: 4` could write
 * `ansible_become_password` into the datastore. Redaction targets the values
 * themselves rather than a pattern, so it holds however Ansible formats them.
 */
export function redactSecrets(
  text: string,
  secrets: (string | undefined)[],
): string {
  let out = text;
  for (const secret of secrets) {
    // Very short values are skipped: replacing them globally would mangle
    // unrelated output for no real security gain.
    if (!secret || secret.length < 6) continue;
    out = out.split(secret).join("***REDACTED***");
  }
  return out;
}

/**
 * Run the playbook.
 *
 * Secrets go to 0600 files inside a 0700 temp dir, removed in `finally` — never
 * argv, which is world-readable via the process list on most systems.
 */
async function run(
  mode: "check" | "apply",
  args: z.infer<typeof RunArgs>,
  context: Context,
): Promise<unknown> {
  const g = context.globalArgs;
  const tmp = await Deno.makeTempDir({ prefix: "swamp-ansible-" });
  await Deno.chmod(tmp, 0o700).catch(() => {});

  const paths: {
    inventory?: string;
    vaultPasswordFile?: string;
    extraVarsFile?: string;
    privateKeyFile?: string;
  } = {};

  try {
    if (args.inventoryContent !== undefined) {
      paths.inventory = `${tmp}/inventory.yml`;
      await Deno.writeTextFile(paths.inventory, args.inventoryContent);
    } else if (g.inventoryPath) {
      paths.inventory = g.inventoryPath;
    }

    if (g.privateKey) {
      paths.privateKeyFile = `${tmp}/id_key`;
      // ssh refuses a key file with loose permissions, so chmod before writing
      // would be too late — create it, tighten it, then fill it.
      await Deno.writeTextFile(paths.privateKeyFile, "");
      await Deno.chmod(paths.privateKeyFile, 0o600);
      const withNewline = g.privateKey.endsWith("\n")
        ? g.privateKey
        : g.privateKey + "\n";
      await Deno.writeTextFile(paths.privateKeyFile, withNewline);
    }

    if (g.vaultPassword) {
      paths.vaultPasswordFile = `${tmp}/vault-pass`;
      await Deno.writeTextFile(paths.vaultPasswordFile, g.vaultPassword + "\n");
      await Deno.chmod(paths.vaultPasswordFile, 0o600);
    }

    // become password rides in the extra-vars file so it stays out of argv
    const extra: Record<string, unknown> = { ...args.extraVars };
    if (g.becomePassword) extra.ansible_become_password = g.becomePassword;
    if (Object.keys(extra).length > 0) {
      paths.extraVarsFile = `${tmp}/extra-vars.json`;
      await Deno.writeTextFile(paths.extraVarsFile, JSON.stringify(extra));
      await Deno.chmod(paths.extraVarsFile, 0o600);
    }

    const argv = buildArgs(mode, g, args, paths);
    context.logger.info(
      "ansible-playbook {mode}: {playbook} (limit={limit})",
      { mode, playbook: g.playbook, limit: args.limit ?? "all" },
    );

    const started = Date.now();
    const command = new Deno.Command(g.ansibleBin, {
      args: argv,
      cwd: g.workdir,
      stdout: "piped",
      stderr: "piped",
      env: { ANSIBLE_FORCE_COLOR: "0", PY_COLORS: "0" },
    });

    const child = command.spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
    }, args.timeoutSec * 1000);

    let out;
    try {
      out = await child.output();
    } finally {
      clearTimeout(timer);
    }

    const decoder = new TextDecoder();
    // Redact before anything is persisted or surfaced. Parsing runs on the raw
    // text, since the recap never contains secrets and redaction could in
    // principle disturb it.
    const secrets = [g.becomePassword, g.vaultPassword, g.privateKey];
    const stdout = redactSecrets(decoder.decode(out.stdout), secrets);
    const stderr = redactSecrets(decoder.decode(out.stderr), secrets);
    const hosts = parseRecap(decoder.decode(out.stdout));
    const status = deriveStatus(mode, hosts, out.code);
    const stdoutTail = tail(stdout);

    const handle = await context.writeResource(
      "run",
      `run-${mode}-${slug(g.playbook)}`,
      {
        mode,
        playbook: g.playbook,
        workdir: g.workdir,
        limit: args.limit ?? null,
        tags: args.tags,
        status,
        exitCode: out.code,
        hosts,
        hostCount: hosts.length,
        totals: {
          ok: total(hosts, "ok"),
          changed: total(hosts, "changed"),
          unreachable: total(hosts, "unreachable"),
          failed: total(hosts, "failed"),
          skipped: total(hosts, "skipped"),
        },
        durationSec: Math.round((Date.now() - started) / 1000),
        stdoutTail: stdoutTail.text,
        stdoutTruncated: stdoutTail.truncated,
        stderrTail: tail(stderr, 8192).text,
        ranAt: new Date().toISOString(),
      },
    );

    context.logger.info(
      "{status}: {hostCount} host(s), changed={changed}, failed={failed}",
      {
        status,
        hostCount: hosts.length,
        changed: total(hosts, "changed"),
        failed: total(hosts, "failed"),
      },
    );

    // A failed convergence must fail the step, or a workflow will march on
    // treating an unconverged host as ready.
    if (status === "failed") {
      throw new Error(
        `ansible-playbook ${mode} failed (exit ${out.code}): ` +
          `${total(hosts, "failed")} failed, ${
            total(hosts, "unreachable")
          } unreachable. ` +
          (stderr.trim().slice(0, 300) || stdoutTail.text.slice(-300)),
      );
    }

    return { dataHandles: [handle] };
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

// ── Model ─────────────────────────────────────────────────────────────────────

/**
 * The `@jamesakeech/ansible` model: run an existing playbook as a swamp method,
 * with `check` as a non-mutating compliance gate and `apply` for real runs.
 */
export const model = {
  type: "@jamesakeech/ansible",
  version: "2026.07.30.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    run: {
      description: "Result of an ansible-playbook run, per host",
      schema: z.object({
        mode: z.string(),
        playbook: z.string(),
        workdir: z.string(),
        limit: z.string().nullable(),
        tags: z.array(z.string()),
        status: StatusSchema,
        exitCode: z.number(),
        hosts: z.array(HostRecapSchema),
        hostCount: z.number(),
        totals: z.object({
          ok: z.number(),
          changed: z.number(),
          unreachable: z.number(),
          failed: z.number(),
          skipped: z.number(),
        }),
        durationSec: z.number(),
        stdoutTail: z.string(),
        stdoutTruncated: z.boolean(),
        stderrTail: z.string(),
        ranAt: z.string(),
      }),
      lifetime: "30d",
      garbageCollection: 5,
    },
  },

  checks: {
    "playbook-present": {
      description:
        "The playbook exists under workdir and ansible-playbook is executable.",
      execute: async (context: Context) => {
        const g = context.globalArgs;
        try {
          const st = await Deno.stat(`${g.workdir}/${g.playbook}`);
          if (!st.isFile) {
            return { pass: false, message: `${g.playbook} is not a file` };
          }
        } catch {
          return {
            pass: false,
            message: `playbook not found: ${g.workdir}/${g.playbook}`,
          };
        }
        try {
          const probe = new Deno.Command(g.ansibleBin, {
            args: ["--version"],
            stdout: "null",
            stderr: "null",
          });
          const { code } = await probe.output();
          if (code !== 0) {
            return { pass: false, message: `${g.ansibleBin} --version failed` };
          }
        } catch {
          return { pass: false, message: `${g.ansibleBin} not executable` };
        }
        return { pass: true };
      },
    },
  },

  methods: {
    check: {
      description:
        "Run the playbook with --check --diff. Never mutates; changed=0 on every host means compliant.",
      arguments: RunArgs,
      execute: (args: z.infer<typeof RunArgs>, context: Context) =>
        run("check", args, context),
    },

    apply: {
      description: "Run the playbook for real.",
      arguments: RunArgs,
      execute: (args: z.infer<typeof RunArgs>, context: Context) =>
        run("apply", args, context),
    },
  },
};
