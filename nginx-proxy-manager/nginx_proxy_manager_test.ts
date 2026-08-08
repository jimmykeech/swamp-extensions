/**
 * Unit tests for `@jamesakeech/nginx-proxy-manager`.
 *
 * The tests split along the same seam as the source. Everything in `map.ts`
 * and `change.ts` is pure and tested directly against representative NPM
 * payloads, including the 0/1 boolean shape older builds emit. `client.ts` is
 * exercised against a real loopback HTTP server rather than a stubbed `fetch`,
 * so the assertions cover what actually goes on the wire — bearer headers,
 * multipart bodies, and how a non-JSON error page is reported.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createModelTestContext } from "@swamp-club/swamp-testing";

import { model } from "./nginx_proxy_manager.ts";
import { buildChange, summariseAction } from "./_lib/npm/change.ts";
import { fetchVersion, NpmClient, NpmError } from "./_lib/npm/client.ts";
import {
  accessListBody,
  certificateBody,
  daysUntil,
  findByDomains,
  instanceNameFor,
  KIND_PATHS,
  proxyHostBody,
  type Provenance,
  sameDomainSet,
  streamBody,
  toAccessList,
  toCertificate,
  toProxyHost,
  toStream,
} from "./_lib/npm/map.ts";
import {
  AccessListSchema,
  ApplyAccessListArgsSchema,
  ApplyProxyHostArgsSchema,
  ApplyStreamArgsSchema,
  CertificateSchema,
  ChangeSchema,
  DeleteArgsSchema,
  GlobalArgsSchema,
  InstanceSchema,
  ProxyHostSchema,
  RequestCertificateArgsSchema,
  UploadCertificateArgsSchema,
} from "./_lib/npm/schemas.ts";

const P: Provenance = {
  instanceLabel: "edge",
  baseUrl: "http://npm.example.com:81",
  fetchedAt: "2026-08-08T00:00:00.000Z",
};
const NOW = Date.parse(P.fetchedAt);

// --- Read direction ---------------------------------------------------------

Deno.test("toProxyHost maps a full record and satisfies the schema", () => {
  const raw = {
    id: 7,
    domain_names: ["media.example.com"],
    forward_scheme: "http",
    forward_host: "192.0.2.20",
    forward_port: 8096,
    access_list_id: 2,
    certificate_id: 4,
    ssl_forced: true,
    hsts_enabled: true,
    hsts_subdomains: false,
    http2_support: true,
    block_exploits: true,
    caching_enabled: false,
    allow_websocket_upgrade: true,
    advanced_config: "client_max_body_size 0;",
    enabled: true,
    created_on: "2026-01-01T00:00:00.000Z",
    modified_on: "2026-02-01T00:00:00.000Z",
    locations: [{
      path: "/api",
      forward_scheme: "https",
      forward_host: "192.0.2.21",
      forward_port: 443,
      advanced_config: "proxy_read_timeout 300;",
    }],
  };

  const mapped = toProxyHost(raw, P);
  const parsed = ProxyHostSchema.parse(mapped);

  assertEquals(parsed.id, 7);
  assertEquals(parsed.forwardPort, 8096);
  assertEquals(parsed.accessListId, 2);
  assertEquals(parsed.sslForced, true);
  assertEquals(parsed.hstsSubdomains, false);
  assertEquals(parsed.advancedConfig, "client_max_body_size 0;");
  assertEquals(parsed.locations.length, 1);
  assertEquals(parsed.locations[0].forwardPort, 443);
  assertEquals(parsed.instanceLabel, "edge");
});

Deno.test("toProxyHost reads 0/1 booleans as booleans", () => {
  // The SQLite-backed NPM builds return integers here. Reading `1` as false
  // would report an HTTPS-forced host as plain HTTP.
  const mapped = toProxyHost({
    id: 1,
    domain_names: ["a.example.com"],
    ssl_forced: 1,
    enabled: 0,
    block_exploits: 1,
    caching_enabled: 0,
  }, P);

  assertEquals(mapped.sslForced, true);
  assertEquals(mapped.enabled, false);
  assertEquals(mapped.blockExploits, true);
  assertEquals(mapped.cachingEnabled, false);
});

Deno.test("toProxyHost fills defaults for a sparse record", () => {
  // An older build that omits hsts_subdomains and locations must still
  // produce a schema-valid resource rather than failing the whole sync.
  const parsed = ProxyHostSchema.parse(toProxyHost({ id: 3 }, P));

  assertEquals(parsed.domainNames, []);
  assertEquals(parsed.locations, []);
  assertEquals(parsed.hstsSubdomains, false);
  assertEquals(parsed.advancedConfig, "");
  assertEquals(parsed.createdOn, "");
});

Deno.test("toAccessList never carries a password off the wire", () => {
  const mapped = toAccessList({
    id: 2,
    name: "family",
    satisfy_any: 1,
    pass_auth: 0,
    items: [{ username: "jim", password: "should-not-appear" }],
    clients: [
      { address: "192.0.2.0/24", directive: "allow" },
      { address: "all", directive: "deny" },
    ],
    proxy_host_count: 3,
  }, P);

  // NPM echoes a hash here, never the password — but the resource must not
  // carry the field at all, so nobody can read a blank and believe it.
  const items = mapped.items as Array<Record<string, unknown>>;
  assertEquals(items[0], { username: "jim" });
  assertEquals("password" in items[0], false);
  assertEquals(AccessListSchema.parse(mapped).items[0].username, "jim");
  assertEquals(mapped.satisfyAny, true);
  assertEquals(mapped.passAuth, false);
  assertEquals(mapped.proxyHostCount, 3);
  assertEquals(
    (mapped.clients as Array<{ directive: string }>).map((c) => c.directive),
    ["allow", "deny"],
  );
});

Deno.test("toAccessList defaults an unknown directive to allow", () => {
  const mapped = toAccessList({
    id: 1,
    name: "x",
    clients: [{ address: "1.2.3.4", directive: "" }],
  }, P);
  assertEquals(
    (mapped.clients as Array<{ directive: string }>)[0].directive,
    "allow",
  );
});

Deno.test("toStream maps ports and protocol flags", () => {
  const mapped = toStream({
    id: 5,
    incoming_port: 25565,
    forwarding_host: "192.0.2.30",
    forwarding_port: 25565,
    tcp_forwarding: 1,
    udp_forwarding: 0,
    enabled: 1,
  }, P);

  assertEquals(mapped.incomingPort, 25565);
  assertEquals(mapped.tcpForwarding, true);
  assertEquals(mapped.udpForwarding, false);
  // Absent on builds without stream TLS — must read as "none", not NaN.
  assertEquals(mapped.certificateId, 0);
});

Deno.test("toCertificate computes days until expiry", () => {
  const mapped = toCertificate({
    id: 4,
    provider: "letsencrypt",
    nice_name: "example.com",
    domain_names: ["*.example.com"],
    expires_on: "2026-08-18T00:00:00.000Z",
    meta: { dns_challenge: true, dns_provider: "cloudflare" },
  }, P, NOW);

  const parsed = CertificateSchema.parse(mapped);
  assertEquals(parsed.daysUntilExpiry, 10);
  assertEquals(parsed.dnsChallenge, true);
  assertEquals(parsed.dnsProvider, "cloudflare");
});

Deno.test("toCertificate reports an expired certificate as negative", () => {
  const mapped = toCertificate({
    id: 1,
    expires_on: "2026-08-01T00:00:00.000Z",
  }, P, NOW);
  assertEquals(mapped.daysUntilExpiry, -7);
});

Deno.test("daysUntil sentinels an unparseable date well below zero", () => {
  // Must not land near 0, or a certificate with no date would be reported as
  // expiring today and trip an expiry alert.
  assertEquals(daysUntil("", NOW), -99999);
  assertEquals(daysUntil("not-a-date", NOW), -99999);
});

// --- Matching ---------------------------------------------------------------

Deno.test("sameDomainSet ignores order and case", () => {
  assert(sameDomainSet(["a.example.com", "b.example.com"], ["B.EXAMPLE.COM", "a.example.com"]));
});

Deno.test("sameDomainSet rejects a subset", () => {
  // The upsert match key: treating a subset as a match would silently
  // overwrite a two-domain host with a one-domain config.
  assert(!sameDomainSet(["a.example.com", "b.example.com"], ["a.example.com"]));
  assert(!sameDomainSet(["a.example.com"], ["a.example.com", "b.example.com"]));
});

Deno.test("sameDomainSet tolerates duplicates within a list", () => {
  assert(sameDomainSet(["a.example.com", "a.example.com"], ["a.example.com"]));
});

Deno.test("findByDomains returns the exact match or null", () => {
  const records = [
    { id: 1, domain_names: ["a.example.com"] },
    { id: 2, domain_names: ["b.example.com", "c.example.com"] },
  ];
  assertEquals(findByDomains(records, ["c.example.com", "b.example.com"])?.id, 2);
  assertEquals(findByDomains(records, ["d.example.com"]), null);
});

Deno.test("instanceNameFor keeps kinds in separate namespaces", () => {
  // Instance names share one keyspace on disk; a collision here would make a
  // stream overwrite a proxy host that happened to have the same NPM id.
  assertEquals(instanceNameFor("proxyHost", 1), "proxy-host-1");
  assertEquals(instanceNameFor("stream", 1), "stream-1");
  const names = (Object.keys(KIND_PATHS) as Array<keyof typeof KIND_PATHS>)
    .map((k) => instanceNameFor(k, 1));
  assertEquals(new Set(names).size, names.length);
});

// --- Write direction --------------------------------------------------------

Deno.test("proxyHostBody sends snake_case and omits enabled", () => {
  const args = ApplyProxyHostArgsSchema.parse({
    domainNames: ["media.example.com"],
    forwardHost: "192.0.2.20",
    forwardPort: 8096,
    certificateId: 4,
    sslForced: true,
    locations: [{
      path: "/api",
      forwardScheme: "http",
      forwardHost: "192.0.2.21",
      forwardPort: 80,
    }],
  });
  const body = proxyHostBody(args);

  assertEquals(body.domain_names, ["media.example.com"]);
  assertEquals(body.forward_port, 8096);
  assertEquals(body.certificate_id, 4);
  assertEquals(body.ssl_forced, true);
  assertEquals(body.allow_websocket_upgrade, true);
  assertEquals(body.block_exploits, true);
  // NPM ignores `enabled` on the host body — sending it would imply the
  // enable/disable calls are unnecessary.
  assertEquals("enabled" in body, false);
  assertEquals(
    (body.locations as Array<Record<string, unknown>>)[0].forward_host,
    "192.0.2.21",
  );
});

Deno.test("streamBody omits certificate_id when unset", () => {
  // Older NPM builds have no stream TLS and reject the unknown property.
  const plain = streamBody(ApplyStreamArgsSchema.parse({
    incomingPort: 25565,
    forwardingHost: "192.0.2.30",
    forwardingPort: 25565,
  }));
  assertEquals("certificate_id" in plain, false);
  assertEquals(plain.tcp_forwarding, true);
  assertEquals(plain.udp_forwarding, false);

  const secured = streamBody(ApplyStreamArgsSchema.parse({
    incomingPort: 5432,
    forwardingHost: "192.0.2.31",
    forwardingPort: 5432,
    certificateId: 9,
  }));
  assertEquals(secured.certificate_id, 9);
});

Deno.test("accessListBody carries the full user set through", () => {
  const body = accessListBody({
    name: "family",
    satisfyAny: false,
    passAuth: false,
    items: [{ username: "jim", password: "hunter2" }],
    clients: [{ address: "192.0.2.0/24", directive: "allow" as const }],
  });

  assertEquals(body.name, "family");
  assertEquals(body.satisfy_any, false);
  assertEquals(
    (body.items as Array<Record<string, unknown>>)[0],
    { username: "jim", password: "hunter2" },
  );
  assertEquals(
    (body.clients as Array<Record<string, unknown>>)[0].directive,
    "allow",
  );
});

Deno.test("certificateBody only sends DNS fields for a DNS challenge", () => {
  const http = certificateBody(RequestCertificateArgsSchema.parse({
    domainNames: ["a.example.com"],
    letsencryptEmail: "me@example.com",
  }));
  const httpMeta = http.meta as Record<string, unknown>;
  assertEquals(http.provider, "letsencrypt");
  assertEquals(httpMeta.letsencrypt_agree, true);
  assertEquals(httpMeta.dns_challenge, false);
  assertEquals("dns_provider" in httpMeta, false);

  const dns = certificateBody(RequestCertificateArgsSchema.parse({
    domainNames: ["*.example.com"],
    letsencryptEmail: "me@example.com",
    dnsChallenge: true,
    dnsProvider: "cloudflare",
    dnsProviderCredentials: "dns_cloudflare_api_token = x",
    propagationSeconds: 60,
  }));
  const dnsMeta = dns.meta as Record<string, unknown>;
  assertEquals(dnsMeta.dns_provider, "cloudflare");
  assertEquals(dnsMeta.propagation_seconds, 60);
});

Deno.test("certificateBody omits propagation_seconds at the default", () => {
  const dns = certificateBody(RequestCertificateArgsSchema.parse({
    domainNames: ["*.example.com"],
    letsencryptEmail: "me@example.com",
    dnsChallenge: true,
    dnsProvider: "cloudflare",
    dnsProviderCredentials: "token",
  }));
  assertEquals("propagation_seconds" in (dns.meta as object), false);
});

// --- Change summary ---------------------------------------------------------

Deno.test("summariseAction reports a half-failed fan-out as partial", () => {
  // The important case: a guard written as `action == "deleted"` must not
  // fire when two of three ids are still present on the instance.
  const action = summariseAction([
    { kind: "proxyHost", id: 1, action: "deleted", ok: true, httpStatus: 200, message: "" },
    { kind: "proxyHost", id: 2, action: "failed", ok: false, httpStatus: 404, message: "gone" },
  ]);
  assertEquals(action, "partial");
});

Deno.test("summariseAction passes through a uniform outcome", () => {
  assertEquals(
    summariseAction([
      { kind: "stream", id: 1, action: "deleted", ok: true, httpStatus: 200, message: "" },
      { kind: "stream", id: 2, action: "deleted", ok: true, httpStatus: 200, message: "" },
    ]),
    "deleted",
  );
  assertEquals(
    summariseAction([
      { kind: "stream", id: 1, action: "failed", ok: false, httpStatus: 500, message: "boom" },
    ]),
    "failed",
  );
  assertEquals(summariseAction([]), "none");
});

Deno.test("buildChange counts outcomes and validates against its schema", () => {
  const change = buildChange("delete", "edge", "http://npm.example.com:81", P.fetchedAt, [
    { kind: "proxyHost", id: 1, action: "deleted", ok: true, httpStatus: 200, message: "" },
    { kind: "proxyHost", id: 2, action: "failed", ok: false, httpStatus: 404, message: "HTTP 404" },
  ]);
  const parsed = ChangeSchema.parse(change);

  assertEquals(parsed.okCount, 1);
  assertEquals(parsed.failCount, 1);
  assertEquals(parsed.ok, false);
  assertEquals(parsed.action, "partial");
  // No single primary object in a batch — 0 rather than an arbitrary member.
  assertEquals(parsed.id, 0);
});

Deno.test("buildChange exposes the id for a single-object call", () => {
  const parsed = ChangeSchema.parse(
    buildChange("applyProxyHost", "edge", "http://npm.example.com:81", P.fetchedAt, [
      { kind: "proxyHost", id: 12, action: "created", ok: true, httpStatus: 201, message: "" },
    ]),
  );
  assertEquals(parsed.id, 12);
  assertEquals(parsed.ok, true);
  assertEquals(parsed.action, "created");
});

// --- Argument schemas -------------------------------------------------------

Deno.test("GlobalArgsSchema applies its defaults", () => {
  const parsed = GlobalArgsSchema.parse({
    baseUrl: "http://npm.example.com:81",
    identity: "me@example.com",
    secret: "pw",
  });
  assertEquals(parsed.instanceLabel, "nginx-proxy-manager");
  assertEquals(parsed.requestTimeoutSec, 30);
});

Deno.test("DeleteArgsSchema rejects an empty id list", () => {
  // A delete with no ids is a caller mistake, not a no-op worth running.
  assertEquals(DeleteArgsSchema.safeParse({ kind: "proxyHost", ids: [] }).success, false);
  assertEquals(DeleteArgsSchema.safeParse({ kind: "nope", ids: [1] }).success, false);
  assertEquals(DeleteArgsSchema.safeParse({ kind: "certificate", ids: [1] }).success, true);
});

Deno.test("ApplyProxyHostArgsSchema bounds the upstream port", () => {
  const base = { domainNames: ["a.example.com"], forwardHost: "192.0.2.1" };
  assertEquals(
    ApplyProxyHostArgsSchema.safeParse({ ...base, forwardPort: 70000 }).success,
    false,
  );
  assertEquals(
    ApplyProxyHostArgsSchema.safeParse({ ...base, forwardPort: 0 }).success,
    false,
  );
  assertEquals(
    ApplyProxyHostArgsSchema.safeParse({ ...base, forwardPort: 8096 }).success,
    true,
  );
});

Deno.test("ApplyProxyHostArgsSchema requires at least one domain", () => {
  assertEquals(
    ApplyProxyHostArgsSchema.safeParse({
      domainNames: [],
      forwardHost: "192.0.2.1",
      forwardPort: 80,
    }).success,
    false,
  );
});

// --- Client -----------------------------------------------------------------

/** Route table for the stub NPM instance. */
type Handler = (req: Request, url: URL) => Response | Promise<Response>;

