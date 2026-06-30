/**
 * Fly.io application model — read-only monitoring of a Fly app plus safe volume
 * snapshot creation, via the Fly Machines REST API (https://api.machines.dev/v1).
 *
 * This deliberately does NOT implement `deploy`: rolling/immediate rollout,
 * health gating and lease management are non-trivial and already handled
 * correctly by `flyctl`. This type covers observability (machine/deploy state,
 * volumes, snapshots) and the one safe mutation — taking a volume snapshot.
 *
 * @module
 */
import { z } from "npm:zod@4";

const FLY_MACHINES_API = "https://api.machines.dev/v1";

/** Global arguments shared by every method on a Fly app model. */
const GlobalArgsSchema = z.object({
  appName: z.string().min(1).describe("Fly app name, e.g. my-app"),
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Fly API token with read access (and volume-snapshot write). Source from a vault.",
  ),
  apiBaseUrl: z.string().min(1).default(FLY_MACHINES_API).describe(
    "Fly Machines API base URL; override only for testing.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** A single Fly machine's health check result. */
const CheckSchema = z.object({
  name: z.string(),
  status: z.string(),
  output: z.string().nullable(),
});

/** One Fly machine belonging to the app. */
const MachineSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  region: z.string(),
  image: z.string(),
  updatedAt: z.string(),
  checks: z.array(CheckSchema),
});

/** App-level deployment/runtime status (one record, instance "current"). */
const StatusSchema = z.object({
  appName: z.string(),
  fetchedAt: z.iso.datetime(),
  machineCount: z.number(),
  runningCount: z.number(),
  machines: z.array(MachineSchema),
});

/** One Fly volume (factory: one record per volume, keyed by volume id). */
const VolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  sizeGb: z.number(),
  region: z.string(),
  encrypted: z.boolean().nullable(),
  attachedMachineId: z.string().nullable(),
  snapshotRetention: z.number().nullable(),
  // Filesystem usage, derived from the volume's block stats. Null when the
  // volume isn't mounted on a running machine (the API omits block stats then).
  bytesTotal: z.number().nullable(),
  bytesUsed: z.number().nullable(),
  bytesFree: z.number().nullable(),
  usedPercent: z.number().nullable(),
  createdAt: z.string(),
  fetchedAt: z.iso.datetime(),
});

/** One volume snapshot (factory: one record per snapshot, keyed by snapshot id). */
const SnapshotSchema = z.object({
  id: z.string(),
  volumeId: z.string(),
  volumeName: z.string().nullable(),
  status: z.string(),
  sizeBytes: z.number().nullable(),
  digest: z.string().nullable(),
  retentionDays: z.number().nullable(),
  createdAt: z.string(),
  fetchedAt: z.iso.datetime(),
});

/** Outcome of a snapshot-creation request per targeted volume. */
const SnapshotResultSchema = z.object({
  volumeId: z.string(),
  volumeName: z.string().nullable(),
  httpStatus: z.number(),
});

/** Audit record for a `snapshot` method run (one record, instance "last"). */
const SnapshotRequestSchema = z.object({
  appName: z.string(),
  requestedAt: z.iso.datetime(),
  volumeCount: z.number(),
  volumes: z.array(SnapshotResultSchema),
});

/** A single normalized machine lifecycle event. */
const EventSchema = z.object({
  type: z.string(),
  status: z.string(),
  source: z.string(),
  timestamp: z.string(),
  exitCode: z.number().nullable(),
  oomKilled: z.boolean().nullable(),
});

/**
 * Per-machine event summary (factory: one record per machine, keyed by machine
 * id). Multiple starts/exits or any oomKills indicate crash-looping / OOM.
 */
const MachineEventsSchema = z.object({
  machineId: z.string(),
  machineName: z.string(),
  state: z.string(),
  fetchedAt: z.iso.datetime(),
  eventCount: z.number(),
  truncated: z.boolean(),
  startCount: z.number(),
  exitCount: z.number(),
  oomKills: z.number(),
  lastExitCode: z.number().nullable(),
  lastOomKilled: z.boolean().nullable(),
  recentEvents: z.array(EventSchema),
});

/** Minimal logger surface swamp injects into the execute context. */
type Logger = {
  info: (msg: string, props?: Record<string, unknown>) => void;
  warning?: (msg: string, props?: Record<string, unknown>) => void;
};

