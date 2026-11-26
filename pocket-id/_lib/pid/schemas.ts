/**
 * Zod schemas for `@jamesakeech/pocket-id`.
 *
 * Pocket ID's API already speaks `camelCase`, so unlike most integrations there
 * is no vocabulary to translate. What these schemas do instead is *close gaps*:
 * the API returns `null` for absent strings (`email`, `ldapId`, `lastUsedAt`)
 * and a nested object graph for group membership, neither of which reads well
 * from a CEL expression. Every field below is present and non-null on every
 * write, with `""` standing for "not set" and `-1` for "not applicable", so an
 * expression never has to guard for existence.
 *
 * The derived fields — `daysUntilExpiry`, `updateAvailable`, `signInCount`,
 * `findings` — are the reason this extension exists. Pocket ID exposes the raw
 * facts across five paginated endpoints; the value is in having them joined and
 * scored once, at collection time.
 *
 * @module
 */
import { z } from "npm:zod@4";

// --- Connection -------------------------------------------------------------

/** How to reach and authenticate against one Pocket ID instance. */
export const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Root URL of the Pocket ID instance — e.g. https://id.example.com. The " +
      "same origin the OIDC issuer uses, not a sub-path. A trailing slash is " +
      "tolerated.",
  ),
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "API key from Settings → Admin → API Keys, sent as the `X-API-Key` " +
      "header — supply via `${{ vault.get('<vault>', '<key>') }}`. It must " +
      "belong to an admin account: the user, client, group and audit-log " +
      "endpoints all reject a non-admin key with 403.",
  ),
  instanceLabel: z.string().default("pocket-id").describe(
    "Human label for this instance, stamped onto every resource so output " +
      "from several Pocket ID instances stays distinguishable.",
  ),
  requestTimeoutSec: z.number().int().positive().default(30).describe(
    "Per-request timeout. The audit log is read a page at a time, so this " +
      "bounds each page rather than the whole method.",
  ),
});

/** Connection settings for one Pocket ID instance. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * Re-apply schema defaults to an args object.
 *
 * Method bodies receive parsed global args, so this is belt-and-braces there.
 * It exists because anything running outside a method body — a pre-flight
 * check, a unit test constructing args by hand — receives them unparsed, and a
 * `requestTimeoutSec` of `undefined` becomes `AbortSignal.timeout(NaN)`, which
 * fails against a perfectly healthy instance.
 */
export function withDefaults(globalArgs: GlobalArgs): GlobalArgs {
  return GlobalArgsSchema.parse(globalArgs);
}

// --- Method arguments -------------------------------------------------------

/** Arguments shared by every method that reads the audit log. */
const activityArgs = {
  windowDays: z.number().int().positive().default(30).describe(
    "How far back to read the audit log. Pocket ID cannot filter by date, so " +
      "the log is walked newest-first and paging stops at the first event " +
      "older than this — a small window is genuinely cheaper, not just " +
      "smaller output.",
  ),
  maxAuditEvents: z.number().int().positive().default(2000).describe(
    "Hard ceiling on events read in one run, so a busy instance cannot turn " +
      "one sync into hundreds of requests. When hit, `activity.truncated` is " +
      "true and the rollup covers only the events actually read.",
  ),
  writeAuditEvents: z.boolean().default(true).describe(
    "Write one `auditEvent` resource per event, on top of the `activity` " +
      "rollup. Set false to keep the aggregate counts and skip the " +
      "per-event fan-out.",
  ),
};

/** Arguments for the full inventory sync. */
export const SyncArgsSchema = z.object({
  ...activityArgs,
  includeAuditEvents: z.boolean().default(true).describe(
    "Read the audit log at all. Set false for a pure inventory sync — the " +
      "per-user sign-in stats and per-client usage counts are then reported " +
      "as not collected rather than as zero.",
  ),
  includePasskeys: z.boolean().default(true).describe(
    "Collect each user's passkeys. This is one request per user — the only " +
      "N+1 in the extension — so it is worth turning off on a large " +
      "directory. Without it `passkeyCount` is reported as not collected, " +
      "and the passkey findings are not raised.",
  ),
  apiKeyExpiryWarningDays: z.number().int().nonnegative().default(14).describe(
    "Raise an `api-key-expiring` finding when a key expires within this " +
      "many days.",
  ),
  accessTokenMaxMinutes: z.number().int().positive().default(60).describe(
    "Raise a `long-lived-access-token` finding for clients whose access " +
      "token lifetime exceeds this. Pocket ID's own default is well under an " +
      "hour, so the default here only catches deliberate widening.",
  ),
});

