/**
 * Translation between NPM's wire format and this model's resources.
 *
 * Everything that knows about `snake_case`, sentinel zeros, or NPM's quirks
 * lives here so the model file reads as intent. The read direction is
 * deliberately forgiving — NPM has shipped several field sets across 2.x, and
 * a missing `hsts_subdomains` should surface as `false`, not abort a sync of
 * forty hosts. The write direction is deliberately strict: NPM's request
 * validator rejects unknown properties, so each builder sends exactly the
 * fields its endpoint accepts and nothing more.
 *
 * @module
 */
import type { z } from "npm:zod@4";
import type {
  ApplyAccessListArgsSchema,
  ApplyDeadHostArgsSchema,
  ApplyProxyHostArgsSchema,
  ApplyRedirectionHostArgsSchema,
  ApplyStreamArgsSchema,
  ObjectKind,
  RequestCertificateArgsSchema,
} from "./schemas.ts";

/** A JSON object as returned by the NPM API. */
type Raw = Record<string, unknown>;

/** Provenance stamped onto every fanned-out inventory resource. */
export interface Provenance {
  instanceLabel: string;
  baseUrl: string;
  fetchedAt: string;
}

// --- Coercion helpers ------------------------------------------------------

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * NPM is inconsistent about booleans: the SQLite-backed builds return 0/1
 * integers where the Postgres ones return true/false. Treat both as truthy
 * rather than trusting either.
 */
function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

function rawArray(value: unknown): Raw[] {
  return Array.isArray(value)
    ? value.filter((v): v is Raw => v !== null && typeof v === "object")
    : [];
}

/** Nested `meta` object, or an empty one when absent. */
function meta(raw: Raw): Raw {
  const m = raw.meta;
  return m !== null && typeof m === "object" ? m as Raw : {};
}

/**
 * Whole days until `expiresOn`, rounded down.
 *
 * Returns a large negative sentinel when NPM reported no parseable date, so
 * the field is always a number and "unknown" never sorts as "expiring soon".
 */
export function daysUntil(expiresOn: string, now: number): number {
  const ts = Date.parse(expiresOn);
  if (!Number.isFinite(ts)) return -99999;
  return Math.floor((ts - now) / 86_400_000);
}

// --- Read direction --------------------------------------------------------

/** Shape a raw proxy host into the `proxyHost` resource. */
export function toProxyHost(raw: Raw, p: Provenance): Record<string, unknown> {
  return {
    ...p,
    id: num(raw.id),
    domainNames: strArray(raw.domain_names),
    forwardScheme: str(raw.forward_scheme),
    forwardHost: str(raw.forward_host),
    forwardPort: num(raw.forward_port),
    accessListId: num(raw.access_list_id),
    certificateId: num(raw.certificate_id),
    sslForced: bool(raw.ssl_forced),
    hstsEnabled: bool(raw.hsts_enabled),
    hstsSubdomains: bool(raw.hsts_subdomains),
    http2Support: bool(raw.http2_support),
    blockExploits: bool(raw.block_exploits),
    cachingEnabled: bool(raw.caching_enabled),
    allowWebsocketUpgrade: bool(raw.allow_websocket_upgrade),
    advancedConfig: str(raw.advanced_config),
    locations: rawArray(raw.locations).map((l) => ({
      path: str(l.path),
      forwardScheme: str(l.forward_scheme),
      forwardHost: str(l.forward_host),
      forwardPort: num(l.forward_port),
      advancedConfig: str(l.advanced_config),
    })),
    enabled: bool(raw.enabled),
    createdOn: str(raw.created_on),
    modifiedOn: str(raw.modified_on),
  };
}

/** Shape a raw redirection host into the `redirectionHost` resource. */
export function toRedirectionHost(
  raw: Raw,
  p: Provenance,
): Record<string, unknown> {
  return {
    ...p,
    id: num(raw.id),
    domainNames: strArray(raw.domain_names),
    forwardHttpCode: num(raw.forward_http_code, 301),
    forwardScheme: str(raw.forward_scheme),
    forwardDomainName: str(raw.forward_domain_name),
    preservePath: bool(raw.preserve_path),
    certificateId: num(raw.certificate_id),
    sslForced: bool(raw.ssl_forced),
    hstsEnabled: bool(raw.hsts_enabled),
    hstsSubdomains: bool(raw.hsts_subdomains),
    http2Support: bool(raw.http2_support),
    blockExploits: bool(raw.block_exploits),
    advancedConfig: str(raw.advanced_config),
    enabled: bool(raw.enabled),
    createdOn: str(raw.created_on),
    modifiedOn: str(raw.modified_on),
  };
}

