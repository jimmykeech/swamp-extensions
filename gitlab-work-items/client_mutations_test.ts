import { deepEqual, equal, rejects } from "node:assert/strict";
import { GitLabWorkItemsClient } from "./client.ts";

const token = "test-secret-do-not-report";
const project = "group/project";
const client = () => new GitLabWorkItemsClient("gitlab.example.test", token);
const unknownOutcome =
  "GitLab mutation outcome is unknown; inspect the current GitLab state before any retry.";

Deno.test("description quick actions are rejected before create or update can send any request", async () => {
  let calls = 0;
  await withFetch(() => {
    calls++;
    throw new Error("Unexpected request");
  }, async () => {
    for (
      const description of [
        "Outcome\n/label ~triaged",
        "/relabel ~factory:shipped",
        "/close",
        "/clone group/other",
        "/set_parent #9",
        "/clo\rse",
        "```text\n/close\n```",
      ]
    ) {
      await rejects(
        () =>
          client().create({
            project,
            type: "issue",
            title: "Example",
            description,
          }),
        /quick-action/,
      );
      await rejects(
        () => client().update({ project, iid: 2, description }),
        /quick-action/,
      );
    }
  });
  equal(calls, 0);
});

Deno.test("a successful HTTP status cannot acknowledge label changes GitLab did not apply", async () => {
  await withFetch(
    (_url, init) => json(item(2, "issue"), init.method === "POST" ? 201 : 200),
    async () => {
      await rejects(
        () =>
          client().create({
            project,
            type: "issue",
            title: "Example",
            labels: ["triaged"],
          }),
        { message: unknownOutcome },
      );
      await rejects(
        () => client().update({ project, iid: 2, addLabels: ["triaged"] }),
        { message: unknownOutcome },
      );
      await rejects(
        () => client().update({ project, iid: 2, removeLabels: ["unrelated"] }),
        { message: unknownOutcome },
      );
    },
  );
});

function item(iid: number, type = "task") {
  return {
    id: iid + 100,
    iid,
    issue_type: type,
    title: `Item ${iid}`,
    description: "Outcome\n\nAcceptance criteria",
    state: "opened",
    web_url: `https://gitlab.example.test/group/project/-/issues/${iid}`,
    labels: ["unrelated"],
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T01:00:00.123456Z",
  };
}

function reference(iid: number) {
  return {
    id: `gid://gitlab/WorkItem/${iid + 100}`,
    iid: String(iid),
    title: `Item ${iid}`,
    webUrl: `https://gitlab.example.test/group/project/-/work_items/${iid}`,
  };
}

function hierarchy(parentIid: number | null) {
  return {
    data: {
      workItemUpdate: {
        errors: [],
        workItem: {
          ...reference(2),
          widgets: [{
            type: "HIERARCHY",
            parent: parentIid === null ? null : reference(parentIid),
          }],
        },
      },
    },
  };
}

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, headers });
}

async function withFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    equal(url.origin, "https://gitlab.example.test");
    equal(init?.redirect, "error");
    equal(new Headers(init?.headers).get("PRIVATE-TOKEN"), token);
    equal(init?.signal instanceof AbortSignal, true);
    return Promise.resolve(handler(url, init!));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("create sends one POST for each supported type and preserves the description", async () => {
  let calls = 0;
  await withFetch((url, init) => {
    calls++;
    equal(url.pathname, "/api/v4/projects/group%2Fproject/issues");
    equal(init.method, "POST");
    const body = JSON.parse(String(init.body));
    deepEqual(body, {
      issue_type: ["issue", "task", "incident"][calls - 1],
      title: "Factory intake",
      description: "Outcome\n\n- Scope\n- Verification",
      labels: "triaged,factory::ready",
    });
    return json({
      ...item(calls, body.issue_type),
      title: body.title,
      description: body.description,
      labels: ["triaged", "factory::ready"],
    }, 201);
  }, async () => {
    for (const type of ["issue", "task", "incident"] as const) {
      const result = await client().create({
        project,
        type,
        title: "Factory intake",
        description: "Outcome\n\n- Scope\n- Verification",
        labels: ["triaged", "factory::ready"],
      });
      equal(result.project, project);
      equal(result.item.type, type);
      equal(result.item.description, "Outcome\n\n- Scope\n- Verification");
    }
    equal(calls, 3);
  });
});

