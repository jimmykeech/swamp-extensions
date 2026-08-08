/**
 * HTTP transports for a TP-Link Omada controller.
 *
 * Two APIs live behind one controller and the extension needs both.
 *
 * The **Open API** (`/openapi/v1/...`) is the supported northbound interface.
 * It is versioned, survives controller upgrades, and is the only one available
 * against the cloud northbound hosts. Everything that can be read or done
 * through it, is.
 *
 * The **web API** (`/{omadacId}/api/v2/...`) is what the browser UI calls. It
 * is undocumented and TP-Link changes it without notice, but it is the only
 * place some configuration is exposed — LAN networks, firewall ACLs, per-site
 * settings. It is used strictly as a fallback for reads the Open API cannot
 * serve, and only when web credentials were supplied.
 *
 * Both wrap every response in `{ errorCode, msg, result }`, so a transport-
 * level 200 says nothing about success; `unwrap` is what decides.
 *
 * Neither session is persisted. A swamp method execution is short and a token
 * written into a resource would be a credential leak with no upside — the
 * Open API access token in particular is a bearer credential for the whole
 * controller.
 *
 * @module
 */

/** A controller call that failed, at the transport or the envelope layer. */
export class OmadaError extends Error {
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  /** Omada envelope `errorCode`, or 0 when the failure was transport-level. */
  readonly errorCode: number;
  /** Request path, for context in the message. */
  readonly path: string;

  /** Build an error carrying whichever of status and errorCode applies. */
  constructor(
    message: string,
    opts: { status?: number; errorCode?: number; path: string },
  ) {
    super(message);
    this.name = "OmadaError";
    this.status = opts.status ?? 0;
    this.errorCode = opts.errorCode ?? 0;
    this.path = opts.path;
  }
}

/**
 * Envelope codes meaning "your access token is no longer good".
 *
 * Both arrive inside an HTTP 200, which is why they cannot be handled by
 * status-code inspection alone.
 */
const TOKEN_ERROR_CODES = new Set([-44112, -44113]);

/** Raw outcome of a request that reports failure as a value. */
export interface CallOutcome {
  /** True only when the transport succeeded *and* `errorCode` was 0. */
  ok: boolean;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** Parsed JSON when the body was JSON, otherwise the raw text. */
  body: unknown;
  /** Envelope `errorCode`; 0 when absent or successful. */
  errorCode: number;
  /** Human-readable failure detail; empty when `ok`. */
  message: string;
}

/** Connection settings shared by both transports. */
export interface TransportOptions {
  /** Controller root URL, with or without a trailing slash. */
  baseUrl: string;
  /** Per-request timeout in seconds. */
  requestTimeoutSec: number;
  /** PEM chain trusted in addition to the system roots, for self-signed controllers. */
  caCertPem?: string;
}

/**
 * Build the `fetch` options that carry a custom trust anchor.
 *
 * Omada controllers ship a self-signed certificate on 8043 and most people
 * never replace it. Deno has no per-request "ignore certificate errors", so
 * the honest fix is to let the operator supply the controller's own PEM and
 * trust exactly that — narrower than disabling verification, and it still
 * fails loudly if the controller is impersonated.
 */
function makeHttpClient(caCertPem?: string): Deno.HttpClient | undefined {
  if (caCertPem === undefined || caCertPem.trim() === "") return undefined;
  return Deno.createHttpClient({ caCerts: [caCertPem] });
}

/** Pull a readable reason out of whatever the controller returned. */
function describeFailure(
  status: number,
  errorCode: number,
  body: unknown,
): string {
  if (body && typeof body === "object") {
    const msg = (body as { msg?: string }).msg;
    if (typeof msg === "string" && msg !== "") {
      return errorCode !== 0
        ? `errorCode ${errorCode}: ${msg}`
        : `HTTP ${status}: ${msg}`;
    }
  }
  if (typeof body === "string" && body.trim() !== "") {
    return `HTTP ${status}: ${body.trim().replace(/\s+/g, " ").slice(0, 300)}`;
  }
  return errorCode !== 0 ? `errorCode ${errorCode}` : `HTTP ${status}`;
}

