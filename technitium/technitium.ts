import { z } from "npm:zod@4";
import https from "node:https";
import http from "node:http";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

/**
 * `@jamesakeech/technitium` — a Technitium DNS model type carrying fixes for
 * three defects found while migrating a live authoritative primary/secondary
 * pair between hypervisors — rebuilding both nodes from settings backups, which
 * is the exercise that exposes what a backup does and does not carry.
 *
 * WHY A NEW TYPE RATHER THAN AN EXTENSION. `export const extension` can only
 * ADD methods, never override them. All three defects are in the behaviour of
 * methods that already exist upstream, so they cannot be corrected in place —
 * a caller reaching for `settings_backup` would still get the broken one. The
 * only way to make the right thing the default is to own the type.
 *
 * SCOPE: FULL PARITY. Every method the upstream type exposes is implemented
 * here, plus record_ensure, settings_get and the three cluster methods. The
 * point is not to need @thomas/technitium installed at all.
 *
 * VERIFICATION — read this before trusting a method blind. Paths, parameters
 * and response shapes were taken from the upstream source and from the
 * server's own UI JavaScript at v15.4, so none of it is guesswork. But
 * "ported faithfully" is not "exercised", and the difference is worth being
 * honest about:
 *
 *   VERIFIED against the live pair on 2026-08-15 —
 *     zone_list, record_list, record_get, record_add, record_ensure,
 *     record_update, record_delete, settings_get, settings_backup,
 *     cluster_state, blocking_get_settings, allowed_add, allowed_delete,
 *     allowed_list, allowed_flush, blocked_add, blocked_delete, blocked_list,
 *     blocked_flush, cache_list, cache_delete, dashboard_stats,
 *     client_resolve, logs_query (its not-installed error path).
 *
 *   PORTED BUT NOT EXERCISED — no safe way to run them against a live
 *   authoritative pair without causing the outage or state change they exist
 *   to cause:
 *     zone_create, zone_enable, zone_disable (a disabled primary stops
 *     answering for every name it holds), settings_restore and
 *     web_service_set_tls and cluster_init and cluster_join (each verified
 *     during the migration, but through the predecessor extension rather than
 *     this code), cache_flush, blocking_set_state,
 *     blocking_temporary_disable, blocking_set_lists,
 *     blocking_force_update_lists, dnssec_validation_set.
 *
 *   Treat that second list as "expected to work, not proven to". Exercise one
 *   on something disposable before relying on it in a workflow.
 *
 * ---------------------------------------------------------------------------
 * THE THREE DEFECTS
 * ---------------------------------------------------------------------------
 *
 * 1. `settings_backup` silently produced INCOMPLETE backups.
 *    The upstream flag list omits `dnsSettings` and `logSettings`, so the API
 *    defaults them false and the zip contains no `dns.config` — no forwarders,
 *    no server domain, no cluster catalog. The method's own description called
 *    this "a config-only backup", which is exactly inverted.
 *    How it showed: a "full" backup and a config-only probe backup came back
 *    BYTE-IDENTICAL — same 67290 bytes, same sha256. A backup you cannot
 *    restore a server from, that reports success, is the worst kind of bug.
 *    Fixed: every section defaults TRUE here, including the two omitted ones.
 *
 * 2. `record_ensure` could not write TLSA at all.
 *    Its schema listed only "A | AAAA | CNAME | TXT | MX | SRV | NS | PTR".
 *    Any other type failed with a confusing parameter error rather than an
 *    honest "unsupported type".
 *    Fixed: driven by the RDATA_WRITE_KEYS table below, so every type the
 *    server understands is writable.
 *
 * 3. `record_update` REPORTED FAILURE ON A WRITE THAT SUCCEEDED.
 *    Technitium reads a TLSA back as `{certificateUsage, selector, ...}` but
 *    writes it as `{tlsaCertificateUsage, tlsaSelector, ...}`. The upstream
 *    post-write read-back compared the two shapes directly, so it could never
 *    match, and raised "the live record is missing or has different/empty
 *    data" over a record that was correct in the zone the whole time.
 *    This is the dangerous kind of failure: mid-cutover, the instinct on
 *    seeing it is to retry a write that already landed.
 *    Fixed: both sides are normalised through the mapping before comparison.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SETTINGS BACKUP DOES NOT CONTAIN
 * ---------------------------------------------------------------------------
 * Learned by rebuilding both nodes from one. Even with every flag set, the zip
 * carries none of the following, because Technitium treats them as node-local
 * identity rather than shared config:
 *
 *   - `webservice.config` — the TLS enable flag and HTTPS port. A restored
 *     node comes up with `webServiceEnableTls: false` and 53443 closed, and
 *     must be corrected with `web_service_set_tls`.
 *   - The web service certificate. Both nodes here run self-signed certs that
 *     Technitium generates itself, so a rebuild MINTS A NEW ONE and any TLSA
 *     record pinning the old key must be rewritten.
 *   - Cluster membership. There is no `cluster.config` on disk at all; a
 *     restored node reports `clusterInitialized: false` however complete the
 *     backup. Re-forming the cluster is an explicit act — see `cluster_init`
 *     and `cluster_join`.
 *
 * Plan a rebuild around those three or it will look like the restore failed.
 */

const API = "/api";
const REQUEST_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;
type Params = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  baseUrl: z.string().min(1).describe(
    "Base URL of the Technitium web service, e.g. http://192.0.2.10:5380. " +
      "Prefer an IP where the server being managed is also the server that " +
      "would resolve its own name — a resolver that cannot be reached is not " +
      "a resolver that can tell you where it is.",
  ),
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "API token for a user with the rights the called methods need. Cluster " +
      "methods require Administration — supply via " +
      "`${{ vault.get('<vault>', '<key>') }}`.",
  ),
  skipTlsVerify: z.boolean().optional().describe(
    "Skip TLS verification. Relevant only for an https baseUrl.",
  ),
});
type GlobalArgsT = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// rData key mapping — the fix at the heart of this type
// ---------------------------------------------------------------------------

/**
 * Technitium is NOT symmetric about record data field names. Reads return one
 * shape and writes expect another, and only for some record types.
 *
 * Read names come from what `/zones/records/get` returns; write names are the
 * query parameters `/zones/records/add` and `/update` accept (the `new*` forms
 * are these same names capitalised and prefixed). Both sets were taken from
 * the server's own `js/zone.js` at v15.4 rather than inferred, then checked
 * against live records.
 *
 * Most types ARE symmetric and need no entry — A (`ipAddress`), CNAME
 * (`cname`), TXT (`text`), MX (`preference`/`exchange`), SRV
 * (`priority`/`weight`/`port`/`target`), NS, PTR, CAA, DS, NAPTR, SVCB and
 * HTTPS all read and write the same names. Only the types below diverge, and
 * the divergence is that the write side carries a type-name prefix.
 *
 * Note SRV vs URI: both have `priority` and `weight` on read, but SRV writes
 * them bare while URI writes `uriPriority`/`uriWeight`. That is exactly why
 * this is keyed by record type and not a single global rename.
 */
export const RDATA_WRITE_KEYS: Record<string, Record<string, string>> = {
  TLSA: {
    certificateUsage: "tlsaCertificateUsage",
    selector: "tlsaSelector",
    matchingType: "tlsaMatchingType",
    certificateAssociationData: "tlsaCertificateAssociationData",
  },
  SSHFP: {
    algorithm: "sshfpAlgorithm",
    fingerprint: "sshfpFingerprint",
    fingerprintType: "sshfpFingerprintType",
  },
  URI: {
    priority: "uriPriority",
    weight: "uriWeight",
  },
  // APP records carry their payload under `data` on read but `recordData` on
  // write, and are matched by domain+type rather than by value. Spreading the
  // read shape verbatim sends an unrecognised `data` parameter and Technitium
  // writes the record with EMPTY content — which then SERVFAILs at query time.
  APP: {
    data: "recordData",
  },
};

/** Invert a write map so a read-shaped record can be compared with a write-shaped one. */
export function readKeyFor(type: string, writeKey: string): string {
  const map = RDATA_WRITE_KEYS[type.toUpperCase()];
  if (!map) return writeKey;
  for (const [read, write] of Object.entries(map)) {
    if (write === writeKey) return read;
  }
  return writeKey;
}

/**
 * Normalise an rData object to the READ shape, whichever shape it arrived in.
 * Callers may legitimately supply either — the read shape because that is what
 * `record_get` handed them, or the write shape because that is what the API
 * documentation shows — and both must behave identically.
 */
export function toReadShape(
  type: string,
  rData: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rData)) {
    if (v === undefined || v === null) continue;
    out[readKeyFor(type, k)] = v;
  }
  return out;
}