/** Arguments for the audit-log-only sync. */
export const ActivityArgsSchema = z.object(activityArgs);

/** Arguments for the health probe. */
export const HealthArgsSchema = z.object({});

// --- Shared resource fields -------------------------------------------------

/** Fields every resource carries, so output from two instances stays apart. */
const provenance = {
  instanceLabel: z.string(),
  baseUrl: z.string(),
  fetchedAt: z.iso.datetime(),
};

/**
 * One thing worth looking at, derived at collection time.
 *
 * Findings are the reason a rollup beats a pile of raw records: "which of my
 * 40 users can no longer sign in" is a join across users and passkeys that
 * nothing in Pocket ID's UI answers. `code` is a stable slug so a workflow can
 * assert on it; `severity` orders triage.
 */
export const FindingSchema = z.object({
  severity: z.enum(["info", "warn", "critical"]).describe(
    "critical: something is broken or a real security hole. warn: worth " +
      "fixing. info: worth knowing.",
  ),
  code: z.string().describe(
    "Stable slug, safe to assert on from a workflow — e.g. " +
      "`admin-without-passkey`, `public-client-without-pkce`.",
  ),
  subject: z.string().describe(
    "What the finding is about: a username, client name, group name, API key " +
      "name, or the instance label.",
  ),
  detail: z.string().describe("One sentence of context, for a human."),
});

/** One thing worth looking at. */
export type Finding = z.infer<typeof FindingSchema>;

// --- Resources --------------------------------------------------------------

/** Reachability, authentication and version drift for one instance. */
export const HealthSchema = z.object({
  ...provenance,
  reachable: z.boolean().describe(
    "`GET /healthz` answered. False means the host, the container or the " +
      "reverse proxy in front of it is down — nothing else in this resource " +
      "is meaningful.",
  ),
  healthzStatus: z.number().int().describe(
    "Status from `/healthz`; Pocket ID answers 204. 0 means no response at " +
      "all (DNS, TLS, connection refused, timeout).",
  ),
  apiAuthenticated: z.boolean().describe(
    "The configured API key was accepted. False with `reachable` true is a " +
      "wrong, revoked or expired key.",
  ),
  apiKeyIsAdmin: z.boolean().describe(
    "The key's owner is an admin, read from `isAdmin` on the owning account " +
      "rather than inferred from a rejection. False means `sync` cannot read " +
      "users, clients, groups or the audit log — Pocket ID answers those " +
      "with 403.",
  ),
  apiKeyOwner: z.string().describe(
    "Username the API key belongs to, empty when it was not accepted. Worth " +
      "knowing: a key's reach is exactly its owner's.",
  ),
  apiKeyOwnerId: z.string().describe(
    "Id of the owning account, so its `user` resource can be found directly.",
  ),
  currentVersion: z.string().describe(
    "Deployed version. Empty when the key was not accepted, and also on " +
      "releases before `/api/version/current` existed (roughly pre-2.4) — " +
      "those instances are healthy, they just cannot say what they are.",
  ),
  latestVersion: z.string().describe(
    "Latest published version, as Pocket ID resolves it from upstream. Empty " +
      "when the instance has no outbound network access.",
  ),
  updateAvailable: z.boolean().describe(
    "Deployed version is numerically behind the latest. False when either " +
      "version is missing or not numeric — see `versionsComparable`.",
  ),
  versionsComparable: z.boolean().describe(
    "Both versions parsed as dotted numbers. False on a dev or custom build, " +
      "where `updateAvailable` is not a claim either way.",
  ),
  latencyMs: z.number().int().describe(
    "Round trip for `/healthz`, or -1 when it never answered.",
  ),
  errors: z.array(z.string()).describe(
    "Human-readable reasons any flag above is false. Empty when all is well.",
  ),
});

