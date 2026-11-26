/**
 * Translation from Pocket ID's API shapes to this extension's resources.
 *
 * Three jobs live here. Field normalisation, because Pocket ID uses `null` for
 * absent strings and a resource that CEL can read without existence guards is
 * worth more than a faithful echo. Derivation, because `daysUntilExpiry` and
 * `updateAvailable` are the questions people actually ask. And the audit-log
 * rollup, which is the only place two endpoints are genuinely joined: the log
 * records a client *name* and a user *id*, so activity is attached to users by
 * id and to clients by name, and the difference matters — renaming a client
 * orphans its history.
 *
 * @module
 */
import type {
  ActivitySchema,
  ApiKeySchema,
  AuditEventSchema,
  ClientSchema,
  GroupSchema,
  UserSchema,
} from "./schemas.ts";
import type { z } from "npm:zod@4";

/** A JSON object as returned by the Pocket ID API. */
export type Raw = Record<string, unknown>;

/** Fields every resource carries. */
export interface Provenance {
  instanceLabel: string;
  baseUrl: string;
  fetchedAt: string;
}

/** The country Pocket ID records for a non-routable client address. */
export const INTERNAL_NETWORK = "Internal Network";

/** The country Pocket ID records for an address it could not place. */
export const EXTERNAL_NETWORK = "External Network";

/** Every event type Pocket ID treats as a sign-in. */
export const SIGN_IN_EVENTS = ["SIGN_IN", "TOKEN_SIGN_IN", "REMOTE_SIGN_IN"];

/** Every event type Pocket ID treats as authorizing a client. */
export const AUTHORIZATION_EVENTS = [
  "CLIENT_AUTHORIZATION",
  "NEW_CLIENT_AUTHORIZATION",
  "DEVICE_CODE_AUTHORIZATION",
  "NEW_DEVICE_CODE_AUTHORIZATION",
];

const MS_PER_DAY = 86_400_000;

/**
 * Clock skew allowed when deciding which API key did the reading.
 *
 * `lastUsedAt` is stamped by Pocket ID's clock and compared against the swamp
 * host's, so a server running a minute behind would otherwise disown its own
 * key. Two minutes is generous for NTP-synced hosts and still far tighter than
 * any plausible gap between two different keys being used.
 */
const SELF_KEY_SKEW_MS = 120_000;

// --- Field readers ----------------------------------------------------------

/** Read a string field, collapsing `null`/absent/non-string to `""`. */
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read a boolean field, treating anything non-boolean as false. */
export function flag(value: unknown): boolean {
  return value === true;
}

/** Read an integer field, treating anything non-finite as `fallback`. */
export function int(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

/** Read an array-of-strings field, dropping non-string members. */
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/**
 * Read a timestamp field as an ISO string, or `""` when there is none.
 *
 * Go marshals a zero `time.Time` as year one rather than omitting it, and a
 * resource claiming an API key was last used in the year 1 is worse than one
 * admitting it was never used.
 */
export function isoOrEmpty(value: unknown): string {
  const raw = text(value);
  if (raw === "") return "";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return "";
  return ms <= Date.parse("0002-01-01T00:00:00Z") ? "" : raw;
}

/** Whole days from `fromMs` to `toIso`, rounded towards the past. */
export function daysUntil(toIso: string, fromMs: number): number {
  const target = Date.parse(toIso);
  if (Number.isNaN(target)) return 0;
  return Math.floor((target - fromMs) / MS_PER_DAY);
}

/** The custom-claim keys on a user or group, sorted. */
function claimKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((claim) => text((claim as Raw | null)?.key))
    .filter((key) => key !== "")
    .sort();
}

// --- Instance names ---------------------------------------------------------

/** FNV-1a, so a slugged id keeps a stable tie-break without a dependency. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Reduce an id to characters that are safe in a storage path. */
export function slugify(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return slug === "" ? "x" : slug;
}

