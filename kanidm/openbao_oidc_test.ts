import { extension } from "./openbao_oidc.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(action: () => Promise<unknown>, includes: string) {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes(includes),
      `Expected error containing ${includes}`,
    );
    return error as Error;
  }
  throw new Error("Expected action to reject");
}

const method = extension.methods[0].configure_kanidm_oidc;
const input = {
  token: "operator-token-secret",
  discoveryUrl: "https://auth.example.com/oauth2/openid/openbao",
  clientId: "openbao",
  clientSecret: "client-secret",
  roleName: "kanidm-admin",
  group: "openbao-admins",
  redirectUris: [
    "https://secrets.example.com/ui/vault/auth/oidc/oidc/callback",
  ],
  scopes: ["openid", "email", "profile", "groups_name"],
  policies: ["openbao-admin"],
};

Deno.test("configure_kanidm_oidc writes OpenBao discovery, policy and role", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<
    { path: string; method: string; body?: Record<string, unknown> }
  > = [];
  globalThis.fetch = (resource, init) => {
    const path = new URL(String(resource)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method: init?.method ?? "GET", body });
    if (path === "/v1/sys/auth") {
      return Promise.resolve(
        Response.json({ data: { "oidc/": { type: "oidc" } } }),
      );
    }
    return Promise.resolve(Response.json({}));
  };
  try {
    let written: Record<string, unknown> | undefined;
    const result = await method.execute(input, {
      globalArgs: { apiAddr: "https://bao.example.com" },
      logger: { info: () => {} },
      writeResource: (_spec, name, value) => {
        assert(name === "oidc", "Expected stable OIDC resource name");
        written = value;
        return Promise.resolve({ name });
      },
    });
    assert(
      requests.some((request) => request.path === "/v1/auth/oidc/config"),
      "Expected OIDC config request",
    );
    assert(
      requests.some((request) =>
        request.path === "/v1/sys/policies/acl/openbao-admin"
      ),
      "Expected admin policy request",
    );
    assert(
      requests.some((request) =>
        request.path === "/v1/auth/oidc/role/kanidm-admin"
      ),
      "Expected role request",
    );
    assert(
      written?.roleName === "kanidm-admin",
      "Expected OIDC resource output",
    );
    assert(result.dataHandles.length === 1, "Expected one resource handle");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("configure_kanidm_oidc reports OpenBao response detail without secrets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({ errors: ["permission denied"] }, { status: 403 }),
    );
  try {
    const error = await rejects(
      () =>
        method.execute(input, {
          globalArgs: { apiAddr: "https://bao.example.com" },
          logger: { info: () => {} },
          writeResource: () => Promise.resolve({ name: "unused" }),
        }),
      "permission denied",
    );
    assert(
      !error.message.includes("operator-token-secret"),
      "Operator token must not appear in errors",
    );
    assert(
      !error.message.includes("client-secret"),
      "Client secret must not appear in errors",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