/** Shape a raw dead (404) host into the `deadHost` resource. */
export function toDeadHost(raw: Raw, p: Provenance): Record<string, unknown> {
  return {
    ...p,
    id: num(raw.id),
    domainNames: strArray(raw.domain_names),
    certificateId: num(raw.certificate_id),
    sslForced: bool(raw.ssl_forced),
    hstsEnabled: bool(raw.hsts_enabled),
    hstsSubdomains: bool(raw.hsts_subdomains),
    http2Support: bool(raw.http2_support),
    advancedConfig: str(raw.advanced_config),
    enabled: bool(raw.enabled),
    createdOn: str(raw.created_on),
    modifiedOn: str(raw.modified_on),
  };
}

/** Shape a raw stream into the `stream` resource. */
export function toStream(raw: Raw, p: Provenance): Record<string, unknown> {
  return {
    ...p,
    id: num(raw.id),
    incomingPort: num(raw.incoming_port),
    forwardingHost: str(raw.forwarding_host),
    forwardingPort: num(raw.forwarding_port),
    tcpForwarding: bool(raw.tcp_forwarding),
    udpForwarding: bool(raw.udp_forwarding),
    certificateId: num(raw.certificate_id),
    enabled: bool(raw.enabled),
    createdOn: str(raw.created_on),
    modifiedOn: str(raw.modified_on),
  };
}

/** Shape a raw access list into the `accessList` resource. */
export function toAccessList(raw: Raw, p: Provenance): Record<string, unknown> {
  return {
    ...p,
    id: num(raw.id),
    name: str(raw.name),
    satisfyAny: bool(raw.satisfy_any),
    passAuth: bool(raw.pass_auth),
    // Passwords are hashed server-side and never returned; only usernames
    // survive a round trip, which is why `applyAccessList` has to resend the
    // full user set on every update.
    items: rawArray(raw.items).map((i) => ({ username: str(i.username) })),
    clients: rawArray(raw.clients).map((c) => ({
      address: str(c.address),
      directive: str(c.directive) === "deny" ? "deny" : "allow",
    })),
    proxyHostCount: num(raw.proxy_host_count),
    createdOn: str(raw.created_on),
    modifiedOn: str(raw.modified_on),
  };
}

/** Shape a raw certificate into the `certificate` resource. */
export function toCertificate(
  raw: Raw,
  p: Provenance,
  now: number,
): Record<string, unknown> {
  const expiresOn = str(raw.expires_on);
  const m = meta(raw);
  return {
    ...p,
    id: num(raw.id),
    provider: str(raw.provider),
    niceName: str(raw.nice_name),
    domainNames: strArray(raw.domain_names),
    expiresOn,
    daysUntilExpiry: daysUntil(expiresOn, now),
    dnsChallenge: bool(m.dns_challenge),
    dnsProvider: str(m.dns_provider),
    createdOn: str(raw.created_on),
    modifiedOn: str(raw.modified_on),
  };
}

// --- Write direction -------------------------------------------------------

/**
 * Body for POST/PUT of a proxy host.
 *
 * `enabled` is absent by design: NPM ignores it on the host body and only
 * honours the dedicated `/enable` and `/disable` endpoints, so sending it here
 * would silently do nothing.
 */
export function proxyHostBody(
  args: z.infer<typeof ApplyProxyHostArgsSchema>,
): Raw {
  return {
    domain_names: args.domainNames,
    forward_scheme: args.forwardScheme,
    forward_host: args.forwardHost,
    forward_port: args.forwardPort,
    certificate_id: args.certificateId,
    ssl_forced: args.sslForced,
    hsts_enabled: args.hstsEnabled,
    hsts_subdomains: args.hstsSubdomains,
    http2_support: args.http2Support,
    block_exploits: args.blockExploits,
    caching_enabled: args.cachingEnabled,
    allow_websocket_upgrade: args.allowWebsocketUpgrade,
    access_list_id: args.accessListId,
    advanced_config: args.advancedConfig,
    locations: args.locations.map((l) => ({
      path: l.path,
      forward_scheme: l.forwardScheme,
      forward_host: l.forwardHost,
      forward_port: l.forwardPort,
      advanced_config: l.advancedConfig,
    })),
    meta: { letsencrypt_agree: false, dns_challenge: false },
  };
}

/** Body for POST/PUT of a redirection host. */
export function redirectionHostBody(
  args: z.infer<typeof ApplyRedirectionHostArgsSchema>,
): Raw {
  return {
    domain_names: args.domainNames,
    forward_http_code: args.forwardHttpCode,
    forward_scheme: args.forwardScheme,
    forward_domain_name: args.forwardDomainName,
    preserve_path: args.preservePath,
    certificate_id: args.certificateId,
    ssl_forced: args.sslForced,
    hsts_enabled: args.hstsEnabled,
    hsts_subdomains: args.hstsSubdomains,
    http2_support: args.http2Support,
    block_exploits: args.blockExploits,
    advanced_config: args.advancedConfig,
    meta: { letsencrypt_agree: false, dns_challenge: false },
  };
}

