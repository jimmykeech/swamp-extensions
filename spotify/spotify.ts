/**
 * Spotify listening model — read-only monitoring of a single user's Spotify
 * listening activity via the Spotify Web API (https://developer.spotify.com).
 *
 * Covers recently-played tracks (accumulate over time to build history) and
 * Spotify's own top-artists / top-tracks rankings. Includes two one-time OAuth
 * helper methods (`authorize_url`, `authorize`) to obtain the refresh token the
 * data methods need. Read-only — this type never mutates Spotify state.
 *
 * IMPORTANT — Spotify does not expose arbitrary listening history. The
 * recently-played endpoint returns only the last ~50 plays (a rolling window),
 * so `recent_plays` is designed to be run on a schedule and *accumulate* plays
 * over time (each play is written under a stable, idempotent instance name).
 * The top-artists/top-tracks endpoints give ranked lists over ~4-week,
 * ~6-month, and ~1-year windows, but no per-play timestamps and no albums.
 *
 * @module
 */
import { z } from "npm:zod@4";

const SCOPES = "user-read-recently-played user-top-read";
const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
const DEFAULT_REDIRECT = "http://127.0.0.1:8888/callback";

/** Global arguments shared by every method on a Spotify listening model. */
const GlobalArgsSchema = z.object({
  clientId: z.string().min(1).describe(
    "Spotify app Client ID (developer.spotify.com → your app → Settings).",
  ),
  clientSecret: z.string().min(1).meta({ sensitive: true }).describe(
    "Spotify app Client Secret. Source from a vault.",
  ),
  refreshToken: z.string().meta({ sensitive: true }).default("").describe(
    "OAuth refresh token obtained via the `authorize` method. Required for the " +
      "data methods; leave empty until you have run the auth flow. Source from a vault.",
  ),
  redirectUri: z.string().min(1).default(DEFAULT_REDIRECT).describe(
    "Redirect URI registered in the Spotify app settings. Must match exactly " +
      "in `authorize_url` and `authorize`.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** The authorization URL to open once in a browser (instance "current"). */
const AuthUrlSchema = z.object({
  url: z.string().describe(
    "Open this in a browser, approve, then copy the " +
      "`code` query param from the redirect URL",
  ),
  redirectUri: z.string(),
  scopes: z.string(),
  fetchedAt: z.iso.datetime(),
});

/** The refresh token produced by `authorize` (instance "current", secret). */
const CredentialSchema = z.object({
  refreshToken: z.string().meta({ sensitive: true }).describe(
    "Store this in your vault and wire it into the model's refreshToken arg",
  ),
  scope: z.string(),
  fetchedAt: z.iso.datetime(),
});

/** One recently-played track (factory: one record per play, keyed by play time). */
const PlaySchema = z.object({
  playedAt: z.iso.datetime().describe("When the track finished playing"),
  playedAtMs: z.number().describe("playedAt as Unix milliseconds"),
  trackId: z.string().nullable(),
  trackName: z.string(),
  durationMs: z.number(),
  artistIds: z.array(z.string()),
  artistNames: z.array(z.string()),
  primaryArtist: z.string().nullable(),
  albumId: z.string().nullable(),
  albumName: z.string().nullable(),
  albumReleaseDate: z.string().nullable(),
  contextType: z.string().nullable().describe(
    "Playback context: album, playlist, artist, …",
  ),
  truncated: z.boolean().describe(
    "True when this pull returned a full page (older plays may be unfetched)",
  ),
  fetchedAt: z.iso.datetime(),
});

/** One of the user's top artists for a time range (factory: one per artist). */
const TopArtistSchema = z.object({
  timeRange: z.string().describe(
    "short_term (~4wk), medium_term (~6mo), long_term (~1yr)",
  ),
  rank: z.number().describe("1-based position within the time range"),
  artistId: z.string(),
  name: z.string(),
  genres: z.array(z.string()),
  popularity: z.number(),
  followers: z.number(),
  truncated: z.boolean().describe(
    "True when Spotify reports more top items than this pull returned",
  ),
  fetchedAt: z.iso.datetime(),
});

/** One of the user's top tracks for a time range (factory: one per track). */
const TopTrackSchema = z.object({
  timeRange: z.string().describe(
    "short_term (~4wk), medium_term (~6mo), long_term (~1yr)",
  ),
  rank: z.number().describe("1-based position within the time range"),
  trackId: z.string(),
  name: z.string(),
  artistIds: z.array(z.string()),
  artistNames: z.array(z.string()),
  primaryArtist: z.string().nullable(),
  albumId: z.string().nullable(),
  albumName: z.string().nullable(),
  popularity: z.number(),
  durationMs: z.number(),
  truncated: z.boolean().describe(
    "True when Spotify reports more top items than this pull returned",
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

/** Trim an API error body so it is useful in a message without flooding logs. */
function summarize(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** HTTP Basic auth header for the token endpoint (client_id:client_secret). */
function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

/**
 * Exchange the refresh token for a short-lived access token. Throws a
 * descriptive error (never leaking the secret) on any non-2xx response.
 */
async function getAccessToken(ctx: ExecContext): Promise<string> {
  const { clientId, clientSecret, refreshToken } = ctx.globalArgs;
  if (!refreshToken) {
    throw new Error(
      "No refreshToken configured. Run `authorize_url`, approve in a browser, " +
        "then run `authorize` with the returned code, store the refresh token " +
        "in your vault, and set the model's refreshToken argument.",
    );
  }
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      "Authorization": basicAuth(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind = isTransient(res.status) ? "transient" : "permanent";
    throw new Error(
      `Spotify token refresh failed (${kind}): HTTP ${res.status} — ${
        summarize(body)
      }`,
    );
  }
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Spotify token refresh returned no access_token");
  }
  return json.access_token;
}

/**
 * GET a Spotify API path with a bearer token and parse JSON, throwing a
 * descriptive error on any non-2xx response — before any data is written.
 */
async function spotifyGet<T>(
  accessToken: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind = isTransient(res.status) ? "transient" : "permanent";
    throw new Error(
      `Spotify GET ${path} failed (${kind}): HTTP ${res.status} — ${
        summarize(body)
      }`,
    );
  }
  return await res.json() as T;
}

// --- Raw response shapes (subsets of the Spotify Web API) ---

type RawArtistRef = { id?: string; name?: string };
type RawAlbum = { id?: string; name?: string; release_date?: string };
type RawTrack = {
  id?: string;
  name?: string;
  duration_ms?: number;
  popularity?: number;
  artists?: RawArtistRef[];
  album?: RawAlbum;
};
type RawPlayItem = {
  track?: RawTrack;
  played_at?: string;
  context?: { type?: string } | null;
};
type RawRecentlyPlayed = {
  items?: RawPlayItem[];
  cursors?: { after?: string };
};
type RawTopArtist = {
  id?: string;
  name?: string;
  genres?: string[];
  popularity?: number;
  followers?: { total?: number };
};
type RawTopResponse<T> = { items?: T[]; total?: number };

/** Map a raw track's artists to parallel id/name arrays plus a primary name. */
function artistArrays(
  artists: RawArtistRef[] | undefined,
): { ids: string[]; names: string[]; primary: string | null } {
  const list = artists ?? [];
  const ids = list.map((a) => a.id ?? "").filter(Boolean);
  const names = list.map((a) => a.name ?? "").filter(Boolean);
  return { ids, names, primary: names[0] ?? null };
}

const TIME_RANGES = ["short_term", "medium_term", "long_term"] as const;

/** Model definition for monitoring a user's Spotify listening activity. */
export const model = {
  type: "@jamesakeech/spotify",
  version: "2026.07.07.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "authUrl": {
      description: "The one-time OAuth authorization URL to open in a browser",
      schema: AuthUrlSchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
    "credential": {
      description: "The OAuth refresh token produced by `authorize` (secret)",
      schema: CredentialSchema,
      lifetime: "infinite",
      garbageCollection: 5,
      sensitiveOutput: true,
    },
    "play": {
      description:
        "A recently-played track (one record per play; accumulate over time)",
      schema: PlaySchema,
      lifetime: "infinite",
      garbageCollection: 5000,
    },
    "topArtist": {
      description: "A top artist for a time range (one record per artist)",
      schema: TopArtistSchema,
      lifetime: "infinite",
      garbageCollection: 300,
    },
    "topTrack": {
      description: "A top track for a time range (one record per track)",
      schema: TopTrackSchema,
      lifetime: "infinite",
      garbageCollection: 300,
    },
  },
  methods: {
    authorize_url: {
      description:
        "Build the one-time Spotify OAuth authorization URL. Open it in a " +
        "browser, approve access, then copy the `code` query parameter from " +
        "the redirect URL and pass it to `authorize`. Needs only clientId + " +
        "redirectUri (no refresh token).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { clientId, redirectUri } = ctx.globalArgs;
        const state = crypto.randomUUID();
        const url = `${ACCOUNTS}/authorize?` +
          new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            scope: SCOPES,
            redirect_uri: redirectUri,
            state,
          }).toString();
        const record: z.infer<typeof AuthUrlSchema> = {
          url,
          redirectUri,
          scopes: SCOPES,
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("authUrl", "current", record);
        ctx.logger?.info(
          "Open this URL to authorize, then run `authorize` with the code: {url}",
          { url },
        );
        return { dataHandles: [handle] };
      },
    },
    authorize: {
      description:
        "Exchange an authorization `code` (from the redirect after " +
        "`authorize_url`) for a refresh token. Writes the refresh token as a " +
        "sensitive `credential` resource — read it with `swamp data get`, then " +
        "store it in your vault and set the model's refreshToken argument.",
      arguments: z.object({
        code: z.string().min(1).describe(
          "The `code` query parameter from the redirect URL",
        ),
      }),
      execute: async (
        args: { code: string },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const { clientId, clientSecret, redirectUri } = ctx.globalArgs;
        ctx.logger?.info("Exchanging authorization code for a refresh token");
        const res = await fetch(`${ACCOUNTS}/api/token`, {
          method: "POST",
          headers: {
            "Authorization": basicAuth(clientId, clientSecret),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: args.code,
            redirect_uri: redirectUri,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const kind = isTransient(res.status) ? "transient" : "permanent";
          throw new Error(
            `Spotify code exchange failed (${kind}): HTTP ${res.status} — ${
              summarize(body)
            }`,
          );
        }
        const json = await res.json() as {
          refresh_token?: string;
          scope?: string;
        };
        if (!json.refresh_token) {
          throw new Error(
            "Spotify code exchange returned no refresh_token (was the code " +
              "already used, or the redirect_uri mismatched?)",
          );
        }
        const record: z.infer<typeof CredentialSchema> = {
          refreshToken: json.refresh_token,
          scope: json.scope ?? SCOPES,
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("credential", "current", record);
        ctx.logger?.info(
          "Refresh token acquired. Read it with `swamp data get` and store it " +
            "in your vault (the value is not printed here).",
        );
        return { dataHandles: [handle] };
      },
    },
    recent_plays: {
      description:
        "Pull the current user's recently-played tracks (Spotify returns only " +
        "the last ~50, a rolling window). Writes one `play` record per track, " +
        "keyed by play time so re-runs are idempotent — run on a schedule to " +
        "accumulate history. Pass `after` (Unix ms) to fetch only newer plays.",
      arguments: z.object({
        limit: z.number().int().min(1).max(50).default(50).describe(
          "Max plays to fetch (Spotify caps this endpoint at 50)",
        ),
        after: z.number().int().min(0).optional().describe(
          "Only return plays strictly after this Unix-millisecond timestamp",
        ),
      }),
      execute: async (
        args: { limit: number; after?: number },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const accessToken = await getAccessToken(ctx);
        const params = new URLSearchParams({ limit: String(args.limit) });
        if (typeof args.after === "number") {
          params.set("after", String(args.after));
        }
        ctx.logger?.info("Fetching up to {limit} recent play(s)", {
          limit: args.limit,
        });
        const fetchedAt = new Date().toISOString();
        const res = await spotifyGet<RawRecentlyPlayed>(
          accessToken,
          `/me/player/recently-played?${params}`,
        );
        const items = res.items ?? [];
        // Spotify hard-caps this endpoint; a full page means older plays may
        // not have been returned. Poll frequently (and/or pass `after`) to fill.
        const truncated = items.length >= args.limit;
        const handles: DataHandle[] = [];
        for (const it of items) {
          const playedAt = it.played_at ?? "";
          const playedAtMs = Date.parse(playedAt);
          if (!Number.isFinite(playedAtMs)) continue;
          const track = it.track ?? {};
          const { ids, names, primary } = artistArrays(track.artists);
          const record: z.infer<typeof PlaySchema> = {
            playedAt: new Date(playedAtMs).toISOString(),
            playedAtMs,
            trackId: track.id ?? null,
            trackName: track.name ?? "",
            durationMs: track.duration_ms ?? 0,
            artistIds: ids,
            artistNames: names,
            primaryArtist: primary,
            albumId: track.album?.id ?? null,
            albumName: track.album?.name ?? null,
            albumReleaseDate: track.album?.release_date ?? null,
            contextType: it.context?.type ?? null,
            truncated,
            fetchedAt,
          };
          handles.push(
            await ctx.writeResource("play", `p-${playedAtMs}`, record),
          );
        }
        ctx.logger?.info("Recorded {count} play(s)", { count: handles.length });
        return { dataHandles: handles };
      },
    },
    top_artists: {
      description:
        "Pull the user's top artists for a time range (short_term ~4wk, " +
        "medium_term ~6mo, long_term ~1yr). Writes one `topArtist` record per " +
        "artist with its rank, genres, popularity and follower count.",
      arguments: z.object({
        timeRange: z.enum(TIME_RANGES).default("medium_term").describe(
          "short_term (~4 weeks), medium_term (~6 months), long_term (~1 year)",
        ),
        limit: z.number().int().min(1).max(50).default(50).describe(
          "Max artists to fetch (Spotify caps this at 50)",
        ),
      }),
      execute: async (
        args: { timeRange: string; limit: number },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const accessToken = await getAccessToken(ctx);
        ctx.logger?.info("Fetching top {limit} artists ({range})", {
          limit: args.limit,
          range: args.timeRange,
        });
        const fetchedAt = new Date().toISOString();
        const res = await spotifyGet<RawTopResponse<RawTopArtist>>(
          accessToken,
          `/me/top/artists?time_range=${args.timeRange}&limit=${args.limit}`,
        );
        const items = res.items ?? [];
        const truncated = (res.total ?? items.length) > items.length;
        const handles: DataHandle[] = [];
        for (let i = 0; i < items.length; i++) {
          const a = items[i];
          const artistId = a.id ?? "";
          const record: z.infer<typeof TopArtistSchema> = {
            timeRange: args.timeRange,
            rank: i + 1,
            artistId,
            name: a.name ?? "",
            genres: a.genres ?? [],
            popularity: a.popularity ?? 0,
            followers: a.followers?.total ?? 0,
            truncated,
            fetchedAt,
          };
          handles.push(
            await ctx.writeResource(
              "topArtist",
              `${args.timeRange}-${artistId}`,
              record,
            ),
          );
        }
        ctx.logger?.info("Recorded {count} top artist(s)", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    top_tracks: {
      description:
        "Pull the user's top tracks for a time range (short_term ~4wk, " +
        "medium_term ~6mo, long_term ~1yr). Writes one `topTrack` record per " +
        "track with its rank, artists, album, popularity and duration.",
      arguments: z.object({
        timeRange: z.enum(TIME_RANGES).default("medium_term").describe(
          "short_term (~4 weeks), medium_term (~6 months), long_term (~1 year)",
        ),
        limit: z.number().int().min(1).max(50).default(50).describe(
          "Max tracks to fetch (Spotify caps this at 50)",
        ),
      }),
      execute: async (
        args: { timeRange: string; limit: number },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const accessToken = await getAccessToken(ctx);
        ctx.logger?.info("Fetching top {limit} tracks ({range})", {
          limit: args.limit,
          range: args.timeRange,
        });
        const fetchedAt = new Date().toISOString();
        const res = await spotifyGet<RawTopResponse<RawTrack>>(
          accessToken,
          `/me/top/tracks?time_range=${args.timeRange}&limit=${args.limit}`,
        );
        const items = res.items ?? [];
        const truncated = (res.total ?? items.length) > items.length;
        const handles: DataHandle[] = [];
        for (let i = 0; i < items.length; i++) {
          const t = items[i];
          const trackId = t.id ?? "";
          const { ids, names, primary } = artistArrays(t.artists);
          const record: z.infer<typeof TopTrackSchema> = {
            timeRange: args.timeRange,
            rank: i + 1,
            trackId,
            name: t.name ?? "",
            artistIds: ids,
            artistNames: names,
            primaryArtist: primary,
            albumId: t.album?.id ?? null,
            albumName: t.album?.name ?? null,
            popularity: t.popularity ?? 0,
            durationMs: t.duration_ms ?? 0,
            truncated,
            fetchedAt,
          };
          handles.push(
            await ctx.writeResource(
              "topTrack",
              `${args.timeRange}-${trackId}`,
              record,
            ),
          );
        }
        ctx.logger?.info("Recorded {count} top track(s)", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
