import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Sidecar } from "./sidecar.ts";

async function withCache(
  test: (cache: string, sidecar: Sidecar) => Promise<void>,
) {
  const cache = await Deno.makeTempDir({ prefix: "mongo-dirty-retirement-" });
  const sidecar = new Sidecar(cache);
  try {
    await sidecar.clearDirty();
    await test(cache, sidecar);
  } finally {
    await sidecar.close();
    await Deno.remove(cache, { recursive: true });
  }
}

Deno.test("push retirement preserves foreign paths and repeated/new marks after snapshot", async () => {
  await withCache(async (cache, sidecar) => {
    await sidecar.recordDirty("a/data/repeated");
    await sidecar.recordDirty("a/data/completed");
    await sidecar.recordDirty("b/data/pending");
    const observed = await sidecar.beginPush();
    // Both exact duplicates and descendants are ordinarily deduplicated.
    await sidecar.recordDirty("a/data/repeated");
    await sidecar.recordDirty("a/data/repeated/version-2");
    await sidecar.recordDirty("a/data/new");
    await sidecar.retirePush(observed, (path) => path.startsWith("a/"));
    const expected = ["a/data/new", "a/data/repeated", "b/data/pending"];
    assertEquals((await sidecar.read()).dirtyPaths, expected);
    assertEquals((await new Sidecar(cache).read()).dirtyPaths, expected);
    // A later successful push can retire the retained marks normally.
    await sidecar.retirePush(
      await sidecar.beginPush(),
      (path) => path.startsWith("a/"),
    );
    assertEquals((await sidecar.read()).dirtyPaths, ["b/data/pending"]);
  });
});

Deno.test("push retirement preserves a new bulk signal and foreign full-walk obligations", async () => {
  await withCache(async (cache, sidecar) => {
    await sidecar.recordDirty(undefined);
    const observed = await sidecar.beginPush();
    await sidecar.recordDirty(undefined);
    await sidecar.retirePush(observed, (path) => path.startsWith("a/"), [
      "b/data",
    ]);
    const state = await new Sidecar(cache).read();
    assertEquals(state.bulkInvalidated, true);
    assertEquals(state.dirtyPaths, ["b/data"]);
    // With no newer bulk mark, completion clears only the observed signal.
    await sidecar.retirePush(
      await sidecar.beginPush(),
      (path) => path.startsWith("a/"),
      ["b/data"],
    );
    const completed = await new Sidecar(cache).read();
    assertEquals(completed.bulkInvalidated, false);
    assertEquals(completed.dirtyPaths, ["b/data"]);
  });
});

Deno.test("interrupted journal replacement leaves all pending work durable", async () => {
  await withCache(async (cache, sidecar) => {
    await sidecar.recordDirty("a/data/completed");
    await sidecar.recordDirty("b/data/pending");
    const observed = await sidecar.beginPush();
    const originalRename = Deno.rename;
    let retainedJournal = "";
    Deno.rename = async (oldPath, newPath) => {
      if (newPath === `${cache}/.datastore-dirty.log`) {
        retainedJournal = await Deno.readTextFile(oldPath);
        throw new Error("interrupted before atomic journal replacement");
      }
      return await originalRename(oldPath, newPath);
    };
    try {
      await assertRejects(
        () => sidecar.retirePush(observed, (path) => path.startsWith("a/")),
        Error,
        "interrupted before atomic journal replacement",
      );
    } finally {
      Deno.rename = originalRename;
    }
    // The replacement itself already contains foreign work. There is never
    // an empty-journal intermediate state followed by separate appends.
    assertEquals(retainedJournal, "b/data/pending\n");
    assertEquals((await new Sidecar(cache).read()).dirtyPaths, [
      "a/data/completed",
      "b/data/pending",
    ]);
    await sidecar.retirePush(observed, (path) => path.startsWith("a/"));
    assertEquals((await new Sidecar(cache).read()).dirtyPaths, [
      "b/data/pending",
    ]);
  });
});