/** Perform one HTTP round trip, reporting every failure mode as a value. */
async function send(
  opts: TransportOptions,
  httpClient: Deno.HttpClient | undefined,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<CallOutcome> {
  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    ...headers,
  };
  let payload: string | undefined;
  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: payload,
      signal: AbortSignal.timeout(opts.requestTimeoutSec * 1000),
      ...(httpClient ? { client: httpClient } : {}),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A self-signed controller is the single most common first-run failure,
    // and the raw error names the cipher layer rather than the fix.
    const hint = /certificate|self.signed|unknown issuer|UnknownIssuer/i
        .test(detail)
      ? " — the controller's certificate is not trusted; set `caCertPem` to " +
        "its PEM, or point `baseUrl` at a name the certificate covers"
      : err instanceof DOMException && err.name === "TimeoutError"
      ? ` (no response within ${opts.requestTimeoutSec}s)`
      : "";
    return {
      ok: false,
      status: 0,
      body: null,
      errorCode: 0,
      message: `${method} ${url}: ${detail}${hint}`,
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

  const errorCode = parsed && typeof parsed === "object"
    ? (parsed as { errorCode?: number }).errorCode ?? 0
    : 0;

  if (!response.ok || errorCode !== 0) {
    return {
      ok: false,
      status: response.status,
      body: parsed,
      errorCode,
      message: describeFailure(response.status, errorCode, parsed),
    };
  }
  return {
    ok: true,
    status: response.status,
    body: parsed,
    errorCode: 0,
    message: "",
  };
}

/** Strip trailing slashes so path concatenation cannot double them. */
function normaliseBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Discover the controller's own id.
 *
 * `/api/info` is unauthenticated on every controller build, which makes it the
 * one call that can run before either session exists. Cloud northbound hosts
 * do not serve it — there the id identifies which controller you mean and must
 * be configured rather than discovered.
 */
export async function fetchOmadacId(
  opts: TransportOptions,
): Promise<{ omadacId: string; controllerVersion: string }> {
  const httpClient = makeHttpClient(opts.caCertPem);
  try {
    const base = normaliseBase(opts.baseUrl);
    const outcome = await send(
      opts,
      httpClient,
      "GET",
      `${base}/api/info`,
      {},
      undefined,
    );
    if (!outcome.ok) {
      throw new OmadaError(
        `could not read /api/info: ${outcome.message} — set \`omadacId\` ` +
          `explicitly if this is a cloud northbound endpoint`,
        {
          status: outcome.status,
          errorCode: outcome.errorCode,
          path: "/api/info",
        },
      );
    }
    const result = (outcome.body as { result?: Record<string, unknown> })
      ?.result ?? {};
    const omadacId = typeof result.omadacId === "string" ? result.omadacId : "";
    if (omadacId === "") {
      throw new OmadaError(
        "/api/info answered but carried no omadacId — is `baseUrl` pointing " +
          "at the controller rather than a device or a reverse proxy?",
        { status: outcome.status, path: "/api/info" },
      );
    }
    return {
      omadacId,
      controllerVersion: typeof result.controllerVer === "string"
        ? result.controllerVer
        : "",
    };
  } finally {
    httpClient?.close();
  }
}

// ---------------------------------------------------------------------------
// Open API transport
// ---------------------------------------------------------------------------

/** Credentials for an Open API application in client-credentials mode. */
export interface OpenApiCredentials {
  /** Application client id from Settings > Platform Integration > Open API. */
  clientId: string;
  /** Application client secret. Never logged and never persisted. */
  clientSecret: string;
}

/**
 * Authenticated Open API session against one controller.
 *
 * The access token is fetched lazily on first use and refreshed once on a
 * token-expiry envelope code. One retry is deliberate: a second failure means
 * the credentials are wrong rather than stale, and retrying a wrong secret in
 * a loop is how an Open API app gets locked out.
 */
export class OpenApiSession {
  readonly #opts: TransportOptions;
  readonly #creds: OpenApiCredentials;
  readonly #omadacId: string;
  readonly #httpClient: Deno.HttpClient | undefined;
  #token: string | null = null;

  /** Prepare a session. No network call happens until `login`. */
  constructor(
    opts: TransportOptions,
    creds: OpenApiCredentials,
    omadacId: string,
  ) {
    this.#opts = { ...opts, baseUrl: normaliseBase(opts.baseUrl) };
    this.#creds = creds;
    this.#omadacId = omadacId;
    this.#httpClient = makeHttpClient(opts.caCertPem);
  }

  /** The controller id every Open API path is scoped to. */
  get omadacId(): string {
    return this.#omadacId;
  }

  /** Release the underlying TLS client. Safe to call more than once. */
  close(): void {
    this.#httpClient?.close();
  }

  /** Obtain an access token, or confirm the held one is still unused. */
  async login(): Promise<void> {
    if (this.#token !== null) return;
    await this.#authenticate();
  }

  async #authenticate(): Promise<void> {
    const path = "/openapi/authorize/token?grant_type=client_credentials";
    const outcome = await send(
      this.#opts,
      this.#httpClient,
      "POST",
      `${this.#opts.baseUrl}${path}`,
      {},
      {
        omadacId: this.#omadacId,
        client_id: this.#creds.clientId,
        client_secret: this.#creds.clientSecret,
      },
    );
    if (!outcome.ok) {
      throw new OmadaError(
        `Open API authorization failed: ${outcome.message} — check the ` +
          "client id and secret against Settings > Platform Integration > " +
          "Open API, and confirm the app is in Client mode",
        { status: outcome.status, errorCode: outcome.errorCode, path },
      );
    }
    const result = (outcome.body as { result?: { accessToken?: string } })
      ?.result;
    const token = result?.accessToken;
    if (typeof token !== "string" || token === "") {
      throw new OmadaError(
        "Open API authorization returned no accessToken",
        { status: outcome.status, path },
      );
    }
    this.#token = token;
  }

  /**
   * Call an Open API path, reporting failure as a value.
   *
   * `path` is the part after the controller id, e.g. `/sites/{id}/devices`.
   * `apiVersion` selects between `/openapi/v1` and `/openapi/v2`. It defaults
   * to v1 and nothing currently passes v2: controller 6.x answers the v2
   * spellings with 405 or 404. The knob stays because older builds did expose
   * some collections only under v2, and the cost of keeping it is one
   * parameter.
   */
  async call(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      apiVersion?: "v1" | "v2";
    } = {},
  ): Promise<CallOutcome> {
    await this.login();
    const version = opts.apiVersion ?? "v1";
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.toString() === "" ? "" : `?${search}`;
    const url =
      `${this.#opts.baseUrl}/openapi/${version}/${this.#omadacId}${path}${suffix}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await send(
        this.#opts,
        this.#httpClient,
        method,
        url,
        { Authorization: `AccessToken=${this.#token}` },
        opts.body,
      );
      const expired = outcome.status === 401 ||
        TOKEN_ERROR_CODES.has(outcome.errorCode);
      if (expired && attempt === 0) {
        this.#token = null;
        await this.#authenticate();
        continue;
      }
      return outcome;
    }
    // Unreachable: the loop either returns or refreshes exactly once.
    throw new OmadaError("Open API request exhausted its retry", { path });
  }

  /** Call an Open API path, throwing on failure and returning `result`. */
  async request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      apiVersion?: "v1" | "v2";
    } = {},
  ): Promise<T> {
    const outcome = await this.call(method, path, opts);
    if (!outcome.ok) {
      throw new OmadaError(`${method} ${path} failed: ${outcome.message}`, {
        status: outcome.status,
        errorCode: outcome.errorCode,
        path,
      });
    }
    return (outcome.body as { result?: T })?.result as T;
  }

  /**
   * Read every page of a paginated Open API collection.
   *
   * Omada reports `totalRows` alongside each page. The loop trusts the row
   * count rather than "a short page means the end", because some builds pad
   * the final page.
   *
   * The page cap exists to stop a controller reporting a stale `totalRows`
   * from spinning forever, and exhausting it **throws**. Twenty thousand rows
   * in one site's collection is not a real Omada deployment, so reaching the
   * cap means pagination is not terminating — and returning the rows gathered
   * so far would report a truncated inventory as a complete one, which drift
   * detection would then read as thousands of devices disappearing.
   */
  async listAll<T>(
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      apiVersion?: "v1" | "v2";
      pageSize?: number;
    } = {},
  ): Promise<T[]> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = 200;
    const collected: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const result = await this.request<
        { data?: T[]; totalRows?: number } | T[]
      >("GET", path, {
        query: { ...opts.query, page, pageSize },
        apiVersion: opts.apiVersion,
      });
      // Small collections (a site's SSIDs) come back as a bare array with no
      // envelope of their own — there is nothing to page through.
      if (Array.isArray(result)) return result;
      const rows = result?.data ?? [];
      collected.push(...rows);
      const total = result?.totalRows;
      if (rows.length === 0) return collected;
      if (typeof total === "number" && collected.length >= total) {
        return collected;
      }
      if (typeof total !== "number" && rows.length < pageSize) {
        return collected;
      }
    }
    throw new OmadaError(
      `pagination did not terminate after ${maxPages} pages ` +
        `(${collected.length} rows) — refusing to report a partial ` +
        "collection as complete",
      { path },
    );
  }
}

