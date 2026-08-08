/**
 * Zod schemas for `@jamesakeech/nginx-proxy-manager`.
 *
 * Two vocabularies meet here. Nginx Proxy Manager's admin API speaks
 * `snake_case` and leans on sentinel zeros (`certificate_id: 0` means "no
 * certificate", not "certificate number zero"); swamp resources read better in
 * `camelCase` with those sentinels left intact but documented. The schemas
 * below define the swamp-facing side. Translation lives in `map.ts`.
 *
 * @module
 */
import { z } from "npm:zod@4";

// --- Connection ------------------------------------------------------------

/** How to reach and authenticate against one NPM instance. */
export const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Root URL of the NPM admin interface, including port — e.g. " +
      "http://192.168.1.10:81. Not the proxied sites themselves. A trailing " +
      "slash is tolerated.",
  ),
  identity: z.string().describe(
    "Admin account email, sent as `identity` to POST /api/tokens.",
  ),
  secret: z.string().min(1).meta({ sensitive: true }).describe(
    "Admin account password — supply via " +
      "`${{ vault.get('<vault>', '<key>') }}`. It is exchanged for a bearer " +
      "token per run and never written to any resource.",
  ),
  instanceLabel: z.string().default("nginx-proxy-manager").describe(
    "Human label for this instance, stamped onto every resource so output " +
      "from several NPM instances stays distinguishable.",
  ),
  requestTimeoutSec: z.number().int().positive().default(30).describe(
    "Per-request timeout. Certificate issuance is the slow path — raise this " +
      "if Let's Encrypt DNS challenges time out.",
  ),
});

/** Connection settings for one NPM instance. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- Object kinds ----------------------------------------------------------

/**
 * The six manageable NPM object kinds.
 *
 * Used as the discriminator for the kind-dispatched `delete` and `setEnabled`
 * methods, so one method covers every kind instead of six near-identical ones.
 */
export const ObjectKindSchema = z.enum([
  "proxyHost",
  "redirectionHost",
  "deadHost",
  "stream",
  "accessList",
  "certificate",
]);

/** One of the six manageable NPM object kinds. */
export type ObjectKind = z.infer<typeof ObjectKindSchema>;

/**
 * The kinds NPM can enable and disable.
 *
 * Access lists and certificates have no enabled flag — they are referenced by
 * hosts rather than served directly — so `setEnabled` accepts a narrower set
 * than `delete`.
 */
export const EnableableKindSchema = z.enum([
  "proxyHost",
  "redirectionHost",
  "deadHost",
  "stream",
]);

/** An NPM object kind that can be enabled or disabled. */
export type EnableableKind = z.infer<typeof EnableableKindSchema>;

// --- Inventory resources ---------------------------------------------------

/** Fields every fanned-out inventory resource carries. */
const provenance = {
  instanceLabel: z.string(),
  baseUrl: z.string(),
  fetchedAt: z.iso.datetime(),
};

/** A custom location block nested inside a proxy host. */
export const LocationSchema = z.object({
  path: z.string().describe("URI prefix this block matches, e.g. /api"),
  forwardScheme: z.string(),
  forwardHost: z.string(),
  forwardPort: z.number().int(),
  advancedConfig: z.string().default(""),
});

/** A proxy host: one or more domains forwarded to an upstream service. */
export const ProxyHostSchema = z.object({
  ...provenance,
  id: z.number().int(),
  domainNames: z.array(z.string()),
  forwardScheme: z.string().describe("Scheme used to reach the upstream"),
  forwardHost: z.string().describe("Upstream host or IP, as NPM resolves it"),
  forwardPort: z.number().int(),
  accessListId: z.number().int().describe("0 when no access list is attached"),
  certificateId: z.number().int().describe("0 when the host is plain HTTP"),
  sslForced: z.boolean(),
  hstsEnabled: z.boolean(),
  hstsSubdomains: z.boolean(),
  http2Support: z.boolean(),
  blockExploits: z.boolean(),
  cachingEnabled: z.boolean(),
  allowWebsocketUpgrade: z.boolean(),
  advancedConfig: z.string().describe(
    "Raw nginx directives from the Advanced tab, empty when unused",
  ),
  locations: z.array(LocationSchema),
  enabled: z.boolean(),
  createdOn: z.string().default(""),
  modifiedOn: z.string().default(""),
});

/** A redirection host: domains answered with a 3xx to somewhere else. */
export const RedirectionHostSchema = z.object({
  ...provenance,
  id: z.number().int(),
  domainNames: z.array(z.string()),
  forwardHttpCode: z.number().int().describe("300, 301, 302, 303, 307 or 308"),
  forwardScheme: z.string().describe("auto, http or https"),
  forwardDomainName: z.string(),
  preservePath: z.boolean(),
  certificateId: z.number().int(),
  sslForced: z.boolean(),
  hstsEnabled: z.boolean(),
  hstsSubdomains: z.boolean(),
  http2Support: z.boolean(),
  blockExploits: z.boolean(),
  advancedConfig: z.string(),
  enabled: z.boolean(),
  createdOn: z.string().default(""),
  modifiedOn: z.string().default(""),
});

