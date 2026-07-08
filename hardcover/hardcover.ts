/**
 * Hardcover reading model — read-only monitoring of a single user's reading
 * activity on Hardcover (https://hardcover.app) via its GraphQL API
 * (https://api.hardcover.app/v1/graphql).
 *
 * Covers the user's profile, their whole library of tracked books (each with a
 * shelf status, rating, review flag, page count and read dates), and their
 * individual reading sessions (start/finish dates and progress). Authenticates
 * with a static API token (hardcover.app → account settings → Hardcover API).
 * Read-only — this type never mutates Hardcover state.
 *
 * Unlike streaming services, Hardcover exposes the FULL persistent record of a
 * user's books and reads, so the `sync_*` methods re-pull the complete state on
 * each run and write idempotent records keyed by the Hardcover row id (re-runs
 * update in place rather than duplicating). Run on a schedule to keep the local
 * copy fresh and to capture reads as they finish.
 *
 * Hardcover notes: the API is rate-limited to 60 requests/minute, tokens expire
 * ~yearly (reset Jan 1), and Hardcover asks that scripts send a descriptive
 * User-Agent header. This type honours all three.
 *
 * @module
 */
import { z } from "npm:zod@4";

const DEFAULT_ENDPOINT = "https://api.hardcover.app/v1/graphql";
const DEFAULT_USER_AGENT = "swamp-jamesakeech-hardcover/1.0 (reading monitor)";
const PAGE_SIZE = 100;

/**
 * Hardcover shelf status ids → human labels. Hardcover has no status_id 4.
 * (Stored alongside the raw id so unknown future statuses still round-trip.)
 */
const STATUS_NAMES: Record<number, string> = {
  1: "Want to Read",
  2: "Currently Reading",
  3: "Read",
  5: "Did Not Finish",
};

