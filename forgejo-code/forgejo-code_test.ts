/**
 * Unit tests for the @jamesakeech/forgejo-code extension.
 *
 * Every method talks to the Forgejo `/api/v1` surface via global `fetch`, so the
 * tests swap `globalThis.fetch` for a small URL router serving a canned repo
 * tree plus raw blobs. No live Forgejo instance or token is required.
 *
 * The extension exports `export const extension` whose `methods` is an array of
 * single-key objects, so the tests flatten it into a name → method lookup first.
 * Args are pushed through each method's own zod schema, mirroring what the
 * runtime does, so declared defaults are exercised rather than hand-copied.
 *
 * @module
 */
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_EXCLUDES,
  extension,
  globToRegExp,
  looksBinary,
  matchesAny,
} from "./forgejo-code.ts";

// deno-lint-ignore no-explicit-any
const methods: Record<string, any> = {};
// deno-lint-ignore no-explicit-any
for (const entry of extension.methods as any[]) Object.assign(methods, entry);

const HOST = "https://forge.test";
const GLOBAL = { host: HOST, token: "tok" };

/** Run `args` through the method's declared schema, as the runtime would. */
function parseArgs(method: string, args: Record<string, unknown>) {
  return methods[method].arguments.parse(args);
}

/**
 * The test context types written data as `unknown`; the assertions below index
 * into it, so narrow once here rather than casting at every call site.
 */
// deno-lint-ignore no-explicit-any
function dataOf(written: { data: unknown }): any {
  return written.data;
}

type Blob = { path: string; body: string | Uint8Array; status?: number };

type RouteResult = { status?: number; body?: unknown; raw?: Uint8Array };

