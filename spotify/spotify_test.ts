/**
 * Unit tests for the @jamesakeech/spotify model.
 *
 * Every data method first exchanges the refresh token for an access token at
 * accounts.spotify.com, then calls api.spotify.com, so the fetch stub routes by
 * URL and answers both. No live Spotify app or tokens are required.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { model } from "./spotify.ts";

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;

const GLOBAL = {
  clientId: "cid",
  clientSecret: "sec",
  refreshToken: "rt",
  redirectUri: "http://127.0.0.1:8888/callback",
};

type RouteResult = { status?: number; body?: unknown };

/** Install a fetch stub that routes by URL for the duration of `fn`. */
async function withFetch(
  router: (url: string) => RouteResult,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = {} } = router(url);
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return Promise.resolve(
      new Response(payload, {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const isToken = (url: string) => url.includes("accounts.spotify.com/api/token");

const TRACK = {
  id: "t1",
  name: "Digital Love",
  duration_ms: 301_000,
  popularity: 77,
  artists: [{ id: "a1", name: "Daft Punk" }],
  album: { id: "al1", name: "Discovery", release_date: "2001-03-12" },
};

Deno.test("authorize_url: writes a well-formed authorization URL", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await methods.authorize_url.execute({}, context);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "authUrl");
  assertEquals(written[0].name, "current");
  const url = written[0].data.url as string;
  assertStringIncludes(url, "accounts.spotify.com/authorize");
  assertStringIncludes(url, "client_id=cid");
  assertStringIncludes(url, "user-read-recently-played");
  assertStringIncludes(url, "response_type=code");
});

Deno.test("authorize: exchanges the code and writes the refresh token", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(
    () => ({ body: { refresh_token: "new-refresh", scope: "user-top-read" } }),
    async () => {
      await methods.authorize.execute({ code: "abc" }, context);
    },
  );
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "credential");
  assertEquals(written[0].data.token, "new-refresh");
  assertEquals(written[0].data.scope, "user-top-read");
});

Deno.test("authorize: throws when Spotify returns no refresh_token", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: { scope: "user-top-read" } }), async () => {
    await assertRejects(
      () => methods.authorize.execute({ code: "used" }, context),
      Error,
      "no refresh_token",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("recent_plays: writes one play per item, keyed by play time", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isToken(url)) return { body: { access_token: "at" } };
    return {
      body: {
        items: [{
          track: TRACK,
          played_at: "2026-07-07T03:01:19.000Z",
          context: { type: "playlist" },
        }],
      },
    };
  }, async () => {
    await methods.recent_plays.execute({ limit: 50 }, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "play");
  assertEquals(written[0].name, `p-${Date.parse("2026-07-07T03:01:19.000Z")}`);
  assertEquals(written[0].data.trackName, "Digital Love");
  assertEquals(written[0].data.primaryArtist, "Daft Punk");
  assertEquals(written[0].data.artistIds, ["a1"]);
  assertEquals(written[0].data.albumName, "Discovery");
  assertEquals(written[0].data.contextType, "playlist");
  assertEquals(written[0].data.truncated, false);
});

Deno.test("recent_plays: throws with a clear hint when refreshToken is unset", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...GLOBAL, refreshToken: "" },
  });
  await assertRejects(
    () => methods.recent_plays.execute({ limit: 50 }, context),
    Error,
    "No refreshToken configured",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("recent_plays: propagates a token-refresh failure and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isToken(url)) return { status: 400, body: "invalid_grant" };
    return { body: { items: [] } };
  }, async () => {
    await assertRejects(
      () => methods.recent_plays.execute({ limit: 50 }, context),
      Error,
      "token refresh failed",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("top_artists: writes one record per artist with rank and followers", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isToken(url)) return { body: { access_token: "at" } };
    return {
      body: {
        items: [
          {
            id: "a1",
            name: "Daft Punk",
            genres: ["french house"],
            popularity: 82,
            followers: { total: 9_000_000 },
          },
          { id: "a2", name: "Justice", genres: [], popularity: 70, followers: { total: 2_000_000 } },
        ],
      },
    };
  }, async () => {
    await methods.top_artists.execute(
      { timeRange: "short_term", limit: 50 },
      context,
    );
  });
  const written = getWrittenResources();
  assertEquals(written.length, 2);
  assertEquals(written[0].specName, "topArtist");
  assertEquals(written[0].name, "short_term-a1");
  assertEquals(written[0].data.rank, 1);
  assertEquals(written[0].data.followers, 9_000_000);
  assertEquals(written[0].data.genres, ["french house"]);
  assertEquals(written[0].data.truncated, false);
  assertEquals(written[1].data.rank, 2);
});

Deno.test("top_tracks: writes one record per track with rank and album", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isToken(url)) return { body: { access_token: "at" } };
    return { body: { items: [TRACK] } };
  }, async () => {
    await methods.top_tracks.execute(
      { timeRange: "long_term", limit: 50 },
      context,
    );
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "topTrack");
  assertEquals(written[0].name, "long_term-t1");
  assertEquals(written[0].data.rank, 1);
  assertEquals(written[0].data.primaryArtist, "Daft Punk");
  assertEquals(written[0].data.albumName, "Discovery");
  assertEquals(written[0].data.durationMs, 301_000);
  assertEquals(written[0].data.truncated, false);
});
