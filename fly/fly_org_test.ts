/**
 * Unit tests for the @jamesakeech/fly/org model. Mocks `globalThis.fetch` to
 * return canned Fly Machines API responses; no live infrastructure or token.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { assertEquals } from "@std/assert";
import { model } from "./fly_org.ts";

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;

const BASE = "https://fly.test/v1";
const GLOBAL = { orgSlug: "personal", apiToken: "tok", apiBaseUrl: BASE };

type RouteResult = { status?: number; body?: unknown };

/** Install a fetch stub that routes by URL for the duration of `fn`. */
async function withFetch(
  router: (url: string) => RouteResult,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = {} } = router(url);
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

const APPS = {
  total_apps: 2,
  apps: [
    { id: "id_a", name: "app-a", machine_count: 1, network: "default" },
    { id: "id_b", name: "app-b", machine_count: 0, network: "default" },
  ],
};

Deno.test("apps: one record per discovered app", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: APPS }), async () => {
    await methods.apps.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 2);
  assertEquals(written[0].specName, "app");
  assertEquals(written[0].name, "app-app-a");
  assertEquals(written[0].data.machineCount, 1);
  assertEquals(written[0].data.orgSlug, "personal");
});

Deno.test("status: summarizes machine state per app", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (url.includes("org_slug")) return { body: APPS };
    if (url.includes("/app-a/")) {
      return {
        body: [
          {
            state: "started",
            region: "syd",
            config: { image: "img:1" },
            checks: [{ status: "passing" }],
          },
          {
            state: "stopped",
            region: "lax",
            config: { image: "img:1" },
            checks: [{ status: "critical" }],
          },
        ],
      };
    }
    return { body: [] }; // app-b has no machines
  }, async () => {
    await methods.status.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 2);
  assertEquals(written[0].specName, "appStatus");
  assertEquals(written[0].name, "status-app-a");
  const a = written[0].data;
  assertEquals(a.reachable, true);
  assertEquals(a.machineCount, 2);
  assertEquals(a.runningCount, 1);
  assertEquals(a.unhealthyMachines, 1);
  // deno-lint-ignore no-explicit-any
  assertEquals((a as any).regions.sort(), ["lax", "syd"]);
  // deno-lint-ignore no-explicit-any
  assertEquals((a as any).images, ["img:1"]);
});

Deno.test("status: one unreachable app does not fail the run", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch((url) => {
    if (url.includes("org_slug")) return { body: APPS };
    if (url.includes("/app-b/")) return { status: 403, body: "forbidden" };
    return { body: [{ state: "started", region: "syd", checks: [] }] };
  }, async () => {
    await methods.status.execute({}, context);
  });
  const written = getWrittenResources();
  assertEquals(written.length, 2);
  const byName = Object.fromEntries(written.map((w) => [w.name, w.data]));
  assertEquals(byName["status-app-a"].reachable, true);
  assertEquals(byName["status-app-b"].reachable, false);
  // deno-lint-ignore no-explicit-any
  assertEquals(typeof (byName["status-app-b"] as any).error, "string");
});

Deno.test("apps: empty org writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: { total_apps: 0, apps: [] } }), async () => {
    await methods.apps.execute({}, context);
  });
  assertEquals(getWrittenResources().length, 0);
});