/** Body for POST/PUT of a dead (404) host. */
export function deadHostBody(
  args: z.infer<typeof ApplyDeadHostArgsSchema>,
): Raw {
  return {
    domain_names: args.domainNames,
    certificate_id: args.certificateId,
    ssl_forced: args.sslForced,
    hsts_enabled: args.hstsEnabled,
    hsts_subdomains: args.hstsSubdomains,
    http2_support: args.http2Support,
    advanced_config: args.advancedConfig,
    meta: { letsencrypt_agree: false, dns_challenge: false },
  };
}

/**
 * Body for POST/PUT of a stream.
 *
 * `certificate_id` is omitted when zero rather than sent as 0: stream TLS
 * arrived in NPM 2.10, and older builds reject the unknown property outright,
 * which would break plain TCP forwards that never wanted a certificate.
 */
export function streamBody(
  args: z.infer<typeof ApplyStreamArgsSchema>,
): Raw {
  const body: Raw = {
    incoming_port: args.incomingPort,
    forwarding_host: args.forwardingHost,
    forwarding_port: args.forwardingPort,
    tcp_forwarding: args.tcpForwarding,
    udp_forwarding: args.udpForwarding,
  };
  if (args.certificateId > 0) body.certificate_id = args.certificateId;
  return body;
}

/** Body for POST/PUT of an access list. */
export function accessListBody(
  args: z.infer<typeof ApplyAccessListArgsSchema>,
): Raw {
  return {
    name: args.name,
    satisfy_any: args.satisfyAny,
    pass_auth: args.passAuth,
    items: args.items.map((i) => ({
      username: i.username,
      password: i.password,
    })),
    clients: args.clients.map((c) => ({
      address: c.address,
      directive: c.directive,
    })),
  };
}

/** Body for POST of a Let's Encrypt certificate request. */
export function certificateBody(
  args: z.infer<typeof RequestCertificateArgsSchema>,
): Raw {
  const m: Raw = {
    letsencrypt_email: args.letsencryptEmail,
    letsencrypt_agree: true,
    dns_challenge: args.dnsChallenge,
  };
  if (args.dnsChallenge) {
    m.dns_provider = args.dnsProvider;
    m.dns_provider_credentials = args.dnsProviderCredentials;
    if (args.propagationSeconds > 0) {
      m.propagation_seconds = args.propagationSeconds;
    }
  }
  return {
    provider: "letsencrypt",
    domain_names: args.domainNames,
    meta: m,
  };
}

// --- Endpoints and matching ------------------------------------------------

/** API collection path for each manageable object kind. */
export const KIND_PATHS: Record<ObjectKind, string> = {
  proxyHost: "/api/nginx/proxy-hosts",
  redirectionHost: "/api/nginx/redirection-hosts",
  deadHost: "/api/nginx/dead-hosts",
  stream: "/api/nginx/streams",
  accessList: "/api/nginx/access-lists",
  certificate: "/api/nginx/certificates",
};

/**
 * Resource instance-name prefix for each kind.
 *
 * Instance names share one namespace on disk across every spec, so each kind
 * needs its own prefix or a proxy host and a stream with the same NPM id would
 * overwrite each other.
 */
export const KIND_PREFIXES: Record<ObjectKind, string> = {
  proxyHost: "proxy-host",
  redirectionHost: "redirection-host",
  deadHost: "dead-host",
  stream: "stream",
  accessList: "access-list",
  certificate: "certificate",
};

/** The resource instance name a given object is stored under. */
export function instanceNameFor(kind: ObjectKind, id: number): string {
  return `${KIND_PREFIXES[kind]}-${id}`;
}

/**
 * Whether two domain lists describe the same host.
 *
 * Order and duplicates are irrelevant to nginx, so compare as sets. This is
 * the match key for the host upserts, which is what makes re-running an
 * `applyProxyHost` update the existing host rather than pile up duplicates.
 */
export function sameDomainSet(a: string[], b: string[]): boolean {
  const left = new Set(a.map((d) => d.toLowerCase()));
  const right = new Set(b.map((d) => d.toLowerCase()));
  if (left.size !== right.size) return false;
  for (const d of left) if (!right.has(d)) return false;
  return true;
}

/** Find an existing record whose domain set matches exactly. */
export function findByDomains(records: Raw[], domains: string[]): Raw | null {
  return records.find((r) =>
    sameDomainSet(strArray(r.domain_names), domains)
  ) ??
    null;
}
