import { z } from "npm:zod@4";

/**
 * Local extension that adds playback-activity methods to the `@keeb/jellyfin`
 * model type. The base extension only covers library inventory/audit; this adds
 * watch-history data sourced from the Jellyfin **Playback Reporting** plugin so
 * we can build watch-time dashboards analogous to the audiobookshelf report.
 *
 * Data comes from the plugin's `submit_custom_query` endpoint, which runs a
 * read-only SQL query against the plugin's `PlaybackActivity` table.
 */

/**
 * One watched item from Jellyfin's core per-user play state. Unlike
 * {@link PlaybackSessionSchema} this needs no plugin — it reflects each item's
 * most-recent play (`LastPlayedDate`) and cumulative `PlayCount`, so it works
 * immediately but cannot distinguish individual sessions or exact watch minutes.
 */
const WatchedItemSchema = z.object({
  id: z.string().describe("Composite userId:itemId key"),
  userId: z.string(),
  userName: z.string().nullable(),
  itemId: z.string(),
  itemType: z.string().describe("Movie or Episode"),
  name: z.string(),
  seriesName: z.string().nullable(),
  lastPlayedDate: z.string().describe("ISO timestamp of most recent play"),
  playCount: z.number(),
  runtimeSeconds: z.number().describe("Item runtime (full length)"),
  genres: z.array(z.string()),
  fetchedAt: z.string(),
});

/** One playback event recorded by the Playback Reporting plugin. */
const PlaybackSessionSchema = z.object({
  id: z.string().describe("Plugin rowid — unique per playback event"),
  dateCreated: z
    .string()
    .describe("Server-local start timestamp, 'YYYY-MM-DD HH:MM:SS'"),
  userId: z.string(),
  userName: z.string().nullable(),
  itemId: z.string().nullable(),
  itemType: z.string().describe("Movie, Episode, Audio, …"),
  itemName: z.string(),
  seriesName: z
    .string()
    .nullable()
    .describe("Parsed series title for episodes, else null"),
  client: z.string().nullable().describe("Client app, e.g. 'Jellyfin Web'"),
  device: z.string().nullable(),
  playDurationSeconds: z.number(),
  truncated: z
    .boolean()
    .describe(
      "True when this pull hit the `limit` cap, so older events were dropped",
    ),
  fetchedAt: z.string(),
});

function headers(apiKey: string): Record<string, string> {
  return { "X-Emby-Token": apiKey };
}

/** Strip trailing slashes from a base URL. */
function normUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * Best-effort parse of a series title from a Playback Reporting ItemName.
 * Episodes are stored like "Series - s01e02 - Title"; everything else returns
 * null so the caller can fall back to itemName.
 */
function parseSeriesName(itemType: string, itemName: string): string | null {
  if (itemType !== "Episode") return null;
  const m = itemName.match(/^(.*?)\s+-\s+s\d+e\d+/i);
  return m ? m[1].trim() : null;
}

interface CustomQueryResponse {
  colums?: string[];
  columns?: string[];
  results?: unknown[][];
  message?: string;
}

/**
 * Extends the `@keeb/jellyfin` model type with watch-activity methods and the
 * two resource specs they write. `playback_sessions` pulls accurate per-event
 * data from the Playback Reporting plugin; `watch_history` is a plugin-free
 * core-API fallback. Read-only — neither method mutates server state.
 */