/** A dead (404) host: domains parked so they answer without proxying. */
export const DeadHostSchema = z.object({
  ...provenance,
  id: z.number().int(),
  domainNames: z.array(z.string()),
  certificateId: z.number().int(),
  sslForced: z.boolean(),
  hstsEnabled: z.boolean(),
  hstsSubdomains: z.boolean(),
  http2Support: z.boolean(),
  advancedConfig: z.string(),
  enabled: z.boolean(),
  createdOn: z.string().default(""),
  modifiedOn: z.string().default(""),
});

/** A stream: a raw TCP and/or UDP port forward, no HTTP involved. */
export const StreamSchema = z.object({
  ...provenance,
  id: z.number().int(),
  incomingPort: z.number().int(),
  forwardingHost: z.string(),
  forwardingPort: z.number().int(),
  tcpForwarding: z.boolean(),
  udpForwarding: z.boolean(),
  certificateId: z.number().int().describe(
    "0 when unset. Only meaningful on NPM builds with stream TLS support",
  ),
  enabled: z.boolean(),
  createdOn: z.string().default(""),
  modifiedOn: z.string().default(""),
});

/**
 * One user authorised by an access list, as read back from NPM.
 *
 * There is deliberately no password field. NPM hashes passwords on write and
 * never returns them, so carrying one here would be a field that is always
 * empty — worse than absent, because a caller could read it and believe the
 * blank was the stored value. The write side has its own item shape on
 * `applyAccessList`.
 */
export const AccessListItemSchema = z.object({
  username: z.string(),
});

/** One address rule in an access list. */
export const AccessListClientSchema = z.object({
  address: z.string().describe("IP or CIDR, or the literal 'all'"),
  directive: z.enum(["allow", "deny"]),
});

/** An access list: basic-auth users and/or address rules, shared by hosts. */
export const AccessListSchema = z.object({
  ...provenance,
  id: z.number().int(),
  name: z.string(),
  satisfyAny: z.boolean().describe(
    "true = either auth or address rule suffices; false = both must pass",
  ),
  passAuth: z.boolean().describe(
    "Whether the Authorization header is forwarded to the upstream",
  ),
  items: z.array(AccessListItemSchema),
  clients: z.array(AccessListClientSchema),
  proxyHostCount: z.number().int().describe("How many proxy hosts use this"),
  createdOn: z.string().default(""),
  modifiedOn: z.string().default(""),
});

/** A TLS certificate held by NPM, whether Let's Encrypt or uploaded. */
export const CertificateSchema = z.object({
  ...provenance,
  id: z.number().int(),
  provider: z.string().describe("letsencrypt, or other for uploaded certs"),
  niceName: z.string(),
  domainNames: z.array(z.string()),
  expiresOn: z.string().default(""),
  daysUntilExpiry: z.number().int().describe(
    "Negative once expired. -99999 when NPM reported no expiry date",
  ),
  dnsChallenge: z.boolean().describe(
    "Issued via DNS-01 rather than HTTP-01 — the only route to wildcards",
  ),
  dnsProvider: z.string().default(""),
  createdOn: z.string().default(""),
  modifiedOn: z.string().default(""),
});

/** Instance-wide rollup written once per sync. */
export const InstanceSchema = z.object({
  ...provenance,
  version: z.string().describe("Reported NPM version, e.g. 2.11.3"),
  proxyHostCount: z.number().int(),
  proxyHostsEnabled: z.number().int(),
  redirectionHostCount: z.number().int(),
  deadHostCount: z.number().int(),
  streamCount: z.number().int(),
  accessListCount: z.number().int(),
  certificateCount: z.number().int(),
  certificatesExpired: z.number().int(),
  certificatesExpiringWithin30d: z.number().int().describe(
    "Already-expired certificates are not counted here — see " +
      "certificatesExpired",
  ),
  uniqueDomainCount: z.number().int().describe(
    "Distinct domains across proxy, redirection and dead hosts",
  ),
  hostsWithoutCertificate: z.number().int().describe(
    "Enabled proxy hosts still serving plain HTTP",
  ),
  domainsServedByMultipleHosts: z.array(z.string()).describe(
    "Domains claimed by more than one host — nginx serves whichever config " +
      "loads first, so these are latent misconfigurations",
  ),
});

// --- Change resource -------------------------------------------------------

