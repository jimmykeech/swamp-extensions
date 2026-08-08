/**
 * Unit tests for `@jamesakeech/pocket-id`.
 *
 * The tests split along the same seam as the source. `map.ts` and `findings.ts`
 * are pure and tested directly against representative Pocket ID payloads,
 * including the `null`-for-absent-string shape the DTOs actually emit and the
 * year-one timestamp Go marshals for a zero `time.Time`. `client.ts` and the
 * methods run against a loopback HTTP server rather than a stubbed `fetch`, so
 * the assertions cover what goes on the wire — the `X-API-Key` header, the
 * `pagination[...]`/`sort[...]` query shape, and how many pages a bounded audit
 * window actually costs.
 *
 * Two behaviours get disproportionate attention because getting them wrong is
 * silent rather than loud: instance-name collisions between two OIDC clients
 * whose ids differ only in punctuation, and findings raised against data that
 * was never collected.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createModelTestContext } from "@swamp-club/swamp-testing";

import { model } from "./pocket_id.ts";
import {
  authHint,
  parseRetryAfter,
  PocketIdClient,
  PocketIdError,
} from "./_lib/pid/client.ts";
import { deriveFindings } from "./_lib/pid/findings.ts";
import {
  compareVersions,
  daysUntil,
  instanceNameFor,
  isoOrEmpty,
  type Provenance,
  slugify,
  summariseActivity,
  toApiKey,
  toAuditEvent,
  toClient,
  toGroup,
  toUser,
} from "./_lib/pid/map.ts";
import {
  ActivitySchema,
  ApiKeySchema,
  AuditEventSchema,
  ClientSchema,
  type Finding,
  GlobalArgsSchema,
  GroupSchema,
  InstanceSchema,
  UserSchema,
  withDefaults,
} from "./_lib/pid/schemas.ts";

const P: Provenance = {
  instanceLabel: "id",
  baseUrl: "https://id.example.com",
  fetchedAt: "2026-08-08T12:00:00.000Z",
};
const NOW = Date.parse(P.fetchedAt);

// --- Field readers ----------------------------------------------------------

Deno.test("isoOrEmpty rejects Go's zero time but keeps real timestamps", () => {
  assertEquals(isoOrEmpty("2026-08-01T10:00:00Z"), "2026-08-01T10:00:00Z");
  assertEquals(isoOrEmpty("0001-01-01T00:00:00Z"), "");
  assertEquals(isoOrEmpty(null), "");
  assertEquals(isoOrEmpty(undefined), "");
  assertEquals(isoOrEmpty("not a date"), "");
  assertEquals(isoOrEmpty(12345), "");
});

Deno.test("daysUntil rounds towards the past", () => {
  assertEquals(daysUntil("2026-08-18T12:00:00.000Z", NOW), 10);
  // Later today still reads as zero days left, not one.
  assertEquals(daysUntil("2026-08-08T23:59:00.000Z", NOW), 0);
  assertEquals(daysUntil("2026-08-06T12:00:00.000Z", NOW), -2);
  assertEquals(daysUntil("", NOW), 0);
});

// --- Instance names ---------------------------------------------------------

Deno.test("slugify collapses punctuation and never returns empty", () => {
  assertEquals(slugify("My App"), "my-app");
  assertEquals(slugify("grafana.example.com"), "grafana-example-com");
  assertEquals(slugify("--weird--"), "weird");
  assertEquals(slugify("!!!"), "x");
});

Deno.test("instanceNameFor leaves a UUID alone", () => {
  const uuid = "b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
  assertEquals(instanceNameFor("user", uuid), `user-${uuid}`);
});

Deno.test("instanceNameFor keeps client ids that slug alike apart", () => {
  // The failure this pins: `My App` and `my.app` both slug to `my-app`, and a
  // shared instance name means the second write silently overwrites the first,
  // so one of two real clients vanishes from the inventory.
  const a = instanceNameFor("client", "My App");
  const b = instanceNameFor("client", "my.app");
  const c = instanceNameFor("client", "my-app");
  assert(a !== b, `${a} collided with ${b}`);
  assert(a !== c, `${a} collided with ${c}`);
  assert(b !== c, `${b} collided with ${c}`);
  assertStringIncludes(a, "client-my-app-");
  // Stable across runs, or every sync reports the whole instance as new.
  assertEquals(a, instanceNameFor("client", "My App"));
});

// --- Versions ---------------------------------------------------------------

Deno.test("compareVersions compares numerically, not lexically", () => {
  assertEquals(compareVersions("1.9.0", "1.10.0"), {
    updateAvailable: true,
    comparable: true,
  });
  assertEquals(compareVersions("1.10.0", "1.9.0"), {
    updateAvailable: false,
    comparable: true,
  });
  assertEquals(compareVersions("v1.2.3", "1.2.3"), {
    updateAvailable: false,
    comparable: true,
  });
  // A shorter version is not automatically older.
  assertEquals(compareVersions("2.0", "2.0.0"), {
    updateAvailable: false,
    comparable: true,
  });
  assertEquals(compareVersions("2.0", "2.0.1"), {
    updateAvailable: true,
    comparable: true,
  });
});

Deno.test("compareVersions reports a dev build as not comparable", () => {
  for (const pair of [["dev", "1.2.3"], ["1.2.3", ""], ["", ""]]) {
    assertEquals(compareVersions(pair[0], pair[1]), {
      updateAvailable: false,
      comparable: false,
    });
  }
});

// --- Entity mapping ---------------------------------------------------------

Deno.test("toUser maps a full record and satisfies the schema", () => {
  const mapped = toUser(
    {
      id: "u1",
      username: "jimmy",
      email: "jimmy@example.com",
      emailVerified: true,
      firstName: "Jimmy",
      lastName: "Keech",
      displayName: "Jimmy Keech",
      isAdmin: true,
      disabled: false,
      locale: "en",
      ldapId: null,
      customClaims: [{ key: "role", value: "ops" }, { key: "dept" }],
      userGroups: [{ name: "admins" }, { name: "  " }, { name: "" }],
    },
    P,
    [{
      id: "k1",
      name: "iPhone",
      createdAt: "2026-01-02T00:00:00Z",
      attestationType: "none",
      transport: ["internal", 7],
      backupEligible: true,
      backupState: true,
    }],
    {
      signInCount: 3,
      lastSignInAt: "2026-08-07T09:00:00Z",
      lastSignInFrom: "Leeds, United Kingdom",
      countries: ["United Kingdom"],
    },
  );
  const parsed = UserSchema.parse(mapped);

  assertEquals(parsed.username, "jimmy");
  assertEquals(parsed.ldapId, "");
  assertEquals(parsed.ldapManaged, false);
  assertEquals(parsed.groups, ["  ", "admins"]);
  // A claim with a key but no value still exists, so its name is reported.
  assertEquals(parsed.customClaimKeys, ["dept", "role"]);
  assertEquals(parsed.passkeyCount, 1);
  assertEquals(parsed.passkeys[0].transports, ["internal"]);
  assertEquals(parsed.passkeysCollected, true);
  assertEquals(parsed.signInCount, 3);
  assertEquals(parsed.instanceLabel, "id");
});

Deno.test("toUser fills a sparse record and flags LDAP ownership", () => {
  const parsed = UserSchema.parse(
    toUser({ id: "u2", username: "svc", ldapId: "cn=svc" }, P, [], {
      signInCount: 0,
      lastSignInAt: "",
      lastSignInFrom: "",
      countries: [],
    }),
  );
  assertEquals(parsed.email, "");
  assertEquals(parsed.groups, []);
  assertEquals(parsed.ldapManaged, true);
  assertEquals(parsed.passkeyCount, 0);
  assertEquals(parsed.passkeysCollected, true);
});

Deno.test("toUser distinguishes uncollected passkeys from having none", () => {
  const none = UserSchema.parse(toUser({ id: "u", username: "a" }, P, [], null));
  assertEquals(none.passkeyCount, 0);
  assertEquals(none.passkeysCollected, true);
  assertEquals(none.signInCount, -1);
  assertEquals(none.activityCollected, false);

  const unknown = UserSchema.parse(
    toUser({ id: "u", username: "a" }, P, null, null),
  );
  assertEquals(unknown.passkeyCount, -1);
  assertEquals(unknown.passkeysCollected, false);
});

Deno.test("toClient maps configuration, federation and activity", () => {
  const parsed = ClientSchema.parse(
    toClient(
      {
        id: "grafana",
        name: "Grafana",
        description: "Dashboards",
        clientType: "confidential",
        isPublic: false,
        pkceEnabled: true,
        skipConsent: true,
        isGroupRestricted: true,
        allowedUserGroupsCount: 2,
        callbackURLs: ["https://grafana.example.com/login/generic_oauth"],
        logoutCallbackURLs: [],
        launchURL: null,
        accessTokenDurationMinutes: 15,
        refreshTokenDurationMinutes: 43200,
        credentials: {
          federatedIdentities: [{ issuer: "https://gitlab.example.com" }, {}],
        },
      },
      P,
      { authorizationCount: 12, distinctUserCount: 3, lastAuthorizationAt: "x" },
      true,
    ),
  );
  assertEquals(parsed.launchURL, "");
  assertEquals(parsed.federatedIdentityIssuers, ["https://gitlab.example.com"]);
  assertEquals(parsed.authorizationCount, 12);
  assertEquals(parsed.activityCollected, true);
});

Deno.test("toClient writes zero usage when the log was read, -1 when not", () => {
  // The distinction is the whole point of `unused-client`: an unused client
  // must not be indistinguishable from an unmeasured one.
  const measured = ClientSchema.parse(
    toClient({ id: "c", name: "C" }, P, null, true),
  );
  assertEquals(measured.authorizationCount, 0);
  assertEquals(measured.distinctUserCount, 0);

  const unmeasured = ClientSchema.parse(
    toClient({ id: "c", name: "C" }, P, null, false),
  );
  assertEquals(unmeasured.authorizationCount, -1);
  assertEquals(unmeasured.distinctUserCount, -1);
});

Deno.test("toGroup maps a minimal group DTO", () => {
  const parsed = GroupSchema.parse(
    toGroup({
      id: "g1",
      name: "admins",
      friendlyName: "Administrators",
      userCount: 2,
      ldapId: null,
      createdAt: "2026-02-01T00:00:00Z",
      customClaims: [],
    }, P),
  );
  assertEquals(parsed.userCount, 2);
  assertEquals(parsed.ldapManaged, false);
  assertEquals(parsed.customClaimKeys, []);
});

Deno.test("toApiKey derives expiry, staleness and self-identification", () => {
  const parsed = ApiKeySchema.parse(
    toApiKey({
      id: "k1",
      name: "swamp",
      description: null,
      createdAt: "2026-07-01T00:00:00Z",
      expiresAt: "2026-08-15T00:00:00Z",
      lastUsedAt: P.fetchedAt,
      expirationEmailSent: false,
    }, P, NOW, NOW),
  );
  assertEquals(parsed.daysUntilExpiry, 6);
  assertEquals(parsed.expired, false);
  assertEquals(parsed.neverUsed, false);
  assertEquals(parsed.daysSinceLastUse, 0);
  assertEquals(parsed.isSelf, true);
});

Deno.test("toApiKey reads a never-used key and an expired one", () => {
  const never = ApiKeySchema.parse(
    toApiKey({
      id: "k2",
      name: "unused",
      expiresAt: "2026-09-01T00:00:00Z",
      lastUsedAt: null,
    }, P, NOW, NOW),
  );
  assertEquals(never.neverUsed, true);
  assertEquals(never.daysSinceLastUse, -1);
  assertEquals(never.isSelf, false);

  const expired = ApiKeySchema.parse(
    toApiKey({
      id: "k3",
      name: "old",
      expiresAt: "2026-08-01T00:00:00Z",
      lastUsedAt: "2026-07-30T00:00:00Z",
    }, P, NOW, NOW),
  );
  assertEquals(expired.expired, true);
  assertEquals(expired.daysUntilExpiry, -8);
  assertEquals(expired.isSelf, false);
});

Deno.test("toApiKey tolerates a Pocket ID clock a minute behind", () => {
  // Without the skew allowance the instance disowns the very key it is using,
  // which downgrades `api-key-expiring` from critical to warn.
  const parsed = toApiKey(
    { id: "k", name: "swamp", lastUsedAt: "2026-08-08T11:59:00.000Z" },
    P,
    NOW,
    NOW,
  );
  assertEquals(parsed.isSelf, true);
});

Deno.test("toAuditEvent lifts clientName out of data and flags the LAN", () => {
  const parsed = AuditEventSchema.parse(
    toAuditEvent({
      id: "e1",
      createdAt: "2026-08-07T09:00:00Z",
      event: "CLIENT_AUTHORIZATION",
      ipAddress: "10.0.0.20",
      country: "Internal Network",
      city: "",
      device: "Firefox on macOS 15",
      userID: "u1",
      username: "jimmy",
      actorUsername: "",
      data: { clientName: "Grafana", extra: 7 },
    }, P),
  );
  assertEquals(parsed.userId, "u1");
  assertEquals(parsed.clientName, "Grafana");
  assertEquals(parsed.internalNetwork, true);
  // Non-string members of `data` are dropped rather than coerced.
  assertEquals(parsed.data, { clientName: "Grafana" });
});

// --- Activity rollup --------------------------------------------------------

/** Map a raw audit-log row, defaulted, to an event resource. */
function event(over: Record<string, unknown>) {
  return toAuditEvent({
    id: crypto.randomUUID(),
    createdAt: "2026-08-07T09:00:00Z",
    event: "SIGN_IN",
    ipAddress: "203.0.113.4",
    country: "United Kingdom",
    city: "Leeds",
    device: "Firefox on macOS 15",
    userID: "u1",
    username: "jimmy",
    data: {},
    ...over,
  }, P);
}

