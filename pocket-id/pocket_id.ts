/**
 * `@jamesakeech/pocket-id` — observability for one Pocket ID instance.
 *
 * One model instance represents one Pocket ID installation. That grouping is
 * forced by the API rather than chosen: an API key authenticates against the
 * whole instance, and the interesting facts are cross-cutting — a user's
 * sign-ins come from the audit log, their ability to sign in at all comes from
 * the passkey endpoint, and their reach comes from group membership joined
 * against per-client restrictions.
 *
 * The extension is read-only by design. Pocket ID is the front door to
 * everything else behind it, and the first thing worth having is a truthful
 * picture: is it up, is it current, who can get in, with what, and who has.
 *
 * Three methods sit at three costs. `health` is four requests and needs no
 * admin rights — cheap enough to poll, and it separates "the host is down"
 * from "the key is wrong" from "the key is not an admin's", which is the first
 * fork in every diagnosis. `syncActivity` reads a bounded window of the
 * audit log. `sync` does everything, including the one-request-per-user passkey
 * fan-out, and scores the result into `instance.findings`.
 *
 * Those findings are the point. Pocket ID shows users on one screen and
 * passkeys on another, so "which accounts can no longer sign in" is a question
 * its UI never answers; the same is true of public clients with PKCE disabled,
 * of clients nobody has authorized in a month, and of the API key whose expiry
 * will silently stop this sync.
 *
 * @module
 */
import { z } from "npm:zod@4";

import { authHint, PocketIdClient, PocketIdError } from "./_lib/pid/client.ts";
import { deriveFindings } from "./_lib/pid/findings.ts";
import {
  type ActivityIndex,
  compareVersions,
  flag,
  instanceNameFor,
  isoOrEmpty,
  type Provenance,
  type Raw,
  summariseActivity,
  text,
  toApiKey,
  toAuditEvent,
  toClient,
  toGroup,
  toUser,
} from "./_lib/pid/map.ts";
import {
  ActivityArgsSchema,
  ActivitySchema,
  ApiKeySchema,
  AuditEventSchema,
  ClientSchema,
  type GlobalArgs,
  GlobalArgsSchema,
  GroupSchema,
  HealthArgsSchema,
  HealthSchema,
  InstanceSchema,
  SyncArgsSchema,
  UserSchema,
  withDefaults,
} from "./_lib/pid/schemas.ts";

// --- Method context ---------------------------------------------------------
// Declared structurally rather than imported: swamp wires these at runtime and
// publishes no type package, so every extension states the slice it uses.

interface DataHandle {
  name: string;
  specName: string;
  kind: string;
  dataId: string;
  version: number;
}

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    instanceName: string,
    data: unknown,
  ) => Promise<DataHandle>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

interface MethodResult {
  dataHandles: DataHandle[];
}

type Health = z.infer<typeof HealthSchema>;
type UserResource = z.infer<typeof UserSchema>;
type ClientResource = z.infer<typeof ClientSchema>;
type GroupResource = z.infer<typeof GroupSchema>;
type ApiKeyResource = z.infer<typeof ApiKeySchema>;
type AuditEventResource = z.infer<typeof AuditEventSchema>;

const MS_PER_DAY = 86_400_000;

// --- Shared helpers ---------------------------------------------------------

/** Open a client for one method execution. */
function connect(globalArgs: GlobalArgs): PocketIdClient {
  return new PocketIdClient(withDefaults(globalArgs));
}

/** Provenance stamped onto every resource written by a run. */
function provenance(globalArgs: GlobalArgs, at: string): Provenance {
  return {
    instanceLabel: globalArgs.instanceLabel,
    baseUrl: globalArgs.baseUrl.replace(/\/+$/, ""),
    fetchedAt: at,
  };
}

