/**
 * Unit tests for the @jamesakeech/audiobookshelf model.
 *
 * The model calls the Audiobookshelf REST API via global `fetch`, so each test
 * swaps `globalThis.fetch` for a small router that returns canned responses. No
 * live server or API key is required.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { assertEquals, assertRejects } from "@std/assert";
import { model } from "./audiobookshelf.ts";

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;

const BASE = "https://abs.test";
const GLOBAL = { baseUrl: BASE, apiKey: "tok" };

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

const LIBRARY = {
  id: "lib_1",
  name: "Audiobooks",
  mediaType: "book",
  provider: "audible",
  folders: [{ id: "f1", fullPath: "/audiobooks" }],
  createdAt: 1735689600000,
  lastUpdate: 1735776000000,
};

const ITEM = {
  id: "item_1",
  libraryId: "lib_1",
  mediaType: "book",
  isMissing: false,
  isInvalid: false,
  addedAt: 1735689600000,
  updatedAt: 1735776000000,
  media: {
    metadata: {
      title: "Project Hail Mary",
      subtitle: null,
      authors: [{ name: "Andy Weir" }],
      narrators: ["Ray Porter"],
      series: [{ name: "Standalone", sequence: "1" }],
      genres: ["Science Fiction"],
      publishedYear: "2021",
      isbn: "9780593135204",
      asin: "B08G9PRS1K",
    },
    coverPath: "/metadata/items/item_1/cover.jpg",
    duration: 58320,
    size: 512000000,
    numAudioFiles: 32,
  },
};

const PROGRESS = {
  id: "prog_1",
  libraryItemId: "item_1",
  episodeId: null,
  duration: 58320,
  progress: 0.42,
  currentTime: 24494,
  isFinished: false,
  startedAt: 1735689600000,
  finishedAt: null,
  lastUpdate: 1735776000000,
};

const SESSION = {
  id: "sess_1",
  userId: "user_1",
  libraryItemId: "item_1",
  episodeId: null,
  mediaType: "book",
  displayTitle: "Project Hail Mary",
  displayAuthor: "Andy Weir",
  duration: 58320,
  timeListening: 1800,
  currentTime: 24494,
  startedAt: 1735689600000,
  updatedAt: 1735776000000,
  deviceInfo: {
    clientName: "Audiobookshelf App",
    deviceType: "phone",
    osName: "iOS",
  },
};

Deno.test("libraries: one record per library with mapped fields", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: { libraries: [LIBRARY] } }), async () => {
    await methods.libraries.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "library");
  assertEquals(written[0].name, "lib_1");
  assertEquals(written[0].data.name, "Audiobooks");
  assertEquals(written[0].data.folderCount, 1);
  assertEquals(written[0].data.createdAt, "2025-01-01T00:00:00.000Z");
});

Deno.test("libraries: throws on API error and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ status: 401, body: "unauthorized" }), async () => {
    await assertRejects(
      () => methods.libraries.execute({}, context),
      Error,
      "HTTP 401",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("items: fans out across libraries and normalizes metadata", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (url.includes("/items")) return { body: { results: [ITEM] } };
    return { body: { libraries: [LIBRARY] } };
  }, async () => {
    await methods.items.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "item");
  assertEquals(written[0].name, "item_1");
  assertEquals(written[0].data.title, "Project Hail Mary");
  assertEquals(written[0].data.authors, ["Andy Weir"]);
  assertEquals(written[0].data.narrators, ["Ray Porter"]);
  assertEquals(written[0].data.series, ["Standalone #1"]);
  assertEquals(written[0].data.durationSeconds, 58320);
  assertEquals(written[0].data.coverPath, "/metadata/items/item_1/cover.jpg");
  assertEquals(written[0].data.isbn, "9780593135204");
  assertEquals(written[0].data.asin, "B08G9PRS1K");
});

Deno.test("items: falls back to singular author/narrator/series fields", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const minimal = {
    ...ITEM,
    media: {
      ...ITEM.media,
      metadata: {
        title: "Fallback Book",
        authorName: "Solo Author",
        narratorName: "Solo Narrator",
        seriesName: "Solo Series",
      },
    },
  };
  await withFetch((url) => {
    if (url.includes("/items")) return { body: { results: [minimal] } };
    return { body: { libraries: [LIBRARY] } };
  }, async () => {
    await methods.items.execute({}, context);
  });
  const d = getWrittenResources()[0].data;
  assertEquals(d.authors, ["Solo Author"]);
  assertEquals(d.narrators, ["Solo Narrator"]);
  assertEquals(d.series, ["Solo Series"]);
});

Deno.test("items: skips a library that fails and keeps items from the others", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const okLib = { ...LIBRARY, id: "lib_ok" };
  const badLib = { ...LIBRARY, id: "lib_bad" };
  await withFetch((url) => {
    if (url.includes("/libraries/lib_bad/items")) {
      return { status: 500, body: "boom" };
    }
    if (url.includes("/items")) return { body: { results: [ITEM] } };
    return { body: { libraries: [okLib, badLib] } };
  }, async () => {
    await methods.items.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].name, "item_1");
});

Deno.test("items: throws when every library fails and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (url.includes("/items")) return { status: 500, body: "boom" };
    return { body: { libraries: [LIBRARY] } };
  }, async () => {
    await assertRejects(
      () => methods.items.execute({}, context),
      Error,
      "Failed to fetch items from all",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("progress: one record per media progress entry", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: { mediaProgress: [PROGRESS] } }), async () => {
    await methods.progress.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "progress");
  assertEquals(written[0].name, "prog_1");
  assertEquals(written[0].data.itemId, "item_1");
  assertEquals(written[0].data.progress, 0.42);
  assertEquals(written[0].data.isFinished, false);
});

Deno.test("sessions: requests the given limit and maps device info", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  let requestedUrl = "";
  await withFetch((url) => {
    requestedUrl = url;
    return { body: { sessions: [SESSION], total: 1 } };
  }, async () => {
    await methods.sessions.execute({ limit: 25 }, context);
  });
  assertEquals(requestedUrl.includes("itemsPerPage=25"), true);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "session");
  assertEquals(written[0].name, "sess_1");
  assertEquals(written[0].data.timeListeningSeconds, 1800);
  assertEquals(
    written[0].data.device,
    "Audiobookshelf App / phone / iOS",
  );
  assertEquals(written[0].data.truncated, false);
});

Deno.test("sessions: marks truncated when the server reports more than the limit fetched", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(
    () => ({ body: { sessions: [SESSION], total: 500 } }),
    async () => {
      await methods.sessions.execute({ limit: 1 }, context);
    },
  );
  const written = getWrittenResources();
  assertEquals(written[0].data.truncated, true);
});

Deno.test("stats: aggregates totals, sorted days, and top items", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({
    body: {
      totalTime: 360000,
      today: 1800,
      days: { "2026-07-02": 3600, "2026-07-01": 1800 },
      items: {
        item_1: { timeListening: 5000 },
        item_2: { timeListening: 9000 },
      },
    },
  }), async () => {
    await methods.stats.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "stats");
  assertEquals(written[0].name, "current");
  assertEquals(written[0].data.totalTimeSeconds, 360000);
  // deno-lint-ignore no-explicit-any
  const days = written[0].data.days as any;
  assertEquals(days[0].date, "2026-07-01");
  assertEquals(days[1].date, "2026-07-02");
  // deno-lint-ignore no-explicit-any
  const topItems = written[0].data.topItems as any;
  assertEquals(topItems[0].itemId, "item_2");
  assertEquals(topItems[0].seconds, 9000);
});