/** Install a URL-routing fetch stub for the duration of `fn`. */
async function withFetch(
  router: (url: string, init?: RequestInit) => RouteResult,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body, raw } = router(url, init);
    if (raw !== undefined) {
      return Promise.resolve(
        new Response(raw as unknown as BodyInit, { status }),
      );
    }
    const payload = typeof body === "string" ? body : JSON.stringify(body ?? {});
    return Promise.resolve(
      new Response(payload, {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Build a tree response from blob specs, sized from their bodies. */
function treeBody(blobs: Blob[], extra: Record<string, unknown> = {}) {
  return {
    sha: "deadbeef",
    tree: blobs.map((b, i) => ({
      path: b.path,
      mode: "100644",
      type: "blob",
      size: typeof b.body === "string" ? b.body.length : b.body.length,
      sha: `sha${i}`,
    })),
    total_count: blobs.length,
    ...extra,
  };
}

/** Route trees and raw blobs for a fixed blob set. */
function repoRouter(blobs: Blob[], treeExtra: Record<string, unknown> = {}) {
  return (url: string): RouteResult => {
    if (url.includes("/git/trees/")) return { body: treeBody(blobs, treeExtra) };
    const match = url.match(/\/raw\/(.+?)\?/);
    if (match) {
      const path = decodeURIComponent(
        match[1].split("/").map(decodeURIComponent).join("/"),
      );
      const blob = blobs.find((b) => b.path === path);
      if (!blob) return { status: 404, body: { message: "not found" } };
      if (blob.status && blob.status !== 200) {
        return { status: blob.status, body: { message: "boom" } };
      }
      const raw = typeof blob.body === "string"
        ? new TextEncoder().encode(blob.body)
        : blob.body;
      return { raw };
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };
}

const IAC_BLOBS: Blob[] = [
  { path: "main.tf", body: 'resource "x" "y" {}\n' },
  { path: "variables.tf", body: 'variable "v" { type = string }\n' },
  { path: "README.md", body: "# repo\n" },
  { path: "state/terraform.tfstate", body: '{"version":4}\n' },
  { path: "docs/logo.png", body: "PNGDATA" },
];

// ── Pure helpers ──────────────────────────────────────────────────────────────

Deno.test("globToRegExp: * does not cross a path separator", () => {
  const re = globToRegExp("*.tf");
  assert(re.test("main.tf"));
  assert(!re.test("modules/main.tf"));
});

Deno.test("globToRegExp: ** crosses path separators", () => {
  const re = globToRegExp("**/*.tf");
  assert(re.test("main.tf"), "**/ must also match zero directories");
  assert(re.test("modules/proxmox-vm/main.tf"));
  assert(!re.test("main.tfvars"));
});

Deno.test("globToRegExp: bare ** matches everything", () => {
  const re = globToRegExp("**");
  assert(re.test("a"));
  assert(re.test("a/b/c.yml"));
});

Deno.test("globToRegExp: ? matches one non-separator char", () => {
  const re = globToRegExp("v?.tf");
  assert(re.test("v1.tf"));
  assert(!re.test("v12.tf"));
  assert(!re.test("v/.tf"));
});

Deno.test("globToRegExp: regex metacharacters are escaped, not interpreted", () => {
  // A literal dot must not match an arbitrary character.
  assert(!globToRegExp("*.tf").test("mainXtf"));
  assert(globToRegExp("a+b(c).yml").test("a+b(c).yml"));
});

Deno.test("globToRegExp: patterns are anchored at both ends", () => {
  const re = globToRegExp("main.tf");
  assert(re.test("main.tf"));
  assert(!re.test("x-main.tf"));
  assert(!re.test("main.tf.bak"));
});

Deno.test("matchesAny: true when any pattern matches", () => {
  assert(matchesAny("a/b.yml", ["**/*.tf", "**/*.yml"]));
  assert(!matchesAny("a/b.json", ["**/*.tf", "**/*.yml"]));
  assert(!matchesAny("a/b.yml", []));
});

Deno.test("DEFAULT_EXCLUDES: catches state and binaries, spares source", () => {
  for (const path of [
    "state/terraform.tfstate",
    "state/terraform.tfstate.backup",
    "docs/logo.png",
    "node_modules/pkg/index.js",
    ".git/config",
    "deno.lock",
    "package-lock.json",
    ".terraform/plugin.bin",
  ]) {
    assert(matchesAny(path, DEFAULT_EXCLUDES), `expected excluded: ${path}`);
  }
  for (const path of [
    "main.tf",
    "modules/proxmox-vm/variables.tf",
    "docker-compose.yml",
    "roles/app/templates/config.j2",
    "README.md",
  ]) {
    assert(!matchesAny(path, DEFAULT_EXCLUDES), `expected kept: ${path}`);
  }
});

Deno.test("looksBinary: NUL byte marks binary, plain text does not", () => {
  assert(looksBinary(new Uint8Array([0x41, 0x00, 0x42])));
  assert(!looksBinary(new TextEncoder().encode("resource \"x\" {}\n")));
  assert(!looksBinary(new Uint8Array()));
});

Deno.test("looksBinary: only scans the first 8KiB", () => {
  const bytes = new Uint8Array(9000);
  bytes.fill(0x41);
  bytes[8500] = 0x00; // beyond the scan window
  assert(!looksBinary(bytes));
  bytes[10] = 0x00;
  assert(looksBinary(bytes));
});

// ── list_tree ─────────────────────────────────────────────────────────────────

Deno.test("list_tree: writes a prefixed tree snapshot with counts", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const blobs = IAC_BLOBS;
  await withFetch(
    (url) => {
      if (url.includes("/git/trees/")) {
        const body = treeBody(blobs);
        body.tree.push({
          path: "modules",
          mode: "040000",
          type: "tree",
          size: 0,
          sha: "dirsha",
        });
        return { body };
      }
      throw new Error(`unexpected URL: ${url}`);
    },
    async () => {
      await methods.list_tree.execute(
        parseArgs("list_tree", { owner: "o", repo: "r" }),
        context,
      );
    },
  );
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "tree");
  // Prefixed so it cannot overwrite the base type's `repo`/`issues` snapshots.
  assertEquals(written[0].name, "tree__o__r");
  assertEquals(dataOf(written[0]).fileCount, 5);
  assertEquals(dataOf(written[0]).dirCount, 1);
  assertEquals(dataOf(written[0]).sha, "deadbeef");
  assertEquals(dataOf(written[0]).truncated, false);
  assertEquals(
    dataOf(written[0]).totalBytes,
    IAC_BLOBS.reduce((n, b) => n + (b.body as string).length, 0),
  );
});

Deno.test("list_tree: defaults ref to HEAD and sends token auth", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  let seenUrl = "";
  let seenAuth = "";
  await withFetch((url, init) => {
    seenUrl = url;
    seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    return { body: treeBody([]) };
  }, async () => {
    await methods.list_tree.execute(
      parseArgs("list_tree", { owner: "o", repo: "r" }),
      context,
    );
  });
  assertStringIncludes(seenUrl, `${HOST}/api/v1/repos/o/r/git/trees/HEAD`);
  assertStringIncludes(seenUrl, "recursive=1");
  assertEquals(seenAuth, "token tok");
});

Deno.test("list_tree: paginates until a short page arrives", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  let pages = 0;
  await withFetch((url) => {
    pages++;
    const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? "1");
    // Two full pages of 1000, then a short third page ends pagination.
    const count = page <= 2 ? 1000 : 7;
    return {
      body: {
        sha: "deadbeef",
        tree: Array.from({ length: count }, (_, i) => ({
          path: `p${page}/f${i}.tf`,
          mode: "100644",
          type: "blob",
          size: 1,
          sha: `s${page}-${i}`,
        })),
        total_count: 2007,
      },
    };
  }, async () => {
    await methods.list_tree.execute(
      parseArgs("list_tree", { owner: "o", repo: "r", max_entries: 20000 }),
      context,
    );
  });
  assertEquals(pages, 3);
  assertEquals(dataOf(getWrittenResources()[0]).fileCount, 2007);
});

