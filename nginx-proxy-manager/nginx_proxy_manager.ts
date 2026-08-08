/**
 * `@jamesakeech/nginx-proxy-manager` — full lifecycle management of one Nginx
 * Proxy Manager instance.
 *
 * One model instance represents one NPM installation. That grouping is forced
 * by the API rather than chosen: authentication is instance-wide, and NPM's
 * objects reference each other by numeric id — a proxy host names its
 * certificate and access list by id — so a model that owned a single host
 * could not resolve its own dependencies.
 *
 * `sync` reads the instance and fans out one resource per object, so a single
 * host, stream or certificate is addressable from CEL without post-processing
 * a list. The mutating methods are shaped around the fact that NPM has no
 * declarative surface: `apply*` matches an existing object by a natural key
 * (domain set, listening port, access list name) and updates it in place,
 * falling back to creation, which makes re-running a workflow converge instead
 * of accumulating duplicates.
 *
 * `delete` and `setEnabled` dispatch on a `kind` argument and take a list of
 * ids, so one call covers a batch across any object type — a fan-out that
 * takes the model lock once, rather than a method per kind and a run per id.
 *
 * @module
 */
import { z } from "npm:zod@4";

import { buildChange, type ChangeResult } from "./_lib/npm/change.ts";
import { fetchVersion, NpmClient, NpmError } from "./_lib/npm/client.ts";
import {
  accessListBody,
  certificateBody,
  deadHostBody,
  findByDomains,
  instanceNameFor,
  KIND_PATHS,
  type Provenance,
  proxyHostBody,
  redirectionHostBody,
  sameDomainSet,
  streamBody,
  toAccessList,
  toCertificate,
  toDeadHost,
  toProxyHost,
  toRedirectionHost,
  toStream,
} from "./_lib/npm/map.ts";
import {
  AccessListSchema,
  ApplyAccessListArgsSchema,
  ApplyDeadHostArgsSchema,
  ApplyProxyHostArgsSchema,
  ApplyRedirectionHostArgsSchema,
  ApplyStreamArgsSchema,
  CertificateSchema,
  ChangeSchema,
  DeadHostSchema,
  DeleteArgsSchema,
  type GlobalArgs,
  GlobalArgsSchema,
  InstanceSchema,
  type ObjectKind,
  ProxyHostSchema,
  RedirectionHostSchema,
  RenewCertificateArgsSchema,
  RequestCertificateArgsSchema,
  SetEnabledArgsSchema,
  StreamSchema,
  SyncArgsSchema,
  UploadCertificateArgsSchema,
} from "./_lib/npm/schemas.ts";

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
  deleteResource: (instanceName: string) => Promise<void>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

interface MethodResult {
  dataHandles: DataHandle[];
}

/** Checks get global args only — they must not produce data. */
interface CheckContext {
  globalArgs: GlobalArgs;
}

interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/** A JSON object as returned by the NPM API. */
type Raw = Record<string, unknown>;

// --- Shared helpers ---------------------------------------------------------

/** Open an authenticated session for one method execution. */
async function connect(globalArgs: GlobalArgs): Promise<NpmClient> {
  const client = new NpmClient(globalArgs);
  await client.login();
  return client;
}

/** Provenance stamped onto every resource written by a run. */
function provenance(globalArgs: GlobalArgs, at: string): Provenance {
  return {
    instanceLabel: globalArgs.instanceLabel,
    baseUrl: globalArgs.baseUrl.replace(/\/+$/, ""),
    fetchedAt: at,
  };
}

function recordId(raw: unknown): number {
  const id = (raw as Raw | null)?.id;
  return typeof id === "number" && Number.isFinite(id) ? id : 0;
}

/** Read direction, keyed by kind — used when writing back a single object. */
const MAPPERS: Record<
  ObjectKind,
  (raw: Raw, p: Provenance, now: number) => Record<string, unknown>
> = {
  proxyHost: (raw, p) => toProxyHost(raw, p),
  redirectionHost: (raw, p) => toRedirectionHost(raw, p),
  deadHost: (raw, p) => toDeadHost(raw, p),
  stream: (raw, p) => toStream(raw, p),
  accessList: (raw, p) => toAccessList(raw, p),
  certificate: (raw, p, now) => toCertificate(raw, p, now),
};