const WINDOW = {
  windowDays: 3,
  windowStartMs: NOW - 3 * 86_400_000,
  windowEndMs: NOW,
  totalEventsOnServer: 99,
  truncated: false,
};

Deno.test("summariseActivity counts events, sign-ins and unique users", () => {
  const index = summariseActivity([
    event({}),
    event({ userID: "u2", username: "ada" }),
    event({ event: "PASSKEY_ADDED" }),
    event({
      event: "NEW_CLIENT_AUTHORIZATION",
      data: { clientName: "Grafana" },
    }),
    event({ event: "CLIENT_AUTHORIZATION", data: { clientName: "Grafana" } }),
  ], WINDOW);
  const parsed = ActivitySchema.parse({ ...P, ...index.rollup, eventsWritten: 0 });

  assertEquals(parsed.eventCount, 5);
  assertEquals(parsed.signInCount, 2);
  assertEquals(parsed.uniqueUserCount, 2);
  assertEquals(parsed.uniqueClientCount, 1);
  assertEquals(parsed.passkeysAdded, 1);
  assertEquals(parsed.newClientAuthorizations, 1);
  assertEquals(parsed.byEvent["SIGN_IN"], 2);
  assertEquals(parsed.totalEventsOnServer, 99);
  assertEquals(parsed.externalSignInCountries, ["United Kingdom"]);
  assertEquals(index.byClientName.get("Grafana")?.authorizationCount, 2);
  assertEquals(index.byClientName.get("Grafana")?.distinctUserCount, 1);
});

