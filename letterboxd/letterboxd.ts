/**
 * Letterboxd diary model — read-only monitoring of a single user's Letterboxd
 * film diary via their public RSS feed (https://letterboxd.com/<username>/rss/).
 *
 * Letterboxd's official API is invite-only, but every public account exposes an
 * RSS feed of recent activity. This model parses that feed's diary entries — one
 * record per logged film watch, with the watched date, star rating, like flag,
 * rewatch flag, film title/year, TMDB id, poster and review text.
 *
 * IMPORTANT — the RSS feed is a ROLLING WINDOW of only the most recent activity
 * (~50 items, and it interleaves list activity that this model skips). Letterboxd
 * exposes no way to page back through older history via RSS, so `sync_diary` is
 * designed to be run on a schedule and *accumulate* watches over time: each watch
 * is written under a stable, idempotent instance name (its Letterboxd watch id),
 * so re-runs update in place and older runs are never lost.
 *
 * The feed carries no venue/cinema field — it simply reflects whatever the user
 * logs to their diary. (This model is typically used for cinema visits logged by
 * hand, complementing a home-server watch history from a separate source.)
 *
 * Read-only — this type never mutates Letterboxd state and needs no credentials.
 *
 * @module
 */
import { z } from "npm:zod@4";

const DEFAULT_BASE_URL = "https://letterboxd.com";
// Letterboxd rejects empty/unknown User-Agents; a Mozilla-prefixed UA is accepted.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; swamp-letterboxd/1.0; +https://github.com/jimmykeech/swamp-extensions)";