/** Execution context passed to every method's `execute`. */
type ExecContext = {
  globalArgs: GlobalArgs;
  logger?: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** A persisted-data handle returned from a method execution. */
type DataHandle = { name: string };

/** True for statuses worth retrying (rate limit / server-side / unavailable). */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Trim an API error body so it is useful in a message without flooding logs. */
function summarize(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** Build the auth headers for a Fly Machines API request. */
function flyHeaders(token: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * GET a Fly Machines API path and parse JSON, throwing a descriptive error
 * (with status code, transient/permanent classification, and body summary) on
 * any non-2xx response — before any data is written.
 */
async function flyGet<T>(
  base: string,
  token: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: flyHeaders(token) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind = isTransient(res.status) ? "transient" : "permanent";
    throw new Error(
      `Fly GET ${path} failed (${kind}): HTTP ${res.status} — ${
        summarize(body)
      }`,
    );
  }
  return await res.json() as T;
}

/** Raw machine lifecycle event (subset) returned by the Fly Machines API. */
type RawEvent = {
  type?: string;
  status?: string;
  source?: string;
  timestamp?: number | string;
  request?: { exit_event?: { exit_code?: number; oom_killed?: boolean } };
};

/** Raw machine shape (subset) returned by the Fly Machines API. */
type RawMachine = {
  id?: string;
  name?: string;
  state?: string;
  region?: string;
  updated_at?: string;
  config?: { image?: string };
  checks?: Array<{ name?: string; status?: string; output?: string }>;
  events?: RawEvent[];
};

/** Raw volume shape (subset) returned by the Fly Machines API. */
type RawVolume = {
  id?: string;
  name?: string;
  state?: string;
  size_gb?: number;
  region?: string;
  encrypted?: boolean;
  attached_machine_id?: string | null;
  snapshot_retention?: number;
  created_at?: string;
  blocks?: number;
  block_size?: number;
  blocks_free?: number;
};

/** Raw snapshot shape (subset) returned by the Fly Machines API. */
type RawSnapshot = {
  id?: string;
  status?: string;
  size?: number;
  digest?: string;
  retention_days?: number;
  created_at?: string;
};

/** Fetch and normalize the app's machines into MachineSchema records. */
async function listMachines(
  ctx: ExecContext,
): Promise<z.infer<typeof MachineSchema>[]> {
  const { appName, apiToken, apiBaseUrl } = ctx.globalArgs;
  const raw = await flyGet<RawMachine[]>(
    apiBaseUrl,
    apiToken,
    `/apps/${encodeURIComponent(appName)}/machines`,
  );
  return raw.map((m) => ({
    id: m.id ?? "",
    name: m.name ?? "",
    state: m.state ?? "unknown",
    region: m.region ?? "",
    image: m.config?.image ?? "",
    updatedAt: m.updated_at ?? "",
    checks: (m.checks ?? []).map((c) => ({
      name: c.name ?? "",
      status: c.status ?? "",
      output: c.output ?? null,
    })),
  }));
}

/** Fetch and normalize the app's volumes into VolumeSchema records. */
async function listVolumes(
  ctx: ExecContext,
  fetchedAt: string,
): Promise<z.infer<typeof VolumeSchema>[]> {
  const { appName, apiToken, apiBaseUrl } = ctx.globalArgs;
  const raw = await flyGet<RawVolume[]>(
    apiBaseUrl,
    apiToken,
    `/apps/${encodeURIComponent(appName)}/volumes`,
  );
  return raw.map((v) => {
    const usage = diskUsage(v);
    return {
      id: v.id ?? "",
      name: v.name ?? "",
      state: v.state ?? "unknown",
      sizeGb: v.size_gb ?? 0,
      region: v.region ?? "",
      encrypted: v.encrypted ?? null,
      attachedMachineId: v.attached_machine_id ?? null,
      snapshotRetention: v.snapshot_retention ?? null,
      bytesTotal: usage.bytesTotal,
      bytesUsed: usage.bytesUsed,
      bytesFree: usage.bytesFree,
      usedPercent: usage.usedPercent,
      createdAt: v.created_at ?? "",
      fetchedAt,
    };
  });
}

/**
 * Derive filesystem usage from a volume's block stats. Returns all-null when the
 * block stats are absent (volume not mounted on a running machine).
 */
function diskUsage(v: RawVolume): {
  bytesTotal: number | null;
  bytesUsed: number | null;
  bytesFree: number | null;
  usedPercent: number | null;
} {
  const blank = {
    bytesTotal: null,
    bytesUsed: null,
    bytesFree: null,
    usedPercent: null,
  };
  if (typeof v.blocks !== "number" || typeof v.block_size !== "number") {
    return blank;
  }
  const bytesTotal = v.blocks * v.block_size;
  if (bytesTotal <= 0 || typeof v.blocks_free !== "number") {
    return { ...blank, bytesTotal };
  }
  const bytesFree = v.blocks_free * v.block_size;
  const bytesUsed = bytesTotal - bytesFree;
  const usedPercent = Math.round((bytesUsed / bytesTotal) * 1000) / 10;
  return { bytesTotal, bytesUsed, bytesFree, usedPercent };
}

/** Normalize a raw machine event into EventSchema shape plus a sortable ms key. */
function normalizeEvent(
  e: RawEvent,
): z.infer<typeof EventSchema> & { ms: number } {
  const rawTs = e.timestamp;
  const ms = typeof rawTs === "number"
    ? rawTs
    : (typeof rawTs === "string" ? Date.parse(rawTs) : NaN);
  const exit = e.request?.exit_event;
  return {
    type: e.type ?? "",
    status: e.status ?? "",
    source: e.source ?? "",
    timestamp: Number.isFinite(ms)
      ? new Date(ms).toISOString()
      : String(rawTs ?? ""),
    exitCode: typeof exit?.exit_code === "number" ? exit.exit_code : null,
    oomKilled: typeof exit?.oom_killed === "boolean" ? exit.oom_killed : null,
    ms: Number.isFinite(ms) ? ms : 0,
  };
}

/** Model definition for monitoring a Fly.io app and snapshotting its volumes. */
export const model = {
  type: "@jamesakeech/fly/app",
  version: "2026.07.01.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    "status": {
      description:
        "App deployment/runtime status: machines, state, image, checks",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "volume": {
      description: "A Fly volume attached to the app (one record per volume)",
      schema: VolumeSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "snapshot": {
      description: "A volume snapshot (one record per snapshot)",
      schema: SnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 200,
    },
    "snapshotRequest": {
      description: "Audit record of the last snapshot-creation request",
      schema: SnapshotRequestSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "machineEvents": {
      description:
        "Per-machine lifecycle event summary (starts, exits, OOM kills)",
      schema: MachineEventsSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  checks: {
    "volumes-present": {
      description:
        "Verify the app exposes at least one volume (or the requested volumeId) before snapshotting",
      labels: ["live"],
      appliesTo: ["snapshot"],
      execute: async (
        ctx: { globalArgs: GlobalArgs; logger?: Logger },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const { appName, apiToken, apiBaseUrl } = ctx.globalArgs;
        ctx.logger?.info("Pre-flight: checking volumes for {app}", {
          app: appName,
        });
        let volumes: RawVolume[];
        try {
          volumes = await flyGet<RawVolume[]>(
            apiBaseUrl,
            apiToken,
            `/apps/${encodeURIComponent(appName)}/volumes`,
          );
        } catch (e) {
          return {
            pass: false,
            errors: [
              `Pre-flight: could not list volumes for ${appName}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ],
          };
        }
        if (!volumes || volumes.length === 0) {
          return {
            pass: false,
            errors: [`Pre-flight: app ${appName} has no volumes to snapshot`],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    status: {
      description:
        "List machines and capture deployment state, running image, and health checks",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        ctx.logger?.info("Fetching Fly machine status for {app}", {
          app: ctx.globalArgs.appName,
        });
        const machines = await listMachines(ctx);
        const data: z.infer<typeof StatusSchema> = {
          appName: ctx.globalArgs.appName,
          fetchedAt: new Date().toISOString(),
          machineCount: machines.length,
          runningCount: machines.filter((m) => m.state === "started").length,
          machines,
        };
        const handle = await ctx.writeResource("status", "current", data);
        ctx.logger?.info(
          "Captured status: {running}/{total} machines started",
          {
            running: data.runningCount,
            total: data.machineCount,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    volumes: {
      description:
        "List the app's volumes (size, region, attachment, retention)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        ctx.logger?.info("Listing Fly volumes for {app}", {
          app: ctx.globalArgs.appName,
        });
        const fetchedAt = new Date().toISOString();
        const volumes = await listVolumes(ctx, fetchedAt);
        const handles: DataHandle[] = [];
        for (const v of volumes) {
          handles.push(await ctx.writeResource("volume", v.id, v));
        }
        ctx.logger?.info("Recorded {count} volume(s)", {
          count: volumes.length,
        });
        return { dataHandles: handles };
      },
    },
    events: {
      description:
        "Summarize each machine's lifecycle events (starts, exits, OOM kills)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { appName, apiToken, apiBaseUrl } = ctx.globalArgs;
        ctx.logger?.info("Fetching machine events for {app}", { app: appName });
        const fetchedAt = new Date().toISOString();
        const raw = await flyGet<RawMachine[]>(
          apiBaseUrl,
          apiToken,
          `/apps/${encodeURIComponent(appName)}/machines`,
        );
        const MAX_RECENT = 20;
        const handles: DataHandle[] = [];
        for (const m of raw) {
          // Newest first, so recentEvents and "last exit" are the latest.
          const events = (m.events ?? []).map(normalizeEvent).sort((a, b) =>
            b.ms - a.ms
          );
          const lastExit = events.find((e) => e.type === "exit");
          const recentEvents = events.slice(0, MAX_RECENT).map((
            { ms: _ms, ...rest },
          ) => rest);
          const record: z.infer<typeof MachineEventsSchema> = {
            machineId: m.id ?? "",
            machineName: m.name ?? "",
            state: m.state ?? "unknown",
            fetchedAt,
            eventCount: events.length,
            truncated: events.length > recentEvents.length,
            startCount: events.filter((e) => e.type === "start").length,
            exitCount: events.filter((e) => e.type === "exit").length,
            oomKills: events.filter((e) => e.oomKilled === true).length,
            lastExitCode: lastExit ? lastExit.exitCode : null,
            lastOomKilled: lastExit ? lastExit.oomKilled : null,
            recentEvents,
          };
          handles.push(
            await ctx.writeResource("machineEvents", m.id ?? "unknown", record),
          );
        }
        ctx.logger?.info("Recorded events for {count} machine(s)", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    snapshots: {
      description: "List every snapshot across all of the app's volumes",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { appName, apiToken, apiBaseUrl } = ctx.globalArgs;
        ctx.logger?.info("Listing snapshots for {app}", { app: appName });
        const fetchedAt = new Date().toISOString();
        const volumes = await listVolumes(ctx, fetchedAt);
        const handles: DataHandle[] = [];
        for (const v of volumes) {
          const raw = await flyGet<RawSnapshot[]>(
            apiBaseUrl,
            apiToken,
            `/apps/${encodeURIComponent(appName)}/volumes/${
              encodeURIComponent(v.id)
            }/snapshots`,
          );
          for (const s of raw) {
            const id = s.id ?? "";
            const record: z.infer<typeof SnapshotSchema> = {
              id,
              volumeId: v.id,
              volumeName: v.name,
              status: s.status ?? "unknown",
              sizeBytes: s.size ?? null,
              digest: s.digest ?? null,
              retentionDays: s.retention_days ?? null,
              createdAt: s.created_at ?? "",
              fetchedAt,
            };
            handles.push(await ctx.writeResource("snapshot", id, record));
          }
        }
        ctx.logger?.info("Recorded {count} snapshot(s)", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    snapshot: {
      description: "Create a snapshot of every volume (or a specific volumeId)",
      arguments: z.object({
        volumeId: z.string().optional().describe(
          "Snapshot only this volume; omit to snapshot all of the app's volumes",
        ),
      }),
      execute: async (
        args: { volumeId?: string },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { appName, apiToken, apiBaseUrl } = ctx.globalArgs;
        const requestedAt = new Date().toISOString();

        let targets: Array<{ id: string; name: string | null }>;
        if (args.volumeId) {
          targets = [{ id: args.volumeId, name: null }];
        } else {
          const volumes = await listVolumes(ctx, requestedAt);
          targets = volumes.map((v) => ({ id: v.id, name: v.name }));
        }

        if (targets.length === 0) {
          throw new Error(
            `App ${appName} has no volumes to snapshot. Pass volumeId, or check the app name.`,
          );
        }

        ctx.logger?.info(
          "Creating snapshot(s) for {count} volume(s) on {app}",
          {
            count: targets.length,
            app: appName,
          },
        );

        // Attempt every target; collect outcomes and throw a combined summary
        // (before writing any data) if any snapshot request failed.
        const results: z.infer<typeof SnapshotResultSchema>[] = [];
        const failures: string[] = [];
        for (const t of targets) {
          const res = await fetch(
            `${apiBaseUrl}/apps/${encodeURIComponent(appName)}/volumes/${
              encodeURIComponent(t.id)
            }/snapshots`,
            { method: "POST", headers: flyHeaders(apiToken) },
          );
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const kind = isTransient(res.status) ? "transient" : "permanent";
            failures.push(
              `volume ${t.id} (${kind}): HTTP ${res.status} — ${
                summarize(body)
              }`,
            );
            continue;
          }
          results.push({
            volumeId: t.id,
            volumeName: t.name,
            httpStatus: res.status,
          });
        }
        if (failures.length > 0) {
          const ok = results.length > 0
            ? ` Succeeded: ${results.map((r) => r.volumeId).join(", ")}.`
            : "";
          throw new Error(
            `Snapshot creation failed for ${failures.length}/${targets.length} volume(s): ${
              failures.join("; ")
            }.${ok}`,
          );
        }

        const record: z.infer<typeof SnapshotRequestSchema> = {
          appName,
          requestedAt,
          volumeCount: results.length,
          volumes: results,
        };
        const handle = await ctx.writeResource(
          "snapshotRequest",
          "last",
          record,
        );
        ctx.logger?.info("Requested {count} snapshot(s)", {
          count: results.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