/**
 * Build the instance name a resource is stored under.
 *
 * User, group and event ids are UUIDs and survive slugging unchanged. OIDC
 * client ids do not: Pocket ID lets an admin choose them, so `My App` and
 * `my.app` both slug to `my-app` and would overwrite each other on disk. When
 * slugging alters the id at all, a hash of the original is appended — so
 * distinct clients stay distinct, and each one keeps the same name across runs.
 */
export function instanceNameFor(prefix: string, id: string): string {
  const slug = slugify(id);
  return slug === id.toLowerCase()
    ? `${prefix}-${slug}`
    : `${prefix}-${slug}-${shortHash(id)}`;
}

// --- Versions ---------------------------------------------------------------

/** Split a version into numeric components, or `null` when it isn't numeric. */
function versionParts(version: string): number[] | null {
  const match = version.trim().replace(/^v/i, "").match(/^\d+(?:\.\d+)*/);
  if (match === null) return null;
  return match[0].split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * Decide whether the deployed version is behind the latest.
 *
 * A plain string comparison would report a dev build as out of date and would
 * order `1.10.0` before `1.9.0`, so components are compared numerically. A
 * build whose version isn't numeric is reported as not comparable rather than
 * as up to date — silence and "you're current" are different claims.
 */
export function compareVersions(
  current: string,
  latest: string,
): { updateAvailable: boolean; comparable: boolean } {
  const a = versionParts(current);
  const b = versionParts(latest);
  if (a === null || b === null) {
    return { updateAvailable: false, comparable: false };
  }
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return { updateAvailable: left < right, comparable: true };
    }
  }
  return { updateAvailable: false, comparable: true };
}

// --- Entity mapping ---------------------------------------------------------

/** A user's activity inside the window, joined on user id. */
export interface UserActivity {
  signInCount: number;
  lastSignInAt: string;
  lastSignInFrom: string;
  countries: string[];
}

/** A client's activity inside the window, joined on client name. */
export interface ClientActivity {
  authorizationCount: number;
  distinctUserCount: number;
  lastAuthorizationAt: string;
}

/** Passkeys for one user, or `null` when they were not collected. */
export type PasskeyList = Raw[] | null;

/** Map a `UserDto` plus its passkeys and activity to a `user` resource. */
export function toUser(
  raw: Raw,
  p: Provenance,
  passkeys: PasskeyList,
  activity: UserActivity | null,
): z.infer<typeof UserSchema> {
  const ldapId = text(raw.ldapId);
  const groups = strings(
    (Array.isArray(raw.userGroups) ? raw.userGroups : []).map((g) =>
      text((g as Raw | null)?.name)
    ),
  ).filter((name) => name !== "").sort();

  return {
    ...p,
    id: text(raw.id),
    username: text(raw.username),
    email: text(raw.email),
    emailVerified: flag(raw.emailVerified),
    firstName: text(raw.firstName),
    lastName: text(raw.lastName),
    displayName: text(raw.displayName),
    isAdmin: flag(raw.isAdmin),
    disabled: flag(raw.disabled),
    locale: text(raw.locale),
    ldapId,
    ldapManaged: ldapId !== "",
    groups,
    groupCount: groups.length,
    customClaimKeys: claimKeys(raw.customClaims),
    passkeyCount: passkeys === null ? -1 : passkeys.length,
    passkeys: (passkeys ?? []).map((key) => ({
      id: text(key.id),
      name: text(key.name),
      createdAt: isoOrEmpty(key.createdAt),
      attestationType: text(key.attestationType),
      transports: strings(key.transport),
      backupEligible: flag(key.backupEligible),
      backupState: flag(key.backupState),
    })),
    passkeysCollected: passkeys !== null,
    signInCount: activity === null ? -1 : activity.signInCount,
    lastSignInAt: activity?.lastSignInAt ?? "",
    lastSignInFrom: activity?.lastSignInFrom ?? "",
    signInCountries: activity?.countries ?? [],
    activityCollected: activity !== null,
  };
}