/** Global arguments shared by every method on a Letterboxd diary model. */
const GlobalArgsSchema = z.object({
  username: z.string().min(1).describe(
    "Letterboxd username (the <username> in letterboxd.com/<username>). The " +
      "account must be public for its RSS feed to be readable.",
  ),
  baseUrl: z.string().min(1).default(DEFAULT_BASE_URL).describe(
    "Letterboxd base URL (no trailing slash)",
  ),
  userAgent: z.string().min(1).default(DEFAULT_USER_AGENT).describe(
    "User-Agent header sent with the feed request (Letterboxd blocks unknown " +
      "agents, so keep the Mozilla prefix)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One diary entry — a logged film watch (factory: one record per watch). */
const DiaryEntrySchema = z.object({
  watchId: z.number().describe(
    "Letterboxd watch/review id (from the RSS guid)",
  ),
  guid: z.string().describe("Raw RSS guid, e.g. letterboxd-watch-1369875590"),
  filmTitle: z.string(),
  filmYear: z.number().nullable(),
  watchedDate: z.string().describe(
    "Diary date the film was watched (YYYY-MM-DD)",
  ),
  rating: z.number().nullable().describe(
    "Star rating 0.5–5, or null if unrated",
  ),
  liked: z.boolean(),
  rewatch: z.boolean(),
  tmdbId: z.number().nullable().describe(
    "TMDB movie id, for cross-referencing",
  ),
  letterboxdUri: z.string().describe(
    "Canonical letterboxd.com URL for the entry",
  ),
  posterUrl: z.string().nullable(),
  review: z.string().nullable().describe("Review text, if the entry has one"),
  publishedAt: z.iso.datetime().describe(
    "RSS pubDate (when the entry was logged)",
  ),
  truncated: z.boolean().describe(
    "True when this pull returned a full window (older diary entries may be " +
      "unfetched — poll on a schedule to accumulate)",
  ),
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

/** Trim a response body so it is useful in a message without flooding logs. */
function summarize(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** Parse an optional numeric string, returning null when absent or invalid. */
function toNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A Letterboxd RSS "Yes"/"No" flag as a boolean. */
function toBool(v: unknown): boolean {
  return String(v ?? "").trim().toLowerCase() === "yes";
}

/** The trailing numeric id from a guid like `letterboxd-watch-1369875590`. */
function watchIdFromGuid(guid: string): number | null {
  const m = guid.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/** Extract the poster URL and cleaned review text from an entry's description. */
function parseDescription(
  desc: string | undefined,
): { posterUrl: string | null; review: string | null } {
  if (!desc) return { posterUrl: null, review: null };
  const posterUrl = desc.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? null;
  const text = desc
    .replace(/<img[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Drop the boilerplate "Watched on <date>." sentence Letterboxd always adds.
    .replace(/Watched on [^.]*\.\s*/i, "")
    .trim();
  return { posterUrl, review: text.length > 0 ? text : null };
}

// --- Minimal, dependency-free RSS parsing (the feed is small and regular) ---

type RawItem = {
  link?: string;
  guid?: string;
  pubDate?: string;
  watchedDate?: string;
  rewatch?: string;
  filmTitle?: string;
  filmYear?: string;
  memberRating?: string;
  memberLike?: string;
  movieId?: string;
  description?: string;
};

/** Decode the small set of XML entities that appear in Letterboxd feed text. */
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * Read the text content of the first `<tag>` (with or without a namespace
 * prefix and regardless of attributes) inside an item block. Returns undefined
 * when the tag is absent.
 */
function tag(block: string, name: string): string | undefined {
  const re = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    "i",
  );
  const m = block.match(re);
  return m ? decodeEntities(m[1]).trim() : undefined;
}

/** Split the feed into item blocks and lift each one into a RawItem. */
function parseItems(xml: string): RawItem[] {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return blocks.map((b) => ({
    link: tag(b, "link"),
    guid: tag(b, "guid"),
    pubDate: tag(b, "pubDate"),
    watchedDate: tag(b, "watchedDate"),
    rewatch: tag(b, "rewatch"),
    filmTitle: tag(b, "filmTitle"),
    filmYear: tag(b, "filmYear"),
    memberRating: tag(b, "memberRating"),
    memberLike: tag(b, "memberLike"),
    movieId: tag(b, "movieId"),
    description: tag(b, "description"),
  }));
}

/**
 * Fetch and parse the user's RSS feed, returning its items, throwing a
 * descriptive error on any transport error or non-2xx response — before any
 * data is written.
 */
async function fetchFeedItems(ctx: ExecContext): Promise<RawItem[]> {
  const { username, baseUrl, userAgent } = ctx.globalArgs;
  const url = `${baseUrl}/${encodeURIComponent(username)}/rss/`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      "Accept": "application/rss+xml, text/xml",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind = isTransient(res.status) ? "transient" : "permanent";
    const hint = res.status === 404
      ? " (is the username correct and the account public?)"
      : "";
    throw new Error(
      `Letterboxd feed fetch failed (${kind}): HTTP ${res.status}${hint} — ${
        summarize(body)
      }`,
    );
  }
  return parseItems(await res.text());
}

/** Model definition for monitoring a user's Letterboxd film diary. */
export const model = {
  type: "@jamesakeech/letterboxd",
  version: "2026.07.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "diaryEntry": {
      description:
        "A logged film watch from the user's diary (one record per watch; " +
        "accumulate over time)",
      schema: DiaryEntrySchema,
      lifetime: "infinite",
      garbageCollection: 20000,
    },
  },
  methods: {
    sync_diary: {
      description:
        "Fetch the user's Letterboxd RSS feed and record each diary film watch. " +
        "The feed is a rolling window of recent activity (list entries are " +
        "skipped), so run on a schedule to accumulate history. Writes one " +
        "`diaryEntry` per watch, keyed by its Letterboxd id so re-runs are " +
        "idempotent. Pass `sinceDate` to skip watches logged before a date.",
      arguments: z.object({
        limit: z.number().int().min(1).max(200).default(50).describe(
          "Max diary watches to record from this pull",
        ),
        sinceDate: z.string().optional().describe(
          "Only record watches with watchedDate on/after this YYYY-MM-DD date",
        ),
      }),
      execute: async (
        args: { limit: number; sinceDate?: string },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        ctx.logger?.info("Fetching Letterboxd diary for {user}", {
          user: ctx.globalArgs.username,
        });
        const fetchedAt = new Date().toISOString();
        const items = await fetchFeedItems(ctx);
        // Keep only film watches (they carry a watchedDate + filmTitle); this
        // drops list/other activity that shares the feed.
        const watches = items.filter(
          (it) => it.watchedDate && it.filmTitle && it.guid,
        );
        // A full window means older watches may exist beyond the feed's horizon.
        const truncated = watches.length >= args.limit;
        const handles: DataHandle[] = [];
        for (const it of watches) {
          if (handles.length >= args.limit) break;
          const watchedDate = it.watchedDate as string;
          if (args.sinceDate && watchedDate < args.sinceDate) continue;
          const guid = it.guid as string;
          const watchId = watchIdFromGuid(guid);
          if (watchId === null) continue;
          const { posterUrl, review } = parseDescription(it.description);
          const record: z.infer<typeof DiaryEntrySchema> = {
            watchId,
            guid,
            filmTitle: it.filmTitle as string,
            filmYear: toNumber(it.filmYear),
            watchedDate,
            rating: toNumber(it.memberRating),
            liked: toBool(it.memberLike),
            rewatch: toBool(it.rewatch),
            tmdbId: toNumber(it.movieId),
            letterboxdUri: it.link ?? "",
            posterUrl,
            review,
            publishedAt: it.pubDate
              ? new Date(it.pubDate).toISOString()
              : fetchedAt,
            truncated,
            fetchedAt,
          };
          handles.push(
            await ctx.writeResource("diaryEntry", `d-${watchId}`, record),
          );
        }
        ctx.logger?.info("Recorded {count} diary watch(es)", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