/** Run `fn` against a loopback server, tearing it down afterwards. */
async function withServer(
  handler: Handler,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req) => handler(req, new URL(req.url)),
  );
  try {
    await fn(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    controller.abort();
    await server.finished;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(baseUrl: string, timeoutSec = 5): NpmClient {
  return new NpmClient({
    baseUrl,
    identity: "me@example.com",
    secret: "pw",
    requestTimeoutSec: timeoutSec,
  });
}

Deno.test("login exchanges credentials and bearers every later call", async () => {
  const seen: Array<{ path: string; auth: string | null }> = [];
  await withServer(async (req, url) => {
    seen.push({ path: url.pathname, auth: req.headers.get("Authorization") });
    if (url.pathname === "/api/tokens") {
      const body = await req.json();
      assertEquals(body, { identity: "me@example.com", secret: "pw" });
      return json({ token: "tok-abc", expires: "2026-08-09T00:00:00.000Z" });
    }
    return json([{ id: 1 }]);
  }, async (baseUrl) => {
    const c = client(baseUrl);
    await c.login();
    await c.login(); // idempotent — must not re-authenticate
    await c.request("GET", "/api/nginx/proxy-hosts");

    assertEquals(seen.length, 2);
    assertEquals(seen[0].auth, null);
    assertEquals(seen[1].auth, "Bearer tok-abc");
  });
});

Deno.test("login turns a 401 into an actionable message", async () => {
  await withServer(
    () => json({ error: { code: 401, message: "Invalid email or password" } }, 401),
    async (baseUrl) => {
      const err = await assertRejects(
        () => client(baseUrl).login(),
        NpmError,
      );
      assertStringIncludes(err.message, "Invalid email or password");
      assertStringIncludes(err.message, "check `identity` and `secret`");
      assertEquals(err.status, 401);
    },
  );
});

Deno.test("login rejects a 200 that carries no token", async () => {
  // Pointing baseUrl at a proxied site instead of the admin UI lands here.
  await withServer(() => json({ hello: "world" }), async (baseUrl) => {
    const err = await assertRejects(() => client(baseUrl).login(), NpmError);
    assertStringIncludes(err.message, "no token was returned");
  });
});

Deno.test("baseUrl trailing slashes do not double up in paths", async () => {
  const paths: string[] = [];
  await withServer((_req, url) => {
    paths.push(url.pathname);
    return json({ token: "t" });
  }, async (baseUrl) => {
    const c = new NpmClient({
      baseUrl: `${baseUrl}///`,
      identity: "a",
      secret: "b",
      requestTimeoutSec: 5,
    });
    await c.login();
    assertEquals(paths[0], "/api/tokens");
    assertEquals(c.baseUrl, baseUrl);
  });
});

Deno.test("request throws on a non-2xx and surfaces NPM's error message", async () => {
  await withServer((_req, url) => {
    if (url.pathname === "/api/tokens") return json({ token: "t" });
    return json({ error: { code: 400, message: "domain_names is required" } }, 400);
  }, async (baseUrl) => {
    const c = client(baseUrl);
    await c.login();
    const err = await assertRejects(
      () => c.request("POST", "/api/nginx/proxy-hosts", {}),
      NpmError,
    );
    assertStringIncludes(err.message, "domain_names is required");
    assertEquals(err.status, 400);
  });
});

Deno.test("request reports a non-JSON error page readably", async () => {
  // A crashed container or an intermediate proxy answers with HTML, not the
  // NPM error envelope. The status must still reach the caller.
  await withServer((_req, url) => {
    if (url.pathname === "/api/tokens") return json({ token: "t" });
    return new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
  }, async (baseUrl) => {
    const c = client(baseUrl);
    await c.login();
    const err = await assertRejects(
      () => c.request("GET", "/api/nginx/streams"),
      NpmError,
    );
    assertEquals(err.status, 502);
    assertStringIncludes(err.message, "502 Bad Gateway");
  });
});

Deno.test("call reports failure as a value instead of throwing", async () => {
  // This is what lets a fan-out delete continue past an already-gone id.
  await withServer((_req, url) => {
    if (url.pathname === "/api/tokens") return json({ token: "t" });
    if (url.pathname === "/api/nginx/proxy-hosts/1") return json(true);
    return json({ error: { code: 404, message: "Not found" } }, 404);
  }, async (baseUrl) => {
    const c = client(baseUrl);
    await c.login();

    const ok = await c.call("DELETE", "/api/nginx/proxy-hosts/1");
    assertEquals(ok.ok, true);
    assertEquals(ok.status, 200);
    assertEquals(ok.message, "");

    const gone = await c.call("DELETE", "/api/nginx/proxy-hosts/99");
    assertEquals(gone.ok, false);
    assertEquals(gone.status, 404);
    assertStringIncludes(gone.message, "Not found");
  });
});

Deno.test("call reports an unreachable host without throwing", async () => {
  // Port 1 on loopback refuses connections; no server is started here.
  const outcome = await client("http://127.0.0.1:1", 2).call("GET", "/api/");
  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, 0);
  assert(outcome.message.length > 0);
});

Deno.test("a 204 with an empty body is a success, not a parse failure", async () => {
  await withServer((_req, url) => {
    if (url.pathname === "/api/tokens") return json({ token: "t" });
    return new Response(null, { status: 204 });
  }, async (baseUrl) => {
    const c = client(baseUrl);
    await c.login();
    const outcome = await c.call("DELETE", "/api/nginx/streams/3");
    assertEquals(outcome.ok, true);
    assertEquals(outcome.body, null);
  });
});

Deno.test("uploadCertificateFiles posts multipart with NPM's field names", async () => {
  let fields: string[] = [];
  let certificate = "";
  let contentType = "";
  await withServer(async (req, url) => {
    if (url.pathname === "/api/tokens") return json({ token: "t" });
    contentType = req.headers.get("Content-Type") ?? "";
    const form = await req.formData();
    fields = [...form.keys()].sort();
    certificate = await (form.get("certificate") as File).text();
    return json({ certificate: "ok" });
  }, async (baseUrl) => {
    const c = client(baseUrl);
    await c.login();
    const outcome = await c.uploadCertificateFiles(4, {
      certificate: "-----BEGIN CERTIFICATE-----",
      certificateKey: "-----BEGIN PRIVATE KEY-----",
      intermediateCertificate: "-----BEGIN CERTIFICATE-----",
    });

    assertEquals(outcome.ok, true);
    assertEquals(fields, [
      "certificate",
      "certificate_key",
      "intermediate_certificate",
    ]);
    assertEquals(certificate, "-----BEGIN CERTIFICATE-----");
    // A JSON content type here makes NPM reject the upload outright.
    assertStringIncludes(contentType, "multipart/form-data");
  });
});

Deno.test("uploadCertificateFiles omits the chain when not supplied", async () => {
  let fields: string[] = [];
  await withServer(async (req, url) => {
    if (url.pathname === "/api/tokens") return json({ token: "t" });
    fields = [...(await req.formData()).keys()].sort();
    return json({});
  }, async (baseUrl) => {
    const c = client(baseUrl);
    await c.login();
    await c.uploadCertificateFiles(4, {
      certificate: "cert",
      certificateKey: "key",
    });
    assertEquals(fields, ["certificate", "certificate_key"]);
  });
});

Deno.test("fetchVersion reads the unauthenticated root", async () => {
  await withServer(
    () => json({ status: "OK", version: { major: 2, minor: 11, revision: 3 } }),
    async (baseUrl) => {
      assertEquals(await fetchVersion(client(baseUrl)), "2.11.3");
    },
  );
});

Deno.test("fetchVersion degrades to an empty string, never a guess", async () => {
  // A build that omits the field still syncs; reporting "" is honest where a
  // fabricated version would mislead an upgrade decision.
  await withServer(() => json({ status: "OK" }), async (baseUrl) => {
    assertEquals(await fetchVersion(client(baseUrl)), "");
  });
  await withServer(() => new Response("nope", { status: 500 }), async (b) => {
    assertEquals(await fetchVersion(client(b)), "");
  });
});

Deno.test("a request that outlives the timeout fails as a timeout", async () => {
  await withServer(async (_req, url) => {
    if (url.pathname === "/api/tokens") return json({ token: "t" });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return json({});
  }, async (baseUrl) => {
    const c = client(baseUrl, 1);
    await c.login();
    const outcome = await c.call("GET", "/api/nginx/proxy-hosts");
    assertEquals(outcome.ok, false);
    assertEquals(outcome.status, 0);
    assertStringIncludes(outcome.message, "no response within 1s");
  });
});

// --- Method-level tests -----------------------------------------------------
//
// These drive the exported methods against a stub NPM instance that holds real
// state, so an upsert genuinely has to find (or fail to find) a record, and a
// delete genuinely removes one. `baseUrl` points at the stub rather than
// `fetch` being patched, which keeps the client's real request path under test.

/** Mutable stand-in for an NPM instance's object tables. */
interface Stub {
  proxyHosts: Raw[];
  redirectionHosts: Raw[];
  deadHosts: Raw[];
  streams: Raw[];
  accessLists: Raw[];
  certificates: Raw[];
}

type Raw = Record<string, unknown>;

const COLLECTIONS: Record<string, keyof Stub> = {
  "proxy-hosts": "proxyHosts",
  "redirection-hosts": "redirectionHosts",
  "dead-hosts": "deadHosts",
  "streams": "streams",
  "access-lists": "accessLists",
  "certificates": "certificates",
};

function emptyStub(overrides: Partial<Stub> = {}): Stub {
  return {
    proxyHosts: [],
    redirectionHosts: [],
    deadHosts: [],
    streams: [],
    accessLists: [],
    certificates: [],
    ...overrides,
  };
}

/** Every request the stub saw, for asserting on verbs and paths. */
interface Seen {
  method: string;
  path: string;
  body: Raw | null;
}

/** Route a request against the stub's state, mutating it as NPM would. */
async function routeStub(
  state: Stub,
  seen: Seen[],
  req: Request,
  url: URL,
  nextId: { value: number },
): Promise<Response> {
  const path = url.pathname;
  let body: Raw | null = null;
  if (req.method !== "GET" && req.headers.get("Content-Type")?.includes("json")) {
    body = await req.json().catch(() => null);
  }
  seen.push({ method: req.method, path, body });

  if (path === "/api/tokens") return json({ token: "stub-token" });
  if (path === "/api/") {
    return json({ version: { major: 2, minor: 11, revision: 3 } });
  }

  const parts = path.replace(/^\/api\/nginx\//, "").split("/");
  const key = COLLECTIONS[parts[0]];
  if (key === undefined) return json({ error: { message: "no route" } }, 404);
  const rows = state[key];

  // Collection: list or create.
  if (parts.length === 1) {
    if (req.method === "GET") return json(rows);
    if (req.method === "POST") {
      const created = { id: nextId.value++, enabled: true, ...(body ?? {}) };
      rows.push(created);
      return json(created, 201);
    }
  }

  const id = Number(parts[1]);
  const index = rows.findIndex((r) => r.id === id);
  const action = parts[2];

  if (index === -1) return json({ error: { message: "Not found" } }, 404);

  if (action === undefined) {
    if (req.method === "GET") return json(rows[index]);
    if (req.method === "PUT") {
      rows[index] = { ...rows[index], ...(body ?? {}) };
      return json(rows[index]);
    }
    if (req.method === "DELETE") {
      rows.splice(index, 1);
      return json(true);
    }
  }
  if (action === "enable" || action === "disable") {
    rows[index].enabled = action === "enable";
    return json(true);
  }
  if (action === "renew") {
    rows[index].expires_on = "2027-01-01T00:00:00.000Z";
    return json(rows[index]);
  }
  if (action === "upload") {
    rows[index].domain_names = ["uploaded.example.com"];
    return json(rows[index]);
  }
  return json({ error: { message: "no route" } }, 404);
}

/** A model method context backed by the stub, plus captured writes. */
function stubContext(baseUrl: string) {
  const base = createModelTestContext({
    globalArgs: GlobalArgsSchema.parse({
      baseUrl,
      identity: "admin@example.com",
      secret: "pw",
      instanceLabel: "edge",
      requestTimeoutSec: 5,
    }),
  });
  // Two gaps in the test helper have to be filled to drive real methods:
  //
  //  - no `deleteResource`, which `delete` uses to drop the resource for an
  //    object that no longer exists;
  //  - a logger exposing `warn`, where the swamp runtime (and the rest of this
  //    repo's extensions) call `warning`.
  //
  // Warnings are captured here rather than read back through the helper, so
  // assertions do not depend on which spelling it files them under.
  const deleted: string[] = [];
  const warnings: string[] = [];
  const context = {
    ...base.context,
    deleteResource: (name: string) => {
      deleted.push(name);
      return Promise.resolve();
    },
    logger: {
      ...base.context.logger,
      warning: (msg: string, props?: Record<string, unknown>) => {
        warnings.push(msg);
        base.context.logger.warn(msg, props);
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { ...base, context, deleted, warnings };
}

/** Run `fn` against a stub NPM instance. */
async function withStub(
  state: Stub,
  fn: (
    ctx: ReturnType<typeof stubContext>,
    seen: Seen[],
    state: Stub,
  ) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const nextId = { value: 100 };
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req) => routeStub(state, seen, req, new URL(req.url), nextId),
  );
  try {
    await fn(stubContext(`http://127.0.0.1:${server.addr.port}`), seen, state);
  } finally {
    controller.abort();
    await server.finished;
  }
}

/** Written resources for one spec, in write order. */
// deno-lint-ignore no-explicit-any
function written(ctx: ReturnType<typeof stubContext>, spec: string): any[] {
  return ctx.getWrittenResources().filter((w) => w.specName === spec);
}

Deno.test("sync fans out one resource per object plus the rollup", async () => {
  const state = emptyStub({
    proxyHosts: [
      { id: 1, domain_names: ["a.example.com"], enabled: 1, certificate_id: 0 },
      { id: 2, domain_names: ["b.example.com"], enabled: 1, certificate_id: 5 },
    ],
    redirectionHosts: [{ id: 3, domain_names: ["old.example.com"], enabled: 1 }],
    deadHosts: [{ id: 4, domain_names: ["gone.example.com"], enabled: 1 }],
    streams: [{ id: 5, incoming_port: 25565, enabled: 1 }],
    accessLists: [{ id: 6, name: "family", items: [], clients: [] }],
    certificates: [
      { id: 5, provider: "letsencrypt", expires_on: "2099-01-01T00:00:00.000Z" },
    ],
  });

  await withStub(state, async (ctx) => {
    await model.methods.sync.execute({ includeDisabled: true }, ctx.context);

    assertEquals(written(ctx, "proxyHost").map((w) => w.name), [
      "proxy-host-1",
      "proxy-host-2",
    ]);
    assertEquals(written(ctx, "stream")[0].name, "stream-5");
    assertEquals(written(ctx, "accessList")[0].name, "access-list-6");

    const instance = written(ctx, "instance")[0];
    assertEquals(instance.name, "instance");
    assertEquals(instance.data.version, "2.11.3");
    assertEquals(instance.data.proxyHostCount, 2);
    assertEquals(instance.data.redirectionHostCount, 1);
    assertEquals(instance.data.deadHostCount, 1);
    assertEquals(instance.data.streamCount, 1);
    assertEquals(instance.data.certificateCount, 1);
    // Only proxy host 1 is enabled and certificate-less.
    assertEquals(instance.data.hostsWithoutCertificate, 1);
    assertEquals(instance.data.uniqueDomainCount, 4);
    assertEquals(instance.data.domainsServedByMultipleHosts, []);
    // Validates against the declared schema, not just the assertions above.
    InstanceSchema.parse(instance.data);
  });
});

Deno.test("sync flags a domain claimed by two hosts", async () => {
  const state = emptyStub({
    proxyHosts: [{ id: 1, domain_names: ["dup.example.com"], enabled: 1 }],
    deadHosts: [{ id: 2, domain_names: ["DUP.example.com"], enabled: 1 }],
  });
  await withStub(state, async (ctx) => {
    await model.methods.sync.execute({ includeDisabled: true }, ctx.context);
    const instance = written(ctx, "instance")[0];
    // Case-insensitive: nginx does not care, so neither does the check.
    assertEquals(instance.data.domainsServedByMultipleHosts, ["dup.example.com"]);
    assertEquals(instance.data.uniqueDomainCount, 1);
    assert(ctx.warnings.some((w) => w.includes("more than one host")));
  });
});

Deno.test("sync separates expired certificates from expiring ones", async () => {
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const state = emptyStub({
    certificates: [
      { id: 1, provider: "letsencrypt", expires_on: soon },
      { id: 2, provider: "letsencrypt", expires_on: past },
    ],
  });
  await withStub(state, async (ctx) => {
    await model.methods.sync.execute({ includeDisabled: true }, ctx.context);
    const data = written(ctx, "instance")[0].data;
    // An already-dead certificate must not hide inside "expiring soon".
    assertEquals(data.certificatesExpiringWithin30d, 1);
    assertEquals(data.certificatesExpired, 1);
  });
});

Deno.test("sync can skip disabled hosts while still counting them", async () => {
  const state = emptyStub({
    proxyHosts: [
      { id: 1, domain_names: ["on.example.com"], enabled: 1 },
      { id: 2, domain_names: ["off.example.com"], enabled: 0 },
    ],
  });
  await withStub(state, async (ctx) => {
    await model.methods.sync.execute({ includeDisabled: false }, ctx.context);
    assertEquals(written(ctx, "proxyHost").map((w) => w.name), ["proxy-host-1"]);
    // Counts describe the instance, not the filtered write set.
    assertEquals(written(ctx, "instance")[0].data.proxyHostCount, 2);
  });
});

Deno.test("sync survives a collection the instance does not expose", async () => {
  // Simulates an older build with no /streams endpoint.
  const state = emptyStub({
    proxyHosts: [{ id: 1, domain_names: ["a.example.com"], enabled: 1 }],
  });
  const seen: Seen[] = [];
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/nginx/streams") {
        return json({ error: { message: "Not found" } }, 404);
      }
      return routeStub(state, seen, req, url, { value: 100 });
    },
  );
  try {
    const ctx = stubContext(`http://127.0.0.1:${server.addr.port}`);
    await model.methods.sync.execute({ includeDisabled: true }, ctx.context);
    assertEquals(written(ctx, "instance")[0].data.streamCount, 0);
    // Reporting zero silently would be a lie — it has to say the call failed.
    assert(ctx.warnings.some((w) => w.includes("could not list")));
  } finally {
    controller.abort();
    await server.finished;
  }
});