/** Translate an rData object into the flat write parameters Technitium expects. */
export function toWriteParams(
  type: string,
  rData: Record<string, unknown>,
): Params {
  const map = RDATA_WRITE_KEYS[type.toUpperCase()] ?? {};
  const out: Params = {};
  for (const [k, v] of Object.entries(toReadShape(type, rData))) {
    if (v === undefined || v === null) continue;
    out[map[k] ?? k] = v as string | number | boolean;
  }
  return out;
}

/** The `new*` parameter forms, used by /update to carry the desired values. */
export function toNewWriteParams(
  type: string,
  rData: Record<string, unknown>,
): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(toWriteParams(type, rData))) {
    out["new" + k.charAt(0).toUpperCase() + k.slice(1)] = v;
  }
  return out;
}

/**
 * Compare a desired rData against one read back from the server, in the read
 * shape, comparing only the fields the caller actually specified. Values are
 * stringified because Technitium is loose about numbers vs strings.
 *
 * This is the comparison the upstream got wrong: it matched raw keys, so a
 * caller-supplied `tlsaCertificateUsage` never matched a returned
 * `certificateUsage` and every TLSA write "failed" after succeeding.
 */
export function rDataMatches(
  type: string,
  want: Record<string, unknown>,
  got: Record<string, unknown>,
): boolean {
  const w = toReadShape(type, want);
  const g = toReadShape(type, got ?? {});
  for (const [k, v] of Object.entries(w)) {
    if (String(v ?? "") !== String(g[k] ?? "")) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// https.RequestOptions, not http's: rejectUnauthorized is a TLS option and
// does not exist on the plain-HTTP type. The superset covers both callers.
function httpRequest(
  options: https.RequestOptions,
  secure: boolean,
  payload?: string | Uint8Array,
): Promise<{ status: number; body: Buffer }> {
  const mod = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on(
        "end",
        () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
      );
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function buildRequest(g: GlobalArgsT, path: string, params: Params) {
  const url = new URL(g.baseUrl.replace(/\/+$/, "") + API + path);
  url.searchParams.set("token", g.apiToken);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return {
    url,
    secure: url.protocol === "https:",
    headers: {
      Authorization: `Bearer ${g.apiToken}`,
      Accept: "application/json",
    } as Record<string, string>,
  };
}

/**
 * Technitium answers HTTP 200 with `{"status":"error"}` in the body, so a
 * transport success is not an operation success. Every call must unwrap.
 */
export function unwrapEnvelope(parsed: unknown, context: string): Json {
  const env = (parsed ?? {}) as Json;
  const status = String(env.status ?? "");
  if (status === "error") {
    throw new Error(
      `Technitium ${context}: ${String(env.errorMessage ?? "unknown error")}`,
    );
  }
  if (status === "invalid-token") {
    throw new Error(`Technitium ${context}: invalid or expired API token`);
  }
  return (env.response ?? {}) as Json;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function apiCall(
  g: GlobalArgsT,
  method: "GET" | "POST",
  path: string,
  params: Params = {},
): Promise<Json> {
  const isPost = method === "POST";
  const { url, headers, secure } = buildRequest(g, path, isPost ? {} : params);
  let payload: string | undefined;
  if (isPost) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.set(k, String(v));
    }
    payload = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  const res = await httpRequest(
    {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (secure ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      rejectUnauthorized: !g.skipTlsVerify,
    },
    secure,
    payload,
  );
  const text = res.body.toString("utf8");
  if (res.status >= 400) {
    throw new Error(
      `Technitium ${method} ${path} -> HTTP ${res.status}: ${text}`,
    );
  }
  return unwrapEnvelope(safeJson(text), `${method} ${path}`);
}

/** The backup endpoint returns raw application/zip, not the JSON envelope. */
async function apiDownload(
  g: GlobalArgsT,
  path: string,
  params: Params,
): Promise<Uint8Array> {
  const { url, headers, secure } = buildRequest(g, path, params);
  const res = await httpRequest(
    {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (secure ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers,
      rejectUnauthorized: !g.skipTlsVerify,
    },
    secure,
  );
  if (res.status >= 400) {
    throw new Error(
      `Technitium GET ${path} -> HTTP ${res.status}: ${
        res.body.toString("utf8")
      }`,
    );
  }
  return new Uint8Array(res.body);
}

/**
 * Build a `multipart/form-data` body carrying a single file, which is how the
 * settings restore endpoint accepts a backup zip. Hand-rolled because the
 * payload is binary and must survive byte-for-byte — a re-encoded zip restores
 * nothing.
 */
export function buildMultipart(
  fieldName: string,
  fileName: string,
  bytes: Uint8Array,
): { body: Uint8Array; contentType: string } {
  const boundary = "----swampTechnitium" +
    crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function apiUpload(
  g: GlobalArgsT,
  path: string,
  params: Params,
  fileBytes: Uint8Array,
  fileName: string,
): Promise<Json> {
  const { body, contentType } = buildMultipart(
    "fileToUpload",
    fileName,
    fileBytes,
  );
  const { url, headers, secure } = buildRequest(g, path, params);
  headers["Content-Type"] = contentType;
  headers["Content-Length"] = String(body.length);
  const res = await httpRequest(
    {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (secure ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers,
      rejectUnauthorized: !g.skipTlsVerify,
    },
    secure,
    body,
  );
  const text = res.body.toString("utf8");
  if (res.status >= 400) {
    throw new Error(`Technitium POST ${path} -> HTTP ${res.status}: ${text}`);
  }
  return unwrapEnvelope(safeJson(text), `POST ${path}`);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Sanitise a DNS name into a data-instance-safe fragment. */
export function slug(s: string): string {
  const out = s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return out.length > 0 ? out : "root";
}

/** FNV-1a over canonicalised rData — distinguishes siblings of the same type. */
export function rDataHash(
  type: string,
  rData?: Record<string, unknown>,
): string {
  const norm = toReadShape(type, rData ?? {});
  const canon = JSON.stringify(
    Object.keys(norm).sort().map((k) => [k, String(norm[k])]),
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Stable data instance name for one record: zone, owner, type and a hash of the
 * record data. The hash is what keeps two records of the same type at the same
 * name — round-robin A records, multiple TLSA pins — from overwriting each
 * other's history.
 */
export function recordInstanceName(
  zone: string,
  domain: string,
  type: string,
  rData?: Record<string, unknown>,
): string {
  return `rec-${slug(zone)}-${slug(domain)}-${type.toUpperCase()}-${
    rDataHash(type, rData)
  }`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ZoneSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  internal: z.boolean().optional(),
  disabled: z.boolean().optional(),
  dnssecStatus: z.string().optional(),
  observedAt: z.string(),
});

const ZoneRecordSchema = z.object({
  zone: z.string(),
  name: z.string(),
  type: z.string(),
  ttl: z.number().optional(),
  rData: z.record(z.string(), z.unknown()).optional(),
  action: z.string().optional(),
  observedAt: z.string(),
});

const SettingsSchema = z.object({
  enableBlocking: z.boolean().optional(),
  temporaryDisableBlockingTill: z.string().optional(),
  blockListUrls: z.array(z.string()).optional(),
  allowListUrls: z.array(z.string()).optional(),
  blockListUrlUpdateIntervalHours: z.number().optional(),
  dnsServerDomain: z.string().nullable().optional(),
  forwarders: z.array(z.string()).optional(),
  webServiceEnableTls: z.boolean().optional(),
  webServiceTlsPort: z.number().nullable().optional(),
  webServiceUseSelfSignedTlsCertificate: z.boolean().optional(),
  webServiceTlsCertificatePath: z.string().optional(),
  webServiceHttpToTlsRedirect: z.boolean().optional(),
  dnssecValidation: z.boolean().optional(),
  enableDnsOverTls: z.boolean().optional(),
  clusterInitialized: z.boolean().optional(),
  observedAt: z.string(),
});

const ListEntrySchema = z.object({
  list: z.string(),
  domain: z.string(),
  action: z.string().optional(),
  observedAt: z.string(),
});

const DnsResponseSchema = z.object({
  server: z.string(),
  domain: z.string(),
  type: z.string(),
  protocol: z.string().optional(),
  rcode: z.string().optional(),
  answer: z.array(z.unknown()).optional(),
  observedAt: z.string(),
});

const QueryLogSchema = z.object({
  rowNumber: z.number().optional(),
  timestamp: z.string().optional(),
  clientIpAddress: z.string().optional(),
  protocol: z.string().optional(),
  responseType: z.string().optional(),
  rcode: z.string().optional(),
  qname: z.string().optional(),
  qtype: z.string().optional(),
  qclass: z.string().optional(),
  answer: z.string().optional(),
  observedAt: z.string(),
});

const CacheEntrySchema = z.object({
  name: z.string(),
  kind: z.string(),
  action: z.string().optional(),
  observedAt: z.string(),
});

const StatsSchema = z.object({
  range: z.string(),
  totalQueries: z.number().optional(),
  totalNoError: z.number().optional(),
  totalServerFailure: z.number().optional(),
  totalNxDomain: z.number().optional(),
  totalRefused: z.number().optional(),
  totalBlocked: z.number().optional(),
  totalCached: z.number().optional(),
  totalClients: z.number().optional(),
  topDomains: z.unknown().optional(),
  topBlockedDomains: z.unknown().optional(),
  topClients: z.unknown().optional(),
  observedAt: z.string(),
});

const StatsRange = z.enum([
  "LastHour",
  "LastDay",
  "LastWeek",
  "LastMonth",
  "LastYear",
  "Custom",
]);

const ClusterStateSchema = z.object({
  clusterInitialized: z.boolean(),
  clusterDomain: z.string().nullable(),
  dnsServerDomain: z.string().nullable(),
  version: z.string().nullable(),
  nodeCount: z.number(),
  nodes: z.array(z.object({
    name: z.string().nullable(),
    type: z.string().nullable(),
    state: z.string().nullable(),
    ipAddresses: z.array(z.string()),
  })),
  unreachable: z.number(),
  observedAt: z.string(),
});

const OperationResultSchema = z.object({
  operation: z.string(),
  target: z.string().optional(),
  success: z.boolean(),
  detail: z.string().optional(),
  observedAt: z.string(),
});

const RecordSpec = z.object({
  domain: z.string().describe("Record owner FQDN, e.g. apps02.example.com"),
  type: z.string().describe(
    "Any type the server supports — A, AAAA, CNAME, TXT, MX, SRV, NS, PTR, " +
      "CAA, DS, TLSA, SSHFP, URI, SVCB, HTTPS, NAPTR, APP. Unlike the " +
      "upstream type this is not restricted to a short list.",
  ),
  ttl: z.number().int().optional(),
  rData: z.record(z.string(), z.unknown()).describe(
    "Type-specific fields. Either the READ shape (as record_get returns, " +
      "e.g. {certificateUsage} for TLSA) or the WRITE shape (as the API " +
      "documents, e.g. {tlsaCertificateUsage}) is accepted — they are " +
      "normalised to the same thing.",
  ),
  multiValued: z.boolean().optional().describe(
    "false (default): single-valued — an existing record of this type at " +
      "this name is UPDATED to the desired rData. true: additive — leaves " +
      "siblings alone and adds this exact rData if missing. Use true for " +
      "round-robin A and multiple MX/NS; false for a host's own address, and " +
      "false for a TLSA being repinned, where leaving the dead pin published " +
      "alongside the live one would keep validating.",
  ),
});

/**
 * Every section defaults TRUE — including dnsSettings and logSettings, whose
 * omission upstream is defect 1. A backup missing dns.config cannot rebuild a
 * server, and nothing about the result tells you so.
 */
const BackupSections = z.object({
  dnsSettings: z.boolean().default(true),
  logSettings: z.boolean().default(true),
  authConfig: z.boolean().default(true),
  zones: z.boolean().default(true),
  allowedZones: z.boolean().default(true),
  blockedZones: z.boolean().default(true),
  blockLists: z.boolean().default(true),
  scopes: z.boolean().default(true),
  apps: z.boolean().default(true),
  dnsApps: z.boolean().default(true),
  logs: z.boolean().default(false),
  stats: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type LiveRecord = {
  type: string;
  ttl?: number;
  rData: Record<string, unknown>;
};

async function getDomainRecords(
  g: GlobalArgsT,
  domain: string,
  zone?: string,
): Promise<LiveRecord[]> {
  const params: Params = { domain, listZone: false };
  if (zone) params.zone = zone;
  const r = await apiCall(g, "GET", "/zones/records/get", params);
  const rows = Array.isArray(r.records) ? r.records as Json[] : [];
  return rows.map((row) => ({
    type: String(row.type ?? ""),
    ttl: typeof row.ttl === "number" ? row.ttl : undefined,
    rData: (row.rData ?? {}) as Record<string, unknown>,
  }));
}

/** Reduce a raw cluster state response to the fields worth asserting on. */
export function summariseCluster(r: Json): z.infer<typeof ClusterStateSchema> {
  const nodes = Array.isArray(r.clusterNodes) ? r.clusterNodes as Json[] : [];
  return {
    clusterInitialized: r.clusterInitialized === true,
    clusterDomain: (r.clusterDomain ?? null) as string | null,
    dnsServerDomain: (r.dnsServerDomain ?? null) as string | null,
    version: (r.version ?? null) as string | null,
    nodeCount: nodes.length,
    nodes: nodes.map((n) => ({
      name: (n.name ?? null) as string | null,
      type: (n.type ?? null) as string | null,
      state: (n.state ?? null) as string | null,
      ipAddresses: Array.isArray(n.ipAddresses)
        ? (n.ipAddresses as unknown[]).map(String)
        : [],
    })),
    unreachable: nodes.filter((n) => String(n.state ?? "") === "Unreachable")
      .length,
    observedAt: new Date().toISOString(),
  };
}

/** First defined value among the given keys — tolerates camel/Pascal drift. */
export function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

/** Stringify, preserving undefined for absent values rather than "undefined". */
export function asString(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

/** Coerce to a number, tolerating the numeric strings Technitium sometimes emits. */
export function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return undefined;
}

/** Coerce an unknown value to a string array, or undefined when it is not one. */
export function toStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String) : undefined;
}

/** Collect names from a response that may hold strings or {name}/{domain} objects. */
export function namesFrom(resp: Json, ...keys: string[]): string[] {
  const seen = new Set<string>();
  for (const k of keys) {
    const arr = resp[k];
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (typeof e === "string") seen.add(e);
      else if (e && typeof e === "object") {
        const n = asString(pick(e as Json, "name", "domain"));
        if (n) seen.add(n);
      }
    }
  }
  return [...seen];
}

/** Return the first key holding an array, or an empty array — never throws on shape drift. */
export function coerceArray(resp: Json, ...keys: string[]): Json[] {
  for (const k of keys) {
    if (Array.isArray(resp[k])) return resp[k] as Json[];
  }
  return [];
}

/** Build the record written for a mutating call that produces no resource of its own. */
export function opResult(
  operation: string,
  success: boolean,
  target?: string,
  detail?: string,
): z.infer<typeof OperationResultSchema> {
  return {
    operation,
    target,
    success,
    detail,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Technitium takes block/allow list URLs as ONE comma-joined parameter, and
 * silently misbehaves on individual URLs past 255 characters — so overlong
 * entries are surfaced rather than swallowed.
 */
export function joinListUrls(
  urls: string[],
): { joined: string; tooLong: string[] } {
  return {
    joined: urls.join(","),
    tooLong: urls.filter((u) => u.length > 255),
  };
}

/** The settings subset worth recording, pulled out of the full settings blob. */
export function extractSettings(
  r: Json,
  observedAt: string,
): z.infer<typeof SettingsSchema> {
  return {
    enableBlocking: pick(r, "enableBlocking") as boolean | undefined,
    temporaryDisableBlockingTill: asString(
      pick(r, "temporaryDisableBlockingTill"),
    ),
    blockListUrls: toStringArray(pick(r, "blockListUrls")),
    allowListUrls: toStringArray(pick(r, "allowListUrls")),
    blockListUrlUpdateIntervalHours: asNumber(
      pick(r, "blockListUrlUpdateIntervalHours"),
    ),
    dnsServerDomain: asString(pick(r, "dnsServerDomain")) ?? null,
    forwarders: toStringArray(pick(r, "forwarders")) ?? [],
    webServiceEnableTls: pick(r, "webServiceEnableTls") as boolean | undefined,
    webServiceTlsPort: asNumber(pick(r, "webServiceTlsPort")) ?? null,
    webServiceUseSelfSignedTlsCertificate: pick(
      r,
      "webServiceUseSelfSignedTlsCertificate",
    ) as boolean | undefined,
    webServiceTlsCertificatePath: asString(
      pick(r, "webServiceTlsCertificatePath"),
    ),
    webServiceHttpToTlsRedirect: pick(r, "webServiceHttpToTlsRedirect") as
      | boolean
      | undefined,
    dnssecValidation: pick(r, "dnssecValidation") as boolean | undefined,
    enableDnsOverTls: pick(r, "enableDnsOverTls") as boolean | undefined,
    clusterInitialized: pick(r, "clusterInitialized") === true,
    observedAt,
  };
}

// deno-lint-ignore no-explicit-any
type Ctx = any;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * The `@jamesakeech/technitium` model type: one instance is one Technitium DNS
 * server. A cluster is two instances, because most operations are node-local
 * and the two nodes can legitimately disagree.
 */
export const model = {
  type: "@jamesakeech/technitium",
  version: "2026.08.15.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    zone: {
      description: "A zone as the server reports it, with its DNSSEC status.",
      schema: ZoneSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    zoneRecord: {
      description:
        "A single record, keyed by zone, owner, type and rData hash.",
      schema: ZoneRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    settings: {
      description:
        "The server settings subset worth asserting on in a workflow.",
      schema: SettingsSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    clusterState: {
      description:
        "Cluster membership as ONE node sees it. Worth writing per node: the " +
        "two sides can disagree, and that disagreement is the interesting case.",
      schema: ClusterStateSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    operationResult: {
      description: "The outcome of a mutating call that produces no resource.",
      schema: OperationResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    listEntry: {
      description: "One domain on the allowed or blocked list.",
      schema: ListEntrySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    dnsResponse: {
      description:
        "The answer to a diagnostic resolve. Ephemeral — a resolver's answer " +
        "is true at the moment it was asked and not after.",
      schema: DnsResponseSchema,
      lifetime: "ephemeral" as const,
      garbageCollection: 5,
    },
    queryLog: {
      description: "One row from the query log app.",
      schema: QueryLogSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    cacheEntry: {
      description: "A cached zone or record name.",
      schema: CacheEntrySchema,
      lifetime: "1d" as const,
      garbageCollection: 5,
    },
    stats: {
      description: "Dashboard counters for a time range.",
      schema: StatsSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
  },

  files: {
    backup: {
      description:
        "A full settings backup (zip). CONTAINS SECRETS — auth.config carries " +
        "users, groups and API tokens — hence the short lifetime.",
      contentType: "application/zip",
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },

  checks: {
    reachable: {
      description:
        "The web service answers and the token authenticates. Probes a real " +
        "authenticated endpoint rather than an unauthenticated ping, because " +
        "an ungranted token can return an empty result set instead of an error.",
      labels: ["live"],
      appliesTo: [
        "zone_list",
        "zone_create",
        "zone_delete",
        "record_list",
        "record_get",
        "record_ensure",
        "record_update",
        "record_delete",
        "settings_get",
        "settings_backup",
        "settings_restore",
        "web_service_set_tls",
        "cluster_state",
        "cluster_init",
        "cluster_join",
      ],
      execute: async (
        context: Ctx,
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        try {
          await apiCall(context.globalArgs, "GET", "/zones/list", {});
          return { pass: true };
        } catch (e) {
          return { pass: false, errors: [(e as Error).message] };
        }
      },
    },
  },

  methods: {
    // ----- zones -----------------------------------------------------------
    zone_list: {
      description: "List every zone with its type and DNSSEC status.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const g: GlobalArgsT = context.globalArgs;
        const r = await apiCall(g, "GET", "/zones/list", {});
        const zones = Array.isArray(r.zones) ? r.zones as Json[] : [];
        const handles = [];
        for (const zn of zones) {
          const name = String(zn.name ?? "");
          handles.push(
            await context.writeResource("zone", `zone-${slug(name)}`, {
              name,
              type: zn.type === undefined ? undefined : String(zn.type),
              internal: zn.internal === true,
              disabled: zn.disabled === true,
              dnssecStatus: zn.dnssecStatus === undefined
                ? undefined
                : String(zn.dnssecStatus),
              observedAt: new Date().toISOString(),
            }),
          );
        }
        context.logger.info("Listed {count} zone(s)", { count: zones.length });
        return { dataHandles: handles };
      },
    },

    zone_create: {
      description: "Create a zone (Primary, Secondary, Forwarder, Catalog, …).",
      arguments: z.object({
        zone: z.string(),
        type: z.string().optional().describe(
          "Primary | Secondary | Stub | Forwarder | Catalog | SecondaryCatalog",
        ),
        primaryNameServerAddresses: z.string().optional(),
        catalog: z.string().optional(),
      }),
      execute: async (
        args: {
          zone: string;
          type?: string;
          primaryNameServerAddresses?: string;
          catalog?: string;
        },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const params: Params = { zone: args.zone };
        if (args.type) params.type = args.type;
        if (args.primaryNameServerAddresses) {
          params.primaryNameServerAddresses = args.primaryNameServerAddresses;
        }
        if (args.catalog) params.catalog = args.catalog;
        await apiCall(g, "POST", "/zones/create", params);
        context.logger.info("Created zone {zone}", { zone: args.zone });
        return {
          dataHandles: [
            await context.writeResource("zone", `zone-${slug(args.zone)}`, {
              name: args.zone,
              type: args.type,
              observedAt: new Date().toISOString(),
            }),
          ],
        };
      },
    },

    zone_delete: {
      description:
        "Delete a zone. Destructive — confirm WHICH copy you are deleting " +
        "first. Removing a SecondaryCatalog on a secondary is routine (a " +
        "cluster join recreates it); removing the Catalog on the primary is " +
        "not the same operation at all.",
      arguments: z.object({ zone: z.string() }),
      execute: async (args: { zone: string }, context: Ctx) => {
        const g: GlobalArgsT = context.globalArgs;
        await apiCall(g, "POST", "/zones/delete", { zone: args.zone });
        context.logger.info("Deleted zone {zone}", { zone: args.zone });
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              `zone-delete-${slug(args.zone)}`,
              {
                operation: "zone_delete",
                target: args.zone,
                success: true,
                observedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },

    // ----- records ---------------------------------------------------------
    record_list: {
      description: "List every record in a zone.",
      arguments: z.object({ zone: z.string() }),
      execute: async (args: { zone: string }, context: Ctx) => {
        const g: GlobalArgsT = context.globalArgs;
        const r = await apiCall(g, "GET", "/zones/records/get", {
          domain: args.zone,
          zone: args.zone,
          listZone: true,
        });
        const rows = Array.isArray(r.records) ? r.records as Json[] : [];
        const handles = [];
        for (const row of rows) {
          const name = String(row.name ?? "");
          const type = String(row.type ?? "");
          const rData = (row.rData ?? {}) as Record<string, unknown>;
          handles.push(
            await context.writeResource(
              "zoneRecord",
              recordInstanceName(args.zone, name, type, rData),
              {
                zone: args.zone,
                name,
                type,
                ttl: typeof row.ttl === "number" ? row.ttl : undefined,
                rData,
                action: "observed",
                observedAt: new Date().toISOString(),
              },
            ),
          );
        }
        context.logger.info("Listed {count} record(s) in {zone}", {
          count: rows.length,
          zone: args.zone,
        });
        return { dataHandles: handles };
      },
    },

    record_get: {
      description: "Get the records at one owner name.",
      arguments: z.object({
        domain: z.string(),
        zone: z.string().optional(),
      }),
      execute: async (
        args: { domain: string; zone?: string },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const live = await getDomainRecords(g, args.domain, args.zone);
        const zone = args.zone ?? args.domain;
        const handles = [];
        for (const rec of live) {
          handles.push(
            await context.writeResource(
              "zoneRecord",
              recordInstanceName(zone, args.domain, rec.type, rec.rData),
              {
                zone,
                name: args.domain,
                type: rec.type,
                ttl: rec.ttl,
                rData: rec.rData,
                action: "observed",
                observedAt: new Date().toISOString(),
              },
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    record_ensure: {
      description:
        "Idempotently ensure records exist with the given values (upsert), " +
        "reporting created | updated | unchanged per record. Safe to re-run, " +
        "which is what a workflow step needs — Technitium's own add fails on " +
        "an existing record and its update fails on an absent one. Works for " +
        "EVERY record type, TLSA included; accepts rData in either the read " +
        "or the write shape. Fans out over the array in one execution.",
      arguments: z.object({
        zone: z.string().optional(),
        records: z.array(RecordSpec).min(1),
      }),
      execute: async (
        args: { zone?: string; records: z.infer<typeof RecordSpec>[] },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const handles = [];
        const tally = { created: 0, updated: 0, unchanged: 0 };

        for (const spec of args.records) {
          const type = spec.type.toUpperCase();
          const live = await getDomainRecords(g, spec.domain, args.zone);
          const sameType = live.filter((r) => r.type.toUpperCase() === type);
          const exact = sameType.find((r) =>
            rDataMatches(type, spec.rData, r.rData) &&
            (spec.ttl === undefined || r.ttl === spec.ttl)
          );

          let action: "created" | "updated" | "unchanged";

          if (exact) {
            action = "unchanged";
            tally.unchanged++;
          } else if (sameType.length > 0 && !spec.multiValued) {
            // Retarget the existing record: Technitium matches on its CURRENT
            // rData, and the desired values ride in the new* parameters.
            const current = sameType[0];
            const params: Params = { domain: spec.domain, type };
            if (args.zone) params.zone = args.zone;
            if (spec.ttl !== undefined) params.ttl = spec.ttl;
            Object.assign(params, toWriteParams(type, current.rData));
            Object.assign(params, toNewWriteParams(type, spec.rData));
            await apiCall(g, "POST", "/zones/records/update", params);
            action = "updated";
            tally.updated++;
          } else {
            const params: Params = { domain: spec.domain, type };
            if (args.zone) params.zone = args.zone;
            if (spec.ttl !== undefined) params.ttl = spec.ttl;
            Object.assign(params, toWriteParams(type, spec.rData));
            await apiCall(g, "POST", "/zones/records/add", params);
            action = "created";
            tally.created++;
          }

          // Read back through the SAME normalisation used to write. Comparing
          // raw keys here is what made the upstream report false failures.
          if (action !== "unchanged") {
            const after = await getDomainRecords(g, spec.domain, args.zone);
            const ok = after.some((r) =>
              r.type.toUpperCase() === type &&
              rDataMatches(type, spec.rData, r.rData)
            );
            if (!ok) {
              throw new Error(
                `record_ensure ${action} ${type} ${spec.domain} but the ` +
                  `read-back does not show it — wanted ${
                    JSON.stringify(toReadShape(type, spec.rData))
                  }`,
              );
            }
          }

          const zone = args.zone ?? spec.domain;
          handles.push(
            await context.writeResource(
              "zoneRecord",
              recordInstanceName(zone, spec.domain, type, spec.rData),
              {
                zone,
                name: spec.domain,
                type,
                ttl: spec.ttl,
                rData: toReadShape(type, spec.rData),
                action,
                observedAt: new Date().toISOString(),
              },
            ),
          );
        }

        context.logger.info("Ensured records: {*}", {
          ...tally,
          total: args.records.length,
        });
        return { dataHandles: handles };
      },
    },

    record_update: {
      description:
        "Change an existing record's value or TTL. `rData` identifies it, " +
        "`newRData` carries the new values. Prefer record_ensure unless you " +
        "specifically need to fail when the record is absent.",
      arguments: z.object({
        zone: z.string().optional(),
        domain: z.string(),
        type: z.string(),
        ttl: z.number().int().optional(),
        rData: z.record(z.string(), z.unknown()),
        newRData: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (
        args: {
          zone?: string;
          domain: string;
          type: string;
          ttl?: number;
          rData: Record<string, unknown>;
          newRData?: Record<string, unknown>;
        },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const type = args.type.toUpperCase();
        const want = args.newRData ?? args.rData;
        const params: Params = { domain: args.domain, type };
        if (args.zone) params.zone = args.zone;
        if (args.ttl !== undefined) params.ttl = args.ttl;
        Object.assign(params, toWriteParams(type, args.rData));
        if (args.newRData) {
          Object.assign(params, toNewWriteParams(type, args.newRData));
        }
        await apiCall(g, "POST", "/zones/records/update", params);

        const after = await getDomainRecords(g, args.domain, args.zone);
        const ok = after.some((r) =>
          r.type.toUpperCase() === type && rDataMatches(type, want, r.rData)
        );
        if (!ok) {
          throw new Error(
            `record_update reported success but the read-back does not show ` +
              `${type} ${args.domain} with ${
                JSON.stringify(toReadShape(type, want))
              }`,
          );
        }

        const zone = args.zone ?? args.domain;
        return {
          dataHandles: [
            await context.writeResource(
              "zoneRecord",
              recordInstanceName(zone, args.domain, type, want),
              {
                zone,
                name: args.domain,
                type,
                ttl: args.ttl,
                rData: toReadShape(type, want),
                action: "updated",
                observedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },

    record_delete: {
      description: "Delete one record, identified by its rData.",
      arguments: z.object({
        zone: z.string().optional(),
        domain: z.string(),
        type: z.string(),
        rData: z.record(z.string(), z.unknown()),
      }),
      execute: async (
        args: {
          zone?: string;
          domain: string;
          type: string;
          rData: Record<string, unknown>;
        },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const type = args.type.toUpperCase();
        const params: Params = { domain: args.domain, type };
        if (args.zone) params.zone = args.zone;
        Object.assign(params, toWriteParams(type, args.rData));
        await apiCall(g, "POST", "/zones/records/delete", params);

        const after = await getDomainRecords(g, args.domain, args.zone);
        const still = after.some((r) =>
          r.type.toUpperCase() === type &&
          rDataMatches(type, args.rData, r.rData)
        );
        if (still) {
          throw new Error(
            `record_delete reported success but ${type} ${args.domain} is ` +
              `still present`,
          );
        }
        context.logger.info("Deleted {type} {domain}", {
          type,
          domain: args.domain,
        });
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              `record-delete-${slug(args.domain)}-${type}`,
              {
                operation: "record_delete",
                target: `${type} ${args.domain}`,
                success: true,
                observedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },

    // ----- settings --------------------------------------------------------
    settings_get: {
      description:
        "Read the server settings subset that matters after a rebuild: " +
        "server domain, forwarders, TLS listener state and cluster flag.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const g: GlobalArgsT = context.globalArgs;
        const r = await apiCall(g, "GET", "/settings/get", {});
        const summary = extractSettings(r, new Date().toISOString());
        context.logger.info(
          "Settings: domain={dnsServerDomain} tls={webServiceEnableTls} cluster={clusterInitialized}",
          summary,
        );
        return {
          dataHandles: [
            await context.writeResource("settings", "settings", summary),
          ],
        };
      },
    },

    settings_backup: {
      description:
        "Download a COMPLETE settings backup. Every section is included by " +
        "default — dnsSettings and logSettings among them, whose omission is " +
        "the upstream defect this type exists to fix. Contains secrets. " +
        "Note what a backup can NEVER carry: the TLS enable flag, the web " +
        "service certificate, and cluster membership. Plan a rebuild around " +
        "those three.",
      arguments: z.object({ options: BackupSections.optional() }),
      execute: async (
        args: { options?: z.infer<typeof BackupSections> },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const flags = BackupSections.parse(
          args.options ?? {},
        ) as unknown as Params;
        context.logger.info("Downloading settings backup (all sections)");
        const bytes = await apiDownload(g, "/settings/backup", flags);
        if (bytes.length === 0) {
          throw new Error("settings_backup returned an empty file");
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const writer = context.createFileWriter("backup", `backup-${stamp}`);
        const handle = await writer.writeAll(bytes);
        context.logger.info("Backup written: {bytes} bytes", {
          bytes: bytes.length,
        });
        return { dataHandles: [handle] };
      },
    },

    settings_restore: {
      description:
        "Restore settings from a local backup zip. Sections default TRUE, " +
        "matching settings_backup. HAZARD: authConfig is CLUSTER state — a " +
        "restore against a live cluster member can propagate users and tokens " +
        "to its peer, so restore only onto an isolated node. When rebuilding " +
        "a cluster member, consider restoring with dnsSettings FALSE first so " +
        "the node stays inert, then again with it true once it holds its " +
        "production address.",
      arguments: z.object({
        filePath: z.string().describe("Absolute path to the backup zip"),
        options: BackupSections.optional(),
        deleteExistingFiles: z.boolean().default(false).describe(
          "Delete config files not present in the backup. Leave false unless " +
            "you mean it — the server's own internal zones are not in a " +
            "backup and would go with them.",
        ),
      }),
      execute: async (
        args: {
          filePath: string;
          options?: z.infer<typeof BackupSections>;
          deleteExistingFiles: boolean;
        },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const flags = BackupSections.parse(
          args.options ?? {},
        ) as unknown as Params;
        const params: Params = {
          ...flags,
          deleteExistingFiles: args.deleteExistingFiles,
        };
        const bytes = new Uint8Array(await readFile(args.filePath));
        if (bytes.length === 0) {
          throw new Error(`backup file is empty: ${args.filePath}`);
        }
        context.logger.info("Restoring settings from {file} ({bytes} bytes)", {
          file: args.filePath,
          bytes: bytes.length,
        });
        await apiUpload(g, "/settings/restore", params, bytes, "backup.zip");
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              "settings-restore",
              {
                operation: "settings_restore",
                target: args.filePath,
                success: true,
                observedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },

    web_service_set_tls: {
      description:
        "Configure the admin web service HTTPS listener. Needed after every " +
        "rebuild: webservice.config is not in a settings backup, so a " +
        "restored node comes up with TLS off and its cluster port closed. " +
        "Enabling the self-signed fallback MINTS A NEW CERTIFICATE — any TLSA " +
        "record pinning the old key must be rewritten afterwards.",
      arguments: z.object({
        enableTls: z.boolean().optional(),
        useSelfSignedCertificate: z.boolean().optional(),
        tlsPort: z.number().int().optional(),
        certificatePath: z.string().optional(),
        certificatePassword: z.string().optional().meta({ sensitive: true })
          .describe("Export password for the PKCS#12 file."),
        httpToTlsRedirect: z.boolean().optional().describe(
          "Enable only AFTER verifying the certificate serves correctly — " +
            "turning it on with a broken cert locks you out of the UI, and " +
            "the plaintext port may be the only way a model reaches this node.",
        ),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const map: Record<string, string> = {
          enableTls: "webServiceEnableTls",
          useSelfSignedCertificate: "webServiceUseSelfSignedTlsCertificate",
          tlsPort: "webServiceTlsPort",
          certificatePath: "webServiceTlsCertificatePath",
          certificatePassword: "webServiceTlsCertificatePassword",
          httpToTlsRedirect: "webServiceHttpToTlsRedirect",
        };
        const params: Params = {};
        for (const [k, v] of Object.entries(args)) {
          if (v === undefined || v === null) continue;
          if (map[k]) params[map[k]] = v as string | number | boolean;
        }
        if (Object.keys(params).length === 0) {
          throw new Error("web_service_set_tls called with nothing to change");
        }
        await apiCall(g, "POST", "/settings/set", params);
        const after = await apiCall(g, "GET", "/settings/get", {});
        context.logger.info(
          "Web service TLS: enabled={tls} port={port}",
          {
            tls: after.webServiceEnableTls === true,
            port: after.webServiceTlsPort ?? null,
          },
        );
        return {
          dataHandles: [
            await context.writeResource(
              "settings",
              "settings",
              extractSettings(after, new Date().toISOString()),
            ),
          ],
        };
      },
    },

    // ----- zones (state) ---------------------------------------------------
    zone_enable: {
      description: "Enable a disabled zone.",
      arguments: z.object({ zone: z.string() }),
      execute: async (args: { zone: string }, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/zones/enable", {
          zone: args.zone,
        });
        context.logger.info("Enabled zone {zone}", { zone: args.zone });
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              `zone-enable-${slug(args.zone)}`,
              opResult("zone_enable", true, args.zone),
            ),
          ],
        };
      },
    },

    zone_disable: {
      description:
        "Disable a zone without deleting it. The server stops answering " +
        "authoritatively for it — on a primary that is an outage for every " +
        "name it holds, so prefer it as a deliberate maintenance act.",
      arguments: z.object({ zone: z.string() }),
      execute: async (args: { zone: string }, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/zones/disable", {
          zone: args.zone,
        });
        context.logger.info("Disabled zone {zone}", { zone: args.zone });
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              `zone-disable-${slug(args.zone)}`,
              opResult("zone_disable", true, args.zone),
            ),
          ],
        };
      },
    },

    record_add: {
      description:
        "Add a record, failing if one already exists. Prefer record_ensure " +
        "for anything re-runnable — this is correct only when you KNOW the " +
        "record is absent and want a hard failure if it is not. Kept because " +
        "that is occasionally exactly what you want.",
      arguments: z.object({
        zone: z.string().optional(),
        domain: z.string(),
        type: z.string(),
        ttl: z.number().int().optional(),
        rData: z.record(z.string(), z.unknown()),
      }),
      execute: async (
        args: {
          zone?: string;
          domain: string;
          type: string;
          ttl?: number;
          rData: Record<string, unknown>;
        },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const type = args.type.toUpperCase();
        const params: Params = { domain: args.domain, type };
        if (args.zone) params.zone = args.zone;
        if (args.ttl !== undefined) params.ttl = args.ttl;
        Object.assign(params, toWriteParams(type, args.rData));
        await apiCall(g, "POST", "/zones/records/add", params);
        const zone = args.zone ?? args.domain;
        return {
          dataHandles: [
            await context.writeResource(
              "zoneRecord",
              recordInstanceName(zone, args.domain, type, args.rData),
              {
                zone,
                name: args.domain,
                type,
                ttl: args.ttl,
                rData: toReadShape(type, args.rData),
                action: "created",
                observedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },

    // ----- blocking --------------------------------------------------------
    blocking_get_settings: {
      description:
        "Read the blocking-relevant settings: enable state, any temporary " +
        "disable expiry, and the configured block/allow list URLs.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        const r = await apiCall(context.globalArgs, "GET", "/settings/get", {});
        const s = extractSettings(r, new Date().toISOString());
        context.logger.info("Blocking enabled={enableBlocking}", s);
        return {
          dataHandles: [await context.writeResource("settings", "settings", s)],
        };
      },
    },

    blocking_set_state: {
      description: "Turn blocking on or off.",
      arguments: z.object({ enable: z.boolean() }),
      execute: async (args: { enable: boolean }, context: Ctx) => {
        const r = await apiCall(context.globalArgs, "POST", "/settings/set", {
          enableBlocking: args.enable,
        });
        context.logger.info("Blocking set to {enable}", {
          enable: args.enable,
        });
        return {
          dataHandles: [
            await context.writeResource(
              "settings",
              "settings",
              extractSettings(r, new Date().toISOString()),
            ),
          ],
        };
      },
    },

    blocking_temporary_disable: {
      description:
        "Disable blocking for N minutes, after which the server re-enables it " +
        "itself. Safer than blocking_set_state(false) for a debugging window, " +
        "because forgetting to turn it back on is not an option.",
      arguments: z.object({
        minutes: z.number().int().positive().describe(
          "Minutes to disable blocking, e.g. 5, 15, 30, 60, 1440.",
        ),
      }),
      execute: async (args: { minutes: number }, context: Ctx) => {
        const r = await apiCall(
          context.globalArgs,
          "GET",
          "/settings/temporaryDisableBlocking",
          { minutes: args.minutes },
        );
        const till = asString(pick(r, "temporaryDisableBlockingTill"));
        context.logger.info("Blocking disabled for {minutes}m (until {till})", {
          minutes: args.minutes,
          till: till ?? "unknown",
        });
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              "blocking-temporary-disable",
              opResult(
                "blocking_temporary_disable",
                true,
                `${args.minutes}m`,
                till ? `disabled until ${till}` : undefined,
              ),
            ),
          ],
        };
      },
    },

    blocking_set_lists: {
      description:
        "Replace the block and/or allow list URLs. Whichever array you pass " +
        "REPLACES that list wholesale — pass the complete set, not additions.",
      arguments: z.object({
        blockListUrls: z.array(z.string()).optional(),
        allowListUrls: z.array(z.string()).optional(),
      }),
      execute: async (
        args: { blockListUrls?: string[]; allowListUrls?: string[] },
        context: Ctx,
      ) => {
        if (!args.blockListUrls && !args.allowListUrls) {
          throw new Error(
            "blocking_set_lists called with neither blockListUrls nor allowListUrls",
          );
        }
        const params: Params = {};
        const overlong: string[] = [];
        if (args.blockListUrls) {
          const { joined, tooLong } = joinListUrls(args.blockListUrls);
          params.blockListUrls = joined;
          overlong.push(...tooLong);
        }
        if (args.allowListUrls) {
          const { joined, tooLong } = joinListUrls(args.allowListUrls);
          params.allowListUrls = joined;
          overlong.push(...tooLong);
        }
        if (overlong.length > 0) {
          throw new Error(
            `list URL(s) exceed 255 characters and Technitium handles them ` +
              `unreliably: ${overlong.join(", ")}`,
          );
        }
        const r = await apiCall(
          context.globalArgs,
          "POST",
          "/settings/set",
          params,
        );
        context.logger.info("Updated block/allow list URLs");
        return {
          dataHandles: [
            await context.writeResource(
              "settings",
              "settings",
              extractSettings(r, new Date().toISOString()),
            ),
          ],
        };
      },
    },

    blocking_force_update_lists: {
      description:
        "Force an immediate re-download of the block lists rather than " +
        "waiting for the update interval.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        await apiCall(
          context.globalArgs,
          "POST",
          "/settings/forceUpdateBlockLists",
          {},
        );
        context.logger.info("Forced block list update");
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              "blocking-force-update",
              opResult("blocking_force_update_lists", true),
            ),
          ],
        };
      },
    },

    dnssec_validation_set: {
      description:
        "Enable or disable DNSSEC validation of upstream answers. Note this " +
        "is the RESOLVER side — it does not affect signing of zones this " +
        "server is authoritative for.",
      arguments: z.object({ enable: z.boolean() }),
      execute: async (args: { enable: boolean }, context: Ctx) => {
        const r = await apiCall(context.globalArgs, "POST", "/settings/set", {
          dnssecValidation: args.enable,
        });
        context.logger.info("DNSSEC validation set to {enable}", {
          enable: args.enable,
        });
        return {
          dataHandles: [
            await context.writeResource(
              "settings",
              "settings",
              extractSettings(r, new Date().toISOString()),
            ),
          ],
        };
      },
    },

    // ----- allowed / blocked lists -----------------------------------------
    allowed_add: {
      description: "Add a domain to the allowed list.",
      arguments: z.object({ domain: z.string() }),
      execute: async (args: { domain: string }, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/allowed/add", {
          domain: args.domain,
        });
        return {
          dataHandles: [
            await context.writeResource(
              "listEntry",
              `allowed-${slug(args.domain)}`,
              {
                list: "allowed",
                domain: args.domain,
                action: "added",
                observedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },

    allowed_delete: {
      description: "Remove a domain from the allowed list.",
      arguments: z.object({ domain: z.string() }),
      execute: async (args: { domain: string }, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/allowed/delete", {
          domain: args.domain,
        });
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              `allowed-delete-${slug(args.domain)}`,
              opResult("allowed_delete", true, args.domain),
            ),
          ],
        };
      },
    },

    allowed_list: {
      description:
        "List the allowed-list entries, optionally under a sub-tree.",
      arguments: z.object({
        domain: z.string().optional().describe(
          "Sub-tree to list; root if omitted",
        ),
      }),
      execute: async (args: { domain?: string }, context: Ctx) => {
        const params: Params = {};
        if (args.domain) params.domain = args.domain;
        const r = await apiCall(
          context.globalArgs,
          "GET",
          "/allowed/list",
          params,
        );
        const observedAt = new Date().toISOString();
        const handles = [];
        for (const d of namesFrom(r, "zones", "records")) {
          handles.push(
            await context.writeResource("listEntry", `allowed-${slug(d)}`, {
              list: "allowed",
              domain: d,
              action: "observed",
              observedAt,
            }),
          );
        }
        context.logger.info("Allowed list: {count} entries", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    allowed_flush: {
      description: "Empty the allowed list entirely. Destructive.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/allowed/flush", {});
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              "allowed-flush",
              opResult("allowed_flush", true),
            ),
          ],
        };
      },
    },

    blocked_add: {
      description: "Add a domain to the blocked list.",
      arguments: z.object({ domain: z.string() }),
      execute: async (args: { domain: string }, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/blocked/add", {
          domain: args.domain,
        });
        return {
          dataHandles: [
            await context.writeResource(
              "listEntry",
              `blocked-${slug(args.domain)}`,
              {
                list: "blocked",
                domain: args.domain,
                action: "added",
                observedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },

    blocked_delete: {
      description: "Remove a domain from the blocked list.",
      arguments: z.object({ domain: z.string() }),
      execute: async (args: { domain: string }, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/blocked/delete", {
          domain: args.domain,
        });
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              `blocked-delete-${slug(args.domain)}`,
              opResult("blocked_delete", true, args.domain),
            ),
          ],
        };
      },
    },

    blocked_list: {
      description:
        "List the blocked-list entries, optionally under a sub-tree.",
      arguments: z.object({
        domain: z.string().optional().describe(
          "Sub-tree to list; root if omitted",
        ),
      }),
      execute: async (args: { domain?: string }, context: Ctx) => {
        const params: Params = {};
        if (args.domain) params.domain = args.domain;
        const r = await apiCall(
          context.globalArgs,
          "GET",
          "/blocked/list",
          params,
        );
        const observedAt = new Date().toISOString();
        const handles = [];
        for (const d of namesFrom(r, "zones", "records")) {
          handles.push(
            await context.writeResource("listEntry", `blocked-${slug(d)}`, {
              list: "blocked",
              domain: d,
              action: "observed",
              observedAt,
            }),
          );
        }
        context.logger.info("Blocked list: {count} entries", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    blocked_flush: {
      description: "Empty the blocked list entirely. Destructive.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/blocked/flush", {});
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              "blocked-flush",
              opResult("blocked_flush", true),
            ),
          ],
        };
      },
    },

    // ----- diagnostics -----------------------------------------------------
    client_resolve: {
      description:
        "Resolve a name through the server's own DNS client — the honest way " +
        "to ask what THIS server thinks, as opposed to what your workstation " +
        "resolver happens to answer.",
      arguments: z.object({
        domain: z.string(),
        type: z.string().default("A"),
        server: z.string().default("this-server").describe(
          "this-server | recursive-resolver | system-dns | <ip or hostname>",
        ),
        protocol: z.enum(["Udp", "Tcp", "Tls", "Https", "Quic"]).default("Udp"),
        dnssecValidation: z.boolean().optional(),
      }),
      execute: async (
        args: {
          domain: string;
          type: string;
          server: string;
          protocol: string;
          dnssecValidation?: boolean;
        },
        context: Ctx,
      ) => {
        const params: Params = {
          server: args.server,
          domain: args.domain,
          type: args.type,
          protocol: args.protocol,
        };
        if (args.dnssecValidation !== undefined) {
          params.dnssecValidation = args.dnssecValidation;
        }
        const r = await apiCall(
          context.globalArgs,
          "GET",
          "/dnsClient/resolve",
          params,
        );
        // The parsed datagram (RCODE, Answer, …) is nested under `result`.
        const result = (pick(r, "result") as Json | undefined) ?? r;
        const rcode = asString(pick(result, "RCODE", "rcode"));
        context.logger.info("Resolved {domain} {type}: {rcode}", {
          domain: args.domain,
          type: args.type,
          rcode: rcode ?? "unknown",
        });
        return {
          dataHandles: [
            await context.writeResource(
              "dnsResponse",
              `resolve-${slug(args.domain)}-${args.type}`,
              {
                server: args.server,
                domain: args.domain,
                type: args.type,
                protocol: args.protocol,
                rcode,
                answer: pick(result, "Answer", "answer") as
                  | unknown[]
                  | undefined,
                observedAt: new Date().toISOString(),
              },
            ),
          ],
        };
      },
    },

    logs_query: {
      description:
        "Query the query-log app. Depends on a logging app being installed — " +
        "the defaults match the standard Sqlite query log, and a server " +
        "without it will report the app as missing rather than return rows.",
      arguments: z.object({
        appName: z.string().default("Query Logs (Sqlite)"),
        classPath: z.string().default("QueryLogsSqlite.App"),
        pageNumber: z.number().int().optional(),
        entriesPerPage: z.number().int().optional(),
        descendingOrder: z.boolean().optional(),
        start: z.string().optional().describe("ISO 8601 start time"),
        end: z.string().optional().describe("ISO 8601 end time"),
        clientIpAddress: z.string().optional(),
        protocol: z.string().optional(),
        responseType: z.string().optional(),
        qname: z.string().optional(),
        qtype: z.string().optional(),
        qclass: z.string().optional(),
      }),
      execute: async (args: Record<string, unknown>, context: Ctx) => {
        const params: Params = {
          name: String(args.appName),
          classPath: String(args.classPath),
        };
        for (
          const k of [
            "pageNumber",
            "entriesPerPage",
            "descendingOrder",
            "start",
            "end",
            "clientIpAddress",
            "protocol",
            "responseType",
            "qname",
            "qtype",
            "qclass",
          ]
        ) {
          const v = args[k];
          if (v !== undefined && v !== null) {
            params[k] = v as string | number | boolean;
          }
        }
        const r = await apiCall(
          context.globalArgs,
          "GET",
          "/logs/query",
          params,
        );
        const observedAt = new Date().toISOString();
        const handles = [];
        let i = 0;
        for (const e of coerceArray(r, "entries")) {
          handles.push(
            await context.writeResource("queryLog", `log-${i++}`, {
              rowNumber: asNumber(pick(e, "rowNumber")),
              timestamp: asString(pick(e, "timestamp")),
              clientIpAddress: asString(pick(e, "clientIpAddress")),
              protocol: asString(pick(e, "protocol")),
              responseType: asString(pick(e, "responseType")),
              rcode: asString(pick(e, "rcode", "responseCode")),
              qname: asString(pick(e, "qname")),
              qtype: asString(pick(e, "qtype")),
              qclass: asString(pick(e, "qclass")),
              answer: asString(pick(e, "answer")),
              observedAt,
            }),
          );
        }
        context.logger.info("Query log: {count} row(s)", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    dashboard_stats: {
      description: "Dashboard counters and top-N lists for a time range.",
      arguments: z.object({
        type: StatsRange.default("LastHour"),
        start: z.string().optional().describe(
          "ISO 8601 start (when type=Custom)",
        ),
        end: z.string().optional().describe("ISO 8601 end (when type=Custom)"),
      }),
      execute: async (
        args: { type: string; start?: string; end?: string },
        context: Ctx,
      ) => {
        const params: Params = { type: args.type, utc: true };
        if (args.start) params.start = args.start;
        if (args.end) params.end = args.end;
        const r = await apiCall(
          context.globalArgs,
          "GET",
          "/dashboard/stats/get",
          params,
        );
        const s = (pick(r, "stats") as Json | undefined) ?? {};
        const summary: z.infer<typeof StatsSchema> = {
          range: args.type,
          totalQueries: asNumber(pick(s, "totalQueries")),
          totalNoError: asNumber(pick(s, "totalNoError")),
          totalServerFailure: asNumber(pick(s, "totalServerFailure")),
          totalNxDomain: asNumber(pick(s, "totalNxDomain")),
          totalRefused: asNumber(pick(s, "totalRefused")),
          totalBlocked: asNumber(pick(s, "totalBlocked")),
          totalCached: asNumber(pick(s, "totalCached")),
          totalClients: asNumber(pick(s, "totalClients")),
          topDomains: pick(r, "topDomains"),
          topBlockedDomains: pick(r, "topBlockedDomains"),
          topClients: pick(r, "topClients"),
          observedAt: new Date().toISOString(),
        };
        context.logger.info("Stats {range}: {totalQueries} queries", summary);
        return {
          dataHandles: [
            await context.writeResource("stats", `stats-${args.type}`, summary),
          ],
        };
      },
    },

    // ----- cache -----------------------------------------------------------
    cache_flush: {
      description:
        "Flush the entire resolver cache. Harmless but not free — the server " +
        "re-resolves everything from cold afterwards.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/cache/flush", {});
        context.logger.info("Cache flushed");
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              "cache-flush",
              opResult("cache_flush", true),
            ),
          ],
        };
      },
    },

    cache_list: {
      description:
        "List cached zones and records, optionally under a sub-tree.",
      arguments: z.object({
        domain: z.string().optional().describe(
          "Sub-tree to list; root if omitted",
        ),
      }),
      execute: async (args: { domain?: string }, context: Ctx) => {
        const params: Params = {};
        if (args.domain) params.domain = args.domain;
        const r = await apiCall(
          context.globalArgs,
          "GET",
          "/cache/list",
          params,
        );
        const observedAt = new Date().toISOString();
        const handles = [];
        for (const n of namesFrom(r, "zones")) {
          handles.push(
            await context.writeResource("cacheEntry", `cache-zone-${slug(n)}`, {
              name: n,
              kind: "zone",
              action: "observed",
              observedAt,
            }),
          );
        }
        for (const n of namesFrom(r, "records")) {
          handles.push(
            await context.writeResource("cacheEntry", `cache-rec-${slug(n)}`, {
              name: n,
              kind: "record",
              action: "observed",
              observedAt,
            }),
          );
        }
        context.logger.info("Cache: {count} entr(ies)", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    cache_delete: {
      description: "Drop one name from the cache, leaving the rest intact.",
      arguments: z.object({ domain: z.string() }),
      execute: async (args: { domain: string }, context: Ctx) => {
        await apiCall(context.globalArgs, "POST", "/cache/delete", {
          domain: args.domain,
        });
        return {
          dataHandles: [
            await context.writeResource(
              "operationResult",
              `cache-delete-${slug(args.domain)}`,
              opResult("cache_delete", true, args.domain),
            ),
          ],
        };
      },
    },

    // ----- cluster ---------------------------------------------------------
    cluster_state: {
      description:
        "Report cluster membership as THIS node sees it. Read-only. Call it " +
        "on both nodes after any membership change: the two sides can " +
        "disagree, and a secondary reporting the primary Connected does not " +
        "mean the primary believes it is in a cluster at all.",
      arguments: z.object({
        node: z.string().optional(),
        includeServerIpAddresses: z.boolean().optional(),
      }),
      execute: async (
        args: { node?: string; includeServerIpAddresses?: boolean },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        const params: Params = {};
        if (args.node) params.node = args.node;
        if (args.includeServerIpAddresses) {
          params.includeServerIpAddresses = true;
        }
        const summary = summariseCluster(
          await apiCall(g, "GET", "/admin/cluster/state", params),
        );
        context.logger.info(
          "Cluster: initialized={clusterInitialized} nodes={nodeCount} unreachable={unreachable}",
          summary,
        );
        return {
          dataHandles: [
            await context.writeResource(
              "clusterState",
              "cluster-state",
              summary,
            ),
          ],
        };
      },
    },

    cluster_init: {
      description:
        "Initialize a NEW cluster with this node as Primary. MINTS A FRESH " +
        "SHARED SECRET and cannot adopt an existing one — the API takes no " +
        "parameter for it — so every secondary still holding the old secret " +
        "is orphaned and must be re-attached with cluster_join. Run it only " +
        "when prepared to rejoin every secondary.",
      arguments: z.object({
        clusterDomain: z.string(),
        primaryNodeIpAddresses: z.string().describe(
          "Comma-separated addresses secondaries will reach this primary on.",
        ),
      }),
      execute: async (
        args: { clusterDomain: string; primaryNodeIpAddresses: string },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        await apiCall(g, "GET", "/admin/cluster/init", {
          clusterDomain: args.clusterDomain,
          primaryNodeIpAddresses: args.primaryNodeIpAddresses,
        });
        const summary = summariseCluster(
          await apiCall(g, "GET", "/admin/cluster/state", {}),
        );
        if (!summary.clusterInitialized) {
          throw new Error(
            "cluster_init returned success but the node still reports " +
              "clusterInitialized=false",
          );
        }
        context.logger.info("Cluster initialized: {clusterDomain}", summary);
        return {
          dataHandles: [
            await context.writeResource(
              "clusterState",
              "cluster-state",
              summary,
            ),
          ],
        };
      },
    },

    cluster_join: {
      description:
        "Join this node to an existing cluster as a Secondary, authenticating " +
        "against the PRIMARY. Overwrites any cluster config this node already " +
        "carries, which is what makes it right after a restore has laid down " +
        "a stale secret.",
      arguments: z.object({
        primaryNodeIpAddress: z.string(),
        primaryNodeUrl: z.string().describe(
          "MUST carry the primary's DOMAIN NAME, e.g. " +
            "https://ns1.dns-cluster.example.com:53443/ — Technitium " +
            "rejects an IP: 'the Primary Node URL must use the domain name of " +
            "the Primary node and not its IP address.' That is correct, not " +
            "fussy: the node presents a certificate for its cluster name, " +
            "which an IP URL could never match. Required rather than derived " +
            "from primaryNodeIpAddress, because deriving it is always wrong.",
        ),
        primaryNodeUsername: z.string().describe(
          "An Administrator ON THE PRIMARY — a username and password, not an " +
            "API token. Joining is an authenticated act against the cluster " +
            "being joined.",
        ),
        primaryNodePassword: z.string().meta({ sensitive: true }).describe(
          "Password for primaryNodeUsername, on the primary node.",
        ),
        secondaryNodeIpAddresses: z.string().optional(),
        primaryNodeTotp: z.string().optional(),
        ignoreCertificateErrors: z.boolean().optional().describe(
          "Technitium clusters commonly run self-signed certificates pinned " +
            "by TLSA rather than signed by a CA, and the join path does not " +
            "appear to consult DANE — so strict validation rejects a " +
            "certificate that is nonetheless the correct pinned one.",
        ),
      }),
      execute: async (
        args: {
          primaryNodeIpAddress: string;
          primaryNodeUrl: string;
          primaryNodeUsername: string;
          primaryNodePassword: string;
          secondaryNodeIpAddresses?: string;
          primaryNodeTotp?: string;
          ignoreCertificateErrors?: boolean;
        },
        context: Ctx,
      ) => {
        const g: GlobalArgsT = context.globalArgs;
        await apiCall(g, "POST", "/admin/cluster/initJoin", {
          primaryNodeIpAddress: args.primaryNodeIpAddress,
          primaryNodeUrl: args.primaryNodeUrl,
          primaryNodeUsername: args.primaryNodeUsername,
          primaryNodePassword: args.primaryNodePassword,
          primaryNodeTotp: args.primaryNodeTotp ?? "",
          ignoreCertificateErrors: args.ignoreCertificateErrors ?? false,
          secondaryNodeIpAddresses: args.secondaryNodeIpAddresses ?? "",
        });
        const summary = summariseCluster(
          await apiCall(g, "GET", "/admin/cluster/state", {}),
        );
        if (!summary.clusterInitialized) {
          throw new Error(
            "cluster_join returned success but the node still reports " +
              "clusterInitialized=false",
          );
        }
        context.logger.info(
          "Joined cluster {clusterDomain}: nodes={nodeCount} unreachable={unreachable}",
          summary,
        );
        return {
          dataHandles: [
            await context.writeResource(
              "clusterState",
              "cluster-state",
              summary,
            ),
          ],
        };
      },
    },
  },
};
