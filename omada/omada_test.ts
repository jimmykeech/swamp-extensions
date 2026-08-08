/**
 * Unit tests for `@jamesakeech/omada`.
 *
 * The tests concentrate on the three places this extension can be wrong in a
 * way a smoke test would not catch: the field accessors that decide whether a
 * missing gauge becomes `null` or a fabricated `0`, the drift allowlist that
 * decides whether an idle network reports change, and the transport's
 * pagination and token-refresh loops, which only exercise their interesting
 * branches against a controller that is paging or expiring tokens.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { buildChange, summariseAction } from "./_lib/omada/change.ts";
import { OpenApiSession } from "./_lib/omada/client.ts";
import { buildDrift, diffObject, render } from "./_lib/omada/drift.ts";
import {
  apiMac,
  bool,
  deviceKind,
  deviceState,
  instanceName,
  int,
  isoTime,
  maybeBool,
  normaliseMac,
  num,
  type Provenance,
  str,
  toClient,
  toDevice,
  toSsid,
  toSwitchPort,
  uptimeSeconds,
} from "./_lib/omada/map.ts";

const P: Provenance = {
  controllerLabel: "home",
  baseUrl: "https://omada.local:8043",
  fetchedAt: "2026-08-08T12:00:00.000Z",
};

const SITE = { siteId: "site-1", siteName: "Default" };

// --- accessors --------------------------------------------------------------

Deno.test("str falls back through candidate keys and stringifies numbers", () => {
  assertEquals(str({ a: "", b: "x" }, "a", "b"), "x");
  assertEquals(str({ a: 42 }, "a"), "42");
  assertEquals(str({}, "missing"), "");
});

Deno.test("num rejects the -1 sentinel unless negatives are allowed", () => {
  // A switch that has never reported PoE sends -1; passing it through would
  // claim negative watts.
  assertEquals(num({ poeRemain: -1 }, ["poeRemain"]), null);
  // RSSI is legitimately negative and must survive.
  assertEquals(num({ rssi: -62 }, ["rssi"], { allowNegative: true }), -62);
  assertEquals(num({ cpuUtil: 0 }, ["cpuUtil"]), 0);
  assertEquals(num({}, ["cpuUtil"]), null);
});

Deno.test("num parses numeric strings and skips unparseable ones", () => {
  assertEquals(num({ speed: "1000" }, ["speed"]), 1000);
  assertEquals(num({ speed: "auto" }, ["speed"]), null);
});

Deno.test("int truncates rather than rounding", () => {
  assertEquals(int({ uptime: 99.9 }, ["uptime"]), 99);
});

Deno.test("bool accepts 0/1 integers and honours the fallback", () => {
  assertEquals(bool({ enable: 1 }, ["enable"]), true);
  assertEquals(bool({ enable: 0 }, ["enable"]), false);
  assertEquals(bool({ enable: false }, ["enable"], true), false);
  // An absent key must take the fallback, not silently become false.
  assertEquals(bool({}, ["enable"], true), true);
});

Deno.test("maybeBool distinguishes 'off' from 'not reported'", () => {
  assertEquals(maybeBool({ poeMode: 0 }, ["poeMode"]), false);
  assertEquals(maybeBool({}, ["poeMode"]), null);
});

Deno.test("uptimeSeconds parses 6.x display text and 5.x seconds alike", () => {
  // Real strings from a controller 6.0.0 build 25 device list. Units are omitted
  // when zero, so the parser cannot rely on a fixed shape.
  assertEquals(
    uptimeSeconds({ uptime: "171day(s) 18m 57s" }, "uptime"),
    171 * 86400 + 18 * 60 + 57,
  );
  assertEquals(
    uptimeSeconds({ uptime: "75day(s) 3h 19m" }, "uptime"),
    75 * 86400 + 3 * 3600 + 19 * 60,
  );
  // The `s` inside "day(s)" must not be read as seconds.
  assertEquals(uptimeSeconds({ uptime: "2day(s)" }, "uptime"), 2 * 86400);
  // 5.x sends a plain count of seconds under uptimeLong.
  assertEquals(uptimeSeconds({ uptimeLong: 3600 }, "uptimeLong"), 3600);
  assertEquals(uptimeSeconds({ uptime: "" }, "uptime"), null);
  assertEquals(uptimeSeconds({}, "uptime"), null);
});

Deno.test("isoTime treats ten-digit values as seconds", () => {
  assertEquals(isoTime({ t: 1_754_654_400 }, "t"), "2025-08-08T12:00:00.000Z");
  assertEquals(
    isoTime({ t: 1_754_654_400_000 }, "t"),
    "2025-08-08T12:00:00.000Z",
  );
  assertEquals(isoTime({ t: 0 }, "t"), null);
  assertEquals(isoTime({}, "t"), null);
});

Deno.test("MAC normalisation collapses every format the controller emits", () => {
  const expected = "aabbccddeeff";
  assertEquals(normaliseMac("AA-BB-CC-DD-EE-FF"), expected);
  assertEquals(normaliseMac("aa:bb:cc:dd:ee:ff"), expected);
  assertEquals(normaliseMac("AABBCCDDEEFF"), expected);
  assertEquals(apiMac("aa:bb:cc:dd:ee:ff"), "AA-BB-CC-DD-EE-FF");
  // A malformed MAC is passed through rather than mangled into a valid-looking
  // one that would address the wrong device.
  assertEquals(apiMac("not-a-mac"), "not-a-mac");
});

Deno.test("instanceName slugs path-hostile characters out of site names", () => {
  assertEquals(
    instanceName("site", "Head Office / Floor 2"),
    "site-head-office-floor-2",
  );
  assertEquals(instanceName("site", "///"), "site");
});

Deno.test("instance names are stable across the controller's MAC formats", () => {
  // The slugger cannot tell `AA:BB` from `AA-BB`, so MACs are normalised by
  // the caller. Without that, a controller build that switched separators
  // would rename every resource and drift would report the whole network as
  // new.
  const formats = ["AA:BB:CC:DD:EE:FF", "aa-bb-cc-dd-ee-ff", "AABBCCDDEEFF"];
  const names = formats.map((mac) =>
    instanceName("port", normaliseMac(mac), "3")
  );
  assertEquals(new Set(names).size, 1);
  assertEquals(names[0], "port-aabbccddeeff-3");
});

// --- enumeration mapping ----------------------------------------------------

Deno.test("deviceState maps known categories and refuses to guess", () => {
  assertEquals(deviceState({ statusCategory: 0 }), "disconnected");
  assertEquals(deviceState({ statusCategory: 1 }), "connected");
  assertEquals(deviceState({ statusCategory: 3 }), "heartbeatMissed");
  assertEquals(deviceState({ statusCategory: 99 }), "unknown");
  assertEquals(deviceState({}), "unknown");
});

Deno.test("deviceKind folds the eap spelling into ap", () => {
  assertEquals(deviceKind({ type: "eap" }), "ap");
  assertEquals(deviceKind({ type: "switch" }), "switch");
  assertEquals(deviceKind({ type: "router" }), "unknown");
});

// --- resource mappers -------------------------------------------------------

Deno.test("toDevice trusts needUpgrade and falls back to a version mismatch", () => {
  const flagged = toDevice(
    {
      mac: "AA-BB",
      version: "1.0.0",
      latestFirmwareVersion: "1.0.0",
      needUpgrade: true,
    },
    SITE,
    P,
  );
  assertEquals(flagged.needsUpgrade, true);

  // No flag at all: infer from the versions the controller did send.
  const inferred = toDevice(
    { mac: "AA-BB", version: "1.0.0", latestFirmwareVersion: "1.2.0" },
    SITE,
    P,
  );
  assertEquals(inferred.needsUpgrade, true);

  const current = toDevice(
    { mac: "AA-BB", version: "1.2.0", latestFirmwareVersion: "1.2.0" },
    SITE,
    P,
  );
  assertEquals(current.needsUpgrade, false);
});

Deno.test("toDevice keeps an unmapped statusCategory inspectable", () => {
  const device = toDevice({ mac: "AA", statusCategory: 42 }, SITE, P);
  assertEquals(device.state, "unknown");
  assertEquals(device.statusCategory, 42);
});

Deno.test("toClient picks the uplink matching the connection type", () => {
  const wireless = toClient(
    {
      mac: "AA",
      wireless: true,
      apMac: "AP-MAC",
      apName: "Living Room",
      switchMac: "SW-MAC",
      switchName: "Rack",
    },
    SITE,
    P,
  );
  assertEquals(wireless.uplinkDeviceMac, "AP-MAC");
  assertEquals(wireless.uplinkDeviceName, "Living Room");

  const wired = toClient(
    {
      mac: "AA",
      wireless: false,
      apMac: "AP-MAC",
      switchMac: "SW-MAC",
      switchName: "Rack",
    },
    SITE,
    P,
  );
  assertEquals(wired.uplinkDeviceMac, "SW-MAC");
  assertEquals(wired.uplinkDeviceName, "Rack");
});

Deno.test("toClient keeps dBm and percentage signal apart", () => {
  const client = toClient({ mac: "AA", rssi: -58, signalLevel: 72 }, SITE, P);
  assertEquals(client.signalDbm, -58);
  assertEquals(client.signalPercent, 72);
});

Deno.test("toSwitchPort reads a real poe-info row from controller 6.x", () => {
  // Trimmed from an actual /switches/ports/poe-info response: live readings
  // are nested under portStatus while admin state sits at the top level.
  const port = toSwitchPort(
    {
      port: 3,
      portName: "Port3",
      switchMac: "DC-62-79-E1-3D-9F",
      switchName: "TP-Link Omada 24 Port POE",
      switchSupportPoe: 1,
      connectedStatus: 1,
      disable: false,
      supportPoe: true,
      poe: 1,
      linkSpeed: 0,
      duplex: 0,
      power: 5.1,
      portStatus: {
        linkStatus: 1,
        linkSpeed: 3,
        duplex: 2,
        poe: true,
        poePower: 5.1,
        tx: 2147281494047,
        rx: 181257643700,
      },
    },
    SITE,
    P,
  );
  assertEquals(port.switchMac, "DC-62-79-E1-3D-9F");
  assertEquals(port.port, 3);
  assertEquals(port.enabled, true);
  assertEquals(port.poeCapable, true);
  assertEquals(port.poeEnabled, true);
  assertEquals(port.poeDrawW, 5.1);
  assertEquals(port.linkUp, true);
  // Nested portStatus wins: the top-level linkSpeed/duplex are 0 placeholders.
  assertEquals(port.linkSpeedMbps, 1000);
  assertEquals(port.duplex, "full");
  assertEquals(port.txBytes, 2147281494047);
});

Deno.test("toSwitchPort keeps PoE capability apart from PoE state", () => {
  // `supportPoe` and `poe` are different keys with confusingly similar names.
  // A non-PoE port must report null, not "switched off".
  const plain = toSwitchPort(
    {
      port: 26,
      portName: "Port26",
      switchMac: "SW",
      switchName: "Rack",
      supportPoe: false,
      disable: true,
      portStatus: { linkStatus: 0 },
    },
    SITE,
    P,
  );
  assertEquals(plain.enabled, false);
  assertEquals(plain.poeCapable, false);
  assertEquals(plain.poeEnabled, null);
  assertEquals(plain.poeDrawW, null);
  assertEquals(plain.linkUp, false);
  assertEquals(plain.linkSpeedMbps, null);

  // PoE-capable but switched off is a real "false", not a null.
  const off = toSwitchPort(
    { port: 4, switchMac: "SW", supportPoe: true, poe: 0, disable: false },
    SITE,
    P,
  );
  assertEquals(off.poeCapable, true);
  assertEquals(off.poeEnabled, false);
});

Deno.test("deviceState decodes 6.x, which drops statusCategory", () => {
  // 6.x /devices sends the coarse value in `status`; 5.x sends both, with the
  // fine-grained code in `status`. Preferring statusCategory decodes both.
  assertEquals(deviceState({ status: 1 }), "connected");
  assertEquals(deviceState({ status: 0 }), "disconnected");
  assertEquals(deviceState({ status: 14, statusCategory: 1 }), "connected");
});

Deno.test("toSsid defaults an absent enable flag to enabled", () => {
  const ssid = toSsid({ id: "s1", name: "Home" }, SITE, "w1", P);
  assertEquals(ssid.enabled, true);
  assertEquals(ssid.broadcast, true);
  assertEquals(ssid.wlanId, "w1");

  const off = toSsid({ id: "s2", name: "Old", enable: false }, SITE, "w1", P);
  assertEquals(off.enabled, false);
});

// --- change collapse --------------------------------------------------------

Deno.test("summariseAction reports partial when a fan-out is mixed", () => {
  assertEquals(summariseAction([]), "none");
  assertEquals(
    summariseAction([{
      target: "a",
      action: "rebooted",
      ok: true,
      message: "",
    }]),
    "rebooted",
  );
  assertEquals(
    summariseAction([
      { target: "a", action: "rebooted", ok: true, message: "" },
      { target: "b", action: "failed", ok: false, message: "nope" },
    ]),
    "partial",
  );
  assertEquals(
    summariseAction([{
      target: "b",
      action: "failed",
      ok: false,
      message: "nope",
    }]),
    "failed",
  );
  assertEquals(
    summariseAction([
      { target: "a", action: "poeEnabled", ok: true, message: "" },
      { target: "b", action: "poeDisabled", ok: true, message: "" },
    ]),
    "mixed",
  );
});

Deno.test("buildChange is not ok when nothing was attempted", () => {
  const change = buildChange(
    "rebootDevices",
    "home",
    "https://x",
    P.fetchedAt,
    [],
  );
  assertEquals(change.ok, false);
  assertEquals(change.action, "none");
  assertEquals(change.okCount, 0);
});

Deno.test("buildChange counts successes and failures separately", () => {
  const change = buildChange("setPoePorts", "home", "https://x", P.fetchedAt, [
    { target: "a", action: "poeEnabled", ok: true, message: "" },
    { target: "b", action: "failed", ok: false, message: "boom" },
  ]);
  assertEquals(change.okCount, 1);
  assertEquals(change.failCount, 1);
  assertEquals(change.ok, false);
});

// --- drift ------------------------------------------------------------------

Deno.test("render flattens scalars and keeps null distinct from empty", () => {
  assertEquals(render(null), null);
  assertEquals(render(undefined), null);
  assertEquals(render(""), "");
  assertEquals(render(false), "false");
  assertEquals(render(0), "0");
});

Deno.test("diffObject ignores fields outside the allowlist", () => {
  const before = { ip: "10.0.0.5", uptimeSec: 100, cpuPercent: 4 };
  const after = { ip: "10.0.0.5", uptimeSec: 200, cpuPercent: 71 };
  // Uptime and CPU always move — comparing them would make every sync drift.
  assertEquals(diffObject("device", "device-a", "AP", before, after), []);
});

Deno.test("diffObject reports an allowlisted change with before and after", () => {
  const entries = diffObject(
    "device",
    "device-a",
    "Garage AP",
    { ip: "10.0.0.5", state: "connected" },
    { ip: "10.0.0.9", state: "connected" },
  );
  assertEquals(entries.length, 1);
  assertEquals(entries[0].field, "ip");
  assertEquals(entries[0].before, "10.0.0.5");
  assertEquals(entries[0].after, "10.0.0.9");
  assertEquals(entries[0].subject, "Garage AP");
});

Deno.test("diffObject catches a PoE port being switched off", () => {
  const entries = diffObject(
    "switchPort",
    "port-sw-3",
    "Rack port 3",
    { poeEnabled: true, enabled: true, profileName: "All", name: "" },
    { poeEnabled: false, enabled: true, profileName: "All", name: "" },
  );
  assertEquals(entries.length, 1);
  assertEquals(entries[0].field, "poeEnabled");
  assertEquals(entries[0].after, "false");
});

Deno.test("buildDrift treats the first run as a baseline, not a mass appearance", async () => {
  const tracked = [
    {
      kind: "device",
      instanceName: "device-a",
      subject: "AP",
      current: { ip: "1" },
    },
  ];
  const drift = await buildDrift(tracked, [], () => Promise.resolve(null));
  assertEquals(drift.hasBaseline, false);
  assertEquals(drift.changed, false);
  assertEquals(drift.appeared, []);
});

Deno.test("buildDrift separates appeared, disappeared and modified", async () => {
  const tracked = [
    {
      kind: "device",
      instanceName: "device-a",
      subject: "AP A",
      current: { ip: "10.0.0.9", state: "connected" },
    },
    {
      kind: "device",
      instanceName: "device-new",
      subject: "AP New",
      current: { ip: "10.0.0.20", state: "connected" },
    },
  ];
  const stored: Record<string, Record<string, unknown>> = {
    "device-a": { ip: "10.0.0.5", state: "connected" },
    "device-gone": { ip: "10.0.0.6", state: "connected" },
  };
  const drift = await buildDrift(
    tracked,
    ["device-a", "device-gone"],
    (name) => Promise.resolve(stored[name] ?? null),
  );

  assertEquals(drift.hasBaseline, true);
  assertEquals(drift.changed, true);
  assertEquals(drift.appeared, ["device-new"]);
  assertEquals(drift.disappeared, ["device-gone"]);
  assertEquals(drift.modifiedCount, 1);
  assertEquals(drift.entries.length, 1);
  assertEquals(drift.entries[0].field, "ip");
  // appeared + disappeared + one field entry
  assertEquals(drift.changeCount, 3);
});

Deno.test("buildDrift does not cry drift when old data was garbage-collected", async () => {
  const tracked = [
    {
      kind: "device",
      instanceName: "device-a",
      subject: "AP",
      current: { ip: "10.0.0.9" },
    },
  ];
  // The name is in the index but its body is gone — retention, not change.
  const drift = await buildDrift(
    tracked,
    ["device-a"],
    () => Promise.resolve(null),
  );
  assertEquals(drift.changed, false);
  assertEquals(drift.entries, []);
});

Deno.test("buildDrift reports an idle network as unchanged", async () => {
  const body = { ip: "10.0.0.5", state: "connected", firmwareVersion: "1.0.0" };
  const tracked = [
    {
      kind: "device",
      instanceName: "device-a",
      subject: "AP",
      current: { ...body },
    },
  ];
  const drift = await buildDrift(
    tracked,
    ["device-a"],
    () => Promise.resolve({ ...body, uptimeSec: 999_999 }),
  );
  assertEquals(drift.changed, false);
  assertEquals(drift.changeCount, 0);
});

// --- transport --------------------------------------------------------------

/** Install a scripted `fetch`, returning the URLs it was called with. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function envelope(result: unknown, errorCode = 0): Response {
  return new Response(JSON.stringify({ errorCode, msg: "ok", result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const OPTS = {
  baseUrl: "https://omada.local:8043",
  requestTimeoutSec: 5,
};

Deno.test("listAll walks every page and stops at totalRows", async () => {
  const stub = stubFetch((url) => {
    if (url.includes("/authorize/token")) {
      return envelope({
        accessToken: "tok",
        refreshToken: "r",
        expiresIn: 7200,
      });
    }
    const page = Number(new URL(url).searchParams.get("page"));
    const rows = page === 1 ? [{ mac: "a" }, { mac: "b" }] : [{ mac: "c" }];
    return envelope({ data: rows, totalRows: 3 });
  });
  try {
    const session = new OpenApiSession(
      OPTS,
      { clientId: "id", clientSecret: "secret" },
      "omadac",
    );
    const rows = await session.listAll<{ mac: string }>("/sites/s1/devices", {
      pageSize: 2,
    });
    session.close();
    assertEquals(rows.map((r) => r.mac), ["a", "b", "c"]);
    // One token call plus exactly two pages — no speculative third request.
    assertEquals(stub.urls.filter((u) => u.includes("page=")).length, 2);
  } finally {
    stub.restore();
  }
});

Deno.test("listAll accepts a bare array for collections that do not page", async () => {
  const stub = stubFetch((url) =>
    url.includes("/authorize/token")
      ? envelope({ accessToken: "tok" })
      : envelope([{ id: "w1" }, { id: "w2" }])
  );
  try {
    const session = new OpenApiSession(
      OPTS,
      { clientId: "id", clientSecret: "secret" },
      "omadac",
    );
    const rows = await session.listAll<{ id: string }>("/sites/s1/wlans");
    session.close();
    assertEquals(rows.length, 2);
  } finally {
    stub.restore();
  }
});

Deno.test("an expired-token envelope triggers exactly one re-auth and retry", async () => {
  let tokenCalls = 0;
  let dataCalls = 0;
  const stub = stubFetch((url) => {
    if (url.includes("/authorize/token")) {
      tokenCalls++;
      return envelope({ accessToken: `tok-${tokenCalls}` });
    }
    dataCalls++;
    // -44112 arrives inside an HTTP 200, so status alone cannot detect it.
    return dataCalls === 1 ? envelope(null, -44112) : envelope({ ok: true });
  });
  try {
    const session = new OpenApiSession(
      OPTS,
      { clientId: "id", clientSecret: "secret" },
      "omadac",
    );
    const result = await session.request<{ ok: boolean }>("GET", "/sites");
    session.close();
    assertEquals(result.ok, true);
    assertEquals(tokenCalls, 2);
    assertEquals(dataCalls, 2);
  } finally {
    stub.restore();
  }
});

Deno.test("a persistently expired token fails instead of looping", async () => {
  let tokenCalls = 0;
  const stub = stubFetch((url) => {
    if (url.includes("/authorize/token")) {
      tokenCalls++;
      return envelope({ accessToken: "tok" });
    }
    return envelope(null, -44112);
  });
  try {
    const session = new OpenApiSession(
      OPTS,
      { clientId: "id", clientSecret: "secret" },
      "omadac",
    );
    await assertRejects(() => session.request("GET", "/sites"));
    session.close();
    // Re-authenticated once, then gave up rather than hammering the app.
    assertEquals(tokenCalls, 2);
  } finally {
    stub.restore();
  }
});

Deno.test("a non-zero errorCode inside HTTP 200 is a failure", async () => {
  const stub = stubFetch((url) =>
    url.includes("/authorize/token")
      ? envelope({ accessToken: "tok" })
      : envelope(null, -1005)
  );
  try {
    const session = new OpenApiSession(
      OPTS,
      { clientId: "id", clientSecret: "secret" },
      "omadac",
    );
    const outcome = await session.call("GET", "/sites");
    session.close();
    assertEquals(outcome.ok, false);
    assertEquals(outcome.errorCode, -1005);
    assertEquals(outcome.status, 200);
  } finally {
    stub.restore();
  }
});

Deno.test("a rejected client secret names the credential, not the token", async () => {
  const stub = stubFetch(() => envelope(null, -44106));
  try {
    const session = new OpenApiSession(
      OPTS,
      { clientId: "id", clientSecret: "wrong" },
      "omadac",
    );
    const error = await assertRejects(() => session.request("GET", "/sites"));
    session.close();
    assertEquals(
      (error as Error).message.includes("client id and secret"),
      true,
    );
  } finally {
    stub.restore();
  }
});

Deno.test("the Open API version segment selects v1 or v2", async () => {
  const stub = stubFetch((url) =>
    url.includes("/authorize/token")
      ? envelope({ accessToken: "tok" })
      : envelope({ data: [], totalRows: 0 })
  );
  try {
    const session = new OpenApiSession(
      OPTS,
      { clientId: "id", clientSecret: "secret" },
      "omadac",
    );
    await session.call("GET", "/sites/s1/clients", { apiVersion: "v2" });
    await session.call("GET", "/sites/s1/devices");
    session.close();
    assertEquals(
      stub.urls.some((u) => u.includes("/openapi/v2/omadac/sites/s1/clients")),
      true,
    );
    assertEquals(
      stub.urls.some((u) => u.includes("/openapi/v1/omadac/sites/s1/devices")),
      true,
    );
  } finally {
    stub.restore();
  }
});