Deno.test("applyProxyHost creates when no domain set matches", async () => {
  const state = emptyStub({
    proxyHosts: [{ id: 1, domain_names: ["other.example.com"], enabled: true }],
  });
  await withStub(state, async (ctx, seen) => {
    await model.methods.applyProxyHost.execute(
      ApplyProxyHostArgsSchema.parse({
        domainNames: ["new.example.com"],
        forwardHost: "192.0.2.20",
        forwardPort: 8096,
      }),
      ctx.context,
    );

    assertEquals(state.proxyHosts.length, 2);
    assert(seen.some((s) => s.method === "POST" && s.path === "/api/nginx/proxy-hosts"));
    assert(!seen.some((s) => s.method === "PUT"));

    const change = written(ctx, "change")[0];
    assertEquals(change.name, "change-applyProxyHost");
    assertEquals(change.data.action, "created");
    assertEquals(change.data.id, 100);
    assertEquals(change.data.ok, true);
    // The created object is written too, so its id is usable without a sync.
    assertEquals(written(ctx, "proxyHost")[0].name, "proxy-host-100");
  });
});

Deno.test("applyProxyHost updates in place when the domain set matches", async () => {
  const state = emptyStub({
    proxyHosts: [{
      id: 42,
      domain_names: ["media.example.com"],
      forward_port: 8096,
      enabled: true,
    }],
  });
  await withStub(state, async (ctx, seen) => {
    await model.methods.applyProxyHost.execute(
      ApplyProxyHostArgsSchema.parse({
        // Reordered and recased — still the same host.
        domainNames: ["MEDIA.example.com"],
        forwardHost: "192.0.2.20",
        forwardPort: 9000,
      }),
      ctx.context,
    );

    // Re-running converges rather than accumulating duplicates.
    assertEquals(state.proxyHosts.length, 1);
    assertEquals(state.proxyHosts[0].forward_port, 9000);
    assert(seen.some((s) => s.method === "PUT" && s.path === "/api/nginx/proxy-hosts/42"));
    assertEquals(written(ctx, "change")[0].data.action, "updated");
    assertEquals(written(ctx, "change")[0].data.id, 42);
  });
});