// ---------------------------------------------------------------------------
// Web API (v2) transport
// ---------------------------------------------------------------------------

/** Credentials for the controller's own web login. */
export interface WebApiCredentials {
  /** Controller web account name. */
  username: string;
  /** Controller web account password. Never logged and never persisted. */
  password: string;
}

/**
 * Authenticated session against the browser-facing v2 API.
 *
 * Login returns a token that is simultaneously the CSRF header value and the
 * key to a `TPOMADA_SESSIONID` cookie. Deno's `fetch` has no cookie jar, so
 * the cookie is captured from the login response and replayed by hand.
 */
export class WebApiSession {
  readonly #opts: TransportOptions;
  readonly #creds: WebApiCredentials;
  readonly #omadacId: string;
  readonly #httpClient: Deno.HttpClient | undefined;
  #csrfToken: string | null = null;
  #cookie: string | null = null;

  /** Prepare a session. No network call happens until `login`. */
  constructor(
    opts: TransportOptions,
    creds: WebApiCredentials,
    omadacId: string,
  ) {
    this.#opts = { ...opts, baseUrl: normaliseBase(opts.baseUrl) };
    this.#creds = creds;
    this.#omadacId = omadacId;
    this.#httpClient = makeHttpClient(opts.caCertPem);
  }

