import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { MongoClient } from "npm:mongodb@6.17.0";
import { ConfigSchema, pathsCollectionName } from "./config.ts";
import { getSidecar } from "./sidecar.ts";
import { createSyncService, type DatastoreSyncService } from "./sync.ts";

// Opt in with the test fixture password; never connect to a configured project
// database. Every run creates a unique database and removes only that database.
Deno.test({
  name:
    "MongoDB namespace/configuration synchronization with independent caches",
  ignore: !Deno.env.get("MONGO_PASSWORD"),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const cfg = ConfigSchema.parse({
      uri: Deno.env.get("MONGODB_URI") ??
        "mongodb://127.0.0.1:27027/?directConnection=true",
      username: Deno.env.get("MONGO_USERNAME") ?? "compat",
      database: `swamp_sync_test_${crypto.randomUUID().replaceAll("-", "")}`,
      namespace: "storage",
    });
    const client = new MongoClient(cfg.uri, {
      auth: {
        username: cfg.username,
        password: Deno.env.get("MONGO_PASSWORD")!,
      },
      authSource: "admin",
    });
    const temp = await Deno.makeTempDir({ prefix: "mongo-sync-test-" });
    const caches = [
      "a",
      "b",
      "foreign",
      "cold",
      "lazy",
      "mixed",
      "solo-lazy",
      "stale",
    ]
      .map((n) => `${temp}/${n}`);
    const [a, b, foreign, cold, lazy] = caches;
    const service = (cache: string) =>
      createSyncService(
        cfg,
        () => Promise.resolve({ client, repoDir: temp }),
        temp,
        cache,
      );
    const A = service(a), B = service(b), F = service(foreign);
    const paths = client.db(cfg.database).collection<
      { _id: string; updatedAt: Date; deletedAt: Date | null }
    >(pathsCollectionName(cfg));
    const context = {
      models: [{ modelType: "command/shell", modelId: "probe" }],
    };
    const dataRoot = "shared/data/command/shell/probe/result";
    async function write(
      sync: DatastoreSyncService,
      cache: string,
      path: string,
      text: string,
    ) {
      await sync.markDirty({ relPath: path });
      await Deno.mkdir(`${cache}/${path.slice(0, path.lastIndexOf("/"))}`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${cache}/${path}`, text);
    }
    async function missing(cache: string, path: string) {
      await assertRejects(
        () => Deno.stat(`${cache}/${path}`),
        Deno.errors.NotFound,
      );
    }
    try {
      await client.connect();
      await t.step(
        "namespace scoped pull refreshes the next writer and preserves both versions",
        async () => {
          await write(A, a, `${dataRoot}/1/raw`, "first");
          await write(A, a, `${dataRoot}/latest`, "1");
          await A.pushChanged({ namespace: "shared" });
          await B.pullChanged({ namespace: "shared", context });
          assertEquals(await Deno.readTextFile(`${b}/${dataRoot}/latest`), "1");
          await write(A, a, `${dataRoot}/2/raw`, "second");
          await write(A, a, `${dataRoot}/latest`, "2");
          await A.pushChanged({ namespace: "shared" });
          await B.pullChanged({ namespace: "shared", context });
          const next =
            Number(await Deno.readTextFile(`${b}/${dataRoot}/latest`)) + 1;
          assertEquals(next, 3);
          await write(B, b, `${dataRoot}/${next}/raw`, "third");
          await write(B, b, `${dataRoot}/latest`, String(next));
          await B.pushChanged({ namespace: "shared" });
          await A.pullChanged({ namespace: "shared", context });
          assertEquals(
            await Deno.readTextFile(`${a}/${dataRoot}/2/raw`),
            "second",
          );
          assertEquals(
            await Deno.readTextFile(`${a}/${dataRoot}/3/raw`),
            "third",
          );
          assertEquals(await Deno.readTextFile(`${a}/${dataRoot}/latest`), "3");
        },
      );
      await t.step(
        "same-millisecond changes remain visible at a scoped watermark",
        async () => {
          const fixed = new Date("2030-01-01T00:00:00.000Z");
          await paths.updateMany({ _id: { $regex: "^shared/data/" } }, {
            $set: { updatedAt: fixed },
          });
          await B.pullChanged({ namespace: "shared", context });
          await write(A, a, `${dataRoot}/latest`, "4");
          await A.pushChanged({ namespace: "shared" });
          await paths.updateOne({ _id: `${dataRoot}/latest` }, {
            $set: { updatedAt: fixed },
          });
          await B.pullChanged({ namespace: "shared", context });
          assertEquals(await Deno.readTextFile(`${b}/${dataRoot}/latest`), "4");
        },
      );
      await t.step(
        "selective config refresh includes model and pulled extension without hiding runtime data",
        async () => {
          const C = service(cold);
          await write(A, a, "shared/config/models/probe.yaml", "name: probe\n");
          await write(
            A,
            a,
            "shared/config/pulled-extensions/@test/probe/datastores/mod.ts",
            "export const version = 1;\n",
          );
          await A.pushChanged({ namespace: "shared" });
          await C.pullChanged({ namespace: "shared", subdirs: ["config"] });
          assertEquals(
            await Deno.readTextFile(`${cold}/shared/config/models/probe.yaml`),
            "name: probe\n",
          );
          assertEquals(
            await Deno.readTextFile(
              `${cold}/shared/config/pulled-extensions/@test/probe/datastores/mod.ts`,
            ),
            "export const version = 1;\n",
          );
          await missing(cold, `${dataRoot}/1/raw`);
          await C.pullChanged({ namespace: "shared", context });
          assertEquals(
            await Deno.readTextFile(`${cold}/${dataRoot}/1/raw`),
            "first",
          );
        },
      );
      await t.step(
        "namespace push and deletion preserve foreign data and pending dirty paths",
        async () => {
          await write(
            F,
            foreign,
            "other/config/models/foreign.yaml",
            "foreign",
          );
          await F.pushChanged({ namespace: "other" });
          await A.pullChanged({ namespace: "shared", subdirs: ["config"] });
          const path = "shared/config/models/probe.yaml";
          await A.markDirty({ relPath: path });
          await Deno.remove(`${a}/${path}`);
          await A.pushChanged({ namespace: "shared" });
          const C = service(cold);
          await C.pullChanged({ namespace: "shared", subdirs: ["config"] });
          await missing(cold, path);
          await missing(cold, "other/config/models/foreign.yaml");
          assertEquals(
            (await paths.findOne({ _id: "other/config/models/foreign.yaml" }))
              ?.deletedAt,
            null,
          );
          await write(
            A,
            a,
            "other/data/model/id/result/raw",
            "pending foreign",
          );
          await A.pushChanged({ namespace: "shared" });
          assertEquals(
            await paths.findOne({ _id: "other/data/model/id/result/raw" }),
            null,
          );
          await service(a).pushChanged({ namespace: "other" });
          assertEquals(
            (await paths.findOne({ _id: "other/data/model/id/result/raw" }))
              ?.deletedAt,
            null,
          );
        },
      );
      await t.step(
        "a namespace pull does not bootstrap its first push",
        async () => {
          const localPath = "new/config/models/local.yaml";
          await Deno.mkdir(`${a}/new/config/models`, { recursive: true });
          await Deno.writeTextFile(`${a}/${localPath}`, "preexisting local");
          const N = service(a);
          await N.pullChanged({ namespace: "new" });
          await N.pushChanged({ namespace: "new" });
          assertEquals(
            (await paths.findOne({ _id: localPath }))?.deletedAt,
            null,
          );
        },
      );
      await t.step(
        "lazy namespace hydration and secret/host-local exclusions",
        async () => {
          for (
            const path of [
              "shared/secrets/vault.key",
              "shared/data/_catalog.db",
              "shared/config/.env",
              "shared/data/.lock",
            ]
          ) {
            await write(A, a, path, "must stay local");
          }
          await A.pushChanged({ namespace: "shared" });
          assertEquals(
            await paths.countDocuments({
              _id: {
                $in: [
                  "shared/secrets/vault.key",
                  "shared/data/_catalog.db",
                  "shared/config/.env",
                  "shared/data/.lock",
                ],
              },
            }),
            0,
          );
          const L = service(lazy);
          await L.pullChanged({ namespace: "shared", metadataOnly: true });
          await missing(lazy, `${dataRoot}/1/raw`);
          assertEquals(await L.hydrateFile!(`${dataRoot}/1/raw`), true);
          assertEquals(
            await Deno.readTextFile(`${lazy}/${dataRoot}/1/raw`),
            "first",
          );
          assertEquals(await L.hydrateFile!("../escape"), false);
        },
      );
      await t.step(
        "bulk push in A preserves deletion of an entire foreign namespace B",
        async () => {
          const path = "removed/config/models/probe.yaml";
          const Removed = service(a);
          await write(Removed, a, path, "to be deleted");
          await Removed.pushChanged({ namespace: "removed" });
          await Removed.pullChanged({ namespace: "removed" });
          const Reader = service(cold);
          await Reader.pullChanged({ namespace: "removed" });
          assertEquals(
            await Deno.readTextFile(`${cold}/${path}`),
            "to be deleted",
          );
          await Deno.remove(`${a}/removed`, { recursive: true });
          await A.markDirty();
          await A.pushChanged({ namespace: "shared" });
          await Removed.pushChanged({ namespace: "removed" });
          await Reader.pullChanged({ namespace: "removed" });
          await missing(cold, path);
          assertEquals(
            (await paths.findOne({ _id: path }))?.deletedAt instanceof Date,
            true,
          );
        },
      );
      await t.step(
        "first push of unrelated model does not overwrite stale undirtied cached data",
        async () => {
          const path = "shared/data/command/shell/stale/result/raw";
          const deletedPath = "shared/data/command/shell/stale/deleted/raw";
          const context = {
            models: [{ modelType: "command/shell", modelId: "stale" }],
          };
          await write(A, a, path, "old");
          await write(A, a, deletedPath, "peer will delete");
          await A.pushChanged({ namespace: "shared" });
          const staleCache = caches[7];
          const stale = service(staleCache);
          await stale.pullChanged({ namespace: "shared", context });
          await paths.updateOne({ _id: deletedPath }, {
            $set: { deletedAt: new Date(), updatedAt: new Date() },
          });
          await write(A, a, path, "new peer value");
          await A.pushChanged({ namespace: "shared" });
          await write(
            stale,
            staleCache,
            "shared/data/command/shell/unrelated/result/raw",
            "new model",
          );
          await stale.pushChanged({ namespace: "shared" });
          await service(cold).pullChanged({ namespace: "shared", context });
          assertEquals(
            await Deno.readTextFile(`${cold}/${path}`),
            "new peer value",
          );
          assertEquals(
            (await paths.findOne({ _id: deletedPath }))?.deletedAt instanceof
              Date,
            true,
          );
        },
      );
      await t.step(
        "namespace named data still excludes its secrets tier",
        async () => {
          const S = service(a);
          await S.pullChanged({ namespace: "data" });
          await write(S, a, "data/secrets/vault.key", "host secret");
          await S.pushChanged({ namespace: "data" });
          await S.markDirty({ relPath: "data/secrets/vault.key" });
          await S.pushChanged({ namespace: "data" });
          assertEquals(
            await paths.findOne({ _id: "data/secrets/vault.key" }),
            null,
          );
          assertEquals(await S.hydrateFile!("data/secrets/vault.key"), false);
        },
      );
      await t.step(
        "mixed namespaces and solo/namespaced lazy hydration never tombstone skipped raw",
        async () => {
          await paths.updateMany({ _id: { $regex: "/raw$" } }, {
            $set: { updatedAt: new Date("2020-01-01T00:00:00.000Z") },
          });
          const mixed = caches[5];
          const shared = service(mixed);
          await shared.pullChanged({ namespace: "shared", metadataOnly: true });
          await shared.pushChanged({ namespace: "shared" });
          await service(mixed).pullChanged({ namespace: "other" });
          await shared.markDirty();
          await shared.pushChanged({ namespace: "shared" });
          assertEquals(
            (await paths.findOne({ _id: `${dataRoot}/1/raw` }))?.deletedAt,
            null,
          );
          const rootPush = service(mixed);
          await rootPush.markDirty();
          await rootPush.pushChanged();
          assertEquals(
            (await paths.findOne({ _id: `${dataRoot}/1/raw` }))?.deletedAt,
            null,
          );

          const soloCache = caches[6];
          await service(soloCache).pullChanged({ metadataOnly: true });
          const namespaced = service(soloCache);
          await namespaced.pushChanged({ namespace: "shared" });
          await namespaced.markDirty();
          await namespaced.pushChanged({ namespace: "shared" });
          assertEquals(
            (await paths.findOne({ _id: `${dataRoot}/1/raw` }))?.deletedAt,
            null,
          );
        },
      );
    } finally {
      await client.db(cfg.database).dropDatabase();
      await client.close();
      for (const cache of caches) await getSidecar(cache).close();
      await Deno.remove(temp, { recursive: true });
    }
  },
});