Deno.test("applyProxyHost honours an explicit id over domain matching", async () => {
  // The documented route for changing an existing host's domain set.
  const state = emptyStub({
    proxyHosts: [{ id: 42, domain_names: ["old.example.com"], enabled: true }],
  });
  await withStub(state, async (ctx, seen) => {
    await model.methods.applyProxyHost.execute(
      ApplyProxyHostArgsSchema.parse({
        id: 42,
        domainNames: ["renamed.example.com"],
        forwardHost: "192.0.2.20",
        forwardPort: 80,
      }),
      ctx.context,
    );
    assertEquals(state.proxyHosts.length, 1);
    assertEquals(state.proxyHosts[0].domain_names, ["renamed.example.com"]);
    // No list call is needed when the caller named the target.
    assert(!seen.some((s) => s.method === "GET" && s.path === "/api/nginx/proxy-hosts"));
  });
});

Deno.test("applyProxyHost toggles enabled only when it differs", async () => {
  const state = emptyStub({
    proxyHosts: [{ id: 42, domain_names: ["a.example.com"], enabled: true }],
  });
  await withStub(state, async (ctx, seen) => {
    // Already enabled and staying enabled — no extra call.
    await model.methods.applyProxyHost.execute(
      ApplyProxyHostArgsSchema.parse({
        domainNames: ["a.example.com"],
        forwardHost: "192.0.2.20",
        forwardPort: 80,
        enabled: true,
      }),
      ctx.context,
    );
    assert(!seen.some((s) => s.path.endsWith("/enable")));

    await model.methods.applyProxyHost.execute(
      ApplyProxyHostArgsSchema.parse({
        domainNames: ["a.example.com"],
        forwardHost: "192.0.2.20",
        forwardPort: 80,
        enabled: false,
      }),
      ctx.context,
    );
    assert(seen.some((s) => s.path === "/api/nginx/proxy-hosts/42/disable"));
    assertEquals(state.proxyHosts[0].enabled, false);
  });
});

