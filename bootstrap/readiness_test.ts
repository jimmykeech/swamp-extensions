import { strict as assert } from "node:assert";
import { report } from "./readiness.ts";
import { model } from "./bootstrap.ts";
import { VERSION } from "./schema.ts";

Deno.test("controller enables readiness reporting and upgrades without changing configuration", () => {
  assert.ok(model.reports.includes(report.name));
  assert.equal(model.version, VERSION);
  const upgrade = model.upgrades.at(-1)!;
  assert.equal(upgrade.toVersion, VERSION);
  const previous = { specPath: "docs/bootstrap/custom.json" };
  assert.deepEqual(upgrade.upgradeAttributes(previous), previous);
});

Deno.test("readiness report reads the current execution's exact version and never falls back to stale data", async () => {
  const calls: unknown[][] = [];
  const value = {
    configurationReady: true,
    operationallyVerified: false,
    baselineId: "a".repeat(64),
    activeItems: 0,
    configuredItems: 0,
    blockers: [],
  };
  const context = {
    modelType: "@jamesakeech/bootstrap",
    modelId: "example-model-id",
    methodName: "readiness",
    executionStatus: "succeeded",
    dataHandles: [{ name: "readiness", specName: "readiness", version: 7 }],
    dataRepository: {
      getContent: (
        ...args: [string, string, string, number]
      ): Promise<Uint8Array | null> => {
        calls.push(args);
        return Promise.resolve(new TextEncoder().encode(JSON.stringify(value)));
      },
    },
  };
  const result = await report.execute(context);
  assert.deepEqual(result.json, value);
  assert.match(result.markdown, /accepted and current/);
  assert.match(result.markdown, /not verified/);
  assert.deepEqual(calls, [[
    context.modelType,
    context.modelId,
    "readiness",
    7,
  ]]);

  const failed = await report.execute({
    ...context,
    executionStatus: "failed",
  });
  assert.deepEqual(failed.json, {
    established: false,
    executionStatus: "failed",
  });
  const absent = await report.execute({ ...context, dataHandles: [] });
  assert.deepEqual(absent.json, {
    established: false,
    executionStatus: "succeeded",
  });
  assert.equal(
    calls.length,
    1,
    "Failed and no-output executions must not fetch prior readiness.",
  );

  await assert.rejects(
    () =>
      report.execute({
        ...context,
        dataRepository: { getContent: () => Promise.resolve(null) },
      }),
    /this execution is unavailable/,
  );
});
