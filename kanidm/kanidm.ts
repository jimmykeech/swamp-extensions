import { z } from "npm:zod@4.1.12";

const globalArguments = z.object({
  baseUrl: z.string().url().describe("Kanidm server URL"),
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Kanidm API token with group and OAuth2 administration rights",
  ),
});

const groupResult = z.object({
  name: z.string(),
  members: z.array(z.string()),
  updatedAt: z.string(),
});

const clientResult = z.object({
  clientId: z.string(),
  displayName: z.string(),
  redirectUris: z.array(z.string()),
  scopes: z.array(z.string()),
  supplementalScopes: z.array(z.string()),
  clientSecret: z.string().meta({ sensitive: true }),
  updatedAt: z.string(),
});

type Context = {
  globalArgs: z.infer<typeof globalArguments>;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};
type CheckContext = { globalArgs: z.infer<typeof globalArguments> };

async function errorDetail(
  response: Response,
  secrets: string[],
): Promise<string> {
  const text = await response.text();
  let detail = text;
  try {
    const body = JSON.parse(text);
    detail = [body.error, body.message, body.detail].filter((value) =>
      typeof value === "string"
    ).join(": ") || text;
  } catch {
    // Keep the response text as the detail when the provider does not return JSON.
  }
  for (const secret of secrets) {
    if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
  }
  return detail.slice(0, 500) || "no response detail";
}
type GroupArgs = { name: string; members: string[] };
type ClientArgs = {
  clientId: string;
  displayName: string;
  origin: string;
  redirectUris: string[];
  group: string;
  scopes: string[];
  supplementalScopes: string[];
};

function url(ctx: Context, path: string): string {
  return `${ctx.globalArgs.baseUrl.replace(/\/$/, "")}/v1/${path}`;
}