/**
 * Access lists hide their users and address rules unless asked for them.
 * Everything else returns complete records, so only this kind needs a query.
 */
function expandFor(kind: ObjectKind): string {
  return kind === "accessList" ? "?expand=items,clients" : "";
}

/**
 * Re-read one object and write it as a resource.
 *
 * Every `apply*` ends this way so the caller can reference the result — most
 * usefully a freshly created object's id — without a follow-up `sync`. A
 * failure here is logged rather than thrown: the mutation already succeeded,
 * and turning a bookkeeping miss into a method failure would invite a retry
 * that reapplies a change already made.
 */
async function writeObject(
  client: NpmClient,
  ctx: MethodContext,
  kind: ObjectKind,
  id: number,
  p: Provenance,
): Promise<DataHandle | null> {
  if (id <= 0) return null;
  const outcome = await client.call(
    "GET",
    `${KIND_PATHS[kind]}/${id}${expandFor(kind)}`,
  );
  if (
    !outcome.ok || outcome.body === null || typeof outcome.body !== "object"
  ) {
    ctx.logger.warning(
      "{kind} {id} was applied but could not be read back — {reason}",
      { kind, id, reason: outcome.message || "unexpected response body" },
    );
    return null;
  }
  const mapped = MAPPERS[kind](outcome.body as Raw, p, Date.parse(p.fetchedAt));
  return await ctx.writeResource(kind, instanceNameFor(kind, id), mapped);
}

/**
 * Write the change resource under this method's stable instance name.
 *
 * The name is per method rather than per object so the latest outcome is
 * addressable from CEL without the caller knowing an id in advance; earlier
 * runs stay reachable as versions.
 */
function writeChange(
  ctx: MethodContext,
  method: string,
  performedAt: string,
  results: ChangeResult[],
): Promise<DataHandle> {
  return ctx.writeResource(
    "change",
    `change-${method}`,
    buildChange(
      method,
      ctx.globalArgs.instanceLabel,
      ctx.globalArgs.baseUrl.replace(/\/+$/, ""),
      performedAt,
      results,
    ),
  );
}

/**
 * Create or update one object, matching an existing one when no id is given.
 *
 * The two-step shape — list, match, then PUT or POST — is what NPM's API
 * forces: it has no upsert endpoint and no way to address an object by its
 * natural key.
 */
async function upsert(
  client: NpmClient,
  kind: ObjectKind,
  explicitId: number | undefined,
  match: (records: Raw[]) => Raw | null,
  body: Raw,
): Promise<{ id: number; action: "created" | "updated"; record: Raw | null }> {
  const path = KIND_PATHS[kind];
  let targetId = explicitId;
  if (targetId === undefined) {
    const listed = await client.request<Raw[]>(
      "GET",
      `${path}${expandFor(kind)}`,
    );
    const found = match(Array.isArray(listed) ? listed : []);
    if (found !== null) targetId = recordId(found);
  }

  if (targetId !== undefined && targetId > 0) {
    const updated = await client.request<Raw>(
      "PUT",
      `${path}/${targetId}`,
      body,
    );
    return {
      id: recordId(updated) || targetId,
      action: "updated",
      record: updated ?? null,
    };
  }
  const created = await client.request<Raw>("POST", path, body);
  const id = recordId(created);
  if (id === 0) {
    throw new NpmError(
      `${kind} was created but NPM returned no id — cannot record the result`,
      201,
      path,
    );
  }
  return { id, action: "created", record: created ?? null };
}

/**
 * Bring a host's enabled state in line with what was asked for.
 *
 * NPM ignores `enabled` on the object body and only honours the dedicated
 * endpoints, so this runs as a second call — and only when the state actually
 * differs, to keep a converged re-apply free of pointless writes.
 */
async function reconcileEnabled(
  client: NpmClient,
  ctx: MethodContext,
  kind: ObjectKind,
  id: number,
  desired: boolean,
  current: unknown,
): Promise<void> {
  const isEnabled = current === true || current === 1;
  if (isEnabled === desired) return;
  const verb = desired ? "enable" : "disable";
  const outcome = await client.call(
    "POST",
    `${KIND_PATHS[kind]}/${id}/${verb}`,
  );
  if (!outcome.ok) {
    ctx.logger.warning(
      "{kind} {id} was applied but could not be {verb}d — {reason}",
      { kind, id, verb, reason: outcome.message },
    );
  }
}