Deno.test("summariseActivity takes the latest sign-in regardless of order", () => {
  // The audit log is fetched newest-first, but nothing should depend on that:
  // a caller passing a different sort must still get the real last sign-in.
  const index = summariseActivity([
    event({ createdAt: "2026-08-06T09:00:00Z", city: "Leeds" }),
    event({ createdAt: "2026-08-08T09:00:00Z", city: "York" }),
    event({ createdAt: "2026-08-07T09:00:00Z", city: "Hull" }),
  ], WINDOW);

  const activity = index.byUserId.get("u1");
  assertEquals(activity?.signInCount, 3);
  assertEquals(activity?.lastSignInAt, "2026-08-08T09:00:00Z");
  assertEquals(activity?.lastSignInFrom, "York, United Kingdom");
});

Deno.test("summariseActivity excludes network sentinels from countries", () => {
  const index = summariseActivity([
    event({ country: "Internal Network", city: "" }),
    event({ country: "External Network", city: "" }),
    event({ country: "Germany", city: "Berlin" }),
  ], WINDOW);

  assertEquals(index.rollup.externalSignInCountries, ["Germany"]);
  // The per-user list keeps the sentinels — the finding filters them, so the
  // resource stays a faithful record of where sign-ins came from.
  assertEquals(index.byUserId.get("u1")?.countries, [
    "External Network",
    "Germany",
    "Internal Network",
  ]);
  assertEquals(index.rollup.locations[0].label, "Berlin, Germany");
});

Deno.test("summariseActivity emits a gap-free daily series", () => {
  const index = summariseActivity(
    [event({ createdAt: "2026-08-07T09:00:00Z" })],
    WINDOW,
  );
  assertEquals(index.rollup.byDay.map((d) => d.date), [
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
  ]);
  assertEquals(index.rollup.byDay.map((d) => d.count), [0, 0, 1, 0]);
});

Deno.test("summariseActivity handles an empty window", () => {
  const parsed = ActivitySchema.parse({
    ...P,
    ...summariseActivity([], { ...WINDOW, totalEventsOnServer: 0 }).rollup,
    eventsWritten: 0,
  });
  assertEquals(parsed.eventCount, 0);
  assertEquals(parsed.topUsers, []);
  assertEquals(parsed.byEvent, {});
  assertEquals(parsed.byDay.length, 4);
});

// --- Findings ---------------------------------------------------------------

function baseUser(over: Record<string, unknown> = {}) {
  return UserSchema.parse(toUser({ id: "u1", username: "jimmy", ...over }, P, [], {
    signInCount: 0,
    lastSignInAt: "",
    lastSignInFrom: "",
    countries: [],
  }));
}

function findingInput(over: Record<string, unknown> = {}) {
  return {
    instanceLabel: "id",
    updateAvailable: false,
    currentVersion: "1.2.3",
    latestVersion: "1.2.3",
    users: [],
    clients: [],
    groups: [],
    apiKeys: [],
    passkeysCollected: true,
    activityCollected: true,
    windowDays: 30,
    apiKeyExpiryWarningDays: 14,
    accessTokenMaxMinutes: 60,
    ...over,
  } as Parameters<typeof deriveFindings>[0];
}

function codes(findings: Finding[]): string[] {
  return findings.map((f) => f.code);
}

Deno.test("an admin with no passkey is critical, a plain user is a warning", () => {
  const findings = deriveFindings(findingInput({
    users: [
      baseUser({ isAdmin: true }),
      baseUser({ id: "u2", username: "ada" }),
    ],
  }));
  const admin = findings.find((f) => f.code === "admin-without-passkey");
  const user = findings.find((f) => f.code === "user-without-passkey");
  assertEquals(admin?.severity, "critical");
  assertEquals(admin?.subject, "jimmy");
  assertEquals(user?.severity, "warn");
});

Deno.test("passkey findings are not raised when passkeys were not collected", () => {
  // The rule this pins: an unasked question must not come back as a clean
  // answer. Skipping the passkey fan-out must not read as "everyone has one".
  const users = [
    UserSchema.parse(toUser({ id: "u1", username: "jimmy", isAdmin: true }, P, null, null)),
  ];
  const findings = deriveFindings(
    findingInput({ users, passkeysCollected: false, activityCollected: false }),
  );
  assertFalse(codes(findings).includes("admin-without-passkey"));
  assertFalse(codes(findings).includes("user-without-passkey"));
  assertFalse(codes(findings).includes("unused-client"));
});

Deno.test("a disabled account raises no passkey finding", () => {
  const findings = deriveFindings(findingInput({
    users: [
      baseUser({ isAdmin: true }),
      baseUser({ id: "u2", username: "gone", disabled: true }),
    ],
  }));
  assertEquals(
    findings.filter((f) => f.code.endsWith("without-passkey")).length,
    1,
  );
});

Deno.test("a public client without PKCE is critical", () => {
  const clients = [
    ClientSchema.parse(
      toClient({ id: "cli", name: "CLI", isPublic: true, pkceEnabled: false }, P, null, true),
    ),
    ClientSchema.parse(
      toClient({ id: "web", name: "Web", isPublic: true, pkceEnabled: true }, P, null, true),
    ),
  ];
  const findings = deriveFindings(findingInput({ clients }));
  const pkce = findings.filter((f) => f.code === "public-client-without-pkce");
  assertEquals(pkce.length, 1);
  assertEquals(pkce[0].severity, "critical");
  assertEquals(pkce[0].subject, "CLI");
});

Deno.test("a long access-token lifetime is measured against the threshold", () => {
  const client = (minutes: number) =>
    ClientSchema.parse(
      toClient(
        { id: "c", name: "C", accessTokenDurationMinutes: minutes },
        P,
        { authorizationCount: 1, distinctUserCount: 1, lastAuthorizationAt: "x" },
        true,
      ),
    );
  assertFalse(
    codes(deriveFindings(findingInput({ clients: [client(60)] })))
      .includes("long-lived-access-token"),
  );
  assert(
    codes(deriveFindings(findingInput({ clients: [client(61)] })))
      .includes("long-lived-access-token"),
  );
  assertFalse(
    codes(
      deriveFindings(
        findingInput({ clients: [client(120)], accessTokenMaxMinutes: 240 }),
      ),
    ).includes("long-lived-access-token"),
  );
});