async function request(
  ctx: Context,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(url(ctx, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.globalArgs.apiToken}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
}

async function checked(
  ctx: Context,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await request(ctx, path, init);
  if (!response.ok) {
    throw new Error(
      `Kanidm ${
        init.method ?? "GET"
      } /v1/${path} returned HTTP ${response.status}: ${await errorDetail(
        response,
        [ctx.globalArgs.apiToken],
      )}`,
    );
  }
  if (init.method && init.method !== "GET") {
    await response.body?.cancel();
  }
  return response;
}

export const model = {
  type: "@jamesakeech/kanidm",
  version: "2026.11.12.2",
  description: "Manage Kanidm groups and OAuth2 clients through the REST API",
  upgrades: [{
    toVersion: "2026.11.12.2",
    description:
      "Fix Kanidm OAuth2 attribute mapping; global arguments are unchanged",
    upgradeAttributes: (previous: Record<string, unknown>) => previous,
  }],
  globalArguments,
  resources: {
    group: {
      kind: "resource",
      schema: groupResult,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    oauth2Credential: {
      kind: "resource",
      schema: clientResult,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "kanidm-api-access": {
      description:
        "Verify the Kanidm API token can read group configuration before a change",
      labels: ["live"],
      appliesTo: ["ensure_group", "ensure_oauth2_client"],
      async execute(context: CheckContext) {
        const response = await fetch(
          `${context.globalArgs.baseUrl.replace(/\/$/, "")}/v1/group`,
          {
            headers: {
              Authorization: `Bearer ${context.globalArgs.apiToken}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!response.ok) {
          return {
            pass: false,
            errors: [
              `Kanidm API preflight returned HTTP ${response.status}: ${await errorDetail(
                response,
                [context.globalArgs.apiToken],
              )}`,
            ],
          };
        }
        await response.body?.cancel();
        return { pass: true };
      },
    },
  },
  methods: {
    ensure_group: {
      description:
        "Create a Kanidm group if needed and ensure the requested members are present",
      arguments: z.object({
        name: z.string().min(1),
        members: z.array(z.string()).default([]),
      }),
      async execute(args: GroupArgs, ctx: Context) {
        ctx.logger.info("Ensuring Kanidm group {name}", { name: args.name });
        const encoded = encodeURIComponent(args.name);
        let response = await request(ctx, `group/${encoded}`);
        if (response.status === 404) {
          await checked(ctx, "group", {
            method: "POST",
            body: JSON.stringify({ attrs: { name: [args.name] } }),
          });
          response = await checked(ctx, `group/${encoded}`);
        } else if (!response.ok) {
          throw new Error(
            `Kanidm group lookup returned HTTP ${response.status}: ${await errorDetail(
              response,
              [ctx.globalArgs.apiToken],
            )}`,
          );
        }
        const entry = await response.json();
        const current = entry?.attrs?.member ?? [];
        const missing = args.members.filter((member: string) =>
          !current.includes(member)
        );
        for (const member of missing) {
          await checked(ctx, `group/${encoded}/_attr/member`, {
            method: "POST",
            body: JSON.stringify([member]),
          });
        }
        const handle = await ctx.writeResource("group", args.name, {
          name: args.name,
          members: [...new Set([...current, ...args.members])],
          updatedAt: new Date().toISOString(),
        });
        ctx.logger.info("Ensured Kanidm group {name}", { name: args.name });
        return { dataHandles: [handle] };
      },
    },
    ensure_oauth2_client: {
      description:
        "Create or update a confidential OAuth2 client, its redirects and scope maps",
      arguments: z.object({
        clientId: z.string().min(1),
        displayName: z.string().min(1),
        origin: z.string().url(),
        redirectUris: z.array(z.string().url()).min(1),
        group: z.string().min(1),
        scopes: z.array(z.string()).default(["openid", "email", "profile"]),
        supplementalScopes: z.array(z.string()).default([]),
      }),
      async execute(args: ClientArgs, ctx: Context) {
        ctx.logger.info("Ensuring Kanidm OAuth2 client {clientId}", {
          clientId: args.clientId,
        });
        const id = encodeURIComponent(args.clientId);
        const get = await request(ctx, `oauth2/${id}`);
        if (get.status === 404) {
          await checked(ctx, "oauth2/_basic", {
            method: "POST",
            body: JSON.stringify({
              attrs: {
                name: [args.clientId],
                displayname: [args.displayName],
                oauth2_rs_origin_landing: [args.origin],
                oauth2_rs_origin: args.redirectUris,
              },
            }),
          });
        } else if (!get.ok) {
          throw new Error(
            `Kanidm OAuth2 client lookup returned HTTP ${get.status}: ${await errorDetail(
              get,
              [ctx.globalArgs.apiToken],
            )}`,
          );
        } else {
          await checked(ctx, `oauth2/${id}`, {
            method: "PATCH",
            body: JSON.stringify({
              attrs: {
                displayname: [args.displayName],
                oauth2_rs_origin_landing: [args.origin],
                oauth2_rs_origin: args.redirectUris,
              },
            }),
          });
        }
        await checked(
          ctx,
          `oauth2/${id}/_scopemap/${encodeURIComponent(args.group)}`,
          { method: "POST", body: JSON.stringify(args.scopes) },
        );
        await checked(
          ctx,
          `oauth2/${id}/_sup_scopemap/${encodeURIComponent(args.group)}`,
          { method: "POST", body: JSON.stringify(args.supplementalScopes) },
        );
        const secretResponse = await checked(ctx, `oauth2/${id}/_basic_secret`);
        const secretValue = await secretResponse.json();
        const clientSecret = typeof secretValue === "string"
          ? secretValue
          : secretValue?.secret;
        if (typeof clientSecret !== "string" || !clientSecret) {
          throw new Error("Kanidm returned no OAuth2 client secret");
        }
        const handle = await ctx.writeResource(
          "oauth2Credential",
          args.clientId,
          {
            clientId: args.clientId,
            displayName: args.displayName,
            redirectUris: args.redirectUris,
            scopes: args.scopes,
            supplementalScopes: args.supplementalScopes,
            clientSecret,
            updatedAt: new Date().toISOString(),
          },
        );
        ctx.logger.info("Ensured Kanidm OAuth2 client {clientId}", {
          clientId: args.clientId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