Deno.test("applyProxyHost refuses sslForced without a certificate", async () => {
  await withStub(emptyStub(), async (ctx, seen) => {
    // Must throw before touching the API — a forced-SSL host with no
    // certificate is served as a broken site.
    await assertRejects(
      () =>
        model.methods.applyProxyHost.execute(
          ApplyProxyHostArgsSchema.parse({
            domainNames: ["a.example.com"],
            forwardHost: "192.0.2.20",
            forwardPort: 80,
            sslForced: true,
          }),
          ctx.context,
        ),
      Error,
      "sslForced requires a certificate",
    );
    assertEquals(ctx.getWrittenResources().length, 0);
    assertEquals(seen.filter((s) => s.path !== "/api/tokens").length, 0);
  });
});

Deno.test("applyStream matches on the incoming port", async () => {
  const state = emptyStub({
    streams: [{ id: 9, incoming_port: 25565, forwarding_port: 1000, enabled: true }],
  });
  await withStub(state, async (ctx, seen) => {
    await model.methods.applyStream.execute(
      ApplyStreamArgsSchema.parse({
        incomingPort: 25565,
        forwardingHost: "192.0.2.30",
        forwardingPort: 25565,
      }),
      ctx.context,
    );
    assertEquals(state.streams.length, 1);
    assertEquals(state.streams[0].forwarding_port, 25565);
    assert(seen.some((s) => s.method === "PUT" && s.path === "/api/nginx/streams/9"));
  });
});