Deno.test("the sync's own expiring API key outranks any other", () => {
  const key = (over: Record<string, unknown>) =>
    ApiKeySchema.parse(
      toApiKey({ id: "k", name: "n", expiresAt: "2026-08-15T00:00:00Z", ...over }, P, NOW, NOW),
    );
  const findings = deriveFindings(findingInput({
    apiKeys: [
      key({ id: "k1", name: "other", lastUsedAt: "2026-07-01T00:00:00Z" }),
      key({ id: "k2", name: "swamp", lastUsedAt: P.fetchedAt }),
    ],
  }));
  const expiring = findings.filter((f) => f.code === "api-key-expiring");
  assertEquals(expiring.length, 2);
  assertEquals(expiring.find((f) => f.subject === "swamp")?.severity, "critical");
  assertEquals(expiring.find((f) => f.subject === "other")?.severity, "warn");
  assertStringIncludes(
    expiring.find((f) => f.subject === "swamp")?.detail ?? "",
    "this sync authenticates with",
  );
});

Deno.test("multiple external countries flag a user, sentinels do not", () => {
  const withCountries = (countries: string[]) =>
    UserSchema.parse(
      toUser({ id: "u1", username: "jimmy" }, P, [], {
        signInCount: countries.length,
        lastSignInAt: "2026-08-07T00:00:00Z",
        lastSignInFrom: "x",
        countries,
      }),
    );
  assert(
    codes(
      deriveFindings(
        findingInput({ users: [withCountries(["Germany", "Japan"])] }),
      ),
    ).includes("signin-from-multiple-countries"),
  );
  // Internal + one country is one place plus the LAN, not travel.
  assertFalse(
    codes(
      deriveFindings(
        findingInput({
          users: [withCountries(["Internal Network", "United Kingdom"])],
        }),
      ),
    ).includes("signin-from-multiple-countries"),
  );
});

Deno.test("a lone admin is noted, no admin at all is critical", () => {
  const sole = deriveFindings(findingInput({
    users: [baseUser({ isAdmin: true })],
  }));
  assertEquals(sole.find((f) => f.code === "sole-admin")?.severity, "info");

  const none = deriveFindings(findingInput({ users: [baseUser()] }));
  assertEquals(none.find((f) => f.code === "no-admin")?.severity, "critical");
  assertFalse(codes(none).includes("sole-admin"));
});

Deno.test("findings sort critical first, then by code and subject", () => {
  const findings = deriveFindings(findingInput({
    updateAvailable: true,
    users: [baseUser({ isAdmin: true }), baseUser({ id: "u2", username: "ada" })],
    clients: [
      ClientSchema.parse(
        toClient({ id: "c", name: "CLI", isPublic: true, pkceEnabled: false }, P, null, true),
      ),
    ],
    groups: [GroupSchema.parse(toGroup({ id: "g", name: "empty", userCount: 0 }, P))],
  }));
  const severities = findings.map((f) => f.severity);
  assertEquals(severities, [...severities].sort((a, b) =>
    ["critical", "warn", "info"].indexOf(a) -
    ["critical", "warn", "info"].indexOf(b)
  ));
  assertEquals(findings[0].severity, "critical");
});

// --- Client -----------------------------------------------------------------

/** Route table for the stub Pocket ID instance. */
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

/** A paginated Pocket ID response over `rows`. */
function page(rows: unknown[], url: URL): Response {
  const pageNum = Number(url.searchParams.get("pagination[page]") ?? "1");
  const limit = Number(url.searchParams.get("pagination[limit]") ?? "20");
  const start = (pageNum - 1) * limit;
  return json({
    data: rows.slice(start, start + limit),
    pagination: {
      totalPages: Math.max(1, Math.ceil(rows.length / limit)),
      totalItems: rows.length,
      currentPage: pageNum,
      itemsPerPage: limit,
    },
  });
}

function client(baseUrl: string, timeoutSec = 5): PocketIdClient {
  return new PocketIdClient({ baseUrl, apiKey: "key-abc", requestTimeoutSec: timeoutSec });
}

Deno.test("every authenticated call carries X-API-Key, healthz does not", async () => {
  const seen: Array<{ path: string; key: string | null }> = [];
  await withServer((req, url) => {
    seen.push({ path: url.pathname, key: req.headers.get("X-API-Key") });
    if (url.pathname === "/healthz") return new Response(null, { status: 204 });
    return json({ currentVersion: "1.2.3" });
  }, async (baseUrl) => {
    const c = client(baseUrl);
    await c.healthz();
    await c.request("/api/version/current");
  });

  assertEquals(seen[0], { path: "/healthz", key: null });
  assertEquals(seen[1], { path: "/api/version/current", key: "key-abc" });

});

Deno.test("healthz reports status 0 and latency -1 when nothing answers", async () => {
  // Port 1 on loopback is reliably closed; this is the "instance is down" path.
  const probe = await client("http://127.0.0.1:1").healthz();
  assertEquals(probe.status, 0);
  assertEquals(probe.latencyMs, -1);
});

Deno.test("request throws with Pocket ID's message and code", async () => {
  await withServer(
    () =>
      json({ error: "Missing permission", code: "missing_permission" }, 403),
    async (baseUrl) => {
      const err = await assertRejects(
        () => client(baseUrl).request("/api/users"),
        PocketIdError,
      );
      assertEquals(err.status, 403);
      assertEquals(err.code, "missing_permission");
      assertStringIncludes(err.message, "Missing permission");
      assertStringIncludes(err.message, "not an admin");
    },
  );
});

Deno.test("a non-JSON error page is still reported readably", async () => {
  await withServer(
    () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    async (baseUrl) => {
      const outcome = await client(baseUrl).call("/api/users");
      assertFalse(outcome.ok);
      assertEquals(outcome.status, 502);
      assertStringIncludes(outcome.message, "502 Bad Gateway");
    },
  );
});

Deno.test("parseRetryAfter accepts seconds, an HTTP date, and nonsense", () => {
  assertEquals(parseRetryAfter("2"), 2000);
  assertEquals(parseRetryAfter(" 0.5 "), 500);
  // Missing, malformed or already-past values must not become a zero wait —
  // retrying instantly against a rate limiter just burns the next token too.
  assertEquals(parseRetryAfter(null), 1000);
  assertEquals(parseRetryAfter(""), 1000);
  assertEquals(parseRetryAfter("soon"), 1000);
  assertEquals(parseRetryAfter("-5"), 1000);
  assertEquals(parseRetryAfter("Thu, 01 Jan 1970 00:00:00 GMT"), 1000);
  // Bounded, so a hostile value cannot hang a run.
  assertEquals(parseRetryAfter("99999"), 30_000);
  const future = new Date(Date.now() + 3000).toUTCString();
  assert(parseRetryAfter(future) > 1000);
});