/**
 * Probe reachability, authentication, admin rights and version drift.
 *
 * Nothing here throws. A health probe that failed when the thing it probes is
 * down would report only its own success, so every failure is captured as a
 * flag plus a sentence in `errors` and the caller decides what to do about it.
 *
 * The two probes are ordered so each one's failure is unambiguous: `/healthz`
 * needs no credentials, and `/api/users/me` needs a valid key of any privilege
 * level. Admin rights are then read from that account's own `isAdmin` rather
 * than inferred from a rejection, which is both cheaper and more truthful — a
 * 403 could always have been something else.
 *
 * `/api/users/me` is the probe rather than `/api/version/current` because the
 * latter did not exist before roughly Pocket ID 2.4, where its 404 would read
 * as an authentication failure against a perfectly healthy instance.
 */
async function probeHealth(
  client: PocketIdClient,
  p: Provenance,
): Promise<Health> {
  const errors: string[] = [];

  const { status, latencyMs } = await client.healthz();
  const reachable = status >= 200 && status < 400;
  if (!reachable) {
    errors.push(
      status === 0
        ? `GET /healthz never answered — is ${p.baseUrl} correct and running?`
        : `GET /healthz returned HTTP ${status}; Pocket ID answers 204. Is ` +
          `${p.baseUrl} pointing at Pocket ID rather than something in front ` +
          `of it?`,
    );
  }

  const me = await client.call("/api/users/me");
  const apiAuthenticated = me.ok;
  const owner = (me.ok ? me.body : null) as Raw | null;
  const apiKeyIsAdmin = flag(owner?.isAdmin);
  const apiKeyOwner = text(owner?.username);
  const apiKeyOwnerId = text(owner?.id);
  if (!me.ok && reachable) {
    errors.push(
      `GET /api/users/me failed: ${me.message}` +
        authHint(me.status, me.code),
    );
  } else if (me.ok && !apiKeyIsAdmin) {
    errors.push(
      `the API key belongs to ${apiKeyOwner || "a non-admin account"}, which ` +
        "is not an admin — users, clients, groups and the audit log all " +
        "require an admin account, so `sync` cannot run",
    );
  }

  const [currentVersion, latestVersion] = await Promise.all([
    readVersion(client, "/api/version/current", "currentVersion"),
    // Unauthenticated, but it makes Pocket ID call out to the upstream release
    // feed — an air-gapped instance fails here and is perfectly healthy.
    readVersion(client, "/api/version/latest", "latestVersion"),
  ]);
  const { updateAvailable, comparable } = compareVersions(
    currentVersion,
    latestVersion,
  );

  return {
    ...p,
    reachable,
    healthzStatus: status,
    apiAuthenticated,
    apiKeyIsAdmin,
    apiKeyOwner,
    apiKeyOwnerId,
    currentVersion,
    latestVersion,
    updateAvailable,
    versionsComparable: comparable,
    latencyMs,
    errors,
  };
}

/**
 * Read one version field, best-effort.
 *
 * Neither endpoint is load-bearing, and both have honest reasons to fail: a
 * release before ~2.4 has no `/api/version/current` at all, and an instance
 * with no outbound network cannot resolve the latest. An empty string here
 * feeds `versionsComparable: false`, which says "no claim either way" — quite
 * different from claiming the instance is current.
 */
async function readVersion(
  client: PocketIdClient,
  path: string,
  field: string,
): Promise<string> {
  const outcome = await client.call(path);
  if (!outcome.ok) return "";
  return text((outcome.body as Raw | null)?.[field]);
}

/**
 * Fail a sync that cannot produce a truthful inventory.
 *
 * Called after the `health` resource has been written, which is a deliberate
 * departure from "throw before writing": that rule exists so a failed run
 * leaves no misleading data behind, and a health record saying the instance is
 * unreachable is the opposite of misleading. It is the most useful thing a
 * failed run can leave.
 */
function requireAdminAccess(health: Health): void {
  if (health.reachable && health.apiAuthenticated && health.apiKeyIsAdmin) {
    return;
  }
  throw new PocketIdError(
    `cannot read ${health.instanceLabel}: ${health.errors.join(" ")}`,
    health.healthzStatus,
    "/api",
  );
}

