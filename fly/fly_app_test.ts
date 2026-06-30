/**
 * Unit tests for the @jamesakeech/fly/app model.
 *
 * The model calls the Fly Machines API via global `fetch`, so each test swaps
 * `globalThis.fetch` for a small router that returns canned responses. No live
 * infrastructure or token is required.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { model } from "./fly_app.ts";

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;
// deno-lint-ignore no-explicit-any
const checks = model.checks as any;

const BASE = "https://fly.test/v1";
const GLOBAL = { appName: "demo-app", apiToken: "tok", apiBaseUrl: BASE };

type RouteResult = { status?: number; body?: unknown };

/** Install a fetch stub that routes by URL/method for the duration of `fn`. */
async function withFetch(
  router: (url: string, init?: RequestInit) => RouteResult,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = [] } = router(url, init);
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

const MACHINE = {
  id: "m1",
  name: "app",
  state: "started",
  region: "syd",
  updated_at: "2026-06-30T00:00:00Z",
  config: { image: "ghcr.io/jimmykeech/nervetrack-backend:0.9.0" },
  checks: [{ name: "health", status: "passing", output: "ok" }],
};

const VOLUME = {
  id: "vol_1",
  name: "nervetrack_data",
  state: "created",
  size_gb: 1,
  region: "syd",
  encrypted: true,
  attached_machine_id: "m1",
  snapshot_retention: 5,
  created_at: "2026-06-01T00:00:00Z",
  // 1 GiB total, 25% used.
  blocks: 262144,
  block_size: 4096,
  blocks_free: 196608,
};

const SNAPSHOT = {
  id: "snap_1",
  status: "created",
  size: 12345,
  digest: "sha256:abc",
  retention_days: 5,
  created_at: "2026-06-02T00:00:00Z",
};

Deno.test("status: maps machines and counts running", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: [MACHINE] }), async () => {
    await methods.status.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "status");
  assertEquals(written[0].name, "current");
  assertEquals(written[0].data.machineCount, 1);
  assertEquals(written[0].data.runningCount, 1);
  // deno-lint-ignore no-explicit-any
  const m = (written[0].data as any).machines[0];
  assertEquals(m.image, "ghcr.io/jimmykeech/nervetrack-backend:0.9.0");
  assertEquals(m.checks[0].status, "passing");
});

Deno.test("status: throws on API error and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ status: 500, body: "boom" }), async () => {
    await assertRejects(
      () => methods.status.execute({}, context),
      Error,
      "HTTP 500",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("volumes: one record per volume with mapped fields", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: [VOLUME] }), async () => {
    await methods.volumes.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "volume");
  assertEquals(written[0].name, "vol_1");
  assertEquals(written[0].data.sizeGb, 1);
  assertEquals(written[0].data.attachedMachineId, "m1");
  assertEquals(written[0].data.snapshotRetention, 5);
  assertEquals(written[0].data.bytesTotal, 1073741824);
  assertEquals(written[0].data.usedPercent, 25);
});

Deno.test("volumes: disk usage is null when block stats are absent", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const unmounted = {
    ...VOLUME,
    blocks: undefined,
    block_size: undefined,
    blocks_free: undefined,
  };
  await withFetch(() => ({ body: [unmounted] }), async () => {
    await methods.volumes.execute({}, context);
  });
  const d = getWrittenResources()[0].data;
  assertEquals(d.bytesTotal, null);
  assertEquals(d.usedPercent, null);
});

Deno.test("events: summarizes starts, exits, and OOM kills per machine", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const machine = {
    ...MACHINE,
    events: [
      { type: "start", status: "started", source: "flyd", timestamp: 1000 },
      { type: "start", status: "started", source: "flyd", timestamp: 2000 },
      {
        type: "exit",
        status: "stopped",
        source: "flyd",
        timestamp: 3000,
        request: { exit_event: { exit_code: 137, oom_killed: true } },
      },
    ],
  };
  await withFetch(() => ({ body: [machine] }), async () => {
    await methods.events.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "machineEvents");
  assertEquals(written[0].name, "m1");
  const d = written[0].data;
  assertEquals(d.eventCount, 3);
  assertEquals(d.startCount, 2);
  assertEquals(d.exitCount, 1);
  assertEquals(d.oomKills, 1);
  assertEquals(d.lastExitCode, 137);
  assertEquals(d.lastOomKilled, true);
  assertEquals(d.truncated, false);
  // Newest first.
  // deno-lint-ignore no-explicit-any
  assertEquals((d as any).recentEvents[0].type, "exit");
});

Deno.test("events: machine with no events records zero counts", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: [MACHINE] }), async () => {
    await methods.events.execute({}, context);
  });
  const d = getWrittenResources()[0].data;
  assertEquals(d.eventCount, 0);
  assertEquals(d.startCount, 0);
  assertEquals(d.lastExitCode, null);
});

Deno.test("snapshots: fans out over volumes", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (url.endsWith("/snapshots")) return { body: [SNAPSHOT] };
    return { body: [VOLUME] }; // /volumes
  }, async () => {
    await methods.snapshots.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "snapshot");
  assertEquals(written[0].name, "snap_1");
  assertEquals(written[0].data.volumeId, "vol_1");
  assertEquals(written[0].data.volumeName, "nervetrack_data");
  assertEquals(written[0].data.retentionDays, 5);
});

Deno.test("snapshot: creates for a specific volumeId", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  let posted = 0;
  await withFetch((url, init) => {
    if (url.endsWith("/snapshots") && init?.method === "POST") {
      posted++;
      return { status: 200, body: {} };
    }
    return { body: [] };
  }, async () => {
    await methods.snapshot.execute({ volumeId: "vol_x" }, context);
  });
  assertEquals(posted, 1);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "snapshotRequest");
  assertEquals(written[0].data.volumeCount, 1);
  // deno-lint-ignore no-explicit-any
  assertEquals((written[0].data as any).volumes[0].volumeId, "vol_x");
});

Deno.test("snapshot: throws when the app has no volumes", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: [] }), async () => {
    await assertRejects(
      () => methods.snapshot.execute({}, context),
      Error,
      "no volumes",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("snapshot: partial failure throws a summary, writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const vols = [VOLUME, { ...VOLUME, id: "vol_2" }];
  await withFetch((url, init) => {
    if (url.endsWith("/snapshots") && init?.method === "POST") {
      return url.includes("vol_2")
        ? { status: 500, body: "nope" }
        : { status: 200, body: {} };
    }
    return { body: vols }; // /volumes
  }, async () => {
    await assertRejects(
      () => methods.snapshot.execute({}, context),
      Error,
      "1/2 volume(s)",
    );
  });
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("check volumes-present: passes when volumes exist", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  await withFetch(() => ({ body: [VOLUME] }), async () => {
    const result = await checks["volumes-present"].execute(context);
    assertEquals(result.pass, true);
  });
});

Deno.test("check volumes-present: fails when no volumes", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  await withFetch(() => ({ body: [] }), async () => {
    const result = await checks["volumes-present"].execute(context);
    assertEquals(result.pass, false);
    assertExists(result.errors);
  });
});