export const extension = {
  type: "@keeb/jellyfin",
  resources: {
    watchedItem: {
      description:
        "A per-user watched item from Jellyfin core play state (one per user/item, most-recent play)",
      schema: WatchedItemSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
    playbackSession: {
      description:
        "A single playback event from the Playback Reporting plugin (one per record)",
      schema: PlaybackSessionSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
  },
  methods: [
    {
      watch_history: {
        description:
          "Pull recent play history from Jellyfin's core API (no plugin required) for the last N days. Fans out over ALL users and writes one resource per user/item with its most-recent play date, play count and runtime. Approximates watch time from item runtimes — it cannot see individual sessions or partial plays, but works immediately even before the Playback Reporting plugin has data.",
        arguments: z.object({
          days: z
            .number()
            .int()
            .min(1)
            .max(365)
            .default(30)
            .describe("How many days back to include (by last-played date)"),
        }),
        // deno-lint-ignore no-explicit-any
        execute: async (args: any, context: any) => {
          const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
          const url = normUrl(jellyfinUrl);
          const hdrs = headers(jellyfinApiKey);
          const days = Math.trunc(args.days);
          const cutoff = Date.now() - days * 86400_000;

          const usersResp = await fetch(`${url}/Users`, { headers: hdrs });
          if (!usersResp.ok) {
            throw new Error(`Failed to get users: ${usersResp.status}`);
          }
          const users = await usersResp.json();
          if (!users || users.length === 0) throw new Error("No users found");

          const handles = [];
          const batchSize = 200;
          let totalRuntime = 0;

          for (const user of users) {
            const userId = user.Id as string;
            const userName = (user.Name as string) ?? null;
            let startIndex = 0;
            let stop = false;

            while (!stop) {
              const params = new URLSearchParams({
                Recursive: "true",
                IsPlayed: "true",
                SortBy: "DatePlayed",
                SortOrder: "Descending",
                IncludeItemTypes: "Movie,Episode",
                Fields: "UserData,RunTimeTicks,SeriesName,Genres",
                Limit: String(batchSize),
                StartIndex: String(startIndex),
              });
              const resp = await fetch(
                `${url}/Users/${userId}/Items?${params}`,
                { headers: hdrs },
              );
              if (!resp.ok) {
                throw new Error(
                  `Failed to fetch play history for user ${userName}: ${resp.status}`,
                );
              }
              const data = await resp.json();
              const items = data.Items ?? [];
              if (items.length === 0) break;

              for (const it of items) {
                const ud = it.UserData ?? {};
                const last = ud.LastPlayedDate as string | undefined;
                // Sorted desc by play date — once we pass the cutoff, stop.
                if (!last) continue;
                if (new Date(last).getTime() < cutoff) {
                  stop = true;
                  break;
                }
                const runtimeSeconds = (it.RunTimeTicks ?? 0) / 10_000_000;
                totalRuntime += runtimeSeconds;
                const itemId = it.Id as string;
                const handle = await context.writeResource(
                  "watchedItem",
                  `${userId}-${itemId}`,
                  {
                    id: `${userId}:${itemId}`,
                    userId,
                    userName,
                    itemId,
                    itemType: it.Type ?? "",
                    name: it.Name ?? "",
                    seriesName: it.SeriesName ?? null,
                    lastPlayedDate: last,
                    playCount: ud.PlayCount ?? 0,
                    runtimeSeconds,
                    genres: it.Genres ?? [],
                    fetchedAt: new Date().toISOString(),
                  },
                );
                handles.push(handle);
              }

              startIndex += batchSize;
              if (startIndex >= (data.TotalRecordCount ?? 0)) break;
            }
          }

          context.logger.info(
            "Recorded {count} watched item(s) across {users} user(s) in last {days}d (~{hours}h runtime)",
            {
              count: handles.length,
              users: users.length,
              days,
              hours: Math.round((totalRuntime / 3600) * 10) / 10,
            },
          );

          return { dataHandles: handles };
        },
      },
    },
    {
      playback_sessions: {
        description:
          "Pull raw playback events from the Jellyfin Playback Reporting plugin for the last N days. Writes one resource per event (item, type, client, device, duration, timestamp) so watch-time can be aggregated downstream. Requires the Playback Reporting plugin to be installed on the server.",
        arguments: z.object({
          days: z
            .number()
            .int()
            .min(1)
            .max(365)
            .default(30)
            .describe("How many days of history to pull (default 30)"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20000)
            .default(5000)
            .describe("Max number of events to pull (newest first)"),
        }),
        // deno-lint-ignore no-explicit-any
        execute: async (args: any, context: any) => {
          const { jellyfinUrl, jellyfinApiKey } = context.globalArgs;
          const url = normUrl(jellyfinUrl);
          const hdrs = headers(jellyfinApiKey);
          const days = Math.trunc(args.days);
          const limit = Math.trunc(args.limit);

          // Map userId -> friendly name (best effort; non-fatal on failure).
          const userNames = new Map<string, string>();
          try {
            const usersResp = await fetch(`${url}/Users`, { headers: hdrs });
            if (usersResp.ok) {
              const users = await usersResp.json();
              for (const u of users ?? []) {
                if (u?.Id) userNames.set(u.Id, u.Name ?? null);
              }
            }
          } catch (_e) {
            // ignore — userName just stays null
          }

          // Read-only query against the plugin's activity table. `days`/`limit`
          // are integer-coerced above, so string interpolation is injection-safe.
          const sql =
            "SELECT rowid, DateCreated, UserId, ItemId, ItemType, ItemName, " +
            "ClientName, DeviceName, PlayDuration " +
            "FROM PlaybackActivity " +
            `WHERE DateCreated >= datetime('now', '-${days} days') ` +
            `ORDER BY DateCreated DESC LIMIT ${limit}`;

          const resp = await fetch(
            `${url}/user_usage_stats/submit_custom_query`,
            {
              method: "POST",
              headers: { ...hdrs, "Content-Type": "application/json" },
              body: JSON.stringify({
                CustomQueryString: sql,
                ReplaceUserId: false,
              }),
            },
          );

          if (resp.status === 404) {
            throw new Error(
              "Playback Reporting endpoint not found (404). Install the " +
                "'Playback Reporting' plugin in Jellyfin (Dashboard → Plugins) " +
                "and restart the server, then retry.",
            );
          }
          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(
              `Playback Reporting custom query failed: ${resp.status} ${body}`,
            );
          }

          const data = (await resp.json()) as CustomQueryResponse;
          const cols = data.colums ?? data.columns ?? [];
          const rows = data.results ?? [];
          const idx = (name: string) => cols.indexOf(name);
          // Fall back to fixed positions if the plugin omits column names.
          const col = {
            rowid: idx("rowid") >= 0 ? idx("rowid") : 0,
            date: idx("DateCreated") >= 0 ? idx("DateCreated") : 1,
            user: idx("UserId") >= 0 ? idx("UserId") : 2,
            item: idx("ItemId") >= 0 ? idx("ItemId") : 3,
            type: idx("ItemType") >= 0 ? idx("ItemType") : 4,
            name: idx("ItemName") >= 0 ? idx("ItemName") : 5,
            client: idx("ClientName") >= 0 ? idx("ClientName") : 6,
            device: idx("DeviceName") >= 0 ? idx("DeviceName") : 7,
            dur: idx("PlayDuration") >= 0 ? idx("PlayDuration") : 8,
          };

          const fetchedAt = new Date().toISOString();
          // The SQL `LIMIT` caps the newest N events; if we got exactly `limit`
          // rows there are almost certainly older events we didn't fetch.
          const truncated = rows.length >= limit;
          const handles = [];
          let totalSeconds = 0;

          for (const r of rows) {
            const rowid = String(r[col.rowid] ?? "");
            if (!rowid) continue;
            const itemType = String(r[col.type] ?? "");
            const itemName = String(r[col.name] ?? "");
            const userId = String(r[col.user] ?? "");
            const durRaw = r[col.dur];
            const playDurationSeconds = typeof durRaw === "number"
              ? durRaw
              : Number(durRaw ?? 0) || 0;
            totalSeconds += playDurationSeconds;

            const handle = await context.writeResource(
              "playbackSession",
              `s-${rowid}`,
              {
                id: rowid,
                dateCreated: String(r[col.date] ?? ""),
                userId,
                userName: userNames.get(userId) ?? null,
                itemId: r[col.item] != null ? String(r[col.item]) : null,
                itemType,
                itemName,
                seriesName: parseSeriesName(itemType, itemName),
                client: r[col.client] != null ? String(r[col.client]) : null,
                device: r[col.device] != null ? String(r[col.device]) : null,
                playDurationSeconds,
                truncated,
                fetchedAt,
              },
            );
            handles.push(handle);
          }

          if (truncated) {
            context.logger.warning(
              "Hit the {limit}-event cap — older events were dropped; raise `limit` to see the rest",
              { limit },
            );
          }

          context.logger.info(
            "Recorded {count} playback event(s) over {days}d ({hours}h total)",
            {
              count: handles.length,
              days,
              hours: Math.round((totalSeconds / 3600) * 10) / 10,
            },
          );

          return { dataHandles: handles };
        },
      },
    },
  ],
};
