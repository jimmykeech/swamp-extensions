import { deepEqual, equal, rejects } from "node:assert/strict";
import { model } from "./model.ts";

const token = "synthetic-model-token";
const fixture = {
  id: 500,
  iid: 42,
  issue_type: "task",
  title: "Sample work item",
  description: "Outcome\n\nA testable change",
  state: "opened",
  web_url: "https://gitlab.example.test/group/project/-/issues/42",
  labels: ["triaged", "bug", "factory:building"],
  created_at: "2026-09-10T00:00:00.000Z",
  updated_at: "2026-09-10T01:00:00.123456Z",
};

function context() {
  const writes: {
    spec: string;
    name: string;
    attributes: Record<string, unknown>;
  }[] = [];
  return {
    globalArgs: { host: "gitlab.example.test", token },
    logger: { info: () => undefined },
    writes,
    writeResource: (
      spec: string,
      name: string,
      attributes: Record<string, unknown>,
    ) => {
      const schema =
        model.resources[spec as keyof typeof model.resources].schema;
      schema.parse(attributes);
      equal(JSON.stringify(attributes).includes(token), false);
      const handle = { spec, name, attributes };
      writes.push(handle);
      return Promise.resolve(handle);
    },
  };
}

async function withFetch(
  handler: (url: URL, init: RequestInit) => Response,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    equal(url.origin, "https://gitlab.example.test");
    equal(new Headers(init?.headers).get("PRIVATE-TOKEN"), token);
    equal(init?.redirect, "error");
    return Promise.resolve(handler(url, init!));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("native label, close and reopen methods preserve unrelated labels and write typed results", async () => {
  const ctx = context();
  let labels = [...fixture.labels];
  let state = "opened";
  const bodies: Record<string, string>[] = [];
  await withFetch((url, init) => {
    equal(url.pathname, "/api/v4/projects/group%2Fproject/issues/42");
    equal(init.method, "PUT");
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    equal("labels" in body, false);
    bodies.push(body);
    const removed = body.remove_labels?.split(",") ?? [];
    labels = labels.filter((value) => !removed.includes(value));
    labels = [...new Set([...labels, ...(body.add_labels?.split(",") ?? [])])];
    if (body.state_event) {
      state = body.state_event === "close" ? "closed" : "opened";
    }
    return Response.json({ ...fixture, labels, state });
  }, async () => {
    const target = { project: "group/project", iid: 42 };
    const stage = model.methods.update_work_item_labels;
    await stage.execute(
      stage.arguments.parse({
        ...target,
        addLabels: ["factory:review"],
        removeLabels: ["factory:building"],
      }),
      ctx,
    );
    const close = model.methods.close_work_item;
    await close.execute(
      close.arguments.parse({
        ...target,
        addLabels: ["factory:shipped"],
        removeLabels: ["factory:review"],
      }),
      ctx,
    );
    const closedItem = ctx.writes[1].attributes.item as {
      labels: string[];
      state: string;
    };
    deepEqual(closedItem.labels, ["triaged", "bug", "factory:shipped"]);
    equal(closedItem.state, "closed");
    const reopen = model.methods.reopen_work_item;
    await reopen.execute(
      reopen.arguments.parse({
        ...target,
        addLabels: ["factory:building"],
        removeLabels: ["factory:shipped"],
      }),
      ctx,
    );
  });
  equal(bodies.length, 3);
  equal(bodies[1].state_event, "close");
  equal(bodies[2].state_event, "reopen");
  deepEqual(
    ctx.writes.map((value) => value.spec),
    Array(3).fill("workItemMutation"),
  );
  deepEqual(ctx.writes.map((value) => value.attributes.operation), [
    "labels",
    "close",
    "reopen",
  ]);
  deepEqual(labels, ["triaged", "bug", "factory:building"]);
  equal(state, "opened");
});

Deno.test("native create rejects denied writes without recording success", async () => {
  const ctx = context();
  const create = model.methods.create_work_item;
  const args = create.arguments.parse({
    project: "group/project",
    title: "New item",
  });
  await withFetch((_url, init) => {
    equal(init.method, "POST");
    return Response.json({ error: token }, { status: 403 });
  }, async () => {
    await rejects(() => create.execute(args, ctx), /HTTP 403/);
  });
  equal(ctx.writes.length, 0);
});

Deno.test("native delete records the verified identity only after a 204 acknowledgement", async () => {
  const ctx = context();
  const remove = model.methods.delete_work_item;
  const args = remove.arguments.parse({
    project: "group/project",
    iid: 42,
    expectedId: 500,
  });
  const calls: string[] = [];
  await withFetch((_url, init) => {
    calls.push(init.method!);
    if (init.method === "GET") return Response.json(fixture);
    equal(init.method, "DELETE");
    equal(
      new Headers(init.headers).get("If-Unmodified-Since"),
      fixture.updated_at,
    );
    return new Response(null, { status: 204 });
  }, async () => {
    await remove.execute(args, ctx);
  });
  deepEqual(calls, ["GET", "DELETE"]);
  equal(ctx.writes.length, 1);
  equal(ctx.writes[0].spec, "workItemDeletion");
  equal(ctx.writes[0].attributes.id, 500);
  equal(ctx.writes[0].attributes.iid, 42);
  equal(ctx.writes[0].attributes.deleted, true);
});
