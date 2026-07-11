/**
 * Unit tests for the @jamesakeech/jellyfin-playback extension.
 *
 * The methods call the Jellyfin HTTP API (and the Playback Reporting plugin's
 * custom-query endpoint) via global `fetch`, so each test swaps
 * `globalThis.fetch` for a small URL router returning canned responses. No live
 * server or API key is required.
 *
 * The extension exports `export const extension` whose `methods` is an array of
 * single-key objects (`[{ watch_history: {...} }, { playback_sessions: {...} }]`),
 * so the tests flatten it into a name → method lookup first.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { assertEquals, assertRejects } from "@std/assert";
import { extension } from "./jellyfin-playback.ts";

// deno-lint-ignore no-explicit-any
const methods: Record<string, any> = {};
// deno-lint-ignore no-explicit-any
for (const entry of extension.methods as any[]) Object.assign(methods, entry);

const BASE = "https://jellyfin.test";
const GLOBAL = { jellyfinUrl: BASE, jellyfinApiKey: "tok" };

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

const USERS = [{ Id: "u1", Name: "alice" }];

// A recently played episode — well within any sane `days` cutoff.
const PLAYED_ITEM = {
  Id: "i1",
  Type: "Episode",
  Name: "Some Episode",
  SeriesName: "Some Show",
  SeriesId: "series1",
  SeriesPrimaryImageTag: "seriestag",
  ImageTags: { Primary: "episodetag" },
  RunTimeTicks: 6_000_000_000, // 600 seconds
  Genres: ["Drama"],
  UserData: {
    LastPlayedDate: new Date().toISOString(),
    PlayCount: 3,
  },
};

// Column order the plugin's submit_custom_query returns for our SELECT.
const PB_COLUMNS = [
  "rowid",
  "DateCreated",
  "UserId",
  "ItemId",
  "ItemType",
  "ItemName",
  "ClientName",
  "DeviceName",
  "PlayDuration",
];
const PB_ROW = [
  "1",
  "2026-07-07 03:01:19",
  "u1",
  "itm1",
  "Episode",
  "House of the Dragon - s01e02 - Queen's Landing",
  "Jellyfin Web",
  "Firefox",
  459,
];

const isQuery = (url: string) =>
  url.includes("/user_usage_stats/submit_custom_query");
const isItems = (url: string) => url.includes("/Items");

Deno.test("watch_history: writes one watchedItem per played item with mapped fields", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isItems(url)) {
      return { body: { Items: [PLAYED_ITEM], TotalRecordCount: 1 } };
    }
    return { body: USERS };
  }, async () => {
    await methods.watch_history.execute({ days: 30 }, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "watchedItem");
  assertEquals(written[0].name, "u1-i1");
  assertEquals(written[0].data.id, "u1:i1");
  assertEquals(written[0].data.userName, "alice");
  assertEquals(written[0].data.seriesName, "Some Show");
  assertEquals(written[0].data.runtimeSeconds, 600);
  assertEquals(written[0].data.playCount, 3);
  assertEquals(written[0].data.genres, ["Drama"]);
  assertEquals(written[0].data.primaryImageTag, "episodetag");
  assertEquals(written[0].data.seriesId, "series1");
  assertEquals(written[0].data.seriesPrimaryImageTag, "seriestag");
});

Deno.test("watch_history: skips items whose last play is older than the cutoff", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const old = {
    ...PLAYED_ITEM,
    UserData: { LastPlayedDate: "2000-01-01T00:00:00.000Z", PlayCount: 1 },
  };
  await withFetch((url) => {
    if (isItems(url)) return { body: { Items: [old], TotalRecordCount: 1 } };
    return { body: USERS };
  }, async () => {
    await methods.watch_history.execute({ days: 30 }, context);
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("watch_history: throws on user-list failure and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ status: 500, body: "boom" }), async () => {
    await assertRejects(
      () => methods.watch_history.execute({ days: 30 }, context),
      Error,
      "Failed to get users",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("playback_sessions: writes one playbackSession per event, parses series, not truncated", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isQuery(url)) return { body: { columns: PB_COLUMNS, results: [PB_ROW] } };
    return { body: [{ Id: "u1", Name: "jamesk" }] };
  }, async () => {
    await methods.playback_sessions.execute({ days: 30, limit: 5000 }, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "playbackSession");
  assertEquals(written[0].name, "s-1");
  assertEquals(written[0].data.userName, "jamesk");
  assertEquals(written[0].data.seriesName, "House of the Dragon");
  assertEquals(written[0].data.client, "Jellyfin Web");
  assertEquals(written[0].data.device, "Firefox");
  assertEquals(written[0].data.playDurationSeconds, 459);
  assertEquals(written[0].data.truncated, false);
});

Deno.test("playback_sessions: marks truncated when the row count hits the limit", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isQuery(url)) return { body: { columns: PB_COLUMNS, results: [PB_ROW] } };
    return { body: [{ Id: "u1", Name: "jamesk" }] };
  }, async () => {
    await methods.playback_sessions.execute({ days: 30, limit: 1 }, context);
  });
  assertEquals(getWrittenResources()[0].data.truncated, true);
});

Deno.test("playback_sessions: still writes when the user lookup fails (best-effort name)", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isQuery(url)) return { body: { columns: PB_COLUMNS, results: [PB_ROW] } };
    return { status: 500, body: "boom" };
  }, async () => {
    await methods.playback_sessions.execute({ days: 30, limit: 5000 }, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].data.userName, null);
});

Deno.test("playback_sessions: throws a plugin hint on 404 and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (isQuery(url)) return { status: 404, body: "not found" };
    return { body: [{ Id: "u1", Name: "jamesk" }] };
  }, async () => {
    await assertRejects(
      () => methods.playback_sessions.execute({ days: 30, limit: 5000 }, context),
      Error,
      "Playback Reporting",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});
