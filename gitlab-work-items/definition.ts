/** Shared Swamp definition for the project work-item reader. */
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

/** Native arguments, typed resources and read-only methods; the entry point supplies global arguments and its collective. */
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
  },
};
