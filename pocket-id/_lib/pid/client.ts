/**
 * HTTP client for the Pocket ID admin API.
 *
 * Authentication is a single static header (`X-API-Key`) — there is no token
 * exchange and no session, so unlike most integrations there is nothing to
 * establish before the first read.
 *
 * Two request paths exist deliberately. `request` throws on any non-2xx, which
 * is what a read whose absence would silently corrupt a rollup wants. `call`
 * returns the outcome instead, which is what the per-user passkey fan-out
 * wants: one deleted-mid-sync user should not abandon the other thirty-nine.
 *
 * Pocket ID's errors carry a stable `code` alongside the message, so the two
 * failures that actually happen in practice — a wrong key, and a key belonging
 * to a non-admin — are distinguished here rather than left as a bare 401/403
 * for the caller to guess at.
 *
 * @module
 */

/** A Pocket ID API call that did not return 2xx. */
export class PocketIdError extends Error {
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  /** Request path, for context in the message. */
  readonly path: string;
  /** Pocket ID's stable error code, empty when the body carried none. */
  readonly code: string;

  constructor(message: string, status: number, path: string, code = "") {
    super(message);
    this.name = "PocketIdError";
    this.status = status;
    this.path = path;
    this.code = code;
  }
}

/** Raw outcome of a non-throwing request. */
export interface CallOutcome {
  ok: boolean;
  status: number;
  /** Parsed JSON when the body was JSON, otherwise the raw text. */
  body: unknown;
  /** Pocket ID's stable error code, empty when absent. */
  code: string;
  /** Human-readable failure detail; empty when `ok`. */
  message: string;
}

/** One page of a paginated Pocket ID collection. */
interface Page<T> {
  data: T[];
  pagination: {
    totalPages: number;
    totalItems: number;
    currentPage: number;
    itemsPerPage: number;
  };
}

/** Pocket ID clamps `pagination[limit]` to this, silently. */
const MAX_PAGE_SIZE = 100;

/**
 * Guard against paging forever.
 *
 * `PaginateFilterAndSort` clamps an over-large page number back to the last
 * page rather than returning an empty set, so a loop that trusted
 * `currentPage` to advance could spin on a instance whose data is changing
 * underneath it. 500 pages at 100 items is far past any real directory.
 */
const MAX_PAGES = 500;

/** How many times a 429 is waited out before it is reported as a failure. */
const MAX_RATE_LIMIT_RETRIES = 3;

/** Ceiling on a `Retry-After` wait, so a hostile value cannot hang a run. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Fallback wait when a 429 arrives without a usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * Read `Retry-After`, which RFC 9110 allows as either seconds or an HTTP date.
 *
 * Always returns a usable, bounded delay: a missing, malformed or absurd value
 * becomes the default rather than zero, because retrying instantly against a
 * rate limiter just burns the next token too.
 */