Deno.test("list_tree: stops at total_count without an extra request", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  let pages = 0;
  await withFetch(() => {
    pages++;
    return {
      body: {
        sha: "deadbeef",
        tree: Array.from({ length: 1000 }, (_, i) => ({
          path: `f${i}.tf`,
          mode: "100644",
          type: "blob",
          size: 1,
          sha: `s${i}`,
        })),
        total_count: 1000,
      },
    };
  }, async () => {
    await methods.list_tree.execute(
      parseArgs("list_tree", { owner: "o", repo: "r" }),
      context,
    );
  });
  assertEquals(pages, 1);
});

Deno.test("list_tree: max_entries caps entries and flags truncation", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({
    body: {
      sha: "deadbeef",
      tree: Array.from({ length: 1000 }, (_, i) => ({
        path: `f${i}.tf`,
        mode: "100644",
        type: "blob",
        size: 1,
        sha: `s${i}`,
      })),
      total_count: 5000,
    },
  }), async () => {
    await methods.list_tree.execute(
      parseArgs("list_tree", { owner: "o", repo: "r", max_entries: 10 }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.entries.length, 10);
  assertEquals(data.truncated, true);
});

Deno.test("list_tree: propagates upstream truncated flag", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(
    repoRouter(IAC_BLOBS, { truncated: true }),
    async () => {
      await methods.list_tree.execute(
        parseArgs("list_tree", { owner: "o", repo: "r" }),
        context,
      );
    },
  );
  assertEquals(dataOf(getWrittenResources()[0]).truncated, true);
});

Deno.test("list_tree: tolerates a null tree on an empty repo", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(() => ({ body: { sha: "empty", tree: null } }), async () => {
    await methods.list_tree.execute(
      parseArgs("list_tree", { owner: "o", repo: "r" }),
      context,
    );
  });
  assertEquals(dataOf(getWrittenResources()[0]).fileCount, 0);
});

