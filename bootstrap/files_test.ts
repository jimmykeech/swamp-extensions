import { strict as assert } from "node:assert";
import * as path from "node:path";
import {
  canonical,
  readProjectText,
  resolveWorkspace,
  sha256,
  sourceDigest,
} from "./files.ts";

async function fixture(test: (root: string) => Promise<void>): Promise<void> {
  // macOS commonly places temporary directories under the /var -> /private/var symlink.
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "bootstrap-files-" }),
  );
  try {
    await test(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("canonical snapshots sort object keys and hash exact content", async () => {
  assert.equal(
    canonical({ b: [{ z: 2, a: 1 }], a: true }),
    '{"a":true,"b":[{"a":1,"z":2}]}',
  );
  assert.equal(
    await sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.throws(() => canonical({ unsupported: undefined }));
});

Deno.test("project readers reject escapes, private paths, symlinks, and oversized text", async () => {
  await fixture(async (root) => {
    await Deno.mkdir(path.join(root, "docs"));
    await Deno.writeTextFile(
      path.join(root, "docs", "guide.md"),
      "project context",
    );
    await Deno.symlink(path.join(root, "docs"), path.join(root, "linked"));
    await Deno.symlink(
      path.join(root, "docs", "guide.md"),
      path.join(root, "guide.md"),
    );
    assert.equal(
      await readProjectText(root, "docs/guide.md"),
      "project context",
    );
    for (
      const candidate of [
        "../guide.md",
        "/etc/passwd",
        "docs/../guide.md",
        "docs\\guide.md",
        "C:/Windows/file",
        ".env",
        ".env.local",
        ".swamp.yaml",
        ".git/config",
        "vaults/value",
        "node_modules/a",
        "linked/guide.md",
        "guide.md",
        "docs",
      ]
    ) {
      await assert.rejects(() => readProjectText(root, candidate));
    }
    await assert.rejects(() => resolveWorkspace(root, "linked"));
    await assert.rejects(() =>
      resolveWorkspace(path.join(root, "linked"), ".")
    );
    await Deno.writeTextFile(
      path.join(root, "huge.md"),
      "a".repeat(1024 * 1024 + 1),
    );
    await assert.rejects(() => readProjectText(root, "huge.md"), /byte limit/);
  });
});

Deno.test("source snapshots detect additions, deletion, rename, and binary edits", async () => {
  await fixture(async (root) => {
    await Deno.mkdir(path.join(root, "src"));
    await Deno.writeFile(
      path.join(root, "src", "a.bin"),
      new Uint8Array([0, 1, 255]),
    );
    const workspace = await resolveWorkspace(root, ".");
    const first = await sourceDigest(root, workspace, ["src"]);
    assert.equal(first.fileCount, 1);
    assert.deepEqual(
      await sourceDigest(root, ".", ["src/a.bin", "src"]),
      first,
    );
    await Deno.writeTextFile(path.join(root, "src", "b.txt"), "new");
    const added = await sourceDigest(root, workspace, ["src"]);
    assert.equal(added.fileCount, 2);
    assert.notEqual(added.sourceDigest, first.sourceDigest);
    await Deno.remove(path.join(root, "src", "b.txt"));
    assert.deepEqual(await sourceDigest(root, workspace, ["src"]), first);
    await Deno.rename(
      path.join(root, "src", "a.bin"),
      path.join(root, "src", "renamed.bin"),
    );
    const renamed = await sourceDigest(root, workspace, ["src"]);
    assert.notEqual(renamed.sourceDigest, first.sourceDigest);
    await Deno.writeFile(
      path.join(root, "src", "renamed.bin"),
      new Uint8Array([0, 2, 255]),
    );
    assert.notEqual(
      (await sourceDigest(root, workspace, ["src"])).sourceDigest,
      renamed.sourceDigest,
    );
    await assert.rejects(() => sourceDigest(root, workspace, ["."]));
    await assert.rejects(() => sourceDigest(root, workspace, ["missing"]));
    await Deno.writeTextFile(path.join(root, "src", ".env.local"), "private");
    await assert.rejects(
      () => sourceDigest(root, workspace, ["src"]),
      /disallowed/,
    );
  });
});