/** Map an `OidcClientWithAllowedGroupsCountDto` to a `client` resource. */
export function toClient(
  raw: Raw,
  p: Provenance,
  activity: ClientActivity | null,
  activityCollected: boolean,
): z.infer<typeof ClientSchema> {
  const credentials = (raw.credentials ?? {}) as Raw;
  const federated = Array.isArray(credentials.federatedIdentities)
    ? credentials.federatedIdentities
    : [];

  return {
    ...p,
    id: text(raw.id),
    name: text(raw.name),
    description: text(raw.description),
    clientType: text(raw.clientType),
    isPublic: flag(raw.isPublic),
    pkceEnabled: flag(raw.pkceEnabled),
    requiresPushedAuthorizationRequests: flag(
      raw.requiresPushedAuthorizationRequests,
    ),
    requiresReauthentication: flag(raw.requiresReauthentication),
    skipConsent: flag(raw.skipConsent),
    isGroupRestricted: flag(raw.isGroupRestricted),
    allowedUserGroupsCount: int(raw.allowedUserGroupsCount),
    callbackURLs: strings(raw.callbackURLs),
    logoutCallbackURLs: strings(raw.logoutCallbackURLs),
    launchURL: text(raw.launchURL),
    hasLogo: flag(raw.hasLogo),
    hasDarkLogo: flag(raw.hasDarkLogo),
    // -1, not 0, when the release omits these: a client whose access tokens
    // "live 0 minutes" is nonsense, and it would read as unusually strict
    // rather than as unreported.
    accessTokenDurationMinutes: int(raw.accessTokenDurationMinutes, -1),
    refreshTokenDurationMinutes: int(raw.refreshTokenDurationMinutes, -1),
    federatedIdentityIssuers: federated
      .map((identity) => text((identity as Raw | null)?.issuer))
      .filter((issuer) => issuer !== "")
      .sort(),
    // A client with no activity is written as zero rather than -1 when the log
    // *was* read — "nobody used this" is the finding, and it would be lost if
    // it were indistinguishable from "not measured".
    authorizationCount: activityCollected
      ? activity?.authorizationCount ?? 0
      : -1,
    distinctUserCount: activityCollected
      ? activity?.distinctUserCount ?? 0
      : -1,
    lastAuthorizationAt: activity?.lastAuthorizationAt ?? "",
    activityCollected,
  };
}

/** Map a `UserGroupMinimalDto` to a `group` resource. */
export function toGroup(raw: Raw, p: Provenance): z.infer<typeof GroupSchema> {
  const ldapId = text(raw.ldapId);
  return {
    ...p,
    id: text(raw.id),
    name: text(raw.name),
    friendlyName: text(raw.friendlyName),
    userCount: int(raw.userCount),
    ldapId,
    ldapManaged: ldapId !== "",
    createdAt: isoOrEmpty(raw.createdAt),
    customClaimKeys: claimKeys(raw.customClaims),
  };
}

/** Map an `apiKeyDto` to an `apiKey` resource. */
export function toApiKey(
  raw: Raw,
  p: Provenance,
  nowMs: number,
  runStartedMs: number,
): z.infer<typeof ApiKeySchema> {
  const expiresAt = isoOrEmpty(raw.expiresAt);
  const lastUsedAt = isoOrEmpty(raw.lastUsedAt);
  const lastUsedMs = lastUsedAt === "" ? NaN : Date.parse(lastUsedAt);
  const daysUntilExpiry = expiresAt === "" ? 0 : daysUntil(expiresAt, nowMs);

  return {
    ...p,
    id: text(raw.id),
    name: text(raw.name),
    description: text(raw.description),
    createdAt: isoOrEmpty(raw.createdAt),
    expiresAt,
    lastUsedAt,
    daysUntilExpiry,
    expired: expiresAt !== "" && daysUntilExpiry < 0,
    neverUsed: lastUsedAt === "",
    daysSinceLastUse: Number.isNaN(lastUsedMs)
      ? -1
      : Math.max(0, Math.floor((nowMs - lastUsedMs) / MS_PER_DAY)),
    expirationEmailSent: flag(raw.expirationEmailSent),
    // The key doing the reading is stamped as used by that very read, so it is
    // the one whose `lastUsedAt` falls inside this run. Identifying it matters
    // because its expiry is the one that silently stops the sync.
    isSelf: !Number.isNaN(lastUsedMs) &&
      lastUsedMs >= runStartedMs - SELF_KEY_SKEW_MS,
  };
}