Deno.test("a 429 is waited out on Retry-After, then succeeds", async () => {
  let calls = 0;
  await withServer((_req, url) => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: "Too many requests", code: "rate_limited" }),
        { status: 429, headers: { "Retry-After": "0.01" } },
      );
    }
    return page([{ id: "u1" }], url);
  }, async (baseUrl) => {
    const result = await client(baseUrl).list<{ id: string }>("/api/users");
    assertEquals(result.items.length, 1);
  });
  assertEquals(calls, 2);
});

Deno.test("a persistent 429 gives up rather than retrying forever", async () => {
  let calls = 0;
  await withServer(() => {
    calls++;
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { "Retry-After": "0.01" },
    });
  }, async (baseUrl) => {
    const outcome = await client(baseUrl).call("/api/users");
    assertFalse(outcome.ok);
    assertEquals(outcome.status, 429);
  });
  // One attempt plus the retry budget, not an unbounded loop.
  assertEquals(calls, 4);
});

Deno.test("a non-429 failure is not retried", async () => {
  let calls = 0;
  await withServer(() => {
    calls++;
    return json({ error: "Missing permission", code: "missing_permission" }, 403);
  }, async (baseUrl) => {
    await client(baseUrl).call("/api/users");
  });
  assertEquals(calls, 1);
});

Deno.test("authHint names the fix for each auth failure", () => {
  assertStringIncludes(authHint(403, "missing_permission"), "not an admin");
  assertStringIncludes(authHint(401, "not_signed_in"), "Admin → API Keys");
  assertStringIncludes(authHint(403, "user_disabled"), "has been disabled");
  assertEquals(authHint(500, "internal"), "");
  // Releases before 2.13 answer with `{"error": "..."}` and no `code` at all,
  // so the status fallbacks are the live path on most instances, not a corner.
  assertStringIncludes(authHint(403, ""), "not an admin");
  assertStringIncludes(authHint(401, ""), "Admin → API Keys");
});

Deno.test("a code-less error body is still reported readably", async () => {
  // The pre-2.13 shape, verified against a live instance.
  await withServer(
    () => json({ error: "You are not signed in" }, 401),
    async (baseUrl) => {
      const err = await assertRejects(
        () => client(baseUrl).request("/api/users/me"),
        PocketIdError,
      );
      assertEquals(err.code, "");
      assertStringIncludes(err.message, "You are not signed in");
      assertStringIncludes(err.message, "Admin → API Keys");
    },
  );
});

Deno.test("list walks every page and reports the collection size", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: `u${i}` }));
  const pages: number[] = [];
  await withServer((_req, url) => {
    pages.push(Number(url.searchParams.get("pagination[page]")));
    return page(rows, url);
  }, async (baseUrl) => {
    const result = await client(baseUrl).list<{ id: string }>("/api/users");
    assertEquals(result.items.length, 250);
    assertEquals(result.totalItems, 250);
    assertFalse(result.truncated);
  });
  // 250 rows at Pocket ID's 100-item ceiling is three pages, not more.
  assertEquals(pages, [1, 2, 3]);
});

Deno.test("list clamps limit to Pocket ID's own maximum and passes sort", async () => {
  await withServer((_req, url) => {
    assertEquals(url.searchParams.get("pagination[limit]"), "100");
    assertEquals(url.searchParams.get("sort[column]"), "createdAt");
    assertEquals(url.searchParams.get("sort[direction]"), "desc");
    assertEquals(url.searchParams.getAll("filters[event]"), ["SIGN_IN"]);
    assertEquals(url.searchParams.get("search"), "grafana");
    return page([], url);
  }, async (baseUrl) => {
    await client(baseUrl).list("/api/audit-logs/all", {
      limit: 5000,
      sort: { column: "createdAt", direction: "desc" },
      filters: { event: ["SIGN_IN"] },
      search: "grafana",
    });
  });
});

Deno.test("list stops paging at the first item take rejects", async () => {
  // This is how the audit window is applied to a log with no date filter: a
  // one-page window over a long history must cost one request.
  const rows = Array.from({ length: 500 }, (_, i) => ({ age: i }));
  const pages: number[] = [];
  await withServer((_req, url) => {
    pages.push(Number(url.searchParams.get("pagination[page]")));
    return page(rows, url);
  }, async (baseUrl) => {
    const result = await client(baseUrl).list<{ age: number }>("/api/audit-logs/all", {
      take: (row) => row.age < 30,
    });
    assertEquals(result.items.length, 30);
    assertEquals(result.totalItems, 500);
    assertFalse(result.truncated);
  });
  assertEquals(pages, [1]);
});

Deno.test("list flags truncation when maxItems cuts a longer collection", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: i }));
  await withServer((_req, url) => page(rows, url), async (baseUrl) => {
    const cut = await client(baseUrl).list<{ id: number }>("/api/audit-logs/all", {
      maxItems: 120,
    });
    assertEquals(cut.items.length, 120);
    assert(cut.truncated);

    const whole = await client(baseUrl).list<{ id: number }>("/api/audit-logs/all", {
      maxItems: 250,
    });
    assertEquals(whole.items.length, 250);
    assertFalse(whole.truncated);
  });
});

// --- Methods ----------------------------------------------------------------

/** Everything the stub instance serves. */
interface Stub {
  healthzStatus: number;
  version: string;
  latestVersion: string;
  adminKey: boolean;
  users: Record<string, unknown>[];
  passkeys: Record<string, Record<string, unknown>[]>;
  clients: Record<string, unknown>[];
  groups: Record<string, unknown>[];
  apiKeys: Record<string, unknown>[];
  auditLogs: Record<string, unknown>[];
  /** User ids whose passkey read fails, standing in for a mid-sync deletion. */
  passkeyFailures: string[];
  /** False models a pre-2.4 release, where /api/version/current 404s. */
  hasVersionCurrent: boolean;
  /** False models a pre-2.4 release with no admin passkey endpoint at all. */
  hasAdminPasskeyEndpoint: boolean;
  /** Passkeys returned by the self-only /api/webauthn/credentials route. */
  ownPasskeys: Record<string, unknown>[];
}

function emptyStub(over: Partial<Stub> = {}): Stub {
  return {
    healthzStatus: 204,
    version: "1.2.3",
    latestVersion: "1.2.3",
    adminKey: true,
    users: [],
    passkeys: {},
    clients: [],
    groups: [],
    apiKeys: [],
    auditLogs: [],
    passkeyFailures: [],
    hasVersionCurrent: true,
    hasAdminPasskeyEndpoint: true,
    ownPasskeys: [],
    ...over,
  };
}