Deno.test("list_tree: throws with status and body on API error", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  await withFetch(() => ({ status: 500, body: "upstream exploded" }), async () => {
    const err = await assertRejects(() =>
      methods.list_tree.execute(
        parseArgs("list_tree", { owner: "o", repo: "r" }),
        context,
      )
    );
    assertStringIncludes((err as Error).message, "500");
    assertStringIncludes((err as Error).message, "upstream exploded");
  });
});

// ── get_file ──────────────────────────────────────────────────────────────────

Deno.test("get_file: reads content into a slugged instance name", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(repoRouter(IAC_BLOBS), async () => {
    await methods.get_file.execute(
      parseArgs("get_file", { owner: "o", repo: "r", path: "main.tf" }),
      context,
    );
  });
  const written = getWrittenResources();
  assertEquals(written[0].specName, "file");
  assertEquals(written[0].name, "file__o__r__main.tf");
  assertEquals(dataOf(written[0]).content, 'resource "x" "y" {}\n');
  assertEquals(dataOf(written[0]).size, 20);
  assertEquals(dataOf(written[0]).truncated, false);
  assertEquals(dataOf(written[0]).ref, "HEAD");
});

Deno.test("get_file: slug flattens separators in nested paths", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const blobs = [{ path: "modules/proxmox-vm/main.tf", body: "x\n" }];
  await withFetch(repoRouter(blobs), async () => {
    await methods.get_file.execute(
      parseArgs("get_file", {
        owner: "o",
        repo: "r",
        path: "modules/proxmox-vm/main.tf",
      }),
      context,
    );
  });
  assertEquals(
    getWrittenResources()[0].name,
    "file__o__r__modules_proxmox-vm_main.tf",
  );
});

Deno.test("get_file: truncates at max_bytes and flags it", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const blobs = [{ path: "big.tf", body: "abcdefghij" }];
  await withFetch(repoRouter(blobs), async () => {
    await methods.get_file.execute(
      parseArgs("get_file", {
        owner: "o",
        repo: "r",
        path: "big.tf",
        max_bytes: 4,
      }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.content, "abcd");
  assertEquals(data.truncated, true);
  assertEquals(data.size, 10, "size reports the real blob length, not the slice");
});

Deno.test("get_file: percent-encodes path segments but keeps separators", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  let seenUrl = "";
  await withFetch((url) => {
    seenUrl = url;
    return { raw: new TextEncoder().encode("x") };
  }, async () => {
    await methods.get_file.execute(
      parseArgs("get_file", {
        owner: "o",
        repo: "r",
        path: "dir/a file.tf",
        ref: "feature/branch",
      }),
      context,
    );
  });
  assertStringIncludes(seenUrl, "/raw/dir/a%20file.tf");
  assertStringIncludes(seenUrl, "ref=feature%2Fbranch");
});

Deno.test("get_file: throws a clear error when the file is absent", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  await withFetch(repoRouter(IAC_BLOBS), async () => {
    const err = await assertRejects(() =>
      methods.get_file.execute(
        parseArgs("get_file", { owner: "o", repo: "r", path: "nope.tf" }),
        context,
      )
    );
    assertStringIncludes((err as Error).message, "File not found");
    assertStringIncludes((err as Error).message, "nope.tf");
  });
});

// ── snapshot_code ─────────────────────────────────────────────────────────────

Deno.test("snapshot_code: reads text files, excludes state and binaries by default", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(repoRouter(IAC_BLOBS), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", { owner: "o", repo: "r" }),
      context,
    );
  });
  const written = getWrittenResources();
  assertEquals(written[0].specName, "codebase");
  assertEquals(written[0].name, "code__o__r");
  const data = dataOf(written[0]);
  // Output is sorted by path so the snapshot reads like the repo.
  assertEquals(data.files.map((f: { path: string }) => f.path), [
    "README.md",
    "main.tf",
    "variables.tf",
  ]);
  assertEquals(data.fileCount, 3);
  assertEquals(data.truncated, false);
  const reasons = Object.fromEntries(
    data.skipped.map((s: { path: string; reason: string }) => [s.path, s.reason]),
  );
  assertEquals(reasons["state/terraform.tfstate"], "excluded");
  assertEquals(reasons["docs/logo.png"], "excluded");
  assertEquals(data.totalBytes, 20 + 31 + 7);
});

