import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import { GitLabWorkItemsClient } from "./client.ts";

const token = "test-secret-do-not-report";
const client = () =>
  new GitLabWorkItemsClient("gitlab.example.test:8443", token);

function restItem(
  id: number,
  type = "task",
  description: string | null = "Outcome\n\n- Acceptance criteria",
) {
  return {
    id,
    iid: id,
    issue_type: type,
    title: `Item ${id}`,
    description,
    state: "opened",
    web_url: `https://gitlab.example.test/group/project/-/issues/${id}`,
    labels: ["Ready"],
    created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T01:00:00Z",
  };
}

function ref(id: number) {
  return {
    id: `gid://gitlab/WorkItem/${id}`,
    iid: String(id),
    title: `Item ${id}`,
    webUrl: `https://gitlab.example.test/group/project/-/work_items/${id}`,
  };
}

function graph(
  id: number,
  children: number[],
  cursor: string | null,
  parent: number | null = null,
) {
  return {
    data: {
      project: {
        workItems: {
          nodes: [{
            ...ref(id),
            widgets: [{
              type: "HIERARCHY",
              parent: parent === null ? null : ref(parent),
              children: {
                nodes: children.map(ref),
                pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
              },
            }],
          }],
        },
      },
    },
  };
}

function json(data: unknown, headers?: HeadersInit, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function withFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    equal(url.origin, "https://gitlab.example.test:8443");
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

Deno.test("REST list reads beyond 20 items, preserves unknown types and exposes an explicit page limit", async () => {
  const calls: number[] = [];
  await withFetch((url, init) => {
    equal(init.method, "GET");
    equal(url.pathname, "/api/v4/projects/group%2Fproject/issues");
    equal(url.searchParams.get("issue_type"), null);
    equal(url.searchParams.get("order_by"), "created_at");
    const page = Number(url.searchParams.get("page"));
    calls.push(page);
    return page === 1
      ? json(Array.from({ length: 25 }, (_, i) => restItem(i + 1)), {
        "x-next-page": "2",
      })
      : json([restItem(26, "future_type", null)], { "x-next-page": "" });
  }, async () => {
    const args = {
      project: "group/project",
      type: "all",
      state: "all",
      page: 1,
      perPage: 25,
      maxPages: 2,
    } as const;
    const result = await client().list(args);
    equal(result.items.length, 26);
    equal(result.items[25].type, "future_type");
    equal(result.items[25].description, "");
    deepEqual(result.pagination, {
      complete: true,
      nextPage: null,
      pagesFetched: 2,
    });
    const bounded = await client().list({ ...args, maxPages: 1 });
    equal(bounded.items.length, 25);
    deepEqual(bounded.pagination, {
      complete: false,
      nextPage: 2,
      pagesFetched: 1,
    });
    deepEqual(calls, [1, 2, 1]);
  });
});

Deno.test("task detail retains its description, type and parent issue without privileged GraphQL fields", async () => {
  await withFetch((url, init) => {
    if (url.pathname.endsWith("/issues/2")) return json(restItem(2));
    equal(url.pathname, "/api/graphql");
    equal(init.method, "POST");
    const body = JSON.parse(String(init.body));
    deepEqual(body.variables, {
      project: "group/project",
      iid: "2",
      first: 10,
      after: null,
    });
    equal(/author|workItemType/.test(body.query), false);
    return json(graph(2, [], null, 1));
  }, async () => {
    const result = await client().get({
      project: "group/project",
      iid: 2,
      includeHierarchy: true,
      perPage: 10,
      maxPages: 2,
    });
    equal(result.item.type, "task");
    equal(result.item.description, "Outcome\n\n- Acceptance criteria");
    equal(result.hierarchy.status, "available");
    if (result.hierarchy.status !== "available") {
      throw new Error("Expected available hierarchy");
    }
    equal(result.hierarchy.parent?.id, 1);
    equal(result.hierarchy.parent?.iid, 1);
    deepEqual(result.hierarchy.children, []);
    equal(result.hierarchy.complete, true);
  });
});

Deno.test("issue children paginate by cursor and a request limit never reports complete", async () => {
  const cursors: unknown[] = [];
  await withFetch((url, init) => {
    if (url.pathname.endsWith("/issues/1")) return json(restItem(1, "issue"));
    const { variables } = JSON.parse(String(init.body));
    cursors.push(variables.after);
    return json(
      variables.after === null
        ? graph(1, [2], "cursor-2")
        : graph(1, [3], null),
    );
  }, async () => {
    const args = {
      project: "group/project",
      iid: 1,
      includeHierarchy: true,
      perPage: 1,
      maxPages: 2,
    };
    const result = await client().get(args);
    if (result.hierarchy.status !== "available") {
      throw new Error("Expected available hierarchy");
    }
    deepEqual(result.hierarchy.children.map((child) => child.iid), [2, 3]);
    equal(result.hierarchy.complete, true);
    equal(result.hierarchy.pagesFetched, 2);
    const limited = await client().get({ ...args, maxPages: 1 });
    if (limited.hierarchy.status !== "available") {
      throw new Error("Expected available hierarchy");
    }
    equal(limited.hierarchy.complete, false);
    equal(limited.hierarchy.nextCursor, "cursor-2");
    const resumed = await client().get({
      ...args,
      after: limited.hierarchy.nextCursor!,
    });
    if (resumed.hierarchy.status !== "available") {
      throw new Error("Expected available hierarchy");
    }
    deepEqual(resumed.hierarchy.children.map((child) => child.iid), [3]);
    equal(resumed.hierarchy.complete, true);
    deepEqual(cursors, [null, "cursor-2", null, "cursor-2"]);
  });
});

Deno.test("an absent hierarchy widget is explicitly unavailable, not an empty parent/child result", async () => {
  await withFetch((url) => {
    if (url.pathname.endsWith("/issues/1")) {
      return json(restItem(1, "incident"));
    }
    return json({
      data: { project: { workItems: { nodes: [{ ...ref(1), widgets: [] }] } } },
    });
  }, async () => {
    const result = await client().get({
      project: "group/project",
      iid: 1,
      includeHierarchy: true,
      perPage: 10,
      maxPages: 1,
    });
    equal(result.item.type, "incident");
    deepEqual(result.hierarchy, {
      status: "unavailable",
      reason: "GitLab did not expose the hierarchy widget.",
    });
  });
});

Deno.test("HTTP, transport and partial GraphQL errors fail closed without exposing provider text or tokens", async () => {
  const args = {
    project: "group/project",
    iid: 1,
    includeHierarchy: true,
    perPage: 10,
    maxPages: 1,
  };
  await withFetch(() => json({ error: token }, undefined, 401), async () => {
    await rejects(() => client().get(args), {
      message: "GitLab request failed (HTTP 401).",
    });
  });
  let cancellationAttempted = false;
  await withFetch(() =>
    new Response(
      new ReadableStream({
        cancel() {
          cancellationAttempted = true;
          return Promise.reject(new Error(token));
        },
      }),
      { status: 401 },
    ), async () => {
    await rejects(() => client().get(args), {
      message: "GitLab request failed (HTTP 401).",
    });
    equal(cancellationAttempted, true);
  });
  await withFetch(() => {
    throw new Error(token);
  }, async () => {
    await rejects(() => client().get(args), {
      message: "GitLab request failed or timed out.",
    });
  });
  await withFetch(
    (url) =>
      url.pathname.endsWith("/issues/1")
        ? json(restItem(1))
        : json({ ...graph(1, [], null), errors: [{ message: token }] }),
    async () => {
      await rejects(() => client().get(args), {
        message: "GitLab GraphQL returned errors; hierarchy is incomplete.",
      });
    },
  );
});

Deno.test("invalid REST pagination, repeated hierarchy cursors and mismatched roots cannot produce success", async () => {
  const listArgs = {
    project: "group/project",
    type: "task",
    state: "opened",
    page: 1,
    perPage: 1,
    maxPages: 2,
  } as const;
  await withFetch((url) => {
    equal(url.searchParams.get("issue_type"), "task");
    return json([restItem(1)], { "x-next-page": "1" });
  }, async () => {
    await rejects(() => client().list(listArgs), {
      message: "GitLab returned invalid page progression.",
    });
  });
  await withFetch(() => json([restItem(1)]), async () => {
    await rejects(() => client().list(listArgs), {
      message: "GitLab omitted pagination metadata for a full page.",
    });
  });
  const getArgs = {
    project: "group/project",
    iid: 1,
    includeHierarchy: true,
    perPage: 1,
    maxPages: 2,
  };
  await withFetch((url, init) => {
    if (url.pathname.endsWith("/issues/1")) return json(restItem(1));
    const { variables } = JSON.parse(String(init.body));
    return json(graph(1, [variables.after === null ? 2 : 3], "same-cursor"));
  }, async () => {
    await rejects(() => client().get(getArgs), {
      message: "GitLab returned invalid hierarchy cursor progression.",
    });
  });
  await withFetch(
    (url) =>
      url.pathname.endsWith("/issues/1")
        ? json(restItem(1))
        : json(graph(2, [], null)),
    async () => {
      await rejects(() => client().get(getArgs), {
        message: "GitLab returned a different hierarchy root.",
      });
    },
  );
  throws(() =>
    new GitLabWorkItemsClient("user:password@gitlab.example.test", token)
  );
  throws(() => new GitLabWorkItemsClient("gitlab.example.test/path", token));
});