function routeStub(state: Stub, seen: string[], req: Request, url: URL): Response {
  seen.push(url.pathname);
  if (url.pathname === "/healthz") {
    return new Response(null, { status: state.healthzStatus });
  }
  if (req.headers.get("X-API-Key") !== "key-abc") {
    return json({ error: "Not signed in", code: "not_signed_in" }, 401);
  }
  if (url.pathname === "/api/users/me") {
    return json({ id: "self", username: "svc", isAdmin: state.adminKey });
  }
  if (url.pathname === "/api/webauthn/credentials") {
    return json(state.ownPasskeys);
  }
  if (!state.hasVersionCurrent) {
    // Releases before ~2.4 have no such route.
    if (url.pathname === "/api/version/current") {
      return json({ error: "API endpoint not found" }, 404);
    }
  } else if (url.pathname === "/api/version/current") {
    return json({ currentVersion: state.version });
  }
  if (url.pathname === "/api/version/latest") {
    return json({ latestVersion: state.latestVersion });
  }

  const adminOnly = ["/api/users", "/api/oidc/clients", "/api/user-groups", "/api/audit-logs/all"];
  if (!state.adminKey && adminOnly.some((p) => url.pathname.startsWith(p))) {
    return json({ error: "Missing permission", code: "missing_permission" }, 403);
  }

  const passkeyMatch = url.pathname.match(
    /^\/api\/users\/([^/]+)\/webauthn-credentials$/,
  );
  if (passkeyMatch) {
    if (!state.hasAdminPasskeyEndpoint) {
      return json({ error: "API endpoint not found" }, 404);
    }
    if (state.passkeyFailures.includes(passkeyMatch[1])) {
      return json({ error: "User not found", code: "not_found" }, 404);
    }
    return json(state.passkeys[passkeyMatch[1]] ?? []);
  }

  if (url.pathname === "/api/users") return page(state.users, url);
  if (url.pathname === "/api/oidc/clients") return page(state.clients, url);
  if (url.pathname === "/api/user-groups") return page(state.groups, url);
  if (url.pathname === "/api/api-keys") return page(state.apiKeys, url);
  if (url.pathname === "/api/audit-logs/all") return page(state.auditLogs, url);
  return json({ error: "no route", code: "not_found" }, 404);
}