Deno.test("update applies label deltas and state in one PUT, preserving unrelated labels", async () => {
  let calls = 0;
  await withFetch((url, init) => {
    calls++;
    equal(url.pathname, "/api/v4/projects/group%2Fproject/issues/2");
    equal(init.method, "PUT");
    deepEqual(
      JSON.parse(String(init.body)),
      calls === 1
        ? {
          description: "",
          add_labels: "factory::shipped",
          remove_labels: "factory::verifying",
          state_event: "close",
        }
        : { title: "Follow-up work", state_event: "reopen" },
    );
    return json({
      ...item(2),
      state: calls === 1 ? "closed" : "opened",
      labels: ["unrelated", "triaged", "factory::shipped"],
    });
  }, async () => {
    const closed = await client().update({
      project,
      iid: 2,
      description: "",
      addLabels: ["factory::shipped"],
      removeLabels: ["factory::verifying"],
      state: "closed",
    });
    deepEqual(closed.item.labels, ["unrelated", "triaged", "factory::shipped"]);
    equal(closed.item.state, "closed");
    const reopened = await client().update({
      project,
      iid: 2,
      title: "Follow-up work",
      state: "opened",
    });
    equal(reopened.item.state, "opened");
    equal(calls, 2);
  });
});

Deno.test("list supports an AND label filter and invalid label changes send no requests", async () => {
  let calls = 0;
  const listArgs = {
    project,
    type: "all",
    state: "opened",
    page: 1,
    perPage: 10,
    maxPages: 1,
  } as const;
  await withFetch((url, init) => {
    calls++;
    equal(init.method, "GET");
    equal(url.searchParams.get("labels"), "triaged,factory::ready");
    return json([{ ...item(2), labels: ["triaged", "factory::ready"] }], 200, {
      "x-next-page": "",
    });
  }, async () => {
    equal(
      (await client().list({
        ...listArgs,
        labels: ["triaged", "factory::ready"],
      })).items.length,
      1,
    );
    for (const labels of [["triaged", "triaged"], [" "], ["triaged,ready"]]) {
      await rejects(() =>
        client().update({ project, iid: 2, addLabels: labels })
      );
      await rejects(() =>
        client().create({
          project,
          type: "issue",
          title: "Intake",
          labels,
        })
      );
      await rejects(() => client().list({ ...listArgs, labels }));
    }
    await rejects(() =>
      client().update({
        project,
        iid: 2,
        addLabels: ["triaged"],
        removeLabels: ["triaged"],
      }), /cannot be added and removed/);
    await rejects(
      () => client().update({ project, iid: 2 }),
      /change is required/,
    );
    await rejects(
      () => client().update({ project, iid: 2, addLabels: [] }),
      /change is required/,
    );
    equal(calls, 1);
  });
});

Deno.test("delete uses the freshly verified global ID and exact timestamp, accepting only 204", async () => {
  const calls: string[] = [];
  await withFetch((url, init) => {
    equal(url.pathname, "/api/v4/projects/group%2Fproject/issues/2");
    calls.push(init.method!);
    if (init.method === "GET") return json(item(2));
    equal(init.method, "DELETE");
    equal(init.body, undefined);
    equal(
      new Headers(init.headers).get("If-Unmodified-Since"),
      item(2).updated_at,
    );
    return new Response(null, { status: 204 });
  }, async () => {
    deepEqual(await client().delete({ project, iid: 2, expectedId: 102 }), {
      project,
      id: 102,
      iid: 2,
      deleted: true,
    });
    deepEqual(calls, ["GET", "DELETE"]);
  });
  for (const status of [412, 404]) {
    let writes = 0;
    await withFetch((_url, init) => {
      if (init.method === "GET") return json(item(2));
      writes++;
      return json({ message: token }, status);
    }, async () => {
      await rejects(
        () => client().delete({ project, iid: 2, expectedId: 102 }),
        {
          message: `GitLab mutation was rejected (HTTP ${status}).`,
        },
      );
      equal(writes, 1);
    });
  }
  await withFetch((_url, init) => {
    if (init.method === "GET") return json(item(2));
    return json({ deleted: true }, 200);
  }, async () => {
    await rejects(() => client().delete({ project, iid: 2, expectedId: 102 }), {
      message: unknownOutcome,
    });
  });
});

