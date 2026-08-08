/**
 * Assembly of the `change` resource written by every mutating method.
 *
 * Kept apart from the model so the collapse rule — how a list of per-target
 * outcomes becomes one word a workflow guard can branch on — is a pure
 * function with its own tests rather than a detail repeated in seven method
 * bodies.
 *
 * @module
 */

/** Outcome for one target of a mutating method. */
export interface ChangeResult {
  /** What was acted on — a device name, or `switch ports 3,5`. */
  target: string;
  /** Past-tense verb for what happened, or `failed`/`notFound`. */
  action: string;
  /** True when the controller accepted the change. */
  ok: boolean;
  /** Failure detail; empty when `ok`. */
  message: string;
}

/**
 * Collapse per-target outcomes into a single headline action.
 *
 * The case worth stating: a fan-out where some targets succeeded and others
 * failed reports `partial`, never the successful action. A guard written as
 * `action == "rebooted"` must not fire when half the switches were missed.
 */
export function summariseAction(results: ChangeResult[]): string {
  if (results.length === 0) return "none";
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  if (failCount > 0 && okCount > 0) return "partial";
  if (failCount > 0) return "failed";
  const actions = new Set(results.map((r) => r.action));
  return actions.size === 1 ? [...actions][0] : "mixed";
}

/** Build the `change` resource body for one mutating method call. */
export function buildChange(
  method: string,
  controllerLabel: string,
  baseUrl: string,
  performedAt: string,
  results: ChangeResult[],
): Record<string, unknown> {
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  return {
    controllerLabel,
    baseUrl,
    method,
    performedAt,
    action: summariseAction(results),
    ok: failCount === 0 && results.length > 0,
    okCount,
    failCount,
    results,
  };
}