/** Read a bounded window of the audit log and aggregate it. */
async function collectActivity(
  client: PocketIdClient,
  p: Provenance,
  opts: { windowDays: number; maxAuditEvents: number },
): Promise<{ events: AuditEventResource[]; index: ActivityIndex }> {
  const windowEndMs = Date.parse(p.fetchedAt);
  const windowStartMs = windowEndMs - opts.windowDays * MS_PER_DAY;

  const result = await client.list<Raw>("/api/audit-logs/all", {
    sort: { column: "createdAt", direction: "desc" },
    maxItems: opts.maxAuditEvents,
    // Pocket ID has no date filter on the audit log, so the window is applied
    // by walking newest-first and refusing the first event that falls outside
    // it — which also stops paging, keeping a short window genuinely cheap.
    take: (raw) => {
      const at = Date.parse(isoOrEmpty(raw.createdAt));
      return Number.isNaN(at) || at >= windowStartMs;
    },
  });

  const events = result.items.map((raw) => toAuditEvent(raw, p));
  const index = summariseActivity(events, {
    windowDays: opts.windowDays,
    windowStartMs,
    windowEndMs,
    totalEventsOnServer: result.totalItems,
    truncated: result.truncated,
  });
  return { events, index };
}

/**
 * Read each user's passkeys, degrading to the key owner's own on old releases.
 *
 * `/api/users/:id/webauthn-credentials` is the admin endpoint, and it did not
 * exist before roughly Pocket ID 2.4. Those releases expose only
 * `/api/webauthn/credentials`, which returns the *authenticating* account's
 * passkeys and nothing else — so there the honest outcome is "the key owner has
 * these, and nothing is known about anyone else", never "nobody has any".
 *
 * Capability is settled once, up front, against the key owner's own id. That
 * account certainly exists, so a 404 for it proves the route itself is absent
 * rather than the user — no error-message parsing, and the probe doubles as a
 * useful read.
 */
async function collectPasskeys(
  client: PocketIdClient,
  ctx: MethodContext,
  users: Raw[],
  selfUserId: string,
): Promise<Map<string, Raw[]>> {
  const byUserId = new Map<string, Raw[]>();
  const list = (body: unknown) => Array.isArray(body) ? body as Raw[] : [];
  const perUserPath = (id: string) =>
    `/api/users/${encodeURIComponent(id)}/webauthn-credentials`;

  if (selfUserId !== "") {
    const probe = await client.call(perUserPath(selfUserId));
    if (probe.ok) {
      byUserId.set(selfUserId, list(probe.body));
    } else if (probe.status === 404) {
      const own = await client.call("/api/webauthn/credentials");
      if (own.ok) byUserId.set(selfUserId, list(own.body));
      ctx.logger.warning(
        "this Pocket ID release has no admin endpoint for another account's " +
          "passkeys, so only the API key owner's own could be read — every " +
          "other account is reported as unknown, not as having none",
      );
      return byUserId;
    } else {
      ctx.logger.warning(
        "could not read the API key owner's passkeys — {reason}",
        { reason: probe.message },
      );
    }
  }

  for (const user of users) {
    const id = text(user.id);
    if (id === "" || byUserId.has(id)) continue;
    const outcome = await client.call(perUserPath(id));
    if (outcome.ok) {
      byUserId.set(id, list(outcome.body));
      continue;
    }
    // A user deleted between the list and this read must not abandon the
    // others — and a missing entry must not silently become a
    // `user-without-passkey` finding, so that user is written as "not
    // collected" rather than as passkey-less.
    ctx.logger.warning(
      "could not read passkeys for {username} — reporting them as not " +
        "collected. {reason}",
      { username: text(user.username) || id, reason: outcome.message },
    );
  }
  return byUserId;
}

/** Write the `activity` rollup and, optionally, one resource per event. */
async function writeActivity(
  ctx: MethodContext,
  p: Provenance,
  events: AuditEventResource[],
  index: ActivityIndex,
  writeEvents: boolean,
): Promise<DataHandle[]> {
  const handles: DataHandle[] = [];
  if (writeEvents) {
    for (const event of events) {
      if (event.id === "") continue;
      handles.push(
        await ctx.writeResource(
          "auditEvent",
          instanceNameFor("event", event.id),
          event,
        ),
      );
    }
  }
  handles.push(
    await ctx.writeResource(
      "activity",
      "activity",
      {
        ...p,
        ...index.rollup,
        eventsWritten: writeEvents ? handles.length : 0,
      } satisfies z.infer<typeof ActivitySchema>,
    ),
  );
  return handles;
}

