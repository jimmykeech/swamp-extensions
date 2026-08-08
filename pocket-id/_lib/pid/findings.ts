/**
 * Posture findings derived from a completed inventory.
 *
 * These are the questions Pocket ID's own UI cannot answer, because each one
 * spans two screens: which accounts have no passkey and therefore cannot sign
 * in unaided, which public clients are missing the PKCE that is their only
 * protection, which API key expiring next will break this very sync, which
 * clients nobody has touched.
 *
 * Every finding is deliberately conditional on the data having been collected.
 * `includePasskeys: false` means the passkey findings are not raised at all
 * rather than raised against a count of zero — an unasked question must never
 * come back as a clean answer.
 *
 * @module
 */
import type {
  ApiKeySchema,
  ClientSchema,
  Finding,
  GroupSchema,
  UserSchema,
} from "./schemas.ts";
import type { z } from "npm:zod@4";
import { EXTERNAL_NETWORK, INTERNAL_NETWORK } from "./map.ts";

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

/** Everything the findings are derived from. */
export interface FindingInput {
  instanceLabel: string;
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  users: Array<z.infer<typeof UserSchema>>;
  clients: Array<z.infer<typeof ClientSchema>>;
  groups: Array<z.infer<typeof GroupSchema>>;
  apiKeys: Array<z.infer<typeof ApiKeySchema>>;
  passkeysCollected: boolean;
  activityCollected: boolean;
  windowDays: number;
  apiKeyExpiryWarningDays: number;
  accessTokenMaxMinutes: number;
}

/**
 * Score an inventory, most severe first.
 *
 * Sorted by severity, then code, then subject — a stable order matters because
 * a workflow that diffs two runs should see churn only when the findings
 * themselves change.
 */
export function deriveFindings(input: FindingInput): Finding[] {
  const findings: Finding[] = [];
  const add = (
    severity: Finding["severity"],
    code: string,
    subject: string,
    detail: string,
  ) => findings.push({ severity, code, subject, detail });

  const activeAdmins = input.users.filter((u) => u.isAdmin && !u.disabled);

  if (input.updateAvailable) {
    add(
      "warn",
      "update-available",
      input.instanceLabel,
      `Running ${input.currentVersion}; ${input.latestVersion} is available.`,
    );
  }

  // An identity provider nobody can administer is unrecoverable through the
  // UI, so this outranks everything else even though it is rare.
  if (activeAdmins.length === 0 && input.users.length > 0) {
    add(
      "critical",
      "no-admin",
      input.instanceLabel,
      "No enabled user has admin rights — nobody can manage this instance.",
    );
  } else if (activeAdmins.length === 1) {
    add(
      "info",
      "sole-admin",
      activeAdmins[0].username,
      "The only enabled admin. Losing this account's passkeys locks the " +
        "instance out of its own admin UI.",
    );
  }

  if (input.passkeysCollected) {
    for (const user of input.users) {
      if (user.disabled || user.passkeyCount !== 0) continue;
      // Pocket ID authenticates with passkeys only; an account without one can
      // get in solely via an admin-minted one-time link.
      add(
        user.isAdmin ? "critical" : "warn",
        user.isAdmin ? "admin-without-passkey" : "user-without-passkey",
        user.username,
        "No passkey registered — this account cannot sign in without a " +
          "one-time access token.",
      );
    }
  }

  if (input.activityCollected) {
    for (const user of input.users) {
      const external = user.signInCountries.filter(
        (c) => c !== INTERNAL_NETWORK && c !== EXTERNAL_NETWORK,
      );
      if (external.length > 1) {
        add(
          "warn",
          "signin-from-multiple-countries",
          user.username,
          `Signed in from ${external.join(", ")} within the last ` +
            `${input.windowDays} days.`,
        );
      }
    }
  }

  for (const client of input.clients) {
    if (client.isPublic && !client.pkceEnabled) {
      add(
        "critical",
        "public-client-without-pkce",
        client.name,
        "Public client with PKCE disabled — an intercepted authorization " +
          "code can be exchanged for a token by anyone.",
      );
    }
    // -1 means the release never reported a lifetime, so there is nothing to
    // judge — not a suspiciously short one.
    if (
      client.accessTokenDurationMinutes >= 0 &&
      client.accessTokenDurationMinutes > input.accessTokenMaxMinutes
    ) {
      add(
        "warn",
        "long-lived-access-token",
        client.name,
        `Access tokens live ${client.accessTokenDurationMinutes} minutes, ` +
          `over the ${input.accessTokenMaxMinutes}-minute threshold; a leaked ` +
          "token stays usable for that long.",
      );
    }
    if (input.activityCollected && client.authorizationCount === 0) {
      add(
        "info",
        "unused-client",
        client.name,
        `No authorizations in the last ${input.windowDays} days.`,
      );
    }
  }

  for (const group of input.groups) {
    if (group.userCount === 0) {
      add(
        "info",
        "empty-group",
        group.friendlyName || group.name,
        "No members, so any client restricted to this group is unreachable.",
      );
    }
  }

  for (const key of input.apiKeys) {
    // The key doing the reading gets its own severity: its expiry stops this
    // extension, and a silent sync is worse than a noisy one.
    if (key.expired) {
      add(
        "warn",
        "api-key-expired",
        key.name,
        `Expired ${Math.abs(key.daysUntilExpiry)} days ago.`,
      );
    } else if (key.daysUntilExpiry <= input.apiKeyExpiryWarningDays) {
      add(
        key.isSelf ? "critical" : "warn",
        "api-key-expiring",
        key.name,
        `Expires in ${key.daysUntilExpiry} days` +
          (key.isSelf
            ? " — this is the key this sync authenticates with."
            : "."),
      );
    }
    if (key.neverUsed && !key.expired) {
      add(
        "info",
        "api-key-never-used",
        key.name,
        "Never used since it was created.",
      );
    }
  }

  return findings.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.code.localeCompare(b.code) ||
    a.subject.localeCompare(b.subject)
  );
}