export function parseRetryAfter(header: string | null): number {
  if (header === null || header.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** Pocket ID's error bodies; a proxy in front of it may answer with HTML. */
function describeFailure(
  status: number,
  body: unknown,
  text: string,
): { message: string; code: string } {
  if (body !== null && typeof body === "object") {
    const err = body as { error?: unknown; code?: unknown };
    const detail = typeof err.error === "string" ? err.error : "";
    const code = typeof err.code === "string" ? err.code : "";
    if (detail !== "") return { message: `HTTP ${status}: ${detail}`, code };
    if (code !== "") return { message: `HTTP ${status}: ${code}`, code };
  }
  const trimmed = text.trim().replace(/\s+/g, " ");
  return {
    message: trimmed === ""
      ? `HTTP ${status}`
      : `HTTP ${status}: ${trimmed.slice(0, 300)}`,
    code: "",
  };
}

/**
 * Turn an auth failure into the sentence that actually fixes it.
 *
 * Every admin endpoint answers 403 `missing_permission` when the key is valid
 * but its owner is not an admin, which reads as a bug in the extension unless
 * it says otherwise. This is the single most common way a first run fails.
 */
export function authHint(status: number, code: string): string {
  // Codes are checked before statuses: a disabled owner also answers 403, and
  // telling someone to grant admin rights to a disabled account sends them the
  // wrong way entirely.
  if (code === "user_disabled") {
    return " — the API key's owner has been disabled in Pocket ID";
  }
  if (code === "missing_permission") {
    return " — the API key is valid but its owner is not an admin; users, " +
      "clients, groups and the audit log all require an admin account";
  }
  if (code === "not_signed_in") {
    return " — check `apiKey` against Settings → Admin → API Keys; keys " +
      "expire, and an expired one is rejected exactly like a wrong one";
  }
  if (status === 403) {
    return " — the API key's owner is probably not an admin; users, clients, " +
      "groups and the audit log all require an admin account";
  }
  if (status === 401) {
    return " — check `apiKey` against Settings → Admin → API Keys; keys " +
      "expire, and an expired one is rejected exactly like a wrong one";
  }
  return "";
}

/** Options for reading a whole paginated collection. */
export interface ListOptions<T> {
  /** Page size, clamped to Pocket ID's own maximum of 100. */
  limit?: number;
  /** Server-side sort. Only columns Pocket ID tags `sortable` take effect. */
  sort?: { column: string; direction: "asc" | "desc" };
  /** Free-text search, where the endpoint supports it. */
  search?: string;
  /** `filters[<key>]` query parameters. */
  filters?: Record<string, readonly string[]>;
  /** Stop after this many items; sets `truncated`. */
  maxItems?: number;
  /**
   * Called per item in server order. Returning false drops that item and
   * every later one, and stops paging — this is how a date window is applied
   * to a log Pocket ID cannot filter by date.
   */
  take?: (item: T) => boolean;
}

/** Everything read from one paginated collection. */
export interface ListResult<T> {
  items: T[];
  /** `pagination.totalItems` from the first page: the collection's full size. */
  totalItems: number;
  /** `maxItems` was hit while pages remained. */
  truncated: boolean;
}

/** Authenticated session against one Pocket ID instance. */
export class PocketIdClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    requestTimeoutSec: number;
  }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#apiKey = opts.apiKey;
    this.#timeoutMs = opts.requestTimeoutSec * 1000;
  }

  /** The normalised base URL, as sent to the server. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Perform a GET, throwing `PocketIdError` on any non-2xx response. */
  async request<T>(path: string): Promise<T> {
    const outcome = await this.#send("GET", path, true);
    if (!outcome.ok) {
      throw new PocketIdError(
        `GET ${path} failed: ${outcome.message}` +
          authHint(outcome.status, outcome.code),
        outcome.status,
        path,
        outcome.code,
      );
    }
    return outcome.body as T;
  }

  /** Perform a GET, reporting failure as a value rather than throwing. */
  call(path: string): Promise<CallOutcome> {
    return this.#send("GET", path, true);
  }

  /**
   * Probe `/healthz` without the API key.
   *
   * Deliberately unauthenticated: it separates "the instance is down" from
   * "the key is wrong", which is the first fork in every diagnosis. Returns
   * the observed status and round trip; status 0 means nothing answered.
   */
  async healthz(): Promise<{ status: number; latencyMs: number }> {
    const started = performance.now();
    const outcome = await this.#send("GET", "/healthz", false);
    return {
      status: outcome.status,
      latencyMs: outcome.status === 0
        ? -1
        : Math.round(performance.now() - started),
    };
  }

  /**
   * Read every page of a paginated collection.
   *
   * Pocket ID exposes no date filter anywhere, so a bounded read of the audit
   * log has to be expressed as "sort newest-first and stop early" — hence
   * `take`. Paging stops on the first rejected item, which means a window of
   * one day over a year of history costs one request, not a hundred.
   */
  async list<T>(
    path: string,
    options: ListOptions<T> = {},
  ): Promise<ListResult<T>> {
    const limit = Math.min(options.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const items: T[] = [];
    let totalItems = 0;
    let truncated = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams();
      query.set("pagination[page]", String(page));
      query.set("pagination[limit]", String(limit));
      if (options.sort) {
        query.set("sort[column]", options.sort.column);
        query.set("sort[direction]", options.sort.direction);
      }
      if (options.search !== undefined && options.search !== "") {
        query.set("search", options.search);
      }
      for (const [key, values] of Object.entries(options.filters ?? {})) {
        for (const value of values) query.append(`filters[${key}]`, value);
      }

      const body = await this.request<Page<T>>(`${path}?${query}`);
      const data = Array.isArray(body?.data) ? body.data : [];
      if (page === 1) {
        totalItems = body?.pagination?.totalItems ?? data.length;
      }

      let stopped = false;
      for (const item of data) {
        if (options.take && !options.take(item)) {
          stopped = true;
          break;
        }
        items.push(item);
        if (
          options.maxItems !== undefined && items.length >= options.maxItems
        ) {
          // Errs towards reporting truncation: `totalItems` is the whole
          // collection, so a window that happens to end exactly on the cap
          // reads as truncated. Over-reporting a floor beats a count that
          // silently understates itself.
          truncated = totalItems > items.length;
          return { items, totalItems, truncated };
        }
      }
      if (stopped) break;

      const totalPages = body?.pagination?.totalPages ?? 1;
      if (page >= totalPages || data.length === 0) break;

      // Out of page budget with pages still to go. Reported rather than
      // silently dropped: a partial user list would make an unflagged account
      // look like one that passed every check.
      if (page === MAX_PAGES) truncated = true;
    }

    return { items, totalItems, truncated };
  }

  /**
   * Send a request, waiting out a rate limit rather than failing on it.
   *
   * Pocket ID limits the API to 100 requests a second with a burst of 300, and
   * `sync` reads passkeys one user at a time — a large directory against a
   * local instance can outrun that. A 429 is transient by definition, so it is
   * retried on the server's own `Retry-After` rather than surfaced as a
   * failure; anything else returns on the first attempt.
   */
  async #send(
    method: string,
    path: string,
    authenticated: boolean,
  ): Promise<CallOutcome> {
    let outcome = await this.#attempt(method, path, authenticated);
    for (let retry = 0; retry < MAX_RATE_LIMIT_RETRIES; retry++) {
      if (outcome.status !== 429) return outcome;
      await new Promise((resolve) => setTimeout(resolve, outcome.retryAfterMs));
      outcome = await this.#attempt(method, path, authenticated);
    }
    return outcome;
  }

  async #attempt(
    method: string,
    path: string,
    authenticated: boolean,
  ): Promise<CallOutcome & { retryAfterMs: number }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (authenticated) headers["X-API-Key"] = this.#apiKey;

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const hint = err instanceof DOMException && err.name === "TimeoutError"
        ? ` (no response within ${this.#timeoutMs / 1000}s)`
        : "";
      return {
        ok: false,
        status: 0,
        body: null,
        code: "",
        message: `${method} ${path}: ${detail}${hint}`,
        retryAfterMs: 0,
      };
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const { message, code } = describeFailure(response.status, parsed, text);
      return {
        ok: false,
        status: response.status,
        body: parsed,
        code,
        message,
        retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
      };
    }
    return {
      ok: true,
      status: response.status,
      body: parsed,
      code: "",
      retryAfterMs: 0,
      message: "",
    };
  }
}