/** Map an `AuditLogDto` to an `auditEvent` resource. */
export function toAuditEvent(
  raw: Raw,
  p: Provenance,
): z.infer<typeof AuditEventSchema> {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries((raw.data ?? {}) as Raw)) {
    if (typeof value === "string") data[key] = value;
  }
  const country = text(raw.country);

  return {
    ...p,
    id: text(raw.id),
    createdAt: isoOrEmpty(raw.createdAt),
    event: text(raw.event),
    ipAddress: text(raw.ipAddress),
    country,
    city: text(raw.city),
    device: text(raw.device),
    // The DTO spells this `userID` where every other field is camelCase; read
    // both so a future normalisation upstream doesn't blank the column.
    userId: text(raw.userID) || text(raw.userId),
    username: text(raw.username),
    actorUsername: text(raw.actorUsername),
    clientName: data.clientName ?? "",
    internalNetwork: country === INTERNAL_NETWORK,
    data,
  };
}

// --- Activity rollup --------------------------------------------------------

/** Everything derived from one window of the audit log. */
export interface ActivityIndex {
  /** Per-user activity, keyed by user id. */
  byUserId: Map<string, UserActivity>;
  /** Per-client activity, keyed by the client *name* the log records. */
  byClientName: Map<string, ClientActivity>;
  /** The rollup, minus the fields only the method knows. */
  rollup: Omit<
    z.infer<typeof ActivitySchema>,
    keyof Provenance | "eventsWritten"
  >;
}

/** `city, country`, or whichever half exists. */
function placeOf(event: { city: string; country: string }): string {
  if (event.city !== "" && event.country !== "") {
    return `${event.city}, ${event.country}`;
  }
  return event.city !== "" ? event.city : event.country;
}

/** Highest counts first, ties broken by label so output is stable. */
function topN(counts: Map<string, number>, n: number) {
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, n);
}