Deno.test("identity guards, missing targets and invalid delete timestamps prevent writes", async () => {
  let reads = 0;
  await withFetch((_url, init) => {
    equal(init.method, "GET");
    reads++;
    return json(item(2));
  }, async () => {
    await rejects(
      () => client().delete({ project, iid: 2, expectedId: 999 }),
      /no write was sent/,
    );
    await rejects(
      () =>
        client().update({ project, iid: 2, expectedId: 999, state: "closed" }),
      /no write was sent/,
    );
    await rejects(
      () =>
        client().setParent({ project, iid: 2, expectedId: 999, parentIid: 1 }),
      /no write was sent/,
    );
    equal(reads, 3);
  });
  await withFetch((_url, init) => {
    equal(init.method, "GET");
    return json({ ...item(2), updated_at: "bad\r\nheader" });
  }, async () => {
    await rejects(
      () => client().delete({ project, iid: 2, expectedId: 102 }),
      /no delete was sent/,
    );
  });
  for (const status of [403, 404]) {
    await withFetch((_url, init) => {
      equal(init.method, "GET");
      return json({ message: token }, status);
    }, async () => {
      await rejects(
        () => client().delete({ project, iid: 2, expectedId: 102 }),
        {
          message: `GitLab request failed (HTTP ${status}).`,
        },
      );
    });
  }
});

Deno.test("parent changes resolve global IDs and return the mutation result without refetching", async () => {
  const calls: string[] = [];
  for (const parentIid of [1, null]) {
    await withFetch((url, init) => {
      calls.push(`${init.method} ${url.pathname}`);
      if (init.method === "GET") {
        return json(item(url.pathname.endsWith("/2") ? 2 : 1));
      }
      equal(url.pathname, "/api/graphql");
      equal(init.method, "POST");
      const body = JSON.parse(String(init.body));
      equal(body.query.startsWith("mutation SetWorkItemParent"), true);
      deepEqual(body.variables, {
        input: {
          id: "gid://gitlab/WorkItem/102",
          hierarchyWidget: {
            parentId: parentIid === null ? null : "gid://gitlab/WorkItem/101",
          },
        },
      });
      return json(hierarchy(parentIid));
    }, async () => {
      const result = await client().setParent({
        project,
        iid: 2,
        parentIid,
        expectedId: 102,
      });
      equal(result.item.id, 102);
      equal(result.item.iid, 2);
      equal(result.parent?.iid ?? null, parentIid);
    });
  }
  deepEqual(calls, [
    "GET /api/v4/projects/group%2Fproject/issues/2",
    "GET /api/v4/projects/group%2Fproject/issues/1",
    "POST /api/graphql",
    "GET /api/v4/projects/group%2Fproject/issues/2",
    "POST /api/graphql",
  ]);
});

Deno.test("GraphQL mutation errors and incorrect returned identities cannot report success", async () => {
  const wrongRoot = hierarchy(1);
  wrongRoot.data.workItemUpdate.workItem.id = "gid://gitlab/WorkItem/999";
  const responses = [
    { ...hierarchy(1), errors: [{ message: token }] },
    { data: { workItemUpdate: { errors: [token], workItem: null } } },
    wrongRoot,
    hierarchy(null),
  ];
  for (const response of responses) {
    let writes = 0;
    await withFetch((url, init) => {
      if (init.method === "GET") {
        return json(item(url.pathname.endsWith("/2") ? 2 : 1));
      }
      writes++;
      return json(response);
    }, async () => {
      await rejects(
        () => client().setParent({ project, iid: 2, parentIid: 1 }),
        {
          message: unknownOutcome,
        },
      );
      equal(writes, 1);
    });
  }
});

Deno.test("ambiguous writes never retry or expose transport, provider or cancellation secrets", async () => {
  let cancellations = 0;
  const responders = [
    () => {
      throw new Error(token);
    },
    () => new Response(token, { status: 201 }),
    () => json({}, 201),
    () => json(item(1, "incident"), 201),
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancellations++;
            return Promise.reject(new Error(token));
          },
        }),
        { status: 500 },
      ),
  ];
  for (const respond of responders) {
    let calls = 0;
    await withFetch(() => {
      calls++;
      return respond();
    }, async () => {
      await rejects(
        () => client().create({ project, type: "issue", title: "Intake" }),
        {
          message: unknownOutcome,
        },
      );
      equal(calls, 1);
    });
  }
  equal(cancellations, 1);
  await withFetch(() => json({ message: token }, 403), async () => {
    await rejects(() => client().update({ project, iid: 2, state: "closed" }), {
      message: "GitLab mutation was rejected (HTTP 403).",
    });
  });
  await withFetch((_url, init) => {
    if (init.method === "GET") return json(item(2));
    return json({ ...item(2), id: 999 });
  }, async () => {
    await rejects(
      () =>
        client().update({ project, iid: 2, title: "Changed", expectedId: 102 }),
      {
        message: unknownOutcome,
      },
    );
  });
});
