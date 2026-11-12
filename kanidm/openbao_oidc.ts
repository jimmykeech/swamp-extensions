import { z } from "npm:zod@4.1.12";

const args = z.object({
  token: z.string().min(1).meta({ sensitive: true }),
  discoveryUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).meta({ sensitive: true }),
  roleName: z.string().default("kanidm-admin"),
  group: z.string().default("openbao-admins"),
  redirectUris: z.array(z.string().url()).min(1),
  scopes: z.array(z.string()).default([
    "openid",
    "email",
    "profile",
    "groups_name",
  ]),
  policies: z.array(z.string()).min(1).default(["openbao-admin"]),
});

type Input = z.infer<typeof args>;
type Context = {
  globalArgs: { apiAddr: string };
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};
async function errorDetail(
  response: Response,
  secrets: string[],
): Promise<string> {
  const text = await response.text();
  let detail = text;
  try {
    const body = JSON.parse(text);
    detail =
      [body.errors?.join?.("; "), body.error, body.message].filter((value) =>
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

export const extension = {
  type: "@evrardjp/openbao-configurator",
  version: "2026.11.12.2",
  resources: {
    oidcConfig: {
      description: "OpenBao OIDC configuration applied through the API",
      schema: z.object({
        apiAddr: z.string(),
        authPath: z.string(),
        roleName: z.string(),
        configuredAt: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: [{
    configure_kanidm_oidc: {
      description:
        "Configure OpenBao OIDC discovery, role and callback URIs for a Kanidm provider",
      arguments: args,
      async execute(input: Input, ctx: Context) {
        ctx.logger.info("Configuring OpenBao OIDC role {roleName}", {
          roleName: input.roleName,
        });
        const base = ctx.globalArgs.apiAddr.replace(/\/$/, "");
        const call = async (path: string, method: string, body?: unknown) => {
          const response = await fetch(`${base}/v1/${path}`, {
            method,
            headers: {
              "X-Vault-Token": input.token,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20_000),
          });
          if (!response.ok) {
            throw new Error(
              `OpenBao ${method} /v1/${path} returned HTTP ${response.status}: ${await errorDetail(
                response,
                [input.token, input.clientSecret],
              )}`,
            );
          }
          return response.status === 204 ? {} : await response.json();
        };
        const mounts = await call("sys/auth", "GET");
        if (!mounts?.data?.["oidc/"]) {
          await call("sys/auth/oidc", "POST", { type: "oidc" });
        }
        await call("auth/oidc/config", "POST", {
          oidc_discovery_url: input.discoveryUrl,
          oidc_client_id: input.clientId,
          oidc_client_secret: input.clientSecret,
          default_role: input.roleName,
        });
        await call(
          `sys/policies/acl/${encodeURIComponent(input.policies[0])}`,
          "PUT",
          {
            policy:
              'path "*" { capabilities = ["create", "read", "update", "delete", "list", "sudo"] }',
          },
        );
        await call(
          `auth/oidc/role/${encodeURIComponent(input.roleName)}`,
          "POST",
          {
            role_type: "oidc",
            user_claim: "sub",
            groups_claim: "groups",
            oidc_scopes: input.scopes,
            allowed_redirect_uris: input.redirectUris,
            bound_audiences: [input.clientId],
            bound_claims: { groups: [input.group] },
            policies: input.policies,
            token_ttl: "1h",
            token_max_ttl: "4h",
          },
        );
        const handle = await ctx.writeResource("oidcConfig", "oidc", {
          apiAddr: base,
          authPath: "oidc/",
          roleName: input.roleName,
          configuredAt: new Date().toISOString(),
        });
        ctx.logger.info("Configured OpenBao OIDC role {roleName}", {
          roleName: input.roleName,
        });
        return { dataHandles: [handle] };
      },
    },
  }],
};
