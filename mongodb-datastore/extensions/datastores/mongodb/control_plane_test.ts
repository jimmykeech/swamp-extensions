import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { MongoClient } from "npm:mongodb@6.17.0";
import { ConfigSchema } from "./config.ts";
import { createControlPlaneStore } from "./control_plane.ts";

Deno.test("control-plane connection failures propagate", async () => {
  const cfg = ConfigSchema.parse({
    uri: "mongodb://unused.example.com",
    username: "unused",
    namespace: "test",
  });
  const store = createControlPlaneStore(cfg, () => {
    return Promise.reject(new Error("connection unavailable"));
  }, "/unused");
  await assertRejects(
    () => store.putIfAbsent("fire-records/run", new Uint8Array()),
    Error,
    "connection unavailable",
  );
});

// Opt in with MONGO_TEST_URI, MONGO_TEST_USERNAME and MONGO_PASSWORD.
// Uses and removes a new database; never touches an existing repository.
Deno.test({
  name: "remote control-plane coordination against MongoDB replica set",
  ignore: !Deno.env.get("MONGO_TEST_URI"),
  async fn(t) {
    const cfg = ConfigSchema.parse({
      uri: Deno.env.get("MONGO_TEST_URI"),
      username: Deno.env.get("MONGO_TEST_USERNAME"),
      database: `swamp_control_test_${crypto.randomUUID().replaceAll("-", "")}`,
      tenantId: "tenant-a",
      namespace: "repository-a",
    });
    const options = {
      auth: {
        username: cfg.username,
        password: Deno.env.get("MONGO_PASSWORD")!,
      },
      authSource: "admin",
    };
    const clients = [
      new MongoClient(cfg.uri, options),
      new MongoClient(cfg.uri, options),
    ];
    try {
      await Promise.all(clients.map((client) => client.connect()));
      const getClient = (index: number) => (repoDir: string) =>
        Promise.resolve({ client: clients[index], repoDir });
      const a = createControlPlaneStore(
        cfg,
        getClient(0),
        "/unused-a",
        "shared",
      );
      const b = createControlPlaneStore(
        cfg,
        getClient(1),
        "/unused-b",
        "shared",
      );
      const bytes = new Uint8Array([0, 255, 128, 1, 10]);

      await t.step("independent clients have one atomic winner", async () => {
        const attempts = await Promise.all(
          Array.from(
            { length: 24 },
            (_, index) =>
              (index % 2 ? a : b).putIfAbsent(
                "fire-records/run",
                new Uint8Array([index]),
              ),
          ),
        );
        assertEquals(attempts.filter(Boolean).length, 1);
        assertEquals(
          await a.get("fire-records/run"),
          new Uint8Array([attempts.indexOf(true)]),
        );
      });

      await t.step(
        "bytes overwrite, literal prefix list and delete",
        async () => {
          await a.put("heartbeats/a.+", bytes);
          await a.put("heartbeats/abc", new Uint8Array());
          assertEquals(await b.get("heartbeats/a.+"), bytes);
          assertEquals(await b.list("heartbeats/a.+"), ["heartbeats/a.+"]);
          assertEquals(await b.list("heartbeats/"), [
            "heartbeats/a.+",
            "heartbeats/abc",
          ]);
          await b.put("heartbeats/a.+", new Uint8Array([42]));
          assertEquals(await a.get("heartbeats/a.+"), new Uint8Array([42]));
          await b.delete("heartbeats/a.+");
          await b.delete("heartbeats/a.+");
          assertEquals(await a.get("heartbeats/a.+"), null);
        },
      );

      await t.step(
        "root, namespaces, repositories and tenants are isolated",
        async () => {
          const stores = [
            a,
            createControlPlaneStore(cfg, getClient(0), "/unused"),
            createControlPlaneStore(cfg, getClient(0), "/unused", ""),
            createControlPlaneStore(cfg, getClient(0), "/unused", "other"),
            createControlPlaneStore(
              { ...cfg, namespace: "repository-b" },
              getClient(0),
              "/unused",
              "shared",
            ),
            createControlPlaneStore(
              { ...cfg, tenantId: "tenant-b" },
              getClient(0),
              "/unused",
              "shared",
            ),
          ];
          for (const [index, store] of stores.entries()) {
            assertEquals(
              await store.putIfAbsent(
                "pending-runs/same",
                new Uint8Array([index]),
              ),
              true,
            );
            await store.put(`isolation/${index}`, bytes);
          }
          for (const [index, store] of stores.entries()) {
            assertEquals(
              await store.get("pending-runs/same"),
              new Uint8Array([index]),
            );
            assertEquals(await store.list("isolation/"), [
              `isolation/${index}`,
            ]);
          }
        },
      );
    } finally {
      try {
        await clients[0].db(cfg.database).dropDatabase();
      } finally {
        await Promise.all(clients.map((client) => client.close()));
      }
    }
  },
});