Deno.test("snapshot_code: include filter marks the rest not_included", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(repoRouter(IAC_BLOBS), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", {
        owner: "o",
        repo: "r",
        include: ["**/*.tf"],
      }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.files.map((f: { path: string }) => f.path), [
    "main.tf",
    "variables.tf",
  ]);
  const reasons = Object.fromEntries(
    data.skipped.map((s: { path: string; reason: string }) => [s.path, s.reason]),
  );
  assertEquals(reasons["README.md"], "not_included");
});

Deno.test("snapshot_code: no_default_excludes lets state files through", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(repoRouter(IAC_BLOBS), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", {
        owner: "o",
        repo: "r",
        include: ["**/*.tfstate"],
        no_default_excludes: true,
      }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.files.map((f: { path: string }) => f.path), [
    "state/terraform.tfstate",
  ]);
});

Deno.test("snapshot_code: caller excludes stack on top of the defaults", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(repoRouter(IAC_BLOBS), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", {
        owner: "o",
        repo: "r",
        exclude: ["**/*.md"],
      }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.files.map((f: { path: string }) => f.path), [
    "main.tf",
    "variables.tf",
  ]);
});

Deno.test("snapshot_code: skips blobs that turn out to be binary", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  // A .tf extension the exclude list can't catch, but with NUL bytes inside.
  const blobs: Blob[] = [
    { path: "ok.tf", body: "fine\n" },
    { path: "sneaky.tf", body: new Uint8Array([0x41, 0x00, 0x42]) },
  ];
  await withFetch(repoRouter(blobs), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", { owner: "o", repo: "r" }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.files.map((f: { path: string }) => f.path), ["ok.tf"]);
  assertEquals(data.skipped[0].path, "sneaky.tf");
  assertEquals(data.skipped[0].reason, "binary");
});

Deno.test("snapshot_code: oversized blobs are skipped before any fetch", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const fetched: string[] = [];
  const blobs: Blob[] = [
    { path: "small.tf", body: "x" },
    { path: "huge.tf", body: "y".repeat(500) },
  ];
  const route = repoRouter(blobs);
  await withFetch((url) => {
    if (url.includes("/raw/")) fetched.push(url);
    return route(url);
  }, async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", {
        owner: "o",
        repo: "r",
        max_file_bytes: 10, // 4x cap = 40, so the 500-byte blob is skipped
      }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.files.map((f: { path: string }) => f.path), ["small.tf"]);
  assertEquals(data.skipped[0].reason, "too_large");
  assertEquals(fetched.length, 1, "the oversized blob must not be requested");
});

Deno.test("snapshot_code: max_files keeps the smallest and reports over_budget", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const blobs: Blob[] = [
    { path: "big.tf", body: "x".repeat(30) },
    { path: "tiny.tf", body: "x" },
    { path: "mid.tf", body: "x".repeat(10) },
  ];
  await withFetch(repoRouter(blobs), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", { owner: "o", repo: "r", max_files: 2 }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  // Smallest-first selection: more files beats fewer large ones.
  assertEquals(data.files.map((f: { path: string }) => f.path), [
    "mid.tf",
    "tiny.tf",
  ]);
  assertEquals(data.skippedCount, 1);
  assertEquals(data.skipped[0].path, "big.tf");
  assertEquals(data.skipped[0].reason, "over_budget");
});

