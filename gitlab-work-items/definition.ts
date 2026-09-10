/** Shared Swamp resources and methods for GitLab work-item management. */
import { z } from "npm:zod@4.4.3";
import { GitLabWorkItemsClient } from "./client.ts";

interface Context {
  globalArgs: { host: string; token: string };
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    attributes: Record<string, unknown>,
  ) => Promise<unknown>;
}

const item = z.object({
  id: z.number().int().positive(),
  iid: z.number().int().positive(),
  type: z.string().min(1),
  title: z.string(),
  description: z.string(),
  state: z.string(),
  webUrl: z.string(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const reference = z.object({
  id: z.number().int().positive(),
  gid: z.string(),
  iid: z.number().int().positive(),
  title: z.string(),
  webUrl: z.string(),
});
const label = z.string().min(1).refine(
  (value) => value.trim() === value && !/[,\r\n]/.test(value),
  "Label names must be nonblank and cannot contain commas or newlines",
);
const labels = z.array(label).max(100).refine(
  (values) => new Set(values).size === values.length,
  "Label names must be unique",
);
const labelChanges = {
  addLabels: labels.optional(),
  removeLabels: labels.optional(),
};
const target = {
  project: z.string().min(1).describe(
    "Project path, for example group/project",
  ),
  iid: z.number().int().positive().describe("Project-scoped work-item IID"),
  expectedId: z.number().int().positive().optional().describe(
    "Optional global numeric ID from a prior read; verify before updating",
  ),
};
const createArguments = z.object({
  project: target.project,
  type: z.enum(["issue", "task", "incident"]).default("issue"),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(1_048_576).optional(),
  labels: labels.optional(),
});
const updateArguments = z.object({
  ...target,
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(1_048_576).optional(),
  state: z.enum(["opened", "closed"]).optional(),
  ...labelChanges,
}).refine(
  (args) =>
    args.title !== undefined || args.description !== undefined ||
    args.state !== undefined || (args.addLabels?.length ?? 0) > 0 ||
    (args.removeLabels?.length ?? 0) > 0,
  "Provide a field or label change",
);
const labelsArguments = z.object({ ...target, ...labelChanges }).refine(
  (args) =>
    (args.addLabels?.length ?? 0) > 0 ||
    (args.removeLabels?.length ?? 0) > 0,
  "Provide labels to add or remove",
);
const stateArguments = z.object({ ...target, ...labelChanges });
const deleteArguments = z.object({
  project: target.project,
  iid: target.iid,
  expectedId: z.number().int().positive().describe(
    "Required global numeric ID from get_work_item; prevents deleting a different target",
  ),
});
const parentArguments = z.object({
  ...target,
  parentIid: z.number().int().positive().nullable().describe(
    "Parent IID in the same project, or null to remove the parent relationship",
  ),
});
const hierarchy = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    parent: reference.nullable(),
    children: z.array(reference),
    complete: z.boolean(),
    nextCursor: z.string().nullable(),
    pagesFetched: z.number().int().nonnegative(),
  }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
  z.object({ status: z.literal("not-requested") }),
]);
const listArguments = z.object({
  project: z.string().min(1).describe(
    "Project path, for example group/project",
  ),
  type: z.enum(["all", "issue", "task", "incident"]).default("all"),
  state: z.enum(["all", "opened", "closed"]).default("all"),
  page: z.number().int().positive().default(1),
  perPage: z.number().int().min(1).max(100).default(100),
  maxPages: z.number().int().min(1).max(100).default(10),
  labels: labels.min(1).optional().describe("Require all listed label names"),
});
const getArguments = z.object({
  project: z.string().min(1).describe(
    "Project path, for example group/project",
  ),
  iid: z.number().int().positive().describe("Project-scoped work-item IID"),
  includeHierarchy: z.boolean().default(true),
  perPage: z.number().int().min(1).max(100).default(100),
  maxPages: z.number().int().min(1).max(100).default(10),
  after: z.string().min(1).optional().describe(
    "Resume children from a returned nextCursor",
  ),
});