/** A model method context, plus captured writes and warnings. */
function stubContext(baseUrl: string) {
  const base = createModelTestContext({
    globalArgs: GlobalArgsSchema.parse({
      baseUrl,
      apiKey: "key-abc",
      instanceLabel: "id",
      requestTimeoutSec: 5,
    }),
  });
  // The helper's logger exposes `warn`, where the swamp runtime — and the rest
  // of this repo's extensions — call `warning`. Warnings are captured here so
  // assertions do not depend on which spelling the helper files them under.
  const warnings: string[] = [];
  const context = {
    ...base.context,
    logger: {
      ...base.context.logger,
      warning: (msg: string, props?: Record<string, unknown>) => {
        warnings.push(msg);
        base.context.logger.warn(msg, props);
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { ...base, context, warnings };
}

/** Run `fn` against a stub Pocket ID instance. */
async function withStub(
  state: Stub,
  fn: (ctx: ReturnType<typeof stubContext>, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req) => routeStub(state, seen, req, new URL(req.url)),
  );
  try {
    await fn(stubContext(`http://127.0.0.1:${server.addr.port}`), seen);
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

Deno.test("health reports a healthy admin instance", async () => {
  await withStub(emptyStub({ latestVersion: "1.3.0" }), async (ctx) => {
    await model.methods.health.execute({}, ctx.context);
    const health = written(ctx, "health")[0].data;
    assertEquals(health.reachable, true);
    assertEquals(health.healthzStatus, 204);
    assertEquals(health.apiAuthenticated, true);
    assertEquals(health.apiKeyIsAdmin, true);
    assertEquals(health.currentVersion, "1.2.3");
    assertEquals(health.updateAvailable, true);
    assertEquals(health.versionsComparable, true);
    assertEquals(health.apiKeyOwner, "svc");
    assertEquals(health.errors, []);
    assert(health.latencyMs >= 0);
  });
});

Deno.test("health distinguishes a non-admin key from a wrong one", async () => {
  await withStub(emptyStub({ adminKey: false }), async (ctx) => {
    await model.methods.health.execute({}, ctx.context);
    const health = written(ctx, "health")[0].data;
    assertEquals(health.reachable, true);
    assertEquals(health.apiAuthenticated, true);
    assertEquals(health.apiKeyIsAdmin, false);
    assertEquals(health.apiKeyOwner, "svc");
    assertEquals(health.errors.length, 1);
    assertStringIncludes(health.errors[0], "not an admin");
    // Names the account, so it is obvious which key to swap.
    assertStringIncludes(health.errors[0], "svc");
  });
});

Deno.test("health stays healthy on a release with no /version/current", async () => {
  // Real behaviour on Pocket ID before ~2.4: /api/version/current 404s while
  // everything else is fine. Probing it for authentication would report a
  // perfectly healthy instance as having a bad API key.
  await withStub(
    emptyStub({ hasVersionCurrent: false, latestVersion: "2.13.0" }),
    async (ctx) => {
      await model.methods.health.execute({}, ctx.context);
      const health = written(ctx, "health")[0].data;
      assertEquals(health.reachable, true);
      assertEquals(health.apiAuthenticated, true);
      assertEquals(health.apiKeyIsAdmin, true);
      assertEquals(health.errors, []);
      // Unknown, and explicitly making no claim about being current.
      assertEquals(health.currentVersion, "");
      assertEquals(health.versionsComparable, false);
      assertEquals(health.updateAvailable, false);
      assertEquals(health.latestVersion, "2.13.0");
    },
  );
});

Deno.test("sync runs on a release with no /version/current", async () => {
  await withStub(
    emptyStub({
      hasVersionCurrent: false,
      users: [{ id: "u1", username: "jimmy", isAdmin: true }],
    }),
    async (ctx) => {
      await model.methods.sync.execute(
        model.methods.sync.arguments.parse({ includeAuditEvents: false }),
        ctx.context,
      );
      assertEquals(written(ctx, "user").length, 1);
      assertEquals(written(ctx, "instance")[0].data.currentVersion, "");
      // No version means no update claim, so no `update-available` finding.
      assertFalse(
        written(ctx, "instance")[0].data.findings.some((f: Finding) =>
          f.code === "update-available"
        ),
      );
    },
  );
});

Deno.test("health reports a down instance as data, not as a failure", async () => {
  await withStub(emptyStub({ healthzStatus: 503 }), async (ctx) => {
    // The probe must not throw: a method that failed whenever the thing it
    // probes is down would only ever report its own success.
    await model.methods.health.execute({}, ctx.context);
    const health = written(ctx, "health")[0].data;
    assertEquals(health.reachable, false);
    assertEquals(health.healthzStatus, 503);
    assertStringIncludes(health.errors[0], "answers 204");
  });
});

Deno.test("sync fans out one resource per object plus the rollups", async () => {
  const state = emptyStub({
    users: [
      { id: "u1", username: "jimmy", isAdmin: true, userGroups: [{ name: "admins" }] },
      { id: "u2", username: "ada", email: "ada@example.com" },
    ],
    passkeys: { u1: [{ id: "k1", name: "iPhone", transport: ["internal"] }] },
    clients: [
      { id: "grafana", name: "Grafana", pkceEnabled: true, accessTokenDurationMinutes: 15 },
      { id: "My App", name: "My App", isPublic: true, pkceEnabled: false },
    ],
    groups: [
      { id: "g1", name: "admins", friendlyName: "Administrators", userCount: 1 },
      { id: "g2", name: "empty", friendlyName: "Empty", userCount: 0 },
    ],
    apiKeys: [{ id: "k1", name: "swamp", expiresAt: "2099-01-01T00:00:00Z" }],
    auditLogs: [
      {
        id: "e1",
        createdAt: new Date().toISOString(),
        event: "CLIENT_AUTHORIZATION",
        userID: "u1",
        username: "jimmy",
        country: "Internal Network",
        data: { clientName: "Grafana" },
      },
      {
        id: "e2",
        createdAt: new Date().toISOString(),
        event: "SIGN_IN",
        userID: "u1",
        username: "jimmy",
        country: "Internal Network",
      },
    ],
  });

  await withStub(state, async (ctx) => {
    await model.methods.sync.execute(
      { ...model.methods.sync.arguments.parse({}) },
      ctx.context,
    );

    assertEquals(written(ctx, "user").length, 2);
    assertEquals(written(ctx, "client").length, 2);
    assertEquals(written(ctx, "group").length, 2);
    assertEquals(written(ctx, "apiKey").length, 1);
    assertEquals(written(ctx, "auditEvent").length, 2);
    assertEquals(written(ctx, "activity").length, 1);
    assertEquals(written(ctx, "health").length, 1);

    // Two clients whose ids slug alike must land on two instance names.
    const clientNames = written(ctx, "client").map((w) => w.name);
    assertEquals(new Set(clientNames).size, 2);

    const jimmy = written(ctx, "user").find((w) => w.data.username === "jimmy");
    assertEquals(jimmy.data.passkeyCount, 1);
    assertEquals(jimmy.data.signInCount, 1);
    assertEquals(jimmy.data.groups, ["admins"]);

    const grafana = written(ctx, "client").find((w) => w.data.name === "Grafana");
    assertEquals(grafana.data.authorizationCount, 1);
    assertEquals(grafana.data.distinctUserCount, 1);

    const instance = written(ctx, "instance")[0].data;
    assertEquals(InstanceSchema.parse(instance).userCount, 2);
    assertEquals(instance.adminCount, 1);
    assertEquals(instance.passkeyCount, 1);
    assertEquals(instance.usersWithoutPasskeys, ["ada"]);
    assertEquals(instance.emptyGroups, ["Empty"]);
    assertEquals(instance.unusedClients, ["My App"]);
    assertEquals(instance.trackedUserIds, ["u1", "u2"]);
    assertEquals(instance.criticalFindingCount, 1);
    assertEquals(
      instance.findings[0].code,
      "public-client-without-pkce",
    );
  });
});

Deno.test("sync writes health then fails when the key is not an admin", async () => {
  await withStub(emptyStub({ adminKey: false }), async (ctx) => {
    const err = await assertRejects(
      () =>
        model.methods.sync.execute(
          model.methods.sync.arguments.parse({}),
          ctx.context,
        ),
      PocketIdError,
    );
    assertStringIncludes(err.message, "not an admin");
    // The health record is the most useful thing a failed run can leave.
    assertEquals(written(ctx, "health").length, 1);
    assertEquals(written(ctx, "health")[0].data.apiKeyIsAdmin, false);
    assertEquals(written(ctx, "user").length, 0);
    assertEquals(written(ctx, "instance").length, 0);
  });
});

Deno.test("sync without passkeys or activity reports both as uncollected", async () => {
  const state = emptyStub({
    users: [{ id: "u1", username: "jimmy", isAdmin: true }],
    clients: [{ id: "c", name: "C", pkceEnabled: true }],
  });
  await withStub(state, async (ctx, seen) => {
    await model.methods.sync.execute(
      model.methods.sync.arguments.parse({
        includePasskeys: false,
        includeAuditEvents: false,
      }),
      ctx.context,
    );

    const instance = written(ctx, "instance")[0].data;
    assertEquals(instance.passkeysCollected, false);
    assertEquals(instance.activityCollected, false);
    assertEquals(instance.passkeyCount, -1);
    assertEquals(instance.usersWithoutPasskeys, []);
    assertEquals(instance.unusedClients, []);
    // No finding may be raised from data that was never read — but findings
    // that need neither passkeys nor the audit log still stand.
    assertEquals(instance.findings.map((f: Finding) => f.code), ["sole-admin"]);
    assertEquals(written(ctx, "activity").length, 0);
    assertFalse(seen.some((p) => p.includes("webauthn-credentials")));
    assertFalse(seen.includes("/api/audit-logs/all"));
  });
});

Deno.test("sync survives a user whose passkeys cannot be read", async () => {
  const state = emptyStub({
    users: [
      { id: "u1", username: "jimmy", isAdmin: true },
      { id: "ghost", username: "ghost" },
    ],
    passkeys: { u1: [{ id: "k", name: "iPhone" }] },
    // Stands in for a user deleted between the list and the passkey read.
    passkeyFailures: ["ghost"],
  });
  await withStub(state, async (ctx) => {
    await model.methods.sync.execute(
      model.methods.sync.arguments.parse({ includeAuditEvents: false }),
      ctx.context,
    );

    // Both users are still written, and the unreadable one is reported as
    // uncollected rather than silently as having no passkey — otherwise a
    // transient 500 invents a `user-without-passkey` finding.
    assertEquals(written(ctx, "user").length, 2);
    const ghost = written(ctx, "user").find((w) => w.data.username === "ghost");
    assertEquals(ghost.data.passkeyCount, -1);
    assertEquals(ghost.data.passkeysCollected, false);
    assert(ctx.warnings.some((w) => w.includes("not")));

    const instance = written(ctx, "instance")[0].data;
    assertEquals(instance.usersWithoutPasskeys, []);
    assertFalse(
      instance.findings.some((f: Finding) => f.code.endsWith("without-passkey")),
    );
  });
});

Deno.test("on a release with no admin passkey endpoint, only the owner is known", async () => {
  // Real behaviour verified against a live pre-2.4 instance:
  // /api/users/:id/webauthn-credentials 404s and only the self-only
  // /api/webauthn/credentials exists. The owner's passkeys are still read; every
  // other account must come back UNKNOWN, never as having none — otherwise the
  // rollup invents `user-without-passkey` findings for the whole directory.
  const state = emptyStub({
    hasAdminPasskeyEndpoint: false,
    ownPasskeys: [{ id: "k1", name: "YubiKey" }, { id: "k2", name: "Touch ID" }],
    users: [
      { id: "self", username: "svc", isAdmin: true },
      { id: "u2", username: "ada" },
    ],
  });
  await withStub(state, async (ctx) => {
    await model.methods.sync.execute(
      model.methods.sync.arguments.parse({ includeAuditEvents: false }),
      ctx.context,
    );

    const owner = written(ctx, "user").find((w) => w.data.username === "svc");
    assertEquals(owner.data.passkeyCount, 2);
    assertEquals(owner.data.passkeysCollected, true);

    const other = written(ctx, "user").find((w) => w.data.username === "ada");
    assertEquals(other.data.passkeyCount, -1);
    assertEquals(other.data.passkeysCollected, false);

    const instance = written(ctx, "instance")[0].data;
    // Totalled over what was actually read, never counting ada as zero.
    assertEquals(instance.passkeyCount, 2);
    assertEquals(instance.usersWithoutPasskeys, []);
    assertEquals(instance.usersWithUnknownPasskeys, ["ada"]);
    // Incomplete, so the totals must not read as authoritative.
    assertEquals(instance.passkeysCollected, false);
    assertFalse(
      instance.findings.some((f: Finding) => f.code.endsWith("without-passkey")),
    );
    assert(ctx.warnings.some((w) => w.includes("no admin endpoint")));
  });
});

Deno.test("instance.passkeyCount is -1 when no user's passkeys could be read", async () => {
  // The bug this pins: Math.max(0, -1) turned "could not tell" into "nobody has
  // a passkey", which on a passkey-only IdP is the opposite of the truth.
  const state = emptyStub({
    users: [{ id: "u1", username: "jimmy", isAdmin: true }],
    passkeyFailures: ["u1"],
  });
  await withStub(state, async (ctx) => {
    await model.methods.sync.execute(
      model.methods.sync.arguments.parse({ includeAuditEvents: false }),
      ctx.context,
    );
    const instance = written(ctx, "instance")[0].data;
    assertEquals(instance.passkeyCount, -1);
    assertEquals(instance.usersWithoutPasskeys, []);
    assertEquals(instance.usersWithUnknownPasskeys, ["jimmy"]);
    assertEquals(instance.passkeysCollected, false);
  });
});

Deno.test("a client on a release with no token lifetimes reports -1", async () => {
  const state = emptyStub({
    users: [{ id: "u1", username: "jimmy", isAdmin: true }],
    // Exactly the field set a live pre-2.4 instance returns.
    clients: [{
      id: "forgejo",
      name: "Forgejo",
      isPublic: false,
      pkceEnabled: true,
      isGroupRestricted: true,
      allowedUserGroupsCount: 1,
      callbackURLs: ["https://git.example.com/user/oauth2/pid/callback"],
      logoutCallbackURLs: [],
      hasLogo: true,
      hasDarkLogo: false,
      requiresReauthentication: false,
      credentials: {},
    }],
  });
  await withStub(state, async (ctx) => {
    await model.methods.sync.execute(
      model.methods.sync.arguments.parse({ includeAuditEvents: false }),
      ctx.context,
    );
    const client = written(ctx, "client")[0].data;
    assertEquals(client.accessTokenDurationMinutes, -1);
    assertEquals(client.refreshTokenDurationMinutes, -1);
    assertEquals(client.clientType, "");
    // -1 is "not reported", so no lifetime finding may be raised from it.
    assertFalse(
      written(ctx, "instance")[0].data.findings.some((f: Finding) =>
        f.code === "long-lived-access-token"
      ),
    );
  });
});

Deno.test("syncActivity reads only the audit log", async () => {
  const state = emptyStub({
    users: [{ id: "u1", username: "jimmy", isAdmin: true }],
    auditLogs: [{
      id: "e1",
      createdAt: new Date().toISOString(),
      event: "SIGN_IN",
      userID: "u1",
      username: "jimmy",
      country: "Internal Network",
    }],
  });
  await withStub(state, async (ctx, seen) => {
    await model.methods.syncActivity.execute(
      model.methods.syncActivity.arguments.parse({}),
      ctx.context,
    );
    assertEquals(written(ctx, "activity").length, 1);
    assertEquals(written(ctx, "auditEvent").length, 1);
    assertEquals(written(ctx, "user").length, 0);
    assertEquals(written(ctx, "instance").length, 0);
    assertEquals(written(ctx, "activity")[0].data.eventsWritten, 1);
    assertFalse(seen.includes("/api/oidc/clients"));
  });
});

Deno.test("syncActivity drops events older than the window", async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const state = emptyStub({
    auditLogs: [
      { id: "new", createdAt: new Date().toISOString(), event: "SIGN_IN", userID: "u1" },
      { id: "old", createdAt: old, event: "SIGN_IN", userID: "u1" },
    ],
  });
  await withStub(state, async (ctx) => {
    await model.methods.syncActivity.execute(
      model.methods.syncActivity.arguments.parse({ windowDays: 30 }),
      ctx.context,
    );
    const events = written(ctx, "auditEvent");
    assertEquals(events.length, 1);
    assertEquals(events[0].data.id, "new");
    assertEquals(written(ctx, "activity")[0].data.eventCount, 1);
  });
});

Deno.test("syncActivity can skip the per-event fan-out", async () => {
  const state = emptyStub({
    auditLogs: [
      { id: "e1", createdAt: new Date().toISOString(), event: "SIGN_IN", userID: "u1" },
    ],
  });
  await withStub(state, async (ctx) => {
    await model.methods.syncActivity.execute(
      model.methods.syncActivity.arguments.parse({ writeAuditEvents: false }),
      ctx.context,
    );
    assertEquals(written(ctx, "auditEvent").length, 0);
    assertEquals(written(ctx, "activity")[0].data.eventCount, 1);
    assertEquals(written(ctx, "activity")[0].data.eventsWritten, 0);
  });
});

Deno.test("syncActivity warns when maxAuditEvents truncates the window", async () => {
  const now = Date.now();
  const state = emptyStub({
    auditLogs: Array.from({ length: 30 }, (_, i) => ({
      id: `e${i}`,
      createdAt: new Date(now - i * 1000).toISOString(),
      event: "SIGN_IN",
      userID: "u1",
    })),
  });
  await withStub(state, async (ctx) => {
    await model.methods.syncActivity.execute(
      model.methods.syncActivity.arguments.parse({ maxAuditEvents: 10 }),
      ctx.context,
    );
    const activity = written(ctx, "activity")[0].data;
    assertEquals(activity.eventCount, 10);
    assert(activity.truncated);
    assert(ctx.warnings.some((w) => w.includes("maxAuditEvents")));
  });
});

// --- Schemas ----------------------------------------------------------------

Deno.test("globalArgs defaults survive an unparsed args object", () => {
  // Pre-flight checks and any caller outside a method body receive raw args, so
  // a missing timeout must not become AbortSignal.timeout(NaN).
  const raw = { baseUrl: "https://id.example.com", apiKey: "k" } as never;
  const parsed = withDefaults(raw);
  assertEquals(parsed.requestTimeoutSec, 30);
  assertEquals(parsed.instanceLabel, "pocket-id");
});

Deno.test("the API key is marked sensitive so swamp vaults it", () => {
  const meta = GlobalArgsSchema.shape.apiKey.meta();
  assertEquals(meta?.sensitive, true);
});

Deno.test("resource spec names avoid hyphens and every schema is declared", () => {
  for (const [name, spec] of Object.entries(model.resources)) {
    assertFalse(name.includes("-"), `${name} contains a hyphen`);
    assert(spec.schema !== undefined, `${name} has no schema`);
    assert(spec.description.length > 20, `${name} needs a real description`);
  }
});

Deno.test("method argument schemas parse an empty object", () => {
  for (const [name, method] of Object.entries(model.methods)) {
    const parsed = method.arguments.parse({});
    assert(parsed !== undefined, `${name} rejected empty arguments`);
  }
});
