/**
 * Audiobookshelf server model — read-only monitoring of a self-hosted
 * Audiobookshelf server (https://www.audiobookshelf.org) via its REST API.
 *
 * Covers library/audiobook discovery, per-user listening progress, listening
 * session history, and aggregate listening statistics. Authenticates with a
 * static API key (Settings → Users → your user → API Keys, Audiobookshelf
 * v2.17+). Read-only — this type never mutates server state.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Global arguments shared by every method on an Audiobookshelf server model. */
const GlobalArgsSchema = z.object({
  baseUrl: z.string().min(1).describe(
    "Audiobookshelf server base URL, e.g. https://abs.example.com (no trailing slash)",
  ),
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Audiobookshelf API key (Settings → Users → API Keys). Source from a vault.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One library on the server (factory: one record per library). */
const LibrarySchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  provider: z.string().nullable(),
  folderCount: z.number(),
  createdAt: z.iso.datetime().nullable(),
  lastUpdate: z.iso.datetime().nullable(),
  fetchedAt: z.iso.datetime(),
});

/** One library item — an audiobook or podcast (factory: one record per item). */
const ItemSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  mediaType: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  authors: z.array(z.string()),
  narrators: z.array(z.string()),
  series: z.array(z.string()),
  genres: z.array(z.string()),
  publishedYear: z.string().nullable(),
  isbn: z.string().nullable().describe(
    "ISBN-13/10 from the book's metadata (null if unset). The reliable key " +
      "for resolving a book to an external catalogue (e.g. Hardcover).",
  ),
  asin: z.string().nullable().describe(
    "Amazon/Audible ASIN from the book's metadata (null if unset).",
  ),
  durationSeconds: z.number(),
  sizeBytes: z.number(),
  numAudioFiles: z.number(),
  coverPath: z.string().nullable().describe(
    "Server-side path to the item's cover image when it has one (null if " +
      "none). The cover itself is served, auth-gated, at " +
      "GET /api/items/{id}/cover — use this as a has-cover signal.",
  ),
  isMissing: z.boolean(),
  isInvalid: z.boolean(),
  addedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  fetchedAt: z.iso.datetime(),
});

/** One media progress record for the API key's user (factory: one per item/episode). */
const ProgressSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  episodeId: z.string().nullable(),
  durationSeconds: z.number(),
  progress: z.number(),
  currentTimeSeconds: z.number(),
  isFinished: z.boolean(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  lastUpdate: z.iso.datetime().nullable(),
  fetchedAt: z.iso.datetime(),
});

/** One listening session for the API key's user (factory: one per session). */
const SessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  itemId: z.string(),
  episodeId: z.string().nullable(),
  mediaType: z.string(),
  displayTitle: z.string(),
  displayAuthor: z.string().nullable(),
  durationSeconds: z.number(),
  timeListeningSeconds: z.number(),
  currentTimeSeconds: z.number(),
  device: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  fetchedAt: z.iso.datetime(),
  truncated: z.boolean(),
});

/** One day's listening total, used inside StatsSchema. */
const DailyListeningSchema = z.object({
  date: z.string(),
  seconds: z.number(),
});

/** One item's all-time listening total, used inside StatsSchema. */
const TopItemSchema = z.object({
  itemId: z.string(),
  seconds: z.number(),
});