async function resourceName(
  prefix: string,
  identity: unknown[],
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}-${hex}`;
}

const mutationOperations = [
  "create",
  "update",
  "labels",
  "close",
  "reopen",
] as const;

async function recordMutation(
  operation: typeof mutationOperations[number],
  result: { project: string; item: z.infer<typeof item> },
  ctx: Context,
  start: number,
): Promise<{ dataHandles: unknown[] }> {
  const name = await resourceName("mutation", [
    ctx.globalArgs.host,
    result.project,
    result.item.iid,
  ]);
  const handle = await ctx.writeResource("workItemMutation", name, {
    ...result,
    host: ctx.globalArgs.host,
    operation,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  });
  ctx.logger.info("GitLab work-item {operation} completed", { operation });
  return { dataHandles: [handle] };
}

async function updateItem(
  operation: "update" | "labels" | "close" | "reopen",
  args: z.infer<typeof updateArguments>,
  ctx: Context,
): Promise<{ dataHandles: unknown[] }> {
  const start = Date.now();
  ctx.logger.info("Applying GitLab work-item {operation}", { operation });
  const result = await new GitLabWorkItemsClient(
    ctx.globalArgs.host,
    ctx.globalArgs.token,
  ).update(args);
  return await recordMutation(operation, result, ctx, start);
}

/** Native schemas and CRUD methods; the entry point supplies connection arguments and its collective. */
export const definition = {
  resources: {
    workItems: {
      description: "Typed work items and explicit REST pagination status",
      schema: z.object({
        host: z.string(),
        project: z.string(),
        request: listArguments,
        items: z.array(item),
        pagination: z.object({
          complete: z.boolean(),
          nextPage: z.number().int().positive().nullable(),
          pagesFetched: z.number().int().positive(),
        }),
        fetchedAt: z.string(),
        durationMs: z.number().nonnegative(),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
    workItem: {
      description:
        "Full work-item description, type and optional paginated hierarchy",
      schema: z.object({
        host: z.string(),
        project: z.string(),
        request: getArguments,
        item,
        hierarchy,
        fetchedAt: z.string(),
        durationMs: z.number().nonnegative(),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
    workItemMutation: {
      description:
        "Confirmed create or update result, including current labels and state",
      schema: z.object({
        host: z.string(),
        project: z.string(),
        operation: z.enum(mutationOperations),
        item,
        fetchedAt: z.string(),
        durationMs: z.number().nonnegative(),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
    workItemDeletion: {
      description: "Identity of a work item whose deletion GitLab acknowledged",
      schema: z.object({
        host: z.string(),
        project: z.string(),
        id: z.number().int().positive(),
        iid: z.number().int().positive(),
        deleted: z.literal(true),
        fetchedAt: z.string(),
        durationMs: z.number().nonnegative(),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
    workItemParent: {
      description:
        "Confirmed direct parent relationship after linking or unlinking",
      schema: z.object({
        host: z.string(),
        project: z.string(),
        item: reference,
        parent: reference.nullable(),
        fetchedAt: z.string(),
        durationMs: z.number().nonnegative(),
      }),
      lifetime: "1h",
      garbageCollection: 10,
    },
  },
  methods: {
    list_work_items: {
      description:
        "List project issues, tasks and incidents with type/state filters and bounded pagination",
      arguments: listArguments,
      execute: async (
        args: z.infer<typeof listArguments>,
        ctx: Context,
      ): Promise<{ dataHandles: unknown[] }> => {
        const start = Date.now();
        const { host, token } = ctx.globalArgs;
        ctx.logger.info("Reading GitLab work items");
        const result = await new GitLabWorkItemsClient(host, token).list(args);
        const name = await resourceName("items", [
          host,
          args.project,
          args.type,
          args.state,
          args.page,
          ...(args.labels ? [args.labels] : []),
        ]);
        const handle = await ctx.writeResource("workItems", name, {
          ...result,
          host,
          request: args,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
        });
        ctx.logger.info(
          "Read {count} GitLab work items; complete: {complete}",
          {
            count: result.items.length,
            complete: result.pagination.complete,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    get_work_item: {
      description:
        "Read a project work item's full description and type, with parent and child references",
      arguments: getArguments,
      execute: async (
        args: z.infer<typeof getArguments>,
        ctx: Context,
      ): Promise<{ dataHandles: unknown[] }> => {
        const start = Date.now();
        const { host, token } = ctx.globalArgs;
        ctx.logger.info("Reading a GitLab work item");
        const result = await new GitLabWorkItemsClient(host, token).get(args);
        const name = await resourceName("item", [
          host,
          args.project,
          args.iid,
          args.after ?? null,
        ]);
        const handle = await ctx.writeResource("workItem", name, {
          ...result,
          host,
          request: args,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
        });
        ctx.logger.info("Read GitLab work item; hierarchy: {status}", {
          status: result.hierarchy.status,
        });
        return { dataHandles: [handle] };
      },
    },
    create_work_item: {
      description:
        "Create an issue, task or incident with a title, description and optional labels",
      arguments: createArguments,
      execute: async (args: z.infer<typeof createArguments>, ctx: Context) => {
        const start = Date.now();
        ctx.logger.info("Creating a GitLab work item");
        const result = await new GitLabWorkItemsClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        ).create(args);
        return await recordMutation("create", result, ctx, start);
      },
    },
    update_work_item: {
      description:
        "Update title, description, state and label deltas in one GitLab request",
      arguments: updateArguments,
      execute: async (args: z.infer<typeof updateArguments>, ctx: Context) =>
        await updateItem("update", args, ctx),
    },
    update_work_item_labels: {
      description:
        "Add and remove specific labels while preserving unrelated labels",
      arguments: labelsArguments,
      execute: async (args: z.infer<typeof labelsArguments>, ctx: Context) =>
        await updateItem("labels", args, ctx),
    },
    close_work_item: {
      description:
        "Close a work item and optionally update its labels in the same request",
      arguments: stateArguments,
      execute: async (args: z.infer<typeof stateArguments>, ctx: Context) =>
        await updateItem("close", { ...args, state: "closed" }, ctx),
    },
    reopen_work_item: {
      description:
        "Reopen a work item and optionally update its labels in the same request",
      arguments: stateArguments,
      execute: async (args: z.infer<typeof stateArguments>, ctx: Context) =>
        await updateItem("reopen", { ...args, state: "opened" }, ctx),
    },
    delete_work_item: {
      description:
        "Permanently delete a verified work item; use close_work_item for completed work",
      arguments: deleteArguments,
      execute: async (args: z.infer<typeof deleteArguments>, ctx: Context) => {
        const start = Date.now();
        ctx.logger.info("Deleting a GitLab work item");
        const result = await new GitLabWorkItemsClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        ).delete(args);
        const name = await resourceName("deletion", [
          ctx.globalArgs.host,
          args.project,
          args.iid,
        ]);
        const handle = await ctx.writeResource("workItemDeletion", name, {
          ...result,
          host: ctx.globalArgs.host,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
        });
        ctx.logger.info("GitLab work-item deletion acknowledged");
        return { dataHandles: [handle] };
      },
    },
    set_work_item_parent: {
      description:
        "Link a work item to a parent in the same project, or remove its parent",
      arguments: parentArguments,
      execute: async (args: z.infer<typeof parentArguments>, ctx: Context) => {
        const start = Date.now();
        ctx.logger.info("Updating a GitLab work-item parent relationship");
        const result = await new GitLabWorkItemsClient(
          ctx.globalArgs.host,
          ctx.globalArgs.token,
        ).setParent(args);
        const name = await resourceName("parent", [
          ctx.globalArgs.host,
          args.project,
          args.iid,
        ]);
        const handle = await ctx.writeResource("workItemParent", name, {
          ...result,
          host: ctx.globalArgs.host,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
        });
        ctx.logger.info("GitLab work-item parent relationship updated");
        return { dataHandles: [handle] };
      },
    },
  },
  checks: {
    "valid-gitlab-connection": {
      description:
        "Validate the HTTPS destination and credential format before a mutation",
      labels: ["policy"],
      appliesTo: [
        "create_work_item",
        "update_work_item",
        "update_work_item_labels",
        "close_work_item",
        "reopen_work_item",
        "delete_work_item",
        "set_work_item_parent",
      ],
      execute: (ctx: Pick<Context, "globalArgs">) => {
        try {
          new GitLabWorkItemsClient(ctx.globalArgs.host, ctx.globalArgs.token);
          return Promise.resolve({ pass: true });
        } catch {
          return Promise.resolve({
            pass: false,
            errors: [
              "Configure a valid GitLab HTTPS hostname and token before writing",
            ],
          });
        }
      },
    },
  },
};