  /** Release the underlying TLS client. Safe to call more than once. */
  close(): void {
    this.#httpClient?.close();
  }

  /** Establish a session, or confirm the held one is still unused. */
  async login(): Promise<void> {
    if (this.#csrfToken !== null) return;
    await this.#authenticate();
  }

  async #authenticate(): Promise<void> {
    const path = `/${this.#omadacId}/api/v2/login`;
    const url = `${this.#opts.baseUrl}${path}`;
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          username: this.#creds.username,
          password: this.#creds.password,
        }),
        signal: AbortSignal.timeout(this.#opts.requestTimeoutSec * 1000),
        ...(this.#httpClient ? { client: this.#httpClient } : {}),
      });
    } catch (err) {
      throw new OmadaError(
        `web API login failed: ${err instanceof Error ? err.message : err}`,
        { path },
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    const envelope = parsed as {
      errorCode?: number;
      msg?: string;
      result?: { token?: string };
    };
    if (!response.ok || (envelope?.errorCode ?? 0) !== 0) {
      throw new OmadaError(
        `web API login failed: ${
          describeFailure(response.status, envelope?.errorCode ?? 0, parsed)
        } — check \`username\` and \`password\` against the controller login`,
        {
          status: response.status,
          errorCode: envelope?.errorCode ?? 0,
          path,
        },
      );
    }
    const token = envelope?.result?.token;
    if (typeof token !== "string" || token === "") {
      throw new OmadaError("web API login returned no token", {
        status: response.status,
        path,
      });
    }
    this.#csrfToken = token;

    // The session cookie is mandatory on every later call; the CSRF header on
    // its own is rejected. Keep only the name=value pair.
    const setCookie = response.headers.get("set-cookie") ?? "";
    const match = /TPOMADA_SESSIONID=([^;]+)/.exec(setCookie);
    this.#cookie = match ? `TPOMADA_SESSIONID=${match[1]}` : null;
  }

  /**
   * Call a v2 path under the controller id, reporting failure as a value.
   *
   * `path` is the part after `/{omadacId}/api/v2`, e.g. `/sites/{id}/setting`.
   */
  async call(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<CallOutcome> {
    await this.login();
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.toString() === "" ? "" : `?${search}`;
    const url =
      `${this.#opts.baseUrl}/${this.#omadacId}/api/v2${path}${suffix}`;

    const headers: Record<string, string> = {
      "Csrf-Token": this.#csrfToken ?? "",
    };
    if (this.#cookie !== null) headers.Cookie = this.#cookie;

    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await send(
        this.#opts,
        this.#httpClient,
        method,
        url,
        headers,
        opts.body,
      );
      // -1200 is the v2 API's "session expired". Re-login once, exactly as
      // the Open API path re-authenticates on -44112.
      const expired = outcome.status === 401 || outcome.errorCode === -1200;
      if (expired && attempt === 0) {
        this.#csrfToken = null;
        this.#cookie = null;
        await this.#authenticate();
        headers["Csrf-Token"] = this.#csrfToken ?? "";
        if (this.#cookie !== null) headers.Cookie = this.#cookie;
        continue;
      }
      return outcome;
    }
    throw new OmadaError("web API request exhausted its retry", { path });
  }

  /**
   * Read every page of a paginated v2 collection.
   *
   * The v2 API spells its pagination `currentPage`/`currentPageSize` and
   * reports `totalRows` — same shape as the Open API, different key names.
   * The page cap throws for the same reason it does there: a silently
   * truncated collection is worse than a failed read.
   */
  async listAll<T>(
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      pageSize?: number;
    } = {},
  ): Promise<T[]> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = 200;
    const collected: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const outcome = await this.call("GET", path, {
        query: {
          ...opts.query,
          currentPage: page,
          currentPageSize: pageSize,
        },
      });
      if (!outcome.ok) {
        throw new OmadaError(`GET ${path} failed: ${outcome.message}`, {
          status: outcome.status,
          errorCode: outcome.errorCode,
          path,
        });
      }
      const result = (outcome.body as {
        result?: { data?: T[]; totalRows?: number };
      })?.result;
      const rows = result?.data ?? [];
      collected.push(...rows);
      const total = result?.totalRows;
      if (rows.length === 0) return collected;
      if (typeof total === "number" && collected.length >= total) {
        return collected;
      }
      if (typeof total !== "number" && rows.length < pageSize) {
        return collected;
      }
    }
    throw new OmadaError(
      `pagination did not terminate after ${maxPages} pages ` +
        `(${collected.length} rows) — refusing to report a partial ` +
        "collection as complete",
      { path },
    );
  }
}
