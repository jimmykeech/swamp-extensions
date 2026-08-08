/**
 * HTTP client for the Nginx Proxy Manager admin API.
 *
 * NPM issues a bearer token from an email/password pair and expects it on
 * every subsequent call. The token is held for the lifetime of one method
 * execution and never persisted — a swamp run is short enough that the default
 * expiry is never reached, and a token in a resource would be a credential
 * leak for no benefit.
 *
 * Two request paths exist deliberately. `request` throws on any non-2xx, which
 * is what a read or a single-object write wants. `call` returns the outcome
 * instead, which is what a fan-out delete wants: one 404 on an
 * already-removed object should not abandon the remaining ids.
 *
 * @module
 */

/** An NPM admin API call that did not return 2xx. */
export class NpmError extends Error {
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  /** Request path, for context in the message. */
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "NpmError";
    this.status = status;
    this.path = path;
  }
}

/** Raw outcome of a non-throwing request. */
export interface CallOutcome {
  ok: boolean;
  status: number;
  /** Parsed JSON when the body was JSON, otherwise the raw text. */
  body: unknown;
  /** Human-readable failure detail; empty when `ok`. */
  message: string;
}

/**
 * NPM's error bodies are `{ error: { code, message } }`, but a reverse proxy
 * or a crashed container answers with HTML. Pull out whichever is there and
 * keep it short enough to read in a log line.
 */
function describeFailure(status: number, body: unknown, text: string): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: { message?: string } }).error;
    if (err?.message) return `HTTP ${status}: ${err.message}`;
  }
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed === ""
    ? `HTTP ${status}`
    : `HTTP ${status}: ${trimmed.slice(0, 300)}`;
}

/** Authenticated session against one NPM instance. */
export class NpmClient {
  readonly #baseUrl: string;
  readonly #identity: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  #token: string | null = null;

  constructor(opts: {
    baseUrl: string;
    identity: string;
    secret: string;
    requestTimeoutSec: number;
  }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#identity = opts.identity;
    this.#secret = opts.secret;
    this.#timeoutMs = opts.requestTimeoutSec * 1000;
  }

  /** The normalised base URL, as sent to the server. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * Exchange the admin credentials for a bearer token.
   *
   * Idempotent: repeated calls after the first are no-ops, so every method can
   * open with `await client.login()` without counting round trips.
   */
  async login(): Promise<void> {
    if (this.#token !== null) return;
    const outcome = await this.#fetch("POST", "/api/tokens", {
      identity: this.#identity,
      secret: this.#secret,
    });
    if (!outcome.ok) {
      // A 401 here is a wrong password, not an expired session — say so,
      // because the generic "unauthorized" sends people hunting for a token.
      const hint = outcome.status === 401
        ? " — check `identity` and `secret` against the NPM admin login"
        : "";
      throw new NpmError(
        `login failed: ${outcome.message}${hint}`,
        outcome.status,
        "/api/tokens",
      );
    }
    const token = (outcome.body as { token?: string })?.token;
    if (typeof token !== "string" || token === "") {
      throw new NpmError(
        "login succeeded but no token was returned — is baseUrl pointing at " +
          "the NPM admin interface rather than a proxied site?",
        outcome.status,
        "/api/tokens",
      );
    }
    this.#token = token;
  }

  /** Perform a request, throwing `NpmError` on any non-2xx response. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const outcome = await this.#fetch(method, path, body);
    if (!outcome.ok) {
      throw new NpmError(
        `${method} ${path} failed: ${outcome.message}`,
        outcome.status,
        path,
      );
    }
    return outcome.body as T;
  }

  /** Perform a request, reporting failure as a value rather than throwing. */
  call(method: string, path: string, body?: unknown): Promise<CallOutcome> {
    return this.#fetch(method, path, body);
  }

  /**
   * Upload PEM files against an existing certificate record.
   *
   * Separate from `#fetch` because this is the one multipart endpoint in the
   * API — setting a JSON content type here makes NPM reject the request.
   */
  async uploadCertificateFiles(
    certificateId: number,
    files: {
      certificate: string;
      certificateKey: string;
      intermediateCertificate?: string;
    },
  ): Promise<CallOutcome> {
    const form = new FormData();
    form.append(
      "certificate",
      new Blob([files.certificate]),
      "certificate.pem",
    );
    form.append(
      "certificate_key",
      new Blob([files.certificateKey]),
      "privkey.pem",
    );
    if (files.intermediateCertificate) {
      form.append(
        "intermediate_certificate",
        new Blob([files.intermediateCertificate]),
        "chain.pem",
      );
    }
    return await this.#send(
      "POST",
      `/api/nginx/certificates/${certificateId}/upload`,
      form,
      {},
    );
  }

  #fetch(method: string, path: string, body?: unknown): Promise<CallOutcome> {
    const headers: Record<string, string> = {};
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return this.#send(method, path, payload, headers);
  }

  async #send(
    method: string,
    path: string,
    payload: BodyInit | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<CallOutcome> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...extraHeaders,
    };
    if (this.#token !== null) {
      headers.Authorization = `Bearer ${this.#token}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body: payload,
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
        message: `${method} ${path}: ${detail}${hint}`,
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
      return {
        ok: false,
        status: response.status,
        body: parsed,
        message: describeFailure(response.status, parsed, text),
      };
    }
    return { ok: true, status: response.status, body: parsed, message: "" };
  }
}

/**
 * Read the instance version from the unauthenticated `/api/` root.
 *
 * Best-effort: an NPM build that omits the field still syncs fine, and an
 * empty version string reads more honestly than a fabricated one.
 */
export async function fetchVersion(client: NpmClient): Promise<string> {
  const outcome = await client.call("GET", "/api/");
  if (!outcome.ok || !outcome.body || typeof outcome.body !== "object") {
    return "";
  }
  const version = (outcome.body as {
    version?: { major?: number; minor?: number; revision?: number };
  }).version;
  if (!version || typeof version.major !== "number") return "";
  return `${version.major}.${version.minor ?? 0}.${version.revision ?? 0}`;
}
