/**
 * Assembly of the `change` resource written by every mutating method.
 *
 * Kept apart from the model so the collapse rule — how a list of per-object
 * outcomes becomes one word a workflow guard can branch on — is a pure
 * function with its own tests, rather than a detail buried in ten method
 * bodies.
 *
 * @module
 */
import type { z } from "npm:zod@4";
import type { ChangeSchema } from "./schemas.ts";

/** One entry in a change resource's `results` array. */
export type ChangeResult = z.infer<typeof ChangeSchema>["results"][number];

/**
 * Collapse per-object outcomes into a single headline action.
 *
 * The one case worth stating: a fan-out where some objects succeeded and
 * others failed reports `partial`, never the successful action. A guard
 * written as `action == "deleted"` must not fire when half the ids are still
 * there.
 */
export function summariseAction(results: ChangeResult[]): string {
  if (results.length === 0) return "none";
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  if (failCount > 0 && okCount > 0) return "partial";
  const actions = new Set(results.map((r) => r.action));
  if (actions.size === 1) return [...actions][0];
  return failCount > 0 ? "failed" : "mixed";
}

/** Build the `change` resource body for one mutating method call. */
export function buildChange(
  method: string,
  instanceLabel: string,
  baseUrl: string,
  performedAt: string,
  results: ChangeResult[],
): Record<string, unknown> {
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  return {
    instanceLabel,
    baseUrl,
    method,
    performedAt,
    // A single-object call has an obvious primary id; a batch does not, and
    // inventing one would let a caller act on an arbitrary member.
    id: results.length === 1 ? results[0].id : 0,
    action: summariseAction(results),
    ok: failCount === 0 && results.length > 0,
    okCount,
    failCount,
    results,
  };
}