Deno.test("applyStream refuses a forward with neither protocol", async () => {
  await withStub(emptyStub(), async (ctx) => {
    await assertRejects(
      () =>
        model.methods.applyStream.execute(
          ApplyStreamArgsSchema.parse({
            incomingPort: 25565,
            forwardingHost: "192.0.2.30",
            forwardingPort: 25565,
            tcpForwarding: false,
            udpForwarding: false,
          }),
          ctx.context,
        ),
      Error,
      "must forward TCP, UDP or both",
    );
  });
});

Deno.test("applyAccessList refuses a list that would deny everything", async () => {
  await withStub(emptyStub(), async (ctx) => {
    await assertRejects(
      () =>
        model.methods.applyAccessList.execute(
          ApplyAccessListArgsSchema.parse({ name: "empty" }),
          ctx.context,
        ),
      Error,
      "denies everything",
    );
  });
});

Deno.test("applyAccessList reads back usernames without passwords", async () => {
  await withStub(emptyStub(), async (ctx) => {
    await model.methods.applyAccessList.execute(
      ApplyAccessListArgsSchema.parse({
        name: "family",
        items: [{ username: "jim", password: "hunter2" }],
        clients: [{ address: "192.0.2.0/24", directive: "allow" }],
      }),
      ctx.context,
    );
    const list = written(ctx, "accessList")[0];
    assertEquals(list.data.items, [{ username: "jim" }]);
    assertEquals(list.data.name, "family");
  });
});

