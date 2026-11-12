import { model } from "./kanidm.ts";

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

const args = {
  clientId: "openbao",
  displayName: "OpenBao",
  origin: "https://secrets.example.com",
  redirectUris: [
    "https://secrets.example.com/ui/vault/auth/oidc/oidc/callback",
  ],
  group: "openbao-admins",
  scopes: ["openid", "email", "profile"],
  supplementalScopes: ["groups_name"],
};

Deno.test("ensure_oauth2_client updates Kanidm and writes its sensitive credential", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  const written: Array<Record<string, unknown>> = [];
  globalThis.fetch = (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/v1/oauth2/openbao" && !init?.method) {
      return Promise.resolve(Response.json({ attrs: { name: ["openbao"] } }));
    }
    if (path.endsWith("/_basic_secret")) {
      return Promise.resolve(Response.json("client-secret"));
    }
    return Promise.resolve(Response.json({}));
  };
  try {
    const result = await model.methods.ensure_oauth2_client.execute(args, {
      globalArgs: {
        baseUrl: "https://auth.example.com",
        apiToken: "api-token",
      },
      logger: { info: () => {} },
      writeResource: (_spec, name, value) => {
        assert(name === "openbao", "Expected a stable client resource name");
        written.push(value);
        return Promise.resolve({ name });
      },
    });
    assert(
      paths.includes("PATCH /v1/oauth2/openbao"),
      "Expected OAuth2 client update",
    );
    assert(
      paths.includes("POST /v1/oauth2/openbao/_scopemap/openbao-admins"),
      "Expected scope map update",
    );
    assert(
      written[0]?.clientSecret === "client-secret",
      "Expected client secret in the sensitive output resource",
    );
    assert(result.dataHandles.length === 1, "Expected one resource handle");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("ensure_oauth2_client reports Kanidm response detail without the API token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({ errors: ["client is locked"] }, { status: 403 }),
    );
  try {
    const error = await rejects(
      () =>
        model.methods.ensure_oauth2_client.execute(args, {
          globalArgs: {
            baseUrl: "https://auth.example.com",
            apiToken: "api-token-secret",
          },
          logger: { info: () => {} },
          writeResource: () => Promise.resolve({ name: "unused" }),
        }),
      "client is locked",
    );
    assert(
      !error.message.includes("api-token-secret"),
      "API token must not appear in errors",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
