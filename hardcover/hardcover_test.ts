/**
 * Unit tests for the @jamesakeech/hardcover model.
 *
 * Every method POSTs GraphQL to a single Hardcover endpoint, so the fetch stub
 * routes by the operation in the request body (`me`, `user_books`, or
 * `user_book_reads`) and answers each. No live Hardcover account or token is
 * required.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { model } from "./hardcover.ts";

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;

const GLOBAL = {
  apiToken: "Bearer test-token",
  endpoint: "https://api.hardcover.app/v1/graphql",
  userAgent: "test-agent",
};

const ME = {
  id: 42,
  username: "reader",
  name: "A Reader",
  books_count: 3,
  pro: true,
  flair: null,
};

const USER_BOOK = {
  id: 1001,
  book_id: 555,
  status_id: 3,
  rating: 4.5,
  has_review: true,
  review: "Loved it",
  review_has_spoilers: false,
  read_count: 1,
  owned: true,
  date_added: "2026-01-02",
  first_started_reading_date: "2026-01-03",
  first_read_date: "2026-01-10",
  last_read_date: "2026-01-10",
  updated_at: "2026-01-10T12:00:00+00:00",
  book: {
    id: 555,
    title: "Dune",
    subtitle: null,
    pages: 412,
    release_year: 1965,
    slug: "dune",
    image: { url: "https://assets.hardcover.app/dune.jpg" },
    contributions: [
      { author: { name: "Frank Herbert" } },
      { author: { name: "Frank Herbert" } },
    ],
  },
};

const READ = {
  id: 7001,
  user_book_id: 1001,
  edition_id: 88,
  started_at: "2026-01-03",
  finished_at: "2026-01-10",
  paused_at: null,
  progress: 1,
  progress_pages: 412,
  progress_seconds: null,
  user_book: { book_id: 555, book: { title: "Dune" } },
};

type RouteResult = { status?: number; body?: unknown };

/** Install a fetch stub that routes by the GraphQL body for the duration of `fn`. */
async function withFetch(
  router: (body: string) => RouteResult,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const { status = 200, body: resBody = {} } = router(body);
    const payload = typeof resBody === "string"
      ? resBody
      : JSON.stringify(resBody);
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

/** Default router: `me`, one page of user_books, one page of user_book_reads. */
function route(body: string): RouteResult {
  if (body.includes("user_book_reads")) {
    return { body: { data: { user_book_reads: [READ] } } };
  }
  if (body.includes("user_books")) {
    return { body: { data: { user_books: [USER_BOOK] } } };
  }
  return { body: { data: { me: [ME] } } };
}

Deno.test("whoami: writes the profile and verifies the token", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(route, async () => {
    await methods.whoami.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "profile");
  assertEquals(written[0].name, "current");
  assertEquals(written[0].data.id, 42);
  assertEquals(written[0].data.username, "reader");
  assertEquals(written[0].data.booksCount, 3);
});

Deno.test("sync_books: maps a user_book, dedupes authors, labels status", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(route, async () => {
    await methods.sync_books.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "book");
  assertEquals(written[0].name, "ub-1001");
  assertEquals(written[0].data.status, "Read");
  assertEquals(written[0].data.rating, 4.5);
  assertEquals(written[0].data.title, "Dune");
  assertEquals(written[0].data.pages, 412);
  assertEquals(written[0].data.coverUrl, "https://assets.hardcover.app/dune.jpg");
  // Duplicate contributor collapses to a single author name.
  assertEquals(written[0].data.authors, ["Frank Herbert"]);
});

Deno.test("sync_reads: maps a reading session keyed by id", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(route, async () => {
    await methods.sync_reads.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "read");
  assertEquals(written[0].name, "r-7001");
  assertEquals(written[0].data.finishedAt, "2026-01-10");
  assertEquals(written[0].data.progress, 1);
  assertEquals(written[0].data.title, "Dune");
  assertEquals(written[0].data.bookId, 555);
});

Deno.test("sync_books: maxBooks stops early", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const many = Array.from(
    { length: 5 },
    (_, i) => ({ ...USER_BOOK, id: 2000 + i }),
  );
  await withFetch((body) => {
    if (body.includes("user_books")) {
      return { body: { data: { user_books: many } } };
    }
    return { body: { data: { me: [ME] } } };
  }, async () => {
    await methods.sync_books.execute({ maxBooks: 2 }, context);
  });
  assertEquals(getWrittenResources().length, 2);
});

Deno.test("HTTP 401 raises a descriptive (permanent) error", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  await withFetch(
    () => ({ status: 401, body: { error: "Unable to verify token" } }),
    async () => {
      await assertRejects(
        () => methods.whoami.execute({}, context),
        Error,
        "HTTP 401",
      );
    },
  );
});

Deno.test("GraphQL errors array surfaces as an error", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  await withFetch(
    () => ({ body: { errors: [{ message: 'field "foo" not found' }] } }),
    async () => {
      const err = await assertRejects(
        () => methods.whoami.execute({}, context),
        Error,
        "GraphQL error",
      );
      assertStringIncludes((err as Error).message, "foo");
    },
  );
});