Deno.test("delete removes the object and its swamp resource", async () => {
  const state = emptyStub({
    streams: [{ id: 7, incoming_port: 25565 }, { id: 8, incoming_port: 25566 }],
  });
  await withStub(state, async (ctx) => {
    await model.methods.delete.execute({ kind: "stream", ids: [7] }, ctx.context);

    assertEquals(state.streams.map((s) => s.id), [8]);
    // Inventory must not keep a ghost of something that is gone.
    assertEquals(ctx.deleted, ["stream-7"]);
    const change = written(ctx, "change")[0];
    assertEquals(change.name, "change-delete");
    assertEquals(change.data.action, "deleted");
    assertEquals(change.data.ok, true);
  });
});

Deno.test("delete treats an already-absent object as success", async () => {
  // A converging workflow re-runs its delete step; the second pass must not
  // fail just because the first one worked.
  await withStub(emptyStub(), async (ctx) => {
    await model.methods.delete.execute(
      { kind: "proxyHost", ids: [999] },
      ctx.context,
    );
    const change = written(ctx, "change")[0];
    assertEquals(change.data.action, "deleted");
    assertEquals(change.data.ok, true);
    assertEquals(change.data.results[0].httpStatus, 404);
    assertStringIncludes(change.data.results[0].message, "already absent");
    assertEquals(ctx.deleted, ["proxy-host-999"]);
  });
});

Deno.test("delete reports a mixed batch as partial, never as success", async () => {
  const state = emptyStub({ proxyHosts: [{ id: 1, domain_names: [] }] });
  const seen: Seen[] = [];
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      // id 2 fails for a reason other than "already gone".
      if (url.pathname === "/api/nginx/proxy-hosts/2" && req.method === "DELETE") {
        return json({ error: { message: "in use" } }, 500);
      }
      return routeStub(state, seen, req, url, { value: 100 });
    },
  );
  try {
    const ctx = stubContext(`http://127.0.0.1:${server.addr.port}`);
    await model.methods.delete.execute(
      { kind: "proxyHost", ids: [1, 2] },
      ctx.context,
    );
    const data = written(ctx, "change")[0].data;
    assertEquals(data.action, "partial");
    assertEquals(data.ok, false);
    assertEquals(data.okCount, 1);
    assertEquals(data.failCount, 1);
    // A batch has no single primary object.
    assertEquals(data.id, 0);
    // Only the one that actually went away loses its resource.
    assertEquals(ctx.deleted, ["proxy-host-1"]);
  } finally {
    controller.abort();
    await server.finished;
  }
});