// --- Model ------------------------------------------------------------------

/** Model definition for observing a single Pocket ID instance. */
export const model = {
  type: "@jamesakeech/pocket-id",
  version: "2026.08.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    health: {
      description:
        "Is the instance up, which account the API key belongs to, is that " +
        "account an admin, and is the deployed version current. Written by " +
        "every method; the only resource that survives a run against a " +
        "broken instance.",
      schema: HealthSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    instance: {
      description:
        "Instance-wide rollup: user, client, group and API key counts, plus " +
        "`findings` — accounts with no passkey, public clients without PKCE, " +
        "unused clients, empty groups and expiring API keys, scored by " +
        "severity.",
      schema: InstanceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    user: {
      description:
        "One user: identity, group membership, custom claim keys, registered " +
        "passkeys, and sign-in counts and locations inside the activity " +
        "window.",
      schema: UserSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    client: {
      description:
        "One OIDC client: callback URLs, PKCE and consent settings, token " +
        "lifetimes, group restriction, and how many times it was authorized " +
        "inside the activity window.",
      schema: ClientSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    group: {
      description:
        "One user group: its claim name, member count, and whether LDAP owns " +
        "it.",
      schema: GroupSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    apiKey: {
      description:
        "One API key belonging to the account this model authenticates as — " +
        "Pocket ID exposes no endpoint listing other users' keys, even to an " +
        "admin. Carries days until expiry and days since last use.",
      schema: ApiKeySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    activity: {
      description:
        "Audit-log rollup over the window: counts per event type, a gap-free " +
        "daily series, top users and clients, sign-in locations and devices.",
      schema: ActivitySchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    auditEvent: {
      description:
        "One audit-log entry: event type, user, client, IP, resolved city and " +
        "country, and device. Events are immutable, so polling accumulates " +
        "history that outlives Pocket ID's own retention.",
      schema: AuditEventSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    health: {
      description:
        "Probe the instance without admin rights: /healthz, which account " +
        "the API key belongs to, whether that account is an admin, and " +
        "whether the deployed version is behind the latest. Cheap enough to " +
        "poll, and it reports failure as data rather than throwing.",
      arguments: HealthArgsSchema,
      execute: async (
        _args: z.infer<typeof HealthArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = connect(ctx.globalArgs);
        const p = provenance(ctx.globalArgs, new Date().toISOString());
        const health = await probeHealth(client, p);

        if (health.errors.length > 0) {
          ctx.logger.warning("{label} is not fully healthy: {reason}", {
            label: p.instanceLabel,
            reason: health.errors.join(" "),
          });
        } else {
          ctx.logger.info(
            "{label} is up on {version} ({latency}ms)",
            {
              label: p.instanceLabel,
              version: health.currentVersion || "unknown",
              latency: health.latencyMs,
            },
          );
        }

        const handle = await ctx.writeResource("health", "health", health);
        return { dataHandles: [handle] };
      },
    },

    syncActivity: {
      description:
        "Read a bounded window of the audit log and write the `activity` " +
        "rollup plus one resource per event. Far cheaper than a full `sync` " +
        "— use it to poll for sign-in activity between inventory runs.",
      arguments: ActivityArgsSchema,
      execute: async (
        args: z.infer<typeof ActivityArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = connect(ctx.globalArgs);
        const p = provenance(ctx.globalArgs, new Date().toISOString());

        const health = await probeHealth(client, p);
        const handles = [await ctx.writeResource("health", "health", health)];
        requireAdminAccess(health);

        const { events, index } = await collectActivity(client, p, args);
        if (index.rollup.truncated) {
          ctx.logger.warning(
            "hit maxAuditEvents ({max}) before the {days}-day window ran " +
              "out — every count in `activity` is a floor, not a total",
            { max: args.maxAuditEvents, days: args.windowDays },
          );
        }
        ctx.logger.info(
          "read {count} audit events over {days} days ({signIns} sign-ins)",
          {
            count: events.length,
            days: args.windowDays,
            signIns: index.rollup.signInCount,
          },
        );

        handles.push(
          ...await writeActivity(ctx, p, events, index, args.writeAuditEvents),
        );
        return { dataHandles: handles };
      },
    },

    sync: {
      description:
        "Read the whole instance and write one resource per user, OIDC " +
        "client, group and API key, plus the audit-log rollup and an " +
        "instance rollup carrying scored findings. Requires an admin API key.",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = connect(ctx.globalArgs);
        const fetchedAt = new Date().toISOString();
        const runStartedMs = Date.parse(fetchedAt);
        const p = provenance(ctx.globalArgs, fetchedAt);

        const health = await probeHealth(client, p);
        const handles = [await ctx.writeResource("health", "health", health)];
        requireAdminAccess(health);
        ctx.logger.info("reading {label} at {url}", {
          label: p.instanceLabel,
          url: p.baseUrl,
        });

        // Collect and shape everything before writing anything: a mapping
        // failure halfway through would otherwise leave an inventory that is
        // half this run and half the last one, and findings derived from it
        // would be scored against a directory that never existed.
        const activity = args.includeAuditEvents
          ? await collectActivity(client, p, args)
          : null;

        const [rawUsers, rawClients, rawGroups, rawApiKeys] = await Promise.all(
          [
            client.list<Raw>("/api/users", {
              sort: { column: "username", direction: "asc" },
            }),
            client.list<Raw>("/api/oidc/clients", {
              sort: { column: "name", direction: "asc" },
            }),
            client.list<Raw>("/api/user-groups", {
              sort: { column: "friendlyName", direction: "asc" },
            }),
            client.list<Raw>("/api/api-keys", {
              sort: { column: "expiresAt", direction: "asc" },
            }),
          ],
        );

        // An inventory read has no cap, so truncation here means the page
        // budget ran out. It must be said out loud: findings are derived from
        // absence — a user missing from a short list looks like one that
        // passed every check.
        for (
          const [what, result] of [
            ["users", rawUsers],
            ["clients", rawClients],
            ["groups", rawGroups],
            ["API keys", rawApiKeys],
          ] as const
        ) {
          if (!result.truncated) continue;
          ctx.logger.warning(
            "read only {read} of {total} {what} — findings below are " +
              "incomplete and absence proves nothing",
            { read: result.items.length, total: result.totalItems, what },
          );
        }

        const passkeys = args.includePasskeys
          ? await collectPasskeys(
            client,
            ctx,
            rawUsers.items,
            health.apiKeyOwnerId,
          )
          : null;

        const users: UserResource[] = rawUsers.items.map((raw) =>
          toUser(
            raw,
            p,
            passkeys === null ? null : passkeys.get(text(raw.id)) ?? null,
            activity === null
              ? null
              : activity.index.byUserId.get(text(raw.id)) ??
                {
                  signInCount: 0,
                  lastSignInAt: "",
                  lastSignInFrom: "",
                  countries: [],
                },
          )
        );
        const clients: ClientResource[] = rawClients.items.map((raw) =>
          toClient(
            raw,
            p,
            activity?.index.byClientName.get(text(raw.name)) ?? null,
            activity !== null,
          )
        );
        const groups: GroupResource[] = rawGroups.items.map((raw) =>
          toGroup(raw, p)
        );
        const apiKeys: ApiKeyResource[] = rawApiKeys.items.map((raw) =>
          toApiKey(raw, p, runStartedMs, runStartedMs)
        );

        const collectedPasskeyUsers = users.filter((u) => u.passkeysCollected);

        const findings = deriveFindings({
          instanceLabel: p.instanceLabel,
          updateAvailable: health.updateAvailable,
          currentVersion: health.currentVersion,
          latestVersion: health.latestVersion,
          users,
          clients,
          groups,
          apiKeys,
          passkeysCollected: args.includePasskeys &&
            users.every((u) => u.passkeysCollected),
          activityCollected: activity !== null,
          windowDays: args.windowDays,
          apiKeyExpiryWarningDays: args.apiKeyExpiryWarningDays,
          accessTokenMaxMinutes: args.accessTokenMaxMinutes,
        });

        for (const user of users) {
          handles.push(
            await ctx.writeResource(
              "user",
              instanceNameFor("user", user.id),
              user,
            ),
          );
        }
        for (const oidcClient of clients) {
          handles.push(
            await ctx.writeResource(
              "client",
              instanceNameFor("client", oidcClient.id),
              oidcClient,
            ),
          );
        }
        for (const group of groups) {
          handles.push(
            await ctx.writeResource(
              "group",
              instanceNameFor("group", group.id),
              group,
            ),
          );
        }
        for (const key of apiKeys) {
          handles.push(
            await ctx.writeResource(
              "apiKey",
              instanceNameFor("apikey", key.id),
              key,
            ),
          );
        }
        if (activity !== null) {
          handles.push(
            ...await writeActivity(
              ctx,
              p,
              activity.events,
              activity.index,
              args.writeAuditEvents,
            ),
          );
        }

        const instance: z.infer<typeof InstanceSchema> = {
          ...p,
          currentVersion: health.currentVersion,
          latestVersion: health.latestVersion,
          updateAvailable: health.updateAvailable,
          userCount: users.length,
          adminCount: users.filter((u) => u.isAdmin).length,
          disabledUserCount: users.filter((u) => u.disabled).length,
          ldapUserCount: users.filter((u) => u.ldapManaged).length,
          // Totalled over the users actually read, and -1 when none were —
          // an unread account must never be counted as owning zero passkeys.
          passkeyCount: collectedPasskeyUsers.length === 0
            ? -1
            : collectedPasskeyUsers.reduce((sum, u) => sum + u.passkeyCount, 0),
          usersWithoutPasskeys: collectedPasskeyUsers
            .filter((u) => u.passkeyCount === 0)
            .map((u) => u.username),
          usersWithUnknownPasskeys: args.includePasskeys
            ? users.filter((u) => !u.passkeysCollected).map((u) => u.username)
            : [],
          clientCount: clients.length,
          publicClientCount: clients.filter((c) => c.isPublic).length,
          groupRestrictedClientCount:
            clients.filter((c) => c.isGroupRestricted).length,
          unusedClients: activity === null
            ? []
            : clients.filter((c) => c.authorizationCount === 0).map((c) =>
              c.name
            ),
          groupCount: groups.length,
          emptyGroups: groups.filter((g) => g.userCount === 0).map((g) =>
            g.friendlyName || g.name
          ),
          apiKeyCount: apiKeys.length,
          apiKeysExpired: apiKeys.filter((k) => k.expired).length,
          apiKeysExpiringSoon:
            apiKeys.filter((k) =>
              !k.expired && k.daysUntilExpiry <= args.apiKeyExpiryWarningDays
            ).length,
          apiKeysNeverUsed: apiKeys.filter((k) => k.neverUsed).length,
          passkeysCollected: args.includePasskeys &&
            users.every((u) => u.passkeysCollected),
          activityCollected: activity !== null,
          findings,
          criticalFindingCount:
            findings.filter((f) => f.severity === "critical").length,
          warnFindingCount:
            findings.filter((f) => f.severity === "warn").length,
          trackedUserIds: users.map((u) => u.id),
          trackedClientIds: clients.map((c) => c.id),
        };
        handles.push(await ctx.writeResource("instance", "instance", instance));

        ctx.logger.info(
          "{users} users, {clients} clients, {groups} groups — " +
            "{critical} critical and {warn} warning findings",
          {
            users: users.length,
            clients: clients.length,
            groups: groups.length,
            critical: instance.criticalFindingCount,
            warn: instance.warnFindingCount,
          },
        );
        for (const finding of findings) {
          if (finding.severity !== "critical") continue;
          ctx.logger.warning("{code}: {subject} — {detail}", finding);
        }

        return { dataHandles: handles };
      },
    },
  },
};