/** Global arguments shared by every method on a Hardcover reading model. */
const GlobalArgsSchema = z.object({
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Hardcover API token (hardcover.app → account settings → Hardcover API). " +
      "The leading `Bearer ` is optional. Source from a vault.",
  ),
  endpoint: z.string().min(1).default(DEFAULT_ENDPOINT).describe(
    "Hardcover GraphQL endpoint URL",
  ),
  userAgent: z.string().min(1).default(DEFAULT_USER_AGENT).describe(
    "User-Agent header sent with every request (Hardcover asks scripts to " +
      "identify themselves)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** The authenticated user's profile (one record, instance "current"). */
const ProfileSchema = z.object({
  id: z.number().describe("Hardcover user id"),
  username: z.string(),
  name: z.string().nullable(),
  booksCount: z.number().describe("Total books the user tracks on Hardcover"),
  pro: z.boolean(),
  flair: z.string().nullable(),
  fetchedAt: z.iso.datetime(),
});

/** One tracked book in the user's library (factory: one record per user_book). */
const BookSchema = z.object({
  userBookId: z.number().describe("Hardcover user_books row id"),
  bookId: z.number(),
  statusId: z.number().describe(
    "1 Want to Read, 2 Currently Reading, 3 Read, 5 DNF",
  ),
  status: z.string().describe("Human label for statusId"),
  rating: z.number().nullable().describe("User's rating, 0–5 in 0.5 steps"),
  hasReview: z.boolean(),
  review: z.string().nullable(),
  reviewHasSpoilers: z.boolean(),
  title: z.string(),
  subtitle: z.string().nullable(),
  authors: z.array(z.string()),
  pages: z.number().nullable(),
  releaseYear: z.number().nullable(),
  slug: z.string().nullable().describe("hardcover.app/books/<slug>"),
  readCount: z.number(),
  owned: z.boolean(),
  dateAdded: z.string().nullable().describe(
    "Date added to the library (YYYY-MM-DD)",
  ),
  firstStartedReadingDate: z.string().nullable(),
  firstReadDate: z.string().nullable(),
  lastReadDate: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  fetchedAt: z.iso.datetime(),
});

/** One reading session (factory: one record per user_book_read). */
const ReadSchema = z.object({
  readId: z.number().describe("Hardcover user_book_reads row id"),
  userBookId: z.number(),
  bookId: z.number(),
  title: z.string().describe("Book title (denormalised for convenience)"),
  startedAt: z.string().nullable().describe("YYYY-MM-DD"),
  finishedAt: z.string().nullable().describe("YYYY-MM-DD"),
  pausedAt: z.string().nullable().describe("YYYY-MM-DD"),
  progress: z.number().nullable().describe("Fraction read, 0–1"),
  progressPages: z.number().nullable(),
  progressSeconds: z.number().nullable().describe("For audiobook editions"),
  editionId: z.number().nullable(),
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

/** Normalise the token into a bare value (the account page may include "Bearer "). */
function bearer(apiToken: string): string {
  const bare = apiToken.replace(/^Bearer\s+/i, "").trim();
  return `Bearer ${bare}`;
}

/**
 * POST a GraphQL query to Hardcover and return its `data`, throwing a
 * descriptive error (never leaking the token) on any transport error, non-2xx
 * response, or GraphQL `errors` array — before any data is written.
 */
async function hardcoverQuery<T>(
  ctx: ExecContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const { apiToken, endpoint, userAgent } = ctx.globalArgs;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": bearer(apiToken),
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": userAgent,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind = isTransient(res.status) ? "transient" : "permanent";
    throw new Error(
      `Hardcover request failed (${kind}): HTTP ${res.status} — ${
        summarize(body)
      }`,
    );
  }
  const json = await res.json() as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors.map((e) => e.message ?? "unknown").join("; ");
    throw new Error(`Hardcover GraphQL error: ${summarize(msg)}`);
  }
  if (!json.data) {
    throw new Error("Hardcover response contained no data");
  }
  return json.data;
}

// --- Raw response shapes (subsets of the Hardcover GraphQL schema) ---

type RawContribution = { author?: { name?: string } | null };
type RawBook = {
  id?: number;
  title?: string;
  subtitle?: string | null;
  pages?: number | null;
  release_year?: number | null;
  slug?: string | null;
  contributions?: RawContribution[];
};
type RawUserBook = {
  id?: number;
  book_id?: number;
  status_id?: number;
  rating?: number | null;
  has_review?: boolean;
  review?: string | null;
  review_has_spoilers?: boolean;
  read_count?: number;
  owned?: boolean;
  date_added?: string | null;
  first_started_reading_date?: string | null;
  first_read_date?: string | null;
  last_read_date?: string | null;
  updated_at?: string | null;
  book?: RawBook | null;
};
type RawRead = {
  id?: number;
  user_book_id?: number;
  edition_id?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  paused_at?: string | null;
  progress?: number | null;
  progress_pages?: number | null;
  progress_seconds?: number | null;
  user_book?: { book_id?: number; book?: { title?: string } | null } | null;
};
type RawMe = {
  id?: number;
  username?: string;
  name?: string | null;
  books_count?: number;
  pro?: boolean;
  flair?: string | null;
};

/** Author display names from a book's contributions, de-duplicated, in order. */
function authorNames(book: RawBook | null | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const c of book?.contributions ?? []) {
    const n = c.author?.name?.trim();
    if (n && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }
  return names;
}

const ME_QUERY = `query { me { id username name books_count pro flair } }`;

/** Resolve the authenticated user's id (and profile row) — verifies the token. */
async function fetchMe(ctx: ExecContext): Promise<RawMe> {
  const data = await hardcoverQuery<{ me?: RawMe[] }>(ctx, ME_QUERY, {});
  const me = data.me?.[0];
  if (!me || typeof me.id !== "number") {
    throw new Error(
      "Hardcover `me` query returned no user — is the API token valid?",
    );
  }
  return me;
}

/** Model definition for monitoring a user's Hardcover reading activity. */
export const model = {
  type: "@jamesakeech/hardcover",
  version: "2026.07.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "profile": {
      description:
        'The authenticated Hardcover user\'s profile (instance "current")',
      schema: ProfileSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "book": {
      description:
        "A tracked book in the user's library (one record per user_book, keyed by id)",
      schema: BookSchema,
      lifetime: "infinite",
      garbageCollection: 20000,
    },
    "read": {
      description:
        "A reading session (one record per user_book_read, keyed by id)",
      schema: ReadSchema,
      lifetime: "infinite",
      garbageCollection: 20000,
    },
  },
  methods: {
    whoami: {
      description:
        "Fetch the authenticated user's Hardcover profile (id, username, name, " +
        "book count). Use this to verify the API token is valid. Writes one " +
        '`profile` record (instance "current").',
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const me = await fetchMe(ctx);
        const record: z.infer<typeof ProfileSchema> = {
          id: me.id ?? 0,
          username: me.username ?? "",
          name: me.name ?? null,
          booksCount: me.books_count ?? 0,
          pro: me.pro ?? false,
          flair: me.flair ?? null,
          fetchedAt: new Date().toISOString(),
        };
        const handle = await ctx.writeResource("profile", "current", record);
        ctx.logger?.info("Authenticated as {username} (id {id})", {
          username: record.username,
          id: record.id,
        });
        return { dataHandles: [handle] };
      },
    },
    sync_books: {
      description:
        "Pull the user's entire tracked library (all shelves) from Hardcover, " +
        "paginating through every user_book. Writes one `book` record per entry " +
        "keyed by its Hardcover id, so re-runs update in place. Pass `statusId` " +
        "to sync only one shelf (1 Want to Read, 2 Currently Reading, 3 Read, " +
        "5 Did Not Finish).",
      arguments: z.object({
        statusId: z.number().int().optional().describe(
          "Only sync books with this shelf status id (omit for all shelves)",
        ),
        maxBooks: z.number().int().min(1).optional().describe(
          "Stop after writing this many books (omit for the whole library)",
        ),
      }),
      execute: async (
        args: { statusId?: number; maxBooks?: number },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const me = await fetchMe(ctx);
        const query = `
          query Books($where: user_books_bool_exp!, $limit: Int!, $offset: Int!) {
            user_books(
              where: $where
              order_by: { id: asc }
              limit: $limit
              offset: $offset
            ) {
              id book_id status_id rating has_review review review_has_spoilers
              read_count owned date_added first_started_reading_date
              first_read_date last_read_date updated_at
              book {
                id title subtitle pages release_year slug
                contributions(order_by: { contributable_type: asc }) {
                  author { name }
                }
              }
            }
          }`;
        // Build the filter in TS: passing `_eq: null` through a variable makes
        // Hasura throw, so we OMIT status_id entirely when syncing all shelves.
        const where: Record<string, unknown> = { user_id: { _eq: me.id } };
        if (typeof args.statusId === "number") {
          where.status_id = { _eq: args.statusId };
        }
        const fetchedAt = new Date().toISOString();
        const handles: DataHandle[] = [];
        let offset = 0;
        for (;;) {
          const data = await hardcoverQuery<{ user_books?: RawUserBook[] }>(
            ctx,
            query,
            { where, limit: PAGE_SIZE, offset },
          );
          const rows = data.user_books ?? [];
          if (rows.length === 0) break;
          for (const ub of rows) {
            if (typeof ub.id !== "number") continue;
            const statusId = ub.status_id ?? 0;
            const record: z.infer<typeof BookSchema> = {
              userBookId: ub.id,
              bookId: ub.book_id ?? 0,
              statusId,
              status: STATUS_NAMES[statusId] ?? `status ${statusId}`,
              rating: ub.rating ?? null,
              hasReview: ub.has_review ?? false,
              review: ub.review ?? null,
              reviewHasSpoilers: ub.review_has_spoilers ?? false,
              title: ub.book?.title ?? "",
              subtitle: ub.book?.subtitle ?? null,
              authors: authorNames(ub.book),
              pages: ub.book?.pages ?? null,
              releaseYear: ub.book?.release_year ?? null,
              slug: ub.book?.slug ?? null,
              readCount: ub.read_count ?? 0,
              owned: ub.owned ?? false,
              dateAdded: ub.date_added ?? null,
              firstStartedReadingDate: ub.first_started_reading_date ?? null,
              firstReadDate: ub.first_read_date ?? null,
              lastReadDate: ub.last_read_date ?? null,
              updatedAt: ub.updated_at
                ? new Date(ub.updated_at).toISOString()
                : null,
              fetchedAt,
            };
            handles.push(
              await ctx.writeResource("book", `ub-${ub.id}`, record),
            );
            if (args.maxBooks && handles.length >= args.maxBooks) {
              ctx.logger?.info("Reached maxBooks ({count})", {
                count: handles.length,
              });
              return { dataHandles: handles };
            }
          }
          if (rows.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
        ctx.logger?.info("Synced {count} book(s)", { count: handles.length });
        return { dataHandles: handles };
      },
    },
    sync_reads: {
      description:
        "Pull the user's reading sessions (user_book_reads) from Hardcover, " +
        "paginating through every read. Writes one `read` record per session " +
        "keyed by its Hardcover id with start/finish dates and progress, so " +
        "re-runs update in place. Run on a schedule to capture reads as they " +
        "finish.",
      arguments: z.object({
        maxReads: z.number().int().min(1).optional().describe(
          "Stop after writing this many reads (omit for all reads)",
        ),
      }),
      execute: async (
        args: { maxReads?: number },
        ctx: ExecContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const me = await fetchMe(ctx);
        const query = `
          query Reads($uid: Int!, $limit: Int!, $offset: Int!) {
            user_book_reads(
              where: { user_book: { user_id: { _eq: $uid } } }
              order_by: { id: asc }
              limit: $limit
              offset: $offset
            ) {
              id user_book_id edition_id started_at finished_at paused_at
              progress progress_pages progress_seconds
              user_book { book_id book { title } }
            }
          }`;
        const fetchedAt = new Date().toISOString();
        const handles: DataHandle[] = [];
        let offset = 0;
        for (;;) {
          const data = await hardcoverQuery<{ user_book_reads?: RawRead[] }>(
            ctx,
            query,
            { uid: me.id, limit: PAGE_SIZE, offset },
          );
          const rows = data.user_book_reads ?? [];
          if (rows.length === 0) break;
          for (const r of rows) {
            if (typeof r.id !== "number") continue;
            const record: z.infer<typeof ReadSchema> = {
              readId: r.id,
              userBookId: r.user_book_id ?? 0,
              bookId: r.user_book?.book_id ?? 0,
              title: r.user_book?.book?.title ?? "",
              startedAt: r.started_at ?? null,
              finishedAt: r.finished_at ?? null,
              pausedAt: r.paused_at ?? null,
              progress: r.progress ?? null,
              progressPages: r.progress_pages ?? null,
              progressSeconds: r.progress_seconds ?? null,
              editionId: r.edition_id ?? null,
              fetchedAt,
            };
            handles.push(await ctx.writeResource("read", `r-${r.id}`, record));
            if (args.maxReads && handles.length >= args.maxReads) {
              ctx.logger?.info("Reached maxReads ({count})", {
                count: handles.length,
              });
              return { dataHandles: handles };
            }
          }
          if (rows.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
        ctx.logger?.info("Synced {count} read(s)", { count: handles.length });
        return { dataHandles: handles };
      },
    },
  },
};