Deno.test("snapshot_code: max_total_bytes stops the run and flags truncation", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const blobs: Blob[] = [
    { path: "a.tf", body: "x".repeat(10) },
    { path: "b.tf", body: "x".repeat(10) },
    { path: "c.tf", body: "x".repeat(10) },
  ];
  await withFetch(repoRouter(blobs), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", {
        owner: "o",
        repo: "r",
        max_total_bytes: 25,
        concurrency: 1,
      }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.fileCount, 2);
  assert(data.totalBytes <= 25, "budget must never be exceeded");
  assertEquals(data.truncated, true);
  assert(
    data.skipped.some((s: { reason: string }) => s.reason === "over_budget"),
  );
});

Deno.test("snapshot_code: truncates individual files at max_file_bytes", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const blobs: Blob[] = [{ path: "a.tf", body: "abcdefghij" }];
  await withFetch(repoRouter(blobs), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", {
        owner: "o",
        repo: "r",
        max_file_bytes: 4,
      }),
      context,
    );
  });
  const file = dataOf(getWrittenResources()[0]).files[0];
  assertEquals(file.content, "abcd");
  assertEquals(file.truncated, true);
  assertEquals(file.size, 10);
});

Deno.test("snapshot_code: a file that vanishes mid-run is skipped, not fatal", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  // In the tree, but 404 on the raw fetch — the race the method must absorb.
  const blobs: Blob[] = [
    { path: "kept.tf", body: "x\n" },
    { path: "gone.tf", body: "y\n", status: 404 },
  ];
  await withFetch(repoRouter(blobs), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", { owner: "o", repo: "r" }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.files.map((f: { path: string }) => f.path), ["kept.tf"]);
  assertEquals(data.skipped[0].path, "gone.tf");
  assertEquals(data.skipped[0].reason, "missing");
});

Deno.test("snapshot_code: a non-404 blob error fails the run", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  const blobs: Blob[] = [{ path: "a.tf", body: "x", status: 503 }];
  await withFetch(repoRouter(blobs), async () => {
    const err = await assertRejects(() =>
      methods.snapshot_code.execute(
        parseArgs("snapshot_code", { owner: "o", repo: "r" }),
        context,
      )
    );
    assertStringIncludes((err as Error).message, "503");
  });
});

Deno.test("snapshot_code: carries the ref through to every blob fetch", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL });
  const urls: string[] = [];
  const route = repoRouter([{ path: "a.tf", body: "x" }]);
  await withFetch((url) => {
    urls.push(url);
    return route(url);
  }, async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", { owner: "o", repo: "r", ref: "v1.2.3" }),
      context,
    );
  });
  assert(urls.some((u) => u.includes("/git/trees/v1.2.3")));
  assert(urls.some((u) => u.includes("/raw/a.tf?ref=v1.2.3")));
});

Deno.test("snapshot_code: an empty repo yields an empty snapshot, not an error", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  await withFetch(repoRouter([]), async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", { owner: "o", repo: "r" }),
      context,
    );
  });
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.fileCount, 0);
  assertEquals(data.skippedCount, 0);
  assertEquals(data.truncated, false);
});

Deno.test("snapshot_code: concurrent workers read every selected file exactly once", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL,
  });
  const blobs: Blob[] = Array.from({ length: 25 }, (_, i) => ({
    path: `f${String(i).padStart(2, "0")}.tf`,
    body: `content ${i}\n`,
  }));
  const seen: string[] = [];
  const route = repoRouter(blobs);
  await withFetch((url) => {
    if (url.includes("/raw/")) seen.push(url);
    return route(url);
  }, async () => {
    await methods.snapshot_code.execute(
      parseArgs("snapshot_code", { owner: "o", repo: "r", concurrency: 8 }),
      context,
    );
  });
  assertEquals(seen.length, 25);
  assertEquals(new Set(seen).size, 25, "no file fetched twice");
  const data = dataOf(getWrittenResources()[0]);
  assertEquals(data.fileCount, 25);
  // Sorted output despite out-of-order concurrent completion.
  assertEquals(data.files[0].path, "f00.tf");
  assertEquals(data.files[24].path, "f24.tf");
});