function bump(counts: Map<string, number>, key: string) {
  if (key === "") return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Aggregate a window of audit events into the `activity` rollup and the
 * per-user and per-client indexes the inventory resources join against.
 *
 * Events arrive newest-first, but "most recent" is computed by comparing
 * timestamps rather than trusting arrival order — the log is sorted by the
 * server, and a rollup that silently depended on that would break the day a
 * caller passed a different sort.
 */
export function summariseActivity(
  events: Array<z.infer<typeof AuditEventSchema>>,
  opts: {
    windowDays: number;
    windowStartMs: number;
    windowEndMs: number;
    totalEventsOnServer: number;
    truncated: boolean;
  },
): ActivityIndex {
  const byUserId = new Map<string, UserActivity>();
  const clientUsers = new Map<string, Set<string>>();
  const byClientName = new Map<string, ClientActivity>();

  const byEvent = new Map<string, number>();
  const dayCounts = new Map<string, number>();
  const userEventCounts = new Map<string, number>();
  const clientEventCounts = new Map<string, number>();
  const locationCounts = new Map<string, number>();
  const deviceCounts = new Map<string, number>();
  const externalCountries = new Set<string>();
  const uniqueUsers = new Set<string>();

  let signInCount = 0;
  let passkeysAdded = 0;
  let passkeysRemoved = 0;
  let accountsCreated = 0;
  let newClientAuthorizations = 0;

  for (const event of events) {
    const atMs = event.createdAt === "" ? NaN : Date.parse(event.createdAt);
    bump(byEvent, event.event);
    bump(userEventCounts, event.username);
    bump(clientEventCounts, event.clientName);
    bump(locationCounts, placeOf(event));
    bump(deviceCounts, event.device);
    if (event.userId !== "") uniqueUsers.add(event.userId);
    if (!Number.isNaN(atMs)) {
      const day = new Date(atMs).toISOString().slice(0, 10);
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    }

    if (event.event === "PASSKEY_ADDED") passkeysAdded++;
    if (event.event === "PASSKEY_REMOVED") passkeysRemoved++;
    if (event.event === "ACCOUNT_CREATED") accountsCreated++;
    if (
      event.event === "NEW_CLIENT_AUTHORIZATION" ||
      event.event === "NEW_DEVICE_CODE_AUTHORIZATION"
    ) {
      newClientAuthorizations++;
    }

    if (SIGN_IN_EVENTS.includes(event.event)) {
      signInCount++;
      if (
        event.country !== "" && event.country !== INTERNAL_NETWORK &&
        event.country !== EXTERNAL_NETWORK
      ) {
        externalCountries.add(event.country);
      }
      if (event.userId !== "") {
        const existing = byUserId.get(event.userId) ??
          {
            signInCount: 0,
            lastSignInAt: "",
            lastSignInFrom: "",
            countries: [],
          };
        existing.signInCount++;
        const previousMs = existing.lastSignInAt === ""
          ? -Infinity
          : Date.parse(existing.lastSignInAt);
        if (!Number.isNaN(atMs) && atMs > previousMs) {
          existing.lastSignInAt = event.createdAt;
          existing.lastSignInFrom = placeOf(event);
        }
        if (
          event.country !== "" && !existing.countries.includes(event.country)
        ) {
          existing.countries.push(event.country);
        }
        byUserId.set(event.userId, existing);
      }
    }

    if (AUTHORIZATION_EVENTS.includes(event.event) && event.clientName !== "") {
      const existing = byClientName.get(event.clientName) ??
        {
          authorizationCount: 0,
          distinctUserCount: 0,
          lastAuthorizationAt: "",
        };
      existing.authorizationCount++;
      const previousMs = existing.lastAuthorizationAt === ""
        ? -Infinity
        : Date.parse(existing.lastAuthorizationAt);
      if (!Number.isNaN(atMs) && atMs > previousMs) {
        existing.lastAuthorizationAt = event.createdAt;
      }
      byClientName.set(event.clientName, existing);
      if (event.userId !== "") {
        const users = clientUsers.get(event.clientName) ?? new Set<string>();
        users.add(event.userId);
        clientUsers.set(event.clientName, users);
      }
    }
  }

  for (const [name, activity] of byClientName) {
    activity.distinctUserCount = clientUsers.get(name)?.size ?? 0;
  }
  for (const activity of byUserId.values()) activity.countries.sort();

  // Every UTC day in the window, including the empty ones, so the series plots
  // as a calendar rather than as a list of days that happened to have traffic.
  const byDay: Array<{ date: string; count: number }> = [];
  const firstDay = Date.parse(
    `${new Date(opts.windowStartMs).toISOString().slice(0, 10)}T00:00:00Z`,
  );
  for (let ms = firstDay; ms <= opts.windowEndMs; ms += MS_PER_DAY) {
    const date = new Date(ms).toISOString().slice(0, 10);
    byDay.push({ date, count: dayCounts.get(date) ?? 0 });
  }

  return {
    byUserId,
    byClientName,
    rollup: {
      windowDays: opts.windowDays,
      windowStart: new Date(opts.windowStartMs).toISOString(),
      windowEnd: new Date(opts.windowEndMs).toISOString(),
      eventCount: events.length,
      totalEventsOnServer: opts.totalEventsOnServer,
      truncated: opts.truncated,
      byEvent: Object.fromEntries(
        [...byEvent.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      byDay,
      signInCount,
      uniqueUserCount: uniqueUsers.size,
      uniqueClientCount: clientEventCounts.size,
      topUsers: topN(userEventCounts, 10),
      topClients: topN(clientEventCounts, 10),
      locations: topN(locationCounts, 20),
      devices: topN(deviceCounts, 10),
      passkeysAdded,
      passkeysRemoved,
      accountsCreated,
      newClientAuthorizations,
      externalSignInCountries: [...externalCountries].sort(),
    },
  };
}
