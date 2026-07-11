/**
 * Unit tests for the @jamesakeech/letterboxd model.
 *
 * `sync_diary` GETs a single RSS feed, so the fetch stub returns a canned XML
 * document exercising a rated watch, an unrated watch, a list entry (which must
 * be skipped), and the HTTP error path. No live Letterboxd account is required.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { assertEquals, assertRejects } from "@std/assert";
import { model } from "./letterboxd.ts";

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;

const GLOBAL = {
  username: "dave",
  baseUrl: "https://letterboxd.com",
  userAgent: "test-agent",
};

const FEED = `<?xml version='1.0' encoding='utf-8'?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">
  <channel>
    <title>Letterboxd - Dave</title>
    <link>https://letterboxd.com/dave/</link>
    <item>
      <title>Toy Story 4, 2019 - ★★★½</title>
      <link>https://letterboxd.com/dave/film/toy-story-4/1/</link>
      <guid isPermaLink="false">letterboxd-watch-1369875590</guid>
      <pubDate>Sat, 27 Jun 2026 00:17:04 +1200</pubDate>
      <letterboxd:watchedDate>2026-06-25</letterboxd:watchedDate>
      <letterboxd:rewatch>Yes</letterboxd:rewatch>
      <letterboxd:filmTitle>Toy Story 4</letterboxd:filmTitle>
      <letterboxd:filmYear>2019</letterboxd:filmYear>
      <letterboxd:memberRating>3.5</letterboxd:memberRating>
      <letterboxd:memberLike>Yes</letterboxd:memberLike>
      <tmdb:movieId>301528</tmdb:movieId>
      <description><![CDATA[ <p><img src="https://a.ltrbxd.com/poster.jpg"/></p> <p>A near-perfect send-off.</p> <p>Watched on Thursday June 25, 2026.</p> ]]></description>
      <dc:creator>Dave</dc:creator>
    </item>
    <item>
      <title>The Backrooms, 2022</title>
      <link>https://letterboxd.com/dave/film/the-backrooms/</link>
      <guid isPermaLink="false">letterboxd-watch-1330715465</guid>
      <pubDate>Wed, 27 May 2026 09:57:33 +1200</pubDate>
      <letterboxd:watchedDate>2026-05-22</letterboxd:watchedDate>
      <letterboxd:rewatch>No</letterboxd:rewatch>
      <letterboxd:filmTitle>The Backrooms</letterboxd:filmTitle>
      <letterboxd:filmYear>2022</letterboxd:filmYear>
      <letterboxd:memberLike>No</letterboxd:memberLike>
      <tmdb:movieId>900000</tmdb:movieId>
      <description><![CDATA[ <p><img src="https://a.ltrbxd.com/br.jpg"/></p> <p>Watched on Sunday May 22, 2026.</p> ]]></description>
      <dc:creator>Dave</dc:creator>
    </item>
    <item>
      <title>The five best films I haven't seen…</title>
      <link>https://letterboxd.com/dave/list/the-five-best/</link>
      <guid isPermaLink="false">letterboxd-list-214846</guid>
      <pubDate>Fri, 29 Nov 2013 05:37:52 +1300</pubDate>
      <description><![CDATA[ <p>A list, not a watch.</p> ]]></description>
      <dc:creator>Dave</dc:creator>
    </item>
  </channel>
</rss>`;

type RouteResult = { status?: number; body?: string };

/** Install a fetch stub returning `route()` for the duration of `fn`. */
async function withFetch(
  route: (url: string) => RouteResult,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = "" } = route(url);
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { "content-type": "application/rss+xml" },
      }),
    );
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("sync_diary: maps a rated watch, skips lists, keys by watch id", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: FEED }), async () => {
    await methods.sync_diary.execute({ limit: 50 }, context);
  });
  const written = getWrittenResources();
  // Two film watches; the list entry is dropped.
  assertEquals(written.length, 2);
  const first = written[0];
  assertEquals(first.specName, "diaryEntry");
  assertEquals(first.name, "d-1369875590");
  assertEquals(first.data.filmTitle, "Toy Story 4");
  assertEquals(first.data.filmYear, 2019);
  assertEquals(first.data.watchedDate, "2026-06-25");
  assertEquals(first.data.rating, 3.5);
  assertEquals(first.data.liked, true);
  assertEquals(first.data.rewatch, true);
  assertEquals(first.data.tmdbId, 301528);
  assertEquals(first.data.posterUrl, "https://a.ltrbxd.com/poster.jpg");
  // Poster + "Watched on" boilerplate stripped, review text kept.
  assertEquals(first.data.review, "A near-perfect send-off.");
});

Deno.test("sync_diary: unrated watch yields null rating and null review", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: FEED }), async () => {
    await methods.sync_diary.execute({ limit: 50 }, context);
  });
  const second = getWrittenResources()[1];
  assertEquals(second.name, "d-1330715465");
  assertEquals(second.data.rating, null);
  assertEquals(second.data.liked, false);
  assertEquals(second.data.rewatch, false);
  assertEquals(second.data.review, null);
});

Deno.test("sync_diary: sinceDate filters older watches", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: FEED }), async () => {
    await methods.sync_diary.execute(
      { limit: 50, sinceDate: "2026-06-01" },
      context,
    );
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].name, "d-1369875590");
});

Deno.test("sync_diary: limit caps the number of watches recorded", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: FEED }), async () => {
    await methods.sync_diary.execute({ limit: 1 }, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  // A full window flags truncation so downstream knows to keep polling.
  assertEquals(written[0].data.truncated, true);
});

Deno.test("sync_diary: HTTP 404 raises a descriptive permanent error", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  await withFetch(() => ({ status: 404, body: "Not Found" }), async () => {
    await assertRejects(
      () => methods.sync_diary.execute({ limit: 50 }, context),
      Error,
      "HTTP 404",
    );
  });
});
