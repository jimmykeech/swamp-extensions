/**
 * Fly.io organization model — discover and monitor every app in a Fly org via
 * the Fly Machines REST API (https://api.machines.dev/v1).
 *
 * Complements `@jamesakeech/fly/app` (which monitors one named app) with
 * org-wide discovery (`apps`) and a fan-out machine-state summary (`status`),
 * so a single instance covers any/all apps in an organization without naming
 * each one. Read-only — like the app type, it does not implement `deploy`.
 *
 * @module
 */
import { z } from "npm:zod@4";

const FLY_MACHINES_API = "https://api.machines.dev/v1";

/** Global arguments shared by every method on a Fly org model. */
const GlobalArgsSchema = z.object({
  orgSlug: z.string().min(1).describe("Fly organization slug, e.g. personal"),
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Fly API token with org read access. Source from a vault.",
  ),
  apiBaseUrl: z.string().min(1).default(FLY_MACHINES_API).describe(
    "Fly Machines API base URL; override only for testing.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One app discovered in the org (factory: one record per app). */
const AppSchema = z.object({
  id: z.string(),
  name: z.string(),
  orgSlug: z.string(),
  machineCount: z.number(),
  network: z.string().nullable(),
  fetchedAt: z.iso.datetime(),
});

/** Per-app machine-state summary from the fan-out `status` method. */
const AppStatusSchema = z.object({
  appName: z.string(),
  fetchedAt: z.iso.datetime(),
  reachable: z.boolean(),
  error: z.string().nullable(),
  machineCount: z.number(),
  runningCount: z.number(),
  unhealthyMachines: z.number(),
  regions: z.array(z.string()),
  images: z.array(z.string()),
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
 * (status code, transient/permanent classification, body summary) on any
 * non-2xx response — before any data is written.
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

/** Raw app entry (subset) from `GET /apps?org_slug=`. */
type RawApp = {
  id?: string;
  name?: string;
  machine_count?: number;
  network?: string;
};

/** Raw `GET /apps?org_slug=` response envelope. */
type AppsResponse = { apps?: RawApp[]; total_apps?: number };

/** Raw machine shape (subset) from `GET /apps/{app}/machines`. */
type RawMachine = {
  state?: string;
  region?: string;
  config?: { image?: string };
  checks?: Array<{ status?: string }>;
};

/** List the org's apps via the Machines API. */
async function listApps(ctx: ExecContext): Promise<RawApp[]> {
  const { orgSlug, apiToken, apiBaseUrl } = ctx.globalArgs;
  const res = await flyGet<AppsResponse>(
    apiBaseUrl,
    apiToken,
    `/apps?org_slug=${encodeURIComponent(orgSlug)}`,
  );
  return res.apps ?? [];
}

/** Model definition for discovering and monitoring all apps in a Fly org. */
export const model = {
  type: "@jamesakeech/fly/org",
  version: "2026.07.01.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    "app": {
      description: "An app discovered in the org (one record per app)",
      schema: AppSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "appStatus": {
      description: "Per-app machine-state summary (one record per app)",
      schema: AppStatusSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    apps: {
      description: "Discover every app in the org (id, machine count, network)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { orgSlug } = ctx.globalArgs;
        ctx.logger?.info("Listing apps in org {org}", { org: orgSlug });
        const fetchedAt = new Date().toISOString();
        const apps = await listApps(ctx);
        const handles: DataHandle[] = [];
        for (const a of apps) {
          const name = a.name ?? "";
          const record: z.infer<typeof AppSchema> = {
            id: a.id ?? "",
            name,
            orgSlug,
            machineCount: a.machine_count ?? 0,
            network: a.network ?? null,
            fetchedAt,
          };
          handles.push(await ctx.writeResource("app", `app-${name}`, record));
        }
        ctx.logger?.info("Discovered {count} app(s)", { count: apps.length });
        return { dataHandles: handles };
      },
    },
    status: {
      description:
        "Fan out over every app in the org and summarize its machine state",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { orgSlug, apiToken, apiBaseUrl } = ctx.globalArgs;
        ctx.logger?.info("Summarizing machine state for org {org}", {
          org: orgSlug,
        });
        const fetchedAt = new Date().toISOString();
        const apps = await listApps(ctx);
        const handles: DataHandle[] = [];
        for (const a of apps) {
          const name = a.name ?? "";
          // One unreachable app must not fail the whole org summary; capture
          // the per-app error instead of throwing.
          let record: z.infer<typeof AppStatusSchema>;
          try {
            const machines = await flyGet<RawMachine[]>(
              apiBaseUrl,
              apiToken,
              `/apps/${encodeURIComponent(name)}/machines`,
            );
            const regions = [
              ...new Set(machines.map((m) => m.region ?? "").filter(Boolean)),
            ];
            const images = [
              ...new Set(
                machines.map((m) => m.config?.image ?? "").filter(Boolean),
              ),
            ];
            const unhealthyMachines = machines.filter((m) =>
              (m.checks ?? []).some((c) =>
                c.status === "critical" || c.status === "warning"
              )
            ).length;
            record = {
              appName: name,
              fetchedAt,
              reachable: true,
              error: null,
              machineCount: machines.length,
              runningCount: machines.filter((m) =>
                m.state === "started"
              ).length,
              unhealthyMachines,
              regions,
              images,
            };
          } catch (e) {
            record = {
              appName: name,
              fetchedAt,
              reachable: false,
              error: e instanceof Error ? e.message : String(e),
              machineCount: 0,
              runningCount: 0,
              unhealthyMachines: 0,
              regions: [],
              images: [],
            };
          }
          handles.push(
            await ctx.writeResource("appStatus", `status-${name}`, record),
          );
        }
        ctx.logger?.info("Summarized {count} app(s)", { count: apps.length });
        return { dataHandles: handles };
      },
    },
  },
};