/** List one collection, degrading to an empty list with a warning. */
async function listKind(
  client: NpmClient,
  ctx: MethodContext,
  kind: ObjectKind,
): Promise<Raw[]> {
  const outcome = await client.call(
    "GET",
    `${KIND_PATHS[kind]}${expandFor(kind)}`,
  );
  if (!outcome.ok) {
    // NPM's object set has grown across 2.x. Treating a missing collection as
    // empty keeps a sync useful on an older build instead of failing whole,
    // but it must say so — silently reporting "no streams" would be a lie.
    ctx.logger.warning(
      "could not list {kind} — reporting none. {reason}",
      { kind, reason: outcome.message },
    );
    return [];
  }
  return Array.isArray(outcome.body) ? outcome.body as Raw[] : [];
}

// --- Model ------------------------------------------------------------------

/** Model definition for a single Nginx Proxy Manager instance. */
export const model = {
  type: "@jamesakeech/nginx-proxy-manager",
  version: "2026.08.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    instance: {
      description:
        "Instance-wide rollup: version, object counts, certificate expiry " +
        "pressure, and domains claimed by more than one host.",
      schema: InstanceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    proxyHost: {
      description:
        "One proxy host: its domains, upstream, TLS and access-list " +
        "bindings, custom locations, and raw advanced config.",
      schema: ProxyHostSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    redirectionHost: {
      description:
        "One redirection host: the domains redirected, where to, and with " +
        "which HTTP status.",
      schema: RedirectionHostSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    deadHost: {
      description:
        "One dead (404) host: domains parked so they answer without being " +
        "proxied anywhere.",
      schema: DeadHostSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    stream: {
      description:
        "One TCP/UDP stream: the listening port and where it forwards to.",
      schema: StreamSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    accessList: {
      description:
        "One access list: its address rules and basic-auth usernames, plus " +
        "how many proxy hosts depend on it.",
      schema: AccessListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    certificate: {
      description:
        "One certificate: provider, covered domains, and days until expiry.",
      schema: CertificateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    change: {
      description:
        "Outcome of the most recent run of one mutating method: what was " +
        "created, updated, deleted or toggled, and what failed.",
      schema: ChangeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  checks: {
    "instance-reachable": {
      description:
        "The NPM admin API answers and the configured credentials are " +
        "accepted — separates an unreachable host from a wrong password " +
        "before a change is attempted.",
      labels: ["live"],
      appliesTo: [
        "applyProxyHost",
        "applyRedirectionHost",
        "applyDeadHost",
        "applyStream",
        "applyAccessList",
        "requestCertificate",
        "uploadCertificate",
        "renewCertificate",
        "setEnabled",
        "delete",
      ],
      execute: async (context: CheckContext): Promise<CheckResult> => {
        try {
          await connect(context.globalArgs);
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [err instanceof Error ? err.message : String(err)],
          };
        }
      },
    },
  },
  methods: {
    sync: {
      description:
        "Read the whole instance and write one resource per proxy host, " +
        "redirection host, dead host, stream, access list and certificate, " +
        "plus an instance rollup. Run this before any method that takes an id.",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const fetchedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, fetchedAt);
        const now = Date.parse(fetchedAt);
        ctx.logger.info("reading {label} at {url}", {
          label: ctx.globalArgs.instanceLabel,
          url: p.baseUrl,
        });

        const [
          version,
          proxyRaw,
          redirectRaw,
          deadRaw,
          streamRaw,
          accessRaw,
          certRaw,
        ] = await Promise.all([
          fetchVersion(client),
          listKind(client, ctx, "proxyHost"),
          listKind(client, ctx, "redirectionHost"),
          listKind(client, ctx, "deadHost"),
          listKind(client, ctx, "stream"),
          listKind(client, ctx, "accessList"),
          listKind(client, ctx, "certificate"),
        ]);

        const proxyHosts = proxyRaw.map((r) => toProxyHost(r, p));
        const redirectionHosts = redirectRaw.map((r) =>
          toRedirectionHost(r, p)
        );
        const deadHosts = deadRaw.map((r) => toDeadHost(r, p));
        const streams = streamRaw.map((r) => toStream(r, p));
        const accessLists = accessRaw.map((r) => toAccessList(r, p));
        const certificates = certRaw.map((r) => toCertificate(r, p, now));

        const handles: DataHandle[] = [];
        const writeAll = async (
          spec: ObjectKind,
          records: Array<Record<string, unknown>>,
        ) => {
          for (const record of records) {
            if (!args.includeDisabled && record.enabled === false) continue;
            handles.push(
              await ctx.writeResource(
                spec,
                instanceNameFor(spec, record.id as number),
                record,
              ),
            );
          }
        };
        await writeAll("proxyHost", proxyHosts);
        await writeAll("redirectionHost", redirectionHosts);
        await writeAll("deadHost", deadHosts);
        await writeAll("stream", streams);
        await writeAll("accessList", accessLists);
        await writeAll("certificate", certificates);

        // A domain on two hosts is served by whichever config nginx loads
        // first — surfacing it is the whole point of reading the instance as
        // a set rather than a pile of independent objects.
        const seen = new Map<string, number>();
        for (
          const host of [...proxyHosts, ...redirectionHosts, ...deadHosts]
        ) {
          for (const domain of host.domainNames as string[]) {
            const key = domain.toLowerCase();
            seen.set(key, (seen.get(key) ?? 0) + 1);
          }
        }
        const duplicates = [...seen.entries()]
          .filter(([, count]) => count > 1)
          .map(([domain]) => domain)
          .sort();

        const expired =
          certificates.filter((c) => (c.daysUntilExpiry as number) < 0).length;
        const expiringSoon = certificates.filter((c) => {
          const days = c.daysUntilExpiry as number;
          return days >= 0 && days <= 30;
        }).length;

        const instance = {
          ...p,
          version,
          proxyHostCount: proxyHosts.length,
          proxyHostsEnabled: proxyHosts.filter((h) => h.enabled).length,
          redirectionHostCount: redirectionHosts.length,
          deadHostCount: deadHosts.length,
          streamCount: streams.length,
          accessListCount: accessLists.length,
          certificateCount: certificates.length,
          certificatesExpired: expired,
          certificatesExpiringWithin30d: expiringSoon,
          uniqueDomainCount: seen.size,
          hostsWithoutCertificate:
            proxyHosts.filter((h) =>
              h.enabled === true && h.certificateId === 0
            ).length,
          domainsServedByMultipleHosts: duplicates,
        };
        handles.push(await ctx.writeResource("instance", "instance", instance));

        ctx.logger.info(
          "{label}: {proxy} proxy host(s), {redirect} redirect(s), " +
            "{dead} dead, {stream} stream(s), {cert} certificate(s)",
          {
            label: ctx.globalArgs.instanceLabel,
            proxy: proxyHosts.length,
            redirect: redirectionHosts.length,
            dead: deadHosts.length,
            stream: streams.length,
            cert: certificates.length,
          },
        );
        if (duplicates.length > 0) {
          ctx.logger.warning(
            "{count} domain(s) are claimed by more than one host: {domains}",
            { count: duplicates.length, domains: duplicates.join(", ") },
          );
        }
        if (expired > 0) {
          ctx.logger.warning("{count} certificate(s) have expired", {
            count: expired,
          });
        }

        return { dataHandles: handles };
      },
    },

    applyProxyHost: {
      description:
        "Create or update a proxy host. Without `id`, an existing host with " +
        "exactly the same domain set is updated in place, so re-running is " +
        "idempotent. Writes the resulting host and a change record.",
      arguments: ApplyProxyHostArgsSchema,
      execute: async (
        args: z.infer<typeof ApplyProxyHostArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);

        if (args.sslForced && args.certificateId === 0) {
          throw new Error(
            "sslForced requires a certificate — set certificateId, or run " +
              "requestCertificate for these domains first",
          );
        }

        const { id, action, record } = await upsert(
          client,
          "proxyHost",
          args.id,
          (records) => findByDomains(records, args.domainNames),
          proxyHostBody(args),
        );
        await reconcileEnabled(
          client,
          ctx,
          "proxyHost",
          id,
          args.enabled,
          record?.enabled,
        );

        ctx.logger.info("{action} proxy host {id} for {domains}", {
          action,
          id,
          domains: args.domainNames.join(", "),
        });

        const handles: DataHandle[] = [];
        const objectHandle = await writeObject(client, ctx, "proxyHost", id, p);
        if (objectHandle !== null) handles.push(objectHandle);
        handles.push(
          await writeChange(ctx, "applyProxyHost", performedAt, [{
            kind: "proxyHost",
            id,
            action,
            ok: true,
            httpStatus: action === "created" ? 201 : 200,
            message: "",
          }]),
        );
        return { dataHandles: handles };
      },
    },

    applyRedirectionHost: {
      description:
        "Create or update a redirection host. Without `id`, an existing " +
        "host with exactly the same domain set is updated in place.",
      arguments: ApplyRedirectionHostArgsSchema,
      execute: async (
        args: z.infer<typeof ApplyRedirectionHostArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);

        if (args.sslForced && args.certificateId === 0) {
          throw new Error(
            "sslForced requires a certificate — set certificateId first",
          );
        }

        const { id, action, record } = await upsert(
          client,
          "redirectionHost",
          args.id,
          (records) => findByDomains(records, args.domainNames),
          redirectionHostBody(args),
        );
        await reconcileEnabled(
          client,
          ctx,
          "redirectionHost",
          id,
          args.enabled,
          record?.enabled,
        );

        ctx.logger.info(
          "{action} redirection host {id}: {domains} -> {target}",
          {
            action,
            id,
            domains: args.domainNames.join(", "),
            target: args.forwardDomainName,
          },
        );

        const handles: DataHandle[] = [];
        const objectHandle = await writeObject(
          client,
          ctx,
          "redirectionHost",
          id,
          p,
        );
        if (objectHandle !== null) handles.push(objectHandle);
        handles.push(
          await writeChange(ctx, "applyRedirectionHost", performedAt, [{
            kind: "redirectionHost",
            id,
            action,
            ok: true,
            httpStatus: action === "created" ? 201 : 200,
            message: "",
          }]),
        );
        return { dataHandles: handles };
      },
    },

    applyDeadHost: {
      description:
        "Create or update a dead (404) host. Without `id`, an existing host " +
        "with exactly the same domain set is updated in place.",
      arguments: ApplyDeadHostArgsSchema,
      execute: async (
        args: z.infer<typeof ApplyDeadHostArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);

        if (args.sslForced && args.certificateId === 0) {
          throw new Error(
            "sslForced requires a certificate — set certificateId first",
          );
        }

        const { id, action, record } = await upsert(
          client,
          "deadHost",
          args.id,
          (records) => findByDomains(records, args.domainNames),
          deadHostBody(args),
        );
        await reconcileEnabled(
          client,
          ctx,
          "deadHost",
          id,
          args.enabled,
          record?.enabled,
        );

        ctx.logger.info("{action} dead host {id} for {domains}", {
          action,
          id,
          domains: args.domainNames.join(", "),
        });

        const handles: DataHandle[] = [];
        const objectHandle = await writeObject(client, ctx, "deadHost", id, p);
        if (objectHandle !== null) handles.push(objectHandle);
        handles.push(
          await writeChange(ctx, "applyDeadHost", performedAt, [{
            kind: "deadHost",
            id,
            action,
            ok: true,
            httpStatus: action === "created" ? 201 : 200,
            message: "",
          }]),
        );
        return { dataHandles: handles };
      },
    },

    applyStream: {
      description:
        "Create or update a TCP/UDP stream. Without `id`, an existing " +
        "stream on the same incoming port is updated in place — NPM can " +
        "only bind a port once, which makes the port the natural key.",
      arguments: ApplyStreamArgsSchema,
      execute: async (
        args: z.infer<typeof ApplyStreamArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);

        if (!args.tcpForwarding && !args.udpForwarding) {
          throw new Error(
            "a stream must forward TCP, UDP or both — enable at least one",
          );
        }

        const { id, action, record } = await upsert(
          client,
          "stream",
          args.id,
          (records) =>
            records.find((r) => r.incoming_port === args.incomingPort) ?? null,
          streamBody(args),
        );
        await reconcileEnabled(
          client,
          ctx,
          "stream",
          id,
          args.enabled,
          record?.enabled,
        );

        ctx.logger.info(
          "{action} stream {id}: :{port} -> {host}:{target}",
          {
            action,
            id,
            port: args.incomingPort,
            host: args.forwardingHost,
            target: args.forwardingPort,
          },
        );

        const handles: DataHandle[] = [];
        const objectHandle = await writeObject(client, ctx, "stream", id, p);
        if (objectHandle !== null) handles.push(objectHandle);
        handles.push(
          await writeChange(ctx, "applyStream", performedAt, [{
            kind: "stream",
            id,
            action,
            ok: true,
            httpStatus: action === "created" ? 201 : 200,
            message: "",
          }]),
        );
        return { dataHandles: handles };
      },
    },

    applyAccessList: {
      description:
        "Create or update an access list. Without `id`, an existing list " +
        "with the same name is updated in place. Users and address rules " +
        "are replaced wholesale, not merged — NPM cannot read back stored " +
        "passwords, so every apply must carry the complete set.",
      arguments: ApplyAccessListArgsSchema,
      execute: async (
        args: z.infer<typeof ApplyAccessListArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);

        if (args.items.length === 0 && args.clients.length === 0) {
          throw new Error(
            "an access list with no users and no address rules denies " +
              "everything — add at least one item or client",
          );
        }

        const { id, action } = await upsert(
          client,
          "accessList",
          args.id,
          (records) => records.find((r) => r.name === args.name) ?? null,
          accessListBody(args),
        );

        ctx.logger.info(
          "{action} access list {id} ({name}): {users} user(s), {rules} rule(s)",
          {
            action,
            id,
            name: args.name,
            users: args.items.length,
            rules: args.clients.length,
          },
        );

        const handles: DataHandle[] = [];
        const objectHandle = await writeObject(
          client,
          ctx,
          "accessList",
          id,
          p,
        );
        if (objectHandle !== null) handles.push(objectHandle);
        handles.push(
          await writeChange(ctx, "applyAccessList", performedAt, [{
            kind: "accessList",
            id,
            action,
            ok: true,
            httpStatus: action === "created" ? 201 : 200,
            message: "",
          }]),
        );
        return { dataHandles: handles };
      },
    },

    requestCertificate: {
      description: "Request a Let's Encrypt certificate. Reuses an existing " +
        "certificate covering exactly the same domains unless `force` is " +
        "set, so re-running a workflow does not burn ACME rate limit. " +
        "Wildcards need dnsChallenge with a provider and credentials.",
      arguments: RequestCertificateArgsSchema,
      execute: async (
        args: z.infer<typeof RequestCertificateArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);

        if (args.dnsChallenge && args.dnsProvider === "") {
          throw new Error(
            "dnsChallenge requires dnsProvider — the certbot plugin name, " +
              "e.g. cloudflare",
          );
        }
        if (args.dnsChallenge && args.dnsProviderCredentials === "") {
          throw new Error(
            "dnsChallenge requires dnsProviderCredentials — the contents of " +
              "the certbot credentials file for the provider",
          );
        }
        const wildcards = args.domainNames.filter((d) => d.startsWith("*."));
        if (wildcards.length > 0 && !args.dnsChallenge) {
          throw new Error(
            `wildcard domain(s) ${
              wildcards.join(", ")
            } can only be issued over DNS-01 — set dnsChallenge`,
          );
        }

        const existing = await client.request<Raw[]>(
          "GET",
          KIND_PATHS.certificate,
        );
        const match = (Array.isArray(existing) ? existing : []).find((c) =>
          c.provider === "letsencrypt" &&
          sameDomainSet(
            Array.isArray(c.domain_names) ? c.domain_names as string[] : [],
            args.domainNames,
          )
        );

        let id: number;
        let action: ChangeResult["action"];
        if (match && !args.force) {
          id = recordId(match);
          action = "unchanged";
          ctx.logger.info(
            "certificate {id} already covers {domains} — reusing it",
            { id, domains: args.domainNames.join(", ") },
          );
        } else {
          ctx.logger.info(
            "requesting a Let's Encrypt certificate for {domains} over {method}",
            {
              domains: args.domainNames.join(", "),
              method: args.dnsChallenge ? "DNS-01" : "HTTP-01",
            },
          );
          const created = await client.request<Raw>(
            "POST",
            KIND_PATHS.certificate,
            certificateBody(args),
          );
          id = recordId(created);
          action = "created";
          if (id === 0) {
            throw new NpmError(
              "NPM accepted the certificate request but returned no id",
              201,
              KIND_PATHS.certificate,
            );
          }
        }

        const handles: DataHandle[] = [];
        const objectHandle = await writeObject(
          client,
          ctx,
          "certificate",
          id,
          p,
        );
        if (objectHandle !== null) handles.push(objectHandle);
        handles.push(
          await writeChange(ctx, "requestCertificate", performedAt, [{
            kind: "certificate",
            id,
            action,
            ok: true,
            httpStatus: action === "created" ? 201 : 200,
            message: "",
          }]),
        );
        return { dataHandles: handles };
      },
    },

    uploadCertificate: {
      description:
        "Upload an externally issued certificate from PEM files on the " +
        "machine running swamp. Creates the record then uploads the files; " +
        "NPM derives the covered domains from the certificate itself.",
      arguments: UploadCertificateArgsSchema,
      execute: async (
        args: z.infer<typeof UploadCertificateArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);

        // Read before creating: a typo'd path should fail with a clear file
        // error, not leave an empty certificate record behind in NPM.
        const read = async (path: string, label: string): Promise<string> => {
          try {
            return await Deno.readTextFile(path);
          } catch (err) {
            throw new Error(
              `could not read ${label} at ${path}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        };
        const certificate = await read(args.certificatePath, "certificate");
        const certificateKey = await read(
          args.certificateKeyPath,
          "certificate key",
        );
        const intermediateCertificate = args.intermediateCertificatePath === ""
          ? undefined
          : await read(
            args.intermediateCertificatePath,
            "intermediate certificate",
          );

        const created = await client.request<Raw>(
          "POST",
          KIND_PATHS.certificate,
          { provider: "other", nice_name: args.niceName, meta: {} },
        );
        const id = recordId(created);
        if (id === 0) {
          throw new NpmError(
            "NPM accepted the certificate record but returned no id",
            201,
            KIND_PATHS.certificate,
          );
        }

        const upload = await client.uploadCertificateFiles(id, {
          certificate,
          certificateKey,
          intermediateCertificate,
        });
        if (!upload.ok) {
          // The empty record is useless without its files, and leaving it
          // would make a retry create a second one. Clean up, then report the
          // upload failure rather than the cleanup.
          await client.call("DELETE", `${KIND_PATHS.certificate}/${id}`);
          throw new NpmError(
            `certificate upload rejected, record ${id} removed: ${upload.message}`,
            upload.status,
            `${KIND_PATHS.certificate}/${id}/upload`,
          );
        }

        ctx.logger.info("uploaded certificate {id} ({name})", {
          id,
          name: args.niceName,
        });

        const handles: DataHandle[] = [];
        const objectHandle = await writeObject(
          client,
          ctx,
          "certificate",
          id,
          p,
        );
        if (objectHandle !== null) handles.push(objectHandle);
        handles.push(
          await writeChange(ctx, "uploadCertificate", performedAt, [{
            kind: "certificate",
            id,
            action: "created",
            ok: true,
            httpStatus: upload.status,
            message: "",
          }]),
        );
        return { dataHandles: handles };
      },
    },

    renewCertificate: {
      description:
        "Renew Let's Encrypt certificates by id. Renews every id given, " +
        "recording per-certificate outcomes rather than stopping at the " +
        "first failure.",
      arguments: RenewCertificateArgsSchema,
      execute: async (
        args: z.infer<typeof RenewCertificateArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);

        const handles: DataHandle[] = [];
        const results: ChangeResult[] = [];
        for (const id of args.ids) {
          const outcome = await client.call(
            "POST",
            `${KIND_PATHS.certificate}/${id}/renew`,
          );
          results.push({
            kind: "certificate",
            id,
            action: outcome.ok ? "renewed" : "failed",
            ok: outcome.ok,
            httpStatus: outcome.status,
            message: outcome.message,
          });
          if (outcome.ok) {
            ctx.logger.info("renewed certificate {id}", { id });
            const handle = await writeObject(client, ctx, "certificate", id, p);
            if (handle !== null) handles.push(handle);
          } else {
            ctx.logger.warning("could not renew certificate {id} — {reason}", {
              id,
              reason: outcome.message,
            });
          }
        }

        handles.push(
          await writeChange(ctx, "renewCertificate", performedAt, results),
        );
        return { dataHandles: handles };
      },
    },

    setEnabled: {
      description:
        "Enable or disable hosts and streams by id. Takes a list so a batch " +
        "is one run against the model rather than one run per id.",
      arguments: SetEnabledArgsSchema,
      execute: async (
        args: z.infer<typeof SetEnabledArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();
        const p = provenance(ctx.globalArgs, performedAt);
        const verb = args.enabled ? "enable" : "disable";

        const handles: DataHandle[] = [];
        const results: ChangeResult[] = [];
        for (const id of args.ids) {
          const outcome = await client.call(
            "POST",
            `${KIND_PATHS[args.kind]}/${id}/${verb}`,
          );
          results.push({
            kind: args.kind,
            id,
            action: outcome.ok
              ? (args.enabled ? "enabled" : "disabled")
              : "failed",
            ok: outcome.ok,
            httpStatus: outcome.status,
            message: outcome.message,
          });
          if (outcome.ok) {
            ctx.logger.info("{verb}d {kind} {id}", {
              verb,
              kind: args.kind,
              id,
            });
            const handle = await writeObject(client, ctx, args.kind, id, p);
            if (handle !== null) handles.push(handle);
          } else {
            ctx.logger.warning("could not {verb} {kind} {id} — {reason}", {
              verb,
              kind: args.kind,
              id,
              reason: outcome.message,
            });
          }
        }

        handles.push(
          await writeChange(ctx, "setEnabled", performedAt, results),
        );
        return { dataHandles: handles };
      },
    },

    delete: {
      description:
        "Delete objects of one kind by id. Verify ids against a fresh " +
        "`sync` first: NPM reuses ids after deletion, so a stale id can " +
        "remove the wrong object. Successfully deleted objects also have " +
        "their swamp resource removed, so inventory does not keep ghosts.",
      arguments: DeleteArgsSchema,
      execute: async (
        args: z.infer<typeof DeleteArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const client = await connect(ctx.globalArgs);
        const performedAt = new Date().toISOString();

        const results: ChangeResult[] = [];
        for (const id of args.ids) {
          const outcome = await client.call(
            "DELETE",
            `${KIND_PATHS[args.kind]}/${id}`,
          );
          // An object that is already gone is the state the caller asked for.
          // Reporting 404 as a failure would make a re-run of a workflow's
          // delete step fail on its second pass, which is exactly when a
          // converging workflow re-runs it.
          const alreadyGone = outcome.status === 404;
          const removed = outcome.ok || alreadyGone;

          results.push({
            kind: args.kind,
            id,
            action: removed ? "deleted" : "failed",
            ok: removed,
            httpStatus: outcome.status,
            message: alreadyGone && !outcome.ok
              ? "already absent — nothing to delete"
              : outcome.message,
          });

          if (removed) {
            if (alreadyGone && !outcome.ok) {
              ctx.logger.info("{kind} {id} was already absent", {
                kind: args.kind,
                id,
              });
            } else {
              ctx.logger.info("deleted {kind} {id}", { kind: args.kind, id });
            }
            await ctx.deleteResource(instanceNameFor(args.kind, id));
          } else {
            ctx.logger.warning("could not delete {kind} {id} — {reason}", {
              kind: args.kind,
              id,
              reason: outcome.message,
            });
          }
        }

        return {
          dataHandles: [
            await writeChange(ctx, "delete", performedAt, results),
          ],
        };
      },
    },
  },
};

// Re-exported so reports and downstream models can type NPM output without
// reaching into _lib.
export {
  AccessListSchema,
  CertificateSchema,
  ChangeSchema,
  DeadHostSchema,
  InstanceSchema,
  ProxyHostSchema,
  RedirectionHostSchema,
  StreamSchema,
};