/** Aggregate listening statistics for the API key's user (one record, instance "current"). */
const StatsSchema = z.object({
  totalTimeSeconds: z.number(),
  todaySeconds: z.number(),
  days: z.array(DailyListeningSchema),
  topItems: z.array(TopItemSchema),
  fetchedAt: z.iso.datetime(),
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

/** Build the auth headers for an Audiobookshelf API request. */
function absHeaders(apiKey: string): HeadersInit {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "application/json",
  };
}

/** Strip a trailing slash so path concatenation never double-slashes. */
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * GET an Audiobookshelf API path and parse JSON, throwing a descriptive error
 * (status code, transient/permanent classification, body summary) on any
 * non-2xx response — before any data is written.
 */
async function absGet<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${trimBaseUrl(baseUrl)}${path}`, {
    headers: absHeaders(apiKey),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind = isTransient(res.status) ? "transient" : "permanent";
    throw new Error(
      `Audiobookshelf GET ${path} failed (${kind}): HTTP ${res.status} — ${
        summarize(body)
      }`,
    );
  }
  return await res.json() as T;
}

/** Convert an Audiobookshelf epoch-millisecond timestamp to ISO 8601, or null. */
function toIso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

/** Raw library shape (subset) from `GET /api/libraries`. */
type RawLibrary = {
  id?: string;
  name?: string;
  mediaType?: string;
  provider?: string;
  folders?: unknown[];
  createdAt?: number;
  lastUpdate?: number;
};

/** Raw library item shape (subset) from `GET /api/libraries/{id}/items`. */
type RawLibraryItem = {
  id?: string;
  libraryId?: string;
  mediaType?: string;
  isMissing?: boolean;
  isInvalid?: boolean;
  addedAt?: number;
  updatedAt?: number;
  media?: {
    coverPath?: string | null;
    metadata?: {
      title?: string;
      subtitle?: string;
      authorName?: string;
      authors?: Array<{ name?: string }>;
      narratorName?: string;
      narrators?: string[];
      seriesName?: string;
      series?: Array<{ name?: string; sequence?: string }>;
      genres?: string[];
      publishedYear?: string;
      isbn?: string | null;
      asin?: string | null;
    };
    duration?: number;
    size?: number;
    numAudioFiles?: number;
  };
};

/** Raw media progress entry (subset) from `GET /api/me`. */
type RawMediaProgress = {
  id?: string;
  libraryItemId?: string;
  episodeId?: string | null;
  duration?: number;
  progress?: number;
  currentTime?: number;
  isFinished?: boolean;
  startedAt?: number | null;
  finishedAt?: number | null;
  lastUpdate?: number;
};

/** Raw listening session entry (subset) from `GET /api/me/listening-sessions`. */
type RawListeningSession = {
  id?: string;
  userId?: string;
  libraryItemId?: string;
  episodeId?: string | null;
  mediaType?: string;
  displayTitle?: string;
  displayAuthor?: string;
  duration?: number;
  timeListening?: number;
  currentTime?: number;
  startedAt?: number;
  updatedAt?: number;
  deviceInfo?: {
    deviceType?: string;
    osName?: string;
    browserName?: string;
    clientName?: string;
  };
};

/** Raw listening stats response (subset) from `GET /api/me/listening-stats`. */
type RawListeningStats = {
  totalTime?: number;
  today?: number;
  days?: Record<string, number>;
  items?: Record<string, { timeListening?: number }>;
};

/** Fetch and normalize every item in one library. */
async function listLibraryItems(
  ctx: ExecContext,
  libraryId: string,
): Promise<RawLibraryItem[]> {
  const { baseUrl, apiKey } = ctx.globalArgs;
  const res = await absGet<{ results?: RawLibraryItem[] }>(
    baseUrl,
    apiKey,
    `/api/libraries/${encodeURIComponent(libraryId)}/items?minified=1`,
  );
  return res.results ?? [];
}

/** Model definition for monitoring an Audiobookshelf server. */
export const model = {
  type: "@jamesakeech/audiobookshelf",
  version: "2026.07.11.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "library": {
      description: "A library on the server (one record per library)",
      schema: LibrarySchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    "item": {
      description:
        "A library item — an audiobook or podcast (one record per item)",
      schema: ItemSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    "progress": {
      description:
        "A media progress record for the API key's user (one per item/episode)",
      schema: ProgressSchema,
      lifetime: "infinite",
      garbageCollection: 500,
    },
    "session": {
      description:
        "A listening session for the API key's user (one per session)",
      schema: SessionSchema,
      lifetime: "infinite",
      garbageCollection: 200,
    },
    "stats": {
      description: "Aggregate listening statistics for the API key's user",
      schema: StatsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    libraries: {
      description: "List every library on the server",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { baseUrl, apiKey } = ctx.globalArgs;
        ctx.logger?.info("Listing Audiobookshelf libraries");
        const fetchedAt = new Date().toISOString();
        const res = await absGet<{ libraries?: RawLibrary[] }>(
          baseUrl,
          apiKey,
          "/api/libraries",
        );
        const libraries = res.libraries ?? [];
        const handles: DataHandle[] = [];
        for (const l of libraries) {
          const id = l.id ?? "";
          const record: z.infer<typeof LibrarySchema> = {
            id,
            name: l.name ?? "",
            mediaType: l.mediaType ?? "unknown",
            provider: l.provider ?? null,
            folderCount: (l.folders ?? []).length,
            createdAt: toIso(l.createdAt),
            lastUpdate: toIso(l.lastUpdate),
            fetchedAt,
          };
          handles.push(await ctx.writeResource("library", id, record));
        }
        ctx.logger?.info("Recorded {count} librar(y/ies)", {
          count: libraries.length,
        });
        return { dataHandles: handles };
      },
    },
    items: {
      description:
        "List every item (audiobook/podcast) across every library on the server",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { baseUrl, apiKey } = ctx.globalArgs;
        ctx.logger?.info("Listing Audiobookshelf items across all libraries");
        const fetchedAt = new Date().toISOString();
        const librariesRes = await absGet<{ libraries?: RawLibrary[] }>(
          baseUrl,
          apiKey,
          "/api/libraries",
        );
        const libraries = librariesRes.libraries ?? [];
        const handles: DataHandle[] = [];
        const failedLibraries: string[] = [];
        for (const lib of libraries) {
          const libraryId = lib.id ?? "";
          // One unreachable library must not discard items already recorded
          // for the others — skip it and keep going.
          let items: RawLibraryItem[];
          try {
            items = await listLibraryItems(ctx, libraryId);
          } catch (e) {
            failedLibraries.push(libraryId);
            ctx.logger?.warning?.(
              "Skipping library {library}: {error}",
              {
                library: libraryId,
                error: e instanceof Error ? e.message : String(e),
              },
            );
            continue;
          }
          for (const it of items) {
            const id = it.id ?? "";
            const meta = it.media?.metadata ?? {};
            const authors = meta.authors?.length
              ? meta.authors.map((a) => a.name ?? "").filter(Boolean)
              : (meta.authorName ? [meta.authorName] : []);
            const narrators = meta.narrators?.length
              ? meta.narrators
              : (meta.narratorName ? [meta.narratorName] : []);
            const series = meta.series?.length
              ? meta.series.map((s) =>
                s.sequence ? `${s.name ?? ""} #${s.sequence}` : (s.name ?? "")
              ).filter(Boolean)
              : (meta.seriesName ? [meta.seriesName] : []);
            const record: z.infer<typeof ItemSchema> = {
              id,
              libraryId,
              mediaType: it.mediaType ?? "unknown",
              title: meta.title ?? "",
              subtitle: meta.subtitle ?? null,
              authors,
              narrators,
              series,
              genres: meta.genres ?? [],
              publishedYear: meta.publishedYear ?? null,
              isbn: meta.isbn ?? null,
              asin: meta.asin ?? null,
              durationSeconds: it.media?.duration ?? 0,
              sizeBytes: it.media?.size ?? 0,
              numAudioFiles: it.media?.numAudioFiles ?? 0,
              coverPath: it.media?.coverPath ?? null,
              isMissing: it.isMissing ?? false,
              isInvalid: it.isInvalid ?? false,
              addedAt: toIso(it.addedAt),
              updatedAt: toIso(it.updatedAt),
              fetchedAt,
            };
            handles.push(await ctx.writeResource("item", id, record));
          }
        }
        if (
          libraries.length > 0 && failedLibraries.length === libraries.length
        ) {
          throw new Error(
            `Failed to fetch items from all ${libraries.length} librar(y/ies): ${
              failedLibraries.join(", ")
            }`,
          );
        }
        ctx.logger?.info(
          "Recorded {count} item(s) across {libCount} librar(y/ies) ({failedCount} failed)",
          {
            count: handles.length,
            libCount: libraries.length,
            failedCount: failedLibraries.length,
          },
        );
        return { dataHandles: handles };
      },
    },
    progress: {
      description:
        "List media progress (in-progress and finished items) for the API key's user",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { baseUrl, apiKey } = ctx.globalArgs;
        ctx.logger?.info("Fetching Audiobookshelf media progress");
        const fetchedAt = new Date().toISOString();
        const me = await absGet<{ mediaProgress?: RawMediaProgress[] }>(
          baseUrl,
          apiKey,
          "/api/me",
        );
        const entries = me.mediaProgress ?? [];
        const handles: DataHandle[] = [];
        for (const p of entries) {
          const id = p.id ?? `${p.libraryItemId ?? ""}-${p.episodeId ?? ""}`;
          const record: z.infer<typeof ProgressSchema> = {
            id,
            itemId: p.libraryItemId ?? "",
            episodeId: p.episodeId ?? null,
            durationSeconds: p.duration ?? 0,
            progress: p.progress ?? 0,
            currentTimeSeconds: p.currentTime ?? 0,
            isFinished: p.isFinished ?? false,
            startedAt: toIso(p.startedAt),
            finishedAt: toIso(p.finishedAt),
            lastUpdate: toIso(p.lastUpdate),
            fetchedAt,
          };
          handles.push(await ctx.writeResource("progress", id, record));
        }
        ctx.logger?.info("Recorded {count} progress record(s)", {
          count: entries.length,
        });
        return { dataHandles: handles };
      },
    },
    sessions: {
      description:
        "List recent listening sessions for the API key's user, most recent first",
      arguments: z.object({
        limit: z.number().int().positive().max(500).default(50).describe(
          "Maximum number of recent sessions to fetch",
        ),
      }),
      execute: async (
        args: { limit: number },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { baseUrl, apiKey } = ctx.globalArgs;
        ctx.logger?.info("Fetching up to {limit} listening session(s)", {
          limit: args.limit,
        });
        const fetchedAt = new Date().toISOString();
        const res = await absGet<
          { sessions?: RawListeningSession[]; total?: number }
        >(
          baseUrl,
          apiKey,
          `/api/me/listening-sessions?page=0&itemsPerPage=${args.limit}`,
        );
        const sessions = res.sessions ?? [];
        const truncated = typeof res.total === "number" &&
          res.total > sessions.length;
        const handles: DataHandle[] = [];
        for (const s of sessions) {
          const id = s.id ?? "";
          const device = s.deviceInfo
            ? [
              s.deviceInfo.clientName,
              s.deviceInfo.deviceType,
              s.deviceInfo.osName,
            ]
              .filter(Boolean).join(" / ") || null
            : null;
          const record: z.infer<typeof SessionSchema> = {
            id,
            userId: s.userId ?? "",
            itemId: s.libraryItemId ?? "",
            episodeId: s.episodeId ?? null,
            mediaType: s.mediaType ?? "unknown",
            displayTitle: s.displayTitle ?? "",
            displayAuthor: s.displayAuthor ?? null,
            durationSeconds: s.duration ?? 0,
            timeListeningSeconds: s.timeListening ?? 0,
            currentTimeSeconds: s.currentTime ?? 0,
            device,
            startedAt: toIso(s.startedAt),
            updatedAt: toIso(s.updatedAt),
            fetchedAt,
            truncated,
          };
          handles.push(await ctx.writeResource("session", id, record));
        }
        ctx.logger?.info(
          "Recorded {count} session(s) (truncated: {truncated})",
          {
            count: sessions.length,
            truncated,
          },
        );
        return { dataHandles: handles };
      },
    },
    stats: {
      description:
        "Capture aggregate listening statistics (total time, daily breakdown, top items) for the API key's user",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { baseUrl, apiKey } = ctx.globalArgs;
        ctx.logger?.info("Fetching Audiobookshelf listening stats");
        const fetchedAt = new Date().toISOString();
        const raw = await absGet<RawListeningStats>(
          baseUrl,
          apiKey,
          "/api/me/listening-stats",
        );
        const days = Object.entries(raw.days ?? {})
          .map(([date, seconds]) => ({ date, seconds }))
          .sort((a, b) => a.date.localeCompare(b.date));
        const topItems = Object.entries(raw.items ?? {})
          .map(([itemId, v]) => ({ itemId, seconds: v.timeListening ?? 0 }))
          .sort((a, b) => b.seconds - a.seconds)
          .slice(0, 10);
        const record: z.infer<typeof StatsSchema> = {
          totalTimeSeconds: raw.totalTime ?? 0,
          todaySeconds: raw.today ?? 0,
          days,
          topItems,
          fetchedAt,
        };
        const handle = await ctx.writeResource("stats", "current", record);
        ctx.logger?.info("Recorded stats: {total}s total, {today}s today", {
          total: record.totalTimeSeconds,
          today: record.todaySeconds,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