/** A passkey registered to a user. */
export const PasskeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  attestationType: z.string(),
  transports: z.array(z.string()).describe(
    "e.g. `internal` for a platform authenticator, `usb`/`nfc` for a key.",
  ),
  backupEligible: z.boolean().describe(
    "The credential may be synced to the authenticator's cloud backup.",
  ),
  backupState: z.boolean().describe("The credential is currently backed up."),
});

/** One user: identity, group membership, passkeys, and recent sign-ins. */
export const UserSchema = z.object({
  ...provenance,
  id: z.string(),
  username: z.string(),
  email: z.string().describe("Empty when no address is set."),
  emailVerified: z.boolean(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
  locale: z.string().describe("Empty when the account follows the default."),
  ldapId: z.string().describe("Empty for a locally managed account."),
  ldapManaged: z.boolean().describe(
    "The account came from LDAP sync, so edits here are overwritten on the " +
      "next sync.",
  ),
  groups: z.array(z.string()).describe("Group names, sorted."),
  groupCount: z.number().int(),
  customClaimKeys: z.array(z.string()).describe(
    "Names of custom claims set on this user — values are deliberately not " +
      "collected, since a claim can carry anything.",
  ),
  passkeyCount: z.number().int().describe(
    "-1 when passkeys were not collected. 0 is a real finding: the account " +
      "cannot sign in without a one-time access token.",
  ),
  passkeys: z.array(PasskeySchema).describe(
    "Empty when not collected — check `passkeysCollected` to tell that from " +
      "genuinely having none.",
  ),
  passkeysCollected: z.boolean(),
  signInCount: z.number().int().describe(
    "Sign-ins inside the activity window; -1 when the audit log was not read.",
  ),
  lastSignInAt: z.string().describe(
    "Most recent sign-in inside the window, empty when there was none. Note " +
      "this is bounded by the window, not the account's whole history.",
  ),
  lastSignInFrom: z.string().describe(
    "`city, country` of the most recent sign-in, or the bare network class " +
      "Pocket ID reports for a non-routable address. Empty when none.",
  ),
  signInCountries: z.array(z.string()).describe(
    "Distinct countries seen in the window, sorted. More than one external " +
      "country raises a finding.",
  ),
  activityCollected: z.boolean(),
});

/** One OIDC client: how it is configured and how much it is used. */
export const ClientSchema = z.object({
  ...provenance,
  id: z.string().describe("The OIDC `client_id`."),
  name: z.string(),
  description: z.string(),
  clientType: z.string(),
  isPublic: z.boolean().describe(
    "A public client holds no secret, so PKCE is the only thing standing " +
      "between a stolen authorization code and a token.",
  ),
  pkceEnabled: z.boolean(),
  requiresPushedAuthorizationRequests: z.boolean(),
  requiresReauthentication: z.boolean(),
  skipConsent: z.boolean(),
  isGroupRestricted: z.boolean().describe(
    "False means every enabled user can sign in to this client.",
  ),
  allowedUserGroupsCount: z.number().int(),
  callbackURLs: z.array(z.string()),
  logoutCallbackURLs: z.array(z.string()),
  launchURL: z.string().describe("Empty when the client has no launch link."),
  hasLogo: z.boolean(),
  hasDarkLogo: z.boolean(),
  accessTokenDurationMinutes: z.number().int().describe(
    "-1 on releases that do not report token lifetimes (roughly pre-2.4). " +
      "The `long-lived-access-token` finding is then not raised at all.",
  ),
  refreshTokenDurationMinutes: z.number().int().describe(
    "-1 on releases that do not report token lifetimes.",
  ),
  federatedIdentityIssuers: z.array(z.string()).describe(
    "Issuers this client may authenticate as, for workload federation. " +
      "Empty for an ordinary client.",
  ),
  authorizationCount: z.number().int().describe(
    "Authorizations inside the activity window; -1 when the audit log was " +
      "not read. 0 across a long window means nothing uses this client.",
  ),
  distinctUserCount: z.number().int().describe(
    "Distinct users who authorized this client in the window; -1 when not " +
      "collected.",
  ),
  lastAuthorizationAt: z.string().describe(
    "Empty when the client was not used inside the window.",
  ),
  activityCollected: z.boolean(),
});

/** One user group. */
export const GroupSchema = z.object({
  ...provenance,
  id: z.string(),
  name: z.string().describe("The value emitted in the `groups` claim."),
  friendlyName: z.string(),
  userCount: z.number().int(),
  ldapId: z.string().describe("Empty for a locally managed group."),
  ldapManaged: z.boolean(),
  createdAt: z.string(),
  customClaimKeys: z.array(z.string()),
});

/** One API key belonging to the account this extension authenticates as. */
export const ApiKeySchema = z.object({
  ...provenance,
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().describe("Empty when the key has never been used."),
  daysUntilExpiry: z.number().int().describe(
    "Negative once expired, rounded down — 0 means it expires today.",
  ),
  expired: z.boolean(),
  neverUsed: z.boolean(),
  daysSinceLastUse: z.number().int().describe("-1 when never used."),
  expirationEmailSent: z.boolean(),
  isSelf: z.boolean().describe(
    "This is the key the sync authenticated with, identified by its " +
      "`lastUsedAt` landing inside this run. Its own expiry is the one that " +
      "breaks the sync.",
  ),
});

/** Rollup of the whole instance: what exists, and what to look at. */
export const InstanceSchema = z.object({
  ...provenance,
  currentVersion: z.string(),
  latestVersion: z.string(),
  updateAvailable: z.boolean(),
  userCount: z.number().int(),
  adminCount: z.number().int(),
  disabledUserCount: z.number().int(),
  ldapUserCount: z.number().int(),
  passkeyCount: z.number().int().describe(
    "Passkeys totalled across the users whose passkeys were actually read; " +
      "-1 when none could be. Never silently counts an unread user as zero.",
  ),
  usersWithoutPasskeys: z.array(z.string()).describe(
    "Usernames confirmed to have no registered passkey — each one is an " +
      "account that cannot sign in unaided.",
  ),
  usersWithUnknownPasskeys: z.array(z.string()).describe(
    "Usernames whose passkeys could not be read, so nothing is claimed about " +
      "them either way. Populated on releases before roughly 2.4, which have " +
      "no admin endpoint for another user's passkeys — there, only the API " +
      "key owner's own passkeys are readable.",
  ),
  clientCount: z.number().int(),
  publicClientCount: z.number().int(),
  groupRestrictedClientCount: z.number().int(),
  unusedClients: z.array(z.string()).describe(
    "Client names with no authorization inside the activity window. Empty " +
      "when the audit log was not read.",
  ),
  groupCount: z.number().int(),
  emptyGroups: z.array(z.string()).describe("Group names with no members."),
  apiKeyCount: z.number().int().describe(
    "API keys belonging to the authenticating account only — Pocket ID has " +
      "no endpoint that lists other users' keys, even for an admin.",
  ),
  apiKeysExpired: z.number().int(),
  apiKeysExpiringSoon: z.number().int(),
  apiKeysNeverUsed: z.number().int(),
  passkeysCollected: z.boolean().describe(
    "Every user's passkeys were read, so the totals above are complete. " +
      "False when collection was skipped or any user could not be read — see " +
      "`usersWithUnknownPasskeys`.",
  ),
  activityCollected: z.boolean(),
  findings: z.array(FindingSchema).describe(
    "Everything worth looking at, most severe first. Empty is the good case.",
  ),
  criticalFindingCount: z.number().int().describe(
    "Broken out so a workflow can assert `== 0` without walking `findings`.",
  ),
  warnFindingCount: z.number().int(),
  trackedUserIds: z.array(z.string()).describe(
    "Ids of every user written by this run, so a later run can tell a " +
      "deleted account from one it simply did not reach.",
  ),
  trackedClientIds: z.array(z.string()),
});

/** A day's event count, for a sparkline over the window. */
export const DayCountSchema = z.object({
  date: z.string().describe("`YYYY-MM-DD`, UTC."),
  count: z.number().int(),
});

/** A `label`/`count` pair used by the activity rollup's top-N lists. */
export const LabelCountSchema = z.object({
  label: z.string(),
  count: z.number().int(),
});

/** Aggregated audit-log activity over the window. */
export const ActivitySchema = z.object({
  ...provenance,
  windowDays: z.number().int(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  eventCount: z.number().int().describe("Events actually read and aggregated."),
  totalEventsOnServer: z.number().int().describe(
    "Every event Pocket ID holds, of any age — the log's total size, not the " +
      "window's. Useful for spotting that retention has grown unbounded.",
  ),
  truncated: z.boolean().describe(
    "`maxAuditEvents` was reached before the window was exhausted, so every " +
      "count below is a floor rather than a total.",
  ),
  byEvent: z.record(z.string(), z.number()).describe(
    "Count per Pocket ID event type — `SIGN_IN`, `CLIENT_AUTHORIZATION`, " +
      "`PASSKEY_ADDED`, and so on.",
  ),
  byDay: z.array(DayCountSchema).describe(
    "One entry per UTC day in the window, including days with no events, " +
      "oldest first — so it plots without gap-filling.",
  ),
  signInCount: z.number().int().describe(
    "All sign-in flavours: interactive, one-time token, and remote.",
  ),
  uniqueUserCount: z.number().int(),
  uniqueClientCount: z.number().int(),
  topUsers: z.array(LabelCountSchema).describe(
    "Busiest users by event count, descending, at most 10.",
  ),
  topClients: z.array(LabelCountSchema),
  locations: z.array(LabelCountSchema).describe(
    "`city, country` by event count. Pocket ID reports non-routable " +
      "addresses as `Internal Network` rather than a place.",
  ),
  devices: z.array(LabelCountSchema).describe(
    "Browser and OS as Pocket ID parses the user agent.",
  ),
  passkeysAdded: z.number().int(),
  passkeysRemoved: z.number().int(),
  accountsCreated: z.number().int(),
  newClientAuthorizations: z.number().int().describe(
    "First-time consents — a client a user had never authorized before.",
  ),
  externalSignInCountries: z.array(z.string()).describe(
    "Countries behind sign-ins from outside the local network, sorted.",
  ),
  eventsWritten: z.number().int().describe(
    "How many `auditEvent` resources this run wrote; 0 when " +
      "`writeAuditEvents` was false.",
  ),
});

/** One audit-log entry. */
export const AuditEventSchema = z.object({
  ...provenance,
  id: z.string(),
  createdAt: z.string(),
  event: z.string().describe(
    "`SIGN_IN`, `TOKEN_SIGN_IN`, `REMOTE_SIGN_IN`, `ACCOUNT_CREATED`, " +
      "`CLIENT_AUTHORIZATION`, `NEW_CLIENT_AUTHORIZATION`, " +
      "`DEVICE_CODE_AUTHORIZATION`, `NEW_DEVICE_CODE_AUTHORIZATION`, " +
      "`PASSKEY_ADDED` or `PASSKEY_REMOVED`.",
  ),
  ipAddress: z.string(),
  country: z.string().describe(
    "A country, or `Internal Network` / `External Network` when the address " +
      "could not be placed.",
  ),
  city: z.string(),
  device: z.string().describe("Browser and OS, parsed from the user agent."),
  userId: z.string(),
  username: z.string(),
  actorUsername: z.string().describe(
    "Who performed the action when it was not the subject — an admin " +
      "creating an account or minting a one-time token. Empty otherwise.",
  ),
  clientName: z.string().describe(
    "The OIDC client involved, empty for events that have none. This is a " +
      "name, not an id: it is what Pocket ID records in the log.",
  ),
  internalNetwork: z.boolean().describe(
    "The address was non-routable, so this event came from inside the LAN.",
  ),
  data: z.record(z.string(), z.string()).describe(
    "The event's raw extra fields, as Pocket ID stored them.",
  ),
});