/** What happened to one object during a mutating method. */
export const ChangeResultSchema = z.object({
  kind: ObjectKindSchema,
  id: z.number().int().describe("0 when the object was never created"),
  action: z.enum([
    "created",
    "updated",
    "deleted",
    "enabled",
    "disabled",
    "renewed",
    "unchanged",
    "failed",
  ]),
  ok: z.boolean(),
  httpStatus: z.number().int().describe("0 when the request never completed"),
  message: z.string().describe("Empty on success; error detail otherwise"),
});

/**
 * The outcome of one mutating method call.
 *
 * Written to a per-method instance name (`change-applyProxyHost` and friends)
 * so the latest run is addressable from CEL without the caller having to know
 * an object id in advance, while older runs remain as versions.
 */
export const ChangeSchema = z.object({
  instanceLabel: z.string(),
  baseUrl: z.string(),
  method: z.string(),
  performedAt: z.iso.datetime(),
  id: z.number().int().describe(
    "Primary affected object id — the created/updated object for the apply " +
      "methods, or 0 when a call touched zero or many objects",
  ),
  action: z.string().describe(
    "Primary action. `partial` when a fan-out call had both successes and " +
      "failures",
  ),
  ok: z.boolean().describe("True only when every result succeeded"),
  okCount: z.number().int(),
  failCount: z.number().int(),
  results: z.array(ChangeResultSchema),
});

// --- Method arguments ------------------------------------------------------

/** Shared TLS knobs for the three host kinds that can terminate HTTPS. */
const sslArgs = {
  certificateId: z.number().int().default(0).describe(
    "NPM certificate id, or 0 for plain HTTP. Find ids in the certificate " +
      "resources written by `sync`, or create one with `requestCertificate`",
  ),
  sslForced: z.boolean().default(false).describe(
    "Redirect HTTP to HTTPS. Requires certificateId to be non-zero",
  ),
  hstsEnabled: z.boolean().default(false),
  hstsSubdomains: z.boolean().default(false),
  http2Support: z.boolean().default(false),
};

/** Arguments for `sync`. */
export const SyncArgsSchema = z.object({
  includeDisabled: z.boolean().default(true).describe(
    "Write resources for disabled hosts too. Counts in the instance " +
      "resource always cover everything regardless",
  ),
});

/** Arguments for `applyProxyHost`. */
export const ApplyProxyHostArgsSchema = z.object({
  domainNames: z.array(z.string()).min(1).describe(
    "Domains served by this host. Also the match key: an existing host with " +
      "exactly this set is updated, otherwise a new one is created. Changing " +
      "the set creates a second host rather than renaming the first — pass " +
      "`id` to rename",
  ),
  id: z.number().int().optional().describe(
    "Update this host id directly, ignoring domain matching. Use when " +
      "changing the domain set of an existing host",
  ),
  forwardScheme: z.enum(["http", "https"]).default("http"),
  forwardHost: z.string().describe(
    "Upstream host or IP as reachable from the NPM container, not from your " +
      "workstation",
  ),
  forwardPort: z.number().int().min(1).max(65535),
  ...sslArgs,
  blockExploits: z.boolean().default(true),
  cachingEnabled: z.boolean().default(false),
  allowWebsocketUpgrade: z.boolean().default(true),
  accessListId: z.number().int().default(0).describe(
    "NPM access list id, or 0 for unrestricted",
  ),
  advancedConfig: z.string().default("").describe(
    "Raw nginx directives injected into the server block",
  ),
  locations: z.array(LocationSchema).default([]).describe(
    "Custom location blocks. Replaces the existing set on update",
  ),
  enabled: z.boolean().default(true).describe(
    "Applied after the create/update, since NPM has no enabled flag on the " +
      "host body itself",
  ),
});

/** Arguments for `applyRedirectionHost`. */
export const ApplyRedirectionHostArgsSchema = z.object({
  domainNames: z.array(z.string()).min(1).describe(
    "Domains to redirect. Also the match key for the upsert",
  ),
  id: z.number().int().optional().describe(
    "Update this redirection host id directly, ignoring domain matching",
  ),
  forwardDomainName: z.string().describe("Destination domain, without scheme"),
  forwardHttpCode: z.union([
    z.literal(300),
    z.literal(301),
    z.literal(302),
    z.literal(303),
    z.literal(307),
    z.literal(308),
  ]).default(301),
  forwardScheme: z.enum(["auto", "http", "https"]).default("auto"),
  preservePath: z.boolean().default(true),
  ...sslArgs,
  blockExploits: z.boolean().default(true),
  advancedConfig: z.string().default(""),
  enabled: z.boolean().default(true),
});