Deno.test("setEnabled fans out across ids in one call", async () => {
  const state = emptyStub({
    proxyHosts: [
      { id: 1, domain_names: ["a.example.com"], enabled: true },
      { id: 2, domain_names: ["b.example.com"], enabled: true },
    ],
  });
  await withStub(state, async (ctx) => {
    await model.methods.setEnabled.execute(
      { kind: "proxyHost", ids: [1, 2], enabled: false },
      ctx.context,
    );
    assertEquals(state.proxyHosts.map((h) => h.enabled), [false, false]);
    const data = written(ctx, "change")[0].data;
    assertEquals(data.action, "disabled");
    assertEquals(data.okCount, 2);
    // Each toggled host is re-read so inventory reflects the new state.
    assertEquals(written(ctx, "proxyHost").map((w) => w.name), [
      "proxy-host-1",
      "proxy-host-2",
    ]);
  });
});

Deno.test("requestCertificate reuses a certificate covering the same domains", async () => {
  const state = emptyStub({
    certificates: [{
      id: 3,
      provider: "letsencrypt",
      domain_names: ["a.example.com"],
      expires_on: "2099-01-01T00:00:00.000Z",
    }],
  });
  await withStub(state, async (ctx, seen) => {
    await model.methods.requestCertificate.execute(
      RequestCertificateArgsSchema.parse({
        domainNames: ["a.example.com"],
        letsencryptEmail: "me@example.com",
      }),
      ctx.context,
    );
    // Reissuing here would burn ACME rate limit for no gain.
    assert(!seen.some((s) => s.method === "POST" && s.path === "/api/nginx/certificates"));
    assertEquals(state.certificates.length, 1);
    assertEquals(written(ctx, "change")[0].data.action, "unchanged");
    assertEquals(written(ctx, "change")[0].data.id, 3);
  });
});

Deno.test("requestCertificate reissues when forced", async () => {
  const state = emptyStub({
    certificates: [{
      id: 3,
      provider: "letsencrypt",
      domain_names: ["a.example.com"],
    }],
  });
  await withStub(state, async (ctx) => {
    await model.methods.requestCertificate.execute(
      RequestCertificateArgsSchema.parse({
        domainNames: ["a.example.com"],
        letsencryptEmail: "me@example.com",
        force: true,
      }),
      ctx.context,
    );
    assertEquals(state.certificates.length, 2);
    assertEquals(written(ctx, "change")[0].data.action, "created");
  });
});

Deno.test("requestCertificate refuses a wildcard over HTTP-01", async () => {
  await withStub(emptyStub(), async (ctx) => {
    // Let's Encrypt will not issue a wildcard over HTTP-01; failing here beats
    // a confusing rejection from the ACME server minutes later.
    await assertRejects(
      () =>
        model.methods.requestCertificate.execute(
          RequestCertificateArgsSchema.parse({
            domainNames: ["*.example.com"],
            letsencryptEmail: "me@example.com",
          }),
          ctx.context,
        ),
      Error,
      "only be issued over DNS-01",
    );
  });
});

Deno.test("requestCertificate requires provider credentials for DNS-01", async () => {
  await withStub(emptyStub(), async (ctx) => {
    await assertRejects(
      () =>
        model.methods.requestCertificate.execute(
          RequestCertificateArgsSchema.parse({
            domainNames: ["*.example.com"],
            letsencryptEmail: "me@example.com",
            dnsChallenge: true,
          }),
          ctx.context,
        ),
      Error,
      "requires dnsProvider",
    );
  });
});

Deno.test("renewCertificate records per-certificate outcomes", async () => {
  const state = emptyStub({
    certificates: [{ id: 1, provider: "letsencrypt", domain_names: [] }],
  });
  await withStub(state, async (ctx) => {
    // id 2 does not exist — the batch must still renew id 1.
    await model.methods.renewCertificate.execute({ ids: [1, 2] }, ctx.context);
    const data = written(ctx, "change")[0].data;
    assertEquals(data.action, "partial");
    assertEquals(data.okCount, 1);
    assertEquals(data.results[0].action, "renewed");
    assertEquals(data.results[1].action, "failed");
    assertEquals(state.certificates[0].expires_on, "2027-01-01T00:00:00.000Z");
  });
});

Deno.test("uploadCertificate removes the record when the upload is rejected", async () => {
  const state = emptyStub();
  const seen: Seen[] = [];
  const nextId = { value: 100 };
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/upload")) {
        seen.push({ method: req.method, path: url.pathname, body: null });
        return json({ error: { message: "certificate is invalid" } }, 400);
      }
      return routeStub(state, seen, req, url, nextId);
    },
  );
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/cert.pem`, "-----BEGIN CERTIFICATE-----");
    await Deno.writeTextFile(`${dir}/key.pem`, "-----BEGIN PRIVATE KEY-----");
    const ctx = stubContext(`http://127.0.0.1:${server.addr.port}`);

    await assertRejects(
      () =>
        model.methods.uploadCertificate.execute(
          UploadCertificateArgsSchema.parse({
            niceName: "manual",
            certificatePath: `${dir}/cert.pem`,
            certificateKeyPath: `${dir}/key.pem`,
          }),
          ctx.context,
        ),
      NpmError,
      "certificate is invalid",
    );
    // An empty record left behind would collide with the retry.
    assertEquals(state.certificates.length, 0);
    assert(seen.some((s) => s.method === "DELETE"));
  } finally {
    controller.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uploadCertificate fails on a bad path before creating a record", async () => {
  const state = emptyStub();
  await withStub(state, async (ctx) => {
    await assertRejects(
      () =>
        model.methods.uploadCertificate.execute(
          UploadCertificateArgsSchema.parse({
            niceName: "manual",
            certificatePath: "/nonexistent/cert.pem",
            certificateKeyPath: "/nonexistent/key.pem",
          }),
          ctx.context,
        ),
      Error,
      "could not read certificate",
    );
    assertEquals(state.certificates.length, 0);
  });
});

Deno.test("instance-reachable check fails closed on bad credentials", async () => {
  await withServer(
    () => json({ error: { code: 401, message: "Invalid email or password" } }, 401),
    async (baseUrl) => {
      const result = await model.checks["instance-reachable"].execute({
        globalArgs: GlobalArgsSchema.parse({
          baseUrl,
          identity: "admin@example.com",
          secret: "wrong",
        }),
      });
      assertEquals(result.pass, false);
      assertStringIncludes(result.errors?.[0] ?? "", "check `identity`");
    },
  );
});

Deno.test("instance-reachable check passes against a live instance", async () => {
  await withStub(emptyStub(), async (ctx) => {
    const result = await model.checks["instance-reachable"].execute({
      globalArgs: ctx.context.globalArgs,
    });
    assertEquals(result.pass, true);
  });
});
