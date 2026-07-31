/**
 * SSH execution for the ESXi model.
 *
 * The collection script is fed to the remote shell over **stdin** (`sh -s`)
 * rather than embedded in argv. ESXi's busybox `ash` would otherwise re-parse a
 * multi-hundred-byte quoted string, and every datastore name or guest name
 * interpolated into it would become a quoting hazard. Over stdin the script is
 * opaque bytes to `ssh` and to the local shell — there is no local `sh -c` at
 * any point, since `Deno.Command(bin, {args})` spawns directly.
 *
 * Password auth goes through `sshpass -e`, which reads the password from the
 * `SSHPASS` environment variable. Passing it as `sshpass -p <pw>` would expose
 * it in the process table to every local user.
 *
 * @module
 */

import type { Transport } from "./schemas.ts";

/** Raw outcome of a spawned process. */
export interface ExecOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable process executor. Default spawns via Deno. */
export type CommandExecutor = (
  argv: string[],
  opts: { timeoutMs: number; stdin: string; env?: Record<string, string> },
) => Promise<ExecOutcome>;

/** Thrown when the remote collection fails. */
export class EsxiError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "EsxiError";
  }
}

// ---------------------------------------------------------------------------
// argv assembly
// ---------------------------------------------------------------------------

/** Build the shared `-o`/`-i`/`-J`/`-p` SSH option list. */
function sshOptions(t: Transport): string[] {
  const o: string[] = [];
  o.push("-o", `ConnectTimeout=${t.connectTimeoutSec}`);
  // BatchMode makes a missing key fail fast instead of hanging on a prompt.
  // It must NOT be set for password auth — it disables password prompting,
  // which is exactly what sshpass is there to answer.
  if (t.auth.kind === "key") o.push("-o", "BatchMode=yes");
  if (t.strictHostKeyChecking !== undefined) {
    o.push("-o", `StrictHostKeyChecking=${t.strictHostKeyChecking}`);
  }
  if (t.auth.kind === "key") {
    if (t.auth.identityAgent !== undefined) {
      o.push("-o", `IdentityAgent=${t.auth.identityAgent}`);
    }
    if (t.auth.identityFile !== undefined) o.push("-i", t.auth.identityFile);
  }
  if (t.proxyJump !== undefined) o.push("-J", t.proxyJump);
  o.push("-p", String(t.port));
  return o;
}

/**
 * Full local argv. `sh -s` reads the script from stdin; `--` ends option
 * parsing so a hostile hostname cannot become a flag.
 */
export function buildArgv(t: Transport): string[] {
  const ssh = [
    t.sshBinary,
    ...sshOptions(t),
    "--",
    `${t.user}@${t.host}`,
    "sh -s",
  ];
  return t.auth.kind === "password"
    ? [t.auth.sshpassBinary, "-e", ...ssh]
    : ssh;
}

/** Environment for the spawned process — carries the password out of argv. */
export function buildEnv(t: Transport): Record<string, string> | undefined {
  return t.auth.kind === "password" ? { SSHPASS: t.auth.password } : undefined;
}

// ---------------------------------------------------------------------------
// Injectable seam
// ---------------------------------------------------------------------------

const defaultExecutor: CommandExecutor = async (argv, opts) => {
  const cmd = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    // `env` is merged over the inherited environment, so PATH still resolves.
    ...(opts.env ? { env: opts.env } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  } catch {
    // ssh can exit before it consumes stdin — a rejected password, a refused
    // connection, an unknown host key. The resulting broken pipe is not the
    // diagnosis; the exit status and stderr below are. Abort to release the
    // stream (leaving it locked would hang `output()`) and fall through.
    await writer.abort().catch(() => {});
  }
  const out = await child.output();
  const dec = new TextDecoder();
  return {
    code: out.success ? 0 : out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
};

let activeExecutor: CommandExecutor = defaultExecutor;

/** Replace the process executor (test seam). */
export function setCommandExecutor(e: CommandExecutor): void {
  activeExecutor = e;
}

/** Restore the production executor. */
export function resetSeams(): void {
  activeExecutor = defaultExecutor;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Run `script` on the host and return stdout. Throws on non-zero exit. */
export async function runScript(
  t: Transport,
  script: string,
  timeoutMs: number,
): Promise<string> {
  let outcome: ExecOutcome;
  try {
    outcome = await activeExecutor(buildArgv(t), {
      timeoutMs,
      stdin: script,
      env: buildEnv(t),
    });
  } catch (err) {
    // A missing sshpass surfaces as a spawn failure, which is otherwise an
    // opaque NotFound — name the likely cause.
    const msg = err instanceof Error ? err.message : String(err);
    if (t.auth.kind === "password" && /NotFound|No such file/i.test(msg)) {
      throw new EsxiError(
        `could not spawn "${t.auth.sshpassBinary}" — password auth needs ` +
          `sshpass on the swamp host; install it or switch to key auth`,
        msg,
      );
    }
    throw new EsxiError("ssh invocation failed", msg);
  }
  if (outcome.code !== 0) {
    throw new EsxiError(
      `remote collection on ${t.host} failed (exit ${outcome.code})`,
      outcome.stderr.trim() || outcome.stdout.trim(),
    );
  }
  return outcome.stdout;
}