/** Arguments for `applyDeadHost`. */
export const ApplyDeadHostArgsSchema = z.object({
  domainNames: z.array(z.string()).min(1).describe(
    "Domains to park on a 404. Also the match key for the upsert",
  ),
  id: z.number().int().optional().describe(
    "Update this dead host id directly, ignoring domain matching",
  ),
  ...sslArgs,
  advancedConfig: z.string().default(""),
  enabled: z.boolean().default(true),
});

/** Arguments for `applyStream`. */
export const ApplyStreamArgsSchema = z.object({
  incomingPort: z.number().int().min(1).max(65535).describe(
    "Port NPM listens on. Also the match key: an existing stream on this " +
      "port is updated, otherwise a new one is created",
  ),
  id: z.number().int().optional().describe(
    "Update this stream id directly, ignoring port matching",
  ),
  forwardingHost: z.string(),
  forwardingPort: z.number().int().min(1).max(65535),
  tcpForwarding: z.boolean().default(true),
  udpForwarding: z.boolean().default(false),
  certificateId: z.number().int().default(0).describe(
    "Only sent when non-zero — older NPM builds reject the field outright",
  ),
  enabled: z.boolean().default(true),
});

/** Arguments for `applyAccessList`. */
export const ApplyAccessListArgsSchema = z.object({
  name: z.string().min(1).describe(
    "Access list name. Also the match key for the upsert",
  ),
  id: z.number().int().optional().describe(
    "Update this access list id directly, ignoring name matching. Use when " +
      "renaming",
  ),
  satisfyAny: z.boolean().default(false).describe(
    "false = client must satisfy both the address rules and basic auth",
  ),
  passAuth: z.boolean().default(false).describe(
    "Forward the Authorization header to the upstream as well",
  ),
  items: z.array(z.object({
    username: z.string().min(1),
    password: z.string().min(1).meta({ sensitive: true }),
  })).default([]).describe(
    "Basic-auth users. Replaces the existing set on update — NPM cannot " +
      "read back stored passwords, so every apply must resend all of them or " +
      "the omitted users are dropped",
  ),
  clients: z.array(AccessListClientSchema).default([]).describe(
    "Address rules, evaluated in order. Replaces the existing set on update",
  ),
});

/** Arguments for `requestCertificate`. */
export const RequestCertificateArgsSchema = z.object({
  domainNames: z.array(z.string()).min(1).describe(
    "Domains for the certificate. Also the match key — an existing " +
      "Let's Encrypt certificate covering exactly this set is reused rather " +
      "than reissued. Wildcards require dnsChallenge",
  ),
  letsencryptEmail: z.string().describe(
    "Contact address registered with Let's Encrypt",
  ),
  dnsChallenge: z.boolean().default(false).describe(
    "Use DNS-01 instead of HTTP-01. Required for wildcard domains and for " +
      "hosts not reachable from the public internet on port 80",
  ),
  dnsProvider: z.string().default("").describe(
    "certbot dns plugin name, e.g. cloudflare. Required when dnsChallenge",
  ),
  dnsProviderCredentials: z.string().default("").meta({ sensitive: true })
    .describe(
      "Contents of the certbot credentials file for the provider. Required " +
        "when dnsChallenge",
    ),
  propagationSeconds: z.number().int().min(0).default(0).describe(
    "How long to wait for the DNS record to propagate. 0 uses the plugin " +
      "default",
  ),
  force: z.boolean().default(false).describe(
    "Request a new certificate even when one already covers these domains",
  ),
});

/** Arguments for `uploadCertificate`. */
export const UploadCertificateArgsSchema = z.object({
  niceName: z.string().min(1).describe("Display name for the certificate"),
  certificatePath: z.string().describe(
    "Path on the machine running swamp to the PEM certificate",
  ),
  certificateKeyPath: z.string().describe(
    "Path on the machine running swamp to the PEM private key",
  ),
  intermediateCertificatePath: z.string().default("").describe(
    "Optional path to the intermediate chain PEM",
  ),
});

/** Arguments for `renewCertificate`. */
export const RenewCertificateArgsSchema = z.object({
  ids: z.array(z.number().int()).min(1).describe(
    "Certificate ids to renew. Let's Encrypt only — uploaded certificates " +
      "cannot be renewed through NPM",
  ),
});

/** Arguments for `setEnabled`. */
export const SetEnabledArgsSchema = z.object({
  kind: EnableableKindSchema.describe("Which kind of object the ids refer to"),
  ids: z.array(z.number().int()).min(1),
  enabled: z.boolean(),
});

/** Arguments for `delete`. */
export const DeleteArgsSchema = z.object({
  kind: ObjectKindSchema.describe("Which kind of object the ids refer to"),
  ids: z.array(z.number().int()).min(1).describe(
    "Ids to delete. Verify them against a fresh `sync` first — NPM ids are " +
      "reused after deletion, so a stale id can remove the wrong object",
  ),
});
