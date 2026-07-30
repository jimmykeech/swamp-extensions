import { z } from "npm:zod@4";

// Extends @shrug/forgejo (metadata-only: repos/issues/pulls/releases) with the
// missing piece — reading the actual contents of a repository. `list_tree` maps
// a repo, `get_file` pulls one file, and `snapshot_code` fans out over the whole
// tree in a single method run so a review pass has every file in one snapshot.

// ── API helpers ───────────────────────────────────────────────────────────────

function apiUrl(host: string, path: string): string {
  return `${host.replace(/\/$/, "")}/api/v1${path}`;
}

/** Authenticated GET returning parsed JSON. Throws with status + body on non-2xx. */
async function apiGetJson(
  host: string,
  token: string,
  path: string,
): Promise<unknown> {
  const resp = await fetch(apiUrl(host, path), {
    headers: { Authorization: `token ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(
      `Forgejo API error ${resp.status} on GET ${path}: ${await resp.text()}`,
    );
  }
  return resp.json();
}

/**
 * Authenticated GET of raw bytes. Returns null on 404 (path vanished between
 * tree read and fetch) so a fan-out run degrades instead of aborting.
 */
async function apiGetRaw(
  host: string,
  token: string,
  path: string,
): Promise<Uint8Array | null> {
  const resp = await fetch(apiUrl(host, path), {
    headers: { Authorization: `token ${token}` },
  });
  if (resp.status === 404) {
    await resp.body?.cancel();
    return null;
  }
  if (!resp.ok) {
    throw new Error(
      `Forgejo API error ${resp.status} on GET ${path}: ${await resp.text()}`,
    );
  }
  return new Uint8Array(await resp.arrayBuffer());
}

/** Percent-encode a repo-relative file path, preserving `/` separators. */
function encodePath(filepath: string): string {
  return filepath.split("/").map(encodeURIComponent).join("/");
}

// ── Path filtering (pure) ─────────────────────────────────────────────────────

/**
 * Translate a glob to an anchored RegExp. `**` crosses `/`, `*` and `?` do not.
 * Dependency-free by design — see repo rule 7 on bundled npm deps.
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` also matches zero directories
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when `path` matches any glob in `patterns`. */
export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

/** Paths excluded by default: VCS internals, vendored trees, lockfiles, binaries. */
export const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/.terraform/**",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/*.lock",
  "**/*-lock.json",
  "**/*.lockb",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.svg",
  "**/*.ico",
  "**/*.webp",
  "**/*.pdf",
  "**/*.zip",
  "**/*.gz",
  "**/*.tar",
  "**/*.tgz",
  "**/*.bz2",
  "**/*.xz",
  "**/*.7z",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.otf",
  "**/*.eot",
  "**/*.so",
  "**/*.dylib",
  "**/*.dll",
  "**/*.wasm",
  "**/*.bin",
  "**/*.iso",
  "**/*.img",
  "**/*.qcow2",
  "**/*.mp4",
  "**/*.mp3",
  "**/*.jar",
  "**/*.class",
  "**/*.pyc",
];

/** A NUL byte in the first 8KB is the usual binary tell — skip such blobs. */
export function looksBinary(bytes: Uint8Array): boolean {
  const window = Math.min(bytes.length, 8192);
  for (let i = 0; i < window; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

/** One entry in a recursive git tree listing. */
const TreeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  size: z.number().optional(),
  sha: z.string(),
});

/** Raw shape of Forgejo's `/git/trees/{sha}` response. */
const TreeResponseSchema = z.object({
  sha: z.string(),
  tree: z.array(TreeEntrySchema).nullable().default([]),
  truncated: z.boolean().optional(),
  total_count: z.number().optional(),
});

/** A file whose contents were read into the snapshot. */
const CodeFileSchema = z.object({
  path: z.string(),
  sha: z.string(),
  size: z.number(),
  content: z.string(),
  truncated: z.boolean(),
});

/**
 * A file present in the tree but deliberately not read.
 *
 * `too_large` is a property of the file itself; `over_budget` means the file was
 * fine but the run had already spent its `max_files` / `max_total_bytes` budget.
 * Keeping them distinct tells a caller whether to raise a cap or accept the gap.
 */
const SkippedFileSchema = z.object({
  path: z.string(),
  size: z.number(),
  reason: z.enum([
    "excluded",
    "not_included",
    "too_large",
    "over_budget",
    "binary",
    "missing",
  ]),
});

// ── Method arguments ──────────────────────────────────────────────────────────

const RepoRef = {
  owner: z.string().describe("Repository owner (user or org login)."),
  repo: z.string().describe("Repository name."),
};

const ListTreeArgs = z.object({
  ...RepoRef,
  ref: z.string().default("HEAD").describe(
    "Branch, tag, or commit SHA to read. Defaults to HEAD (the default branch).",
  ),
  max_entries: z.number().int().positive().max(20000).default(5000).describe(
    "Stop paginating after this many tree entries.",
  ),
});

const GetFileArgs = z.object({
  ...RepoRef,
  path: z.string().describe("Repo-relative file path, e.g. terraform/main.tf."),
  ref: z.string().default("HEAD").describe("Branch, tag, or commit SHA."),
  max_bytes: z.number().int().positive().max(2_000_000).default(500_000)
    .describe("Truncate the file after this many bytes."),
});

const SnapshotCodeArgs = z.object({
  ...RepoRef,
  ref: z.string().default("HEAD").describe("Branch, tag, or commit SHA."),
  include: z.array(z.string()).default(["**"]).describe(
    "Glob patterns to include (matched against repo-relative paths).",
  ),
  exclude: z.array(z.string()).default([]).describe(
    "Extra glob patterns to exclude, on top of the built-in binary/vendor list.",
  ),
  no_default_excludes: z.boolean().default(false).describe(
    "Disable the built-in exclude list (binaries, node_modules, lockfiles, …).",
  ),
  max_files: z.number().int().positive().max(2000).default(400).describe(
    "Read at most this many files.",
  ),
  max_file_bytes: z.number().int().positive().max(1_000_000).default(131_072)
    .describe("Truncate any single file after this many bytes."),
  max_total_bytes: z.number().int().positive().max(20_000_000).default(
    4_000_000,
  )
    .describe("Stop reading once total content reaches this many bytes."),
  concurrency: z.number().int().positive().max(16).default(6).describe(
    "Parallel file fetches.",
  ),
});

// ── Runtime context ───────────────────────────────────────────────────────────

type Context = {
  globalArgs: { host: string; token: string };
  writeResource: (
    specName: string,
    instance: string,
    data: unknown,
  ) => Promise<unknown>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warning?: (msg: string, meta?: Record<string, unknown>) => void;
  };
};

/**
 * Instance names are prefixed per spec — the base model keys its snapshots
 * `owner__repo`, and instance names map straight to storage paths, so an
 * unprefixed `owner__repo` here would overwrite `repo`/`issues` data on disk.
 */
function instanceName(spec: string, owner: string, repo: string): string {
  return `${spec}__${owner}__${repo}`;
}

/**
 * Locale-independent path comparator — matches git's own byte ordering, so a
 * snapshot's file order is reproducible regardless of the host's locale.
 */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Collapse a file path into a filesystem-safe instance name fragment. */
function pathSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

/** Page through `/git/trees/{ref}?recursive=1` until exhausted or capped. */
async function fetchTree(
  host: string,
  token: string,
  owner: string,
  repo: string,
  ref: string,
  maxEntries: number,
): Promise<{
  sha: string;
  entries: z.infer<typeof TreeEntrySchema>[];
  truncated: boolean;
}> {
  const entries: z.infer<typeof TreeEntrySchema>[] = [];
  let sha = "";
  let truncated = false;
  const perPage = 1000;

  for (let page = 1; entries.length < maxEntries; page++) {
    const raw = await apiGetJson(
      host,
      token,
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}` +
        `?recursive=1&page=${page}&per_page=${perPage}`,
    );
    const parsed = TreeResponseSchema.parse(raw);
    sha = parsed.sha;
    truncated = truncated || parsed.truncated === true;

    const batch = parsed.tree ?? [];
    entries.push(...batch);
    // total_count reflects the whole tree; a short page also means we're done.
    if (batch.length < perPage) break;
    if (
      parsed.total_count !== undefined && entries.length >= parsed.total_count
    ) {
      break;
    }
  }

  if (entries.length > maxEntries) {
    entries.length = maxEntries;
    truncated = true;
  }
  return { sha, entries, truncated };
}

/** Decode bytes as UTF-8, truncating at `maxBytes` on a whole-byte boundary. */
function decodeCapped(
  bytes: Uint8Array,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const truncated = bytes.length > maxBytes;
  const slice = truncated ? bytes.subarray(0, maxBytes) : bytes;
  return {
    content: new TextDecoder("utf-8", { fatal: false }).decode(slice),
    truncated,
  };
}

// ── Extension ─────────────────────────────────────────────────────────────────

export const extension = {
  type: "@shrug/forgejo",

  resources: {
    tree: {
      description: "Recursive file inventory for a repository at a given ref",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        ref: z.string(),
        sha: z.string(),
        entries: z.array(TreeEntrySchema),
        fileCount: z.number(),
        dirCount: z.number(),
        totalBytes: z.number(),
        truncated: z.boolean(),
        readAt: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 3,
    },
    file: {
      description: "Contents of a single file in a repository",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        ref: z.string(),
        path: z.string(),
        size: z.number(),
        content: z.string(),
        truncated: z.boolean(),
        readAt: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 3,
    },
    codebase: {
      description:
        "Full text snapshot of a repository's files at a ref, for review",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        ref: z.string(),
        sha: z.string(),
        files: z.array(CodeFileSchema),
        skipped: z.array(SkippedFileSchema),
        fileCount: z.number(),
        skippedCount: z.number(),
        totalBytes: z.number(),
        truncated: z.boolean(),
        readAt: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 3,
    },
  },

  methods: [{
    list_tree: {
      description:
        "List every path in a repository at a ref (recursive git tree). Map a repo before reading it.",
      arguments: ListTreeArgs,
      execute: async (args: z.infer<typeof ListTreeArgs>, context: Context) => {
        const { host, token } = context.globalArgs;
        context.logger.info("Reading tree for {owner}/{repo} at {ref}", {
          owner: args.owner,
          repo: args.repo,
          ref: args.ref,
        });

        const { sha, entries, truncated } = await fetchTree(
          host,
          token,
          args.owner,
          args.repo,
          args.ref,
          args.max_entries,
        );

        const files = entries.filter((e) => e.type === "blob");
        const handle = await context.writeResource(
          "tree",
          instanceName("tree", args.owner, args.repo),
          {
            owner: args.owner,
            repo: args.repo,
            ref: args.ref,
            sha,
            entries,
            fileCount: files.length,
            dirCount: entries.filter((e) => e.type === "tree").length,
            totalBytes: files.reduce((n, e) => n + (e.size ?? 0), 0),
            truncated,
            readAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Tree has {fileCount} files ({truncated})",
          {
            fileCount: files.length,
            truncated: truncated ? "truncated" : "complete",
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_file: {
      description: "Read the contents of a single file from a repository.",
      arguments: GetFileArgs,
      execute: async (args: z.infer<typeof GetFileArgs>, context: Context) => {
        const { host, token } = context.globalArgs;
        context.logger.info("Reading {owner}/{repo}:{path} at {ref}", {
          owner: args.owner,
          repo: args.repo,
          path: args.path,
          ref: args.ref,
        });

        const bytes = await apiGetRaw(
          host,
          token,
          `/repos/${args.owner}/${args.repo}/raw/${encodePath(args.path)}` +
            `?ref=${encodeURIComponent(args.ref)}`,
        );
        if (bytes === null) {
          throw new Error(
            `File not found: ${args.owner}/${args.repo}:${args.path} at ${args.ref}`,
          );
        }

        const { content, truncated } = decodeCapped(bytes, args.max_bytes);
        const handle = await context.writeResource(
          "file",
          `file__${args.owner}__${args.repo}__${pathSlug(args.path)}`,
          {
            owner: args.owner,
            repo: args.repo,
            ref: args.ref,
            path: args.path,
            size: bytes.length,
            content,
            truncated,
            readAt: new Date().toISOString(),
          },
        );

        context.logger.info("Read {bytes} bytes from {path}", {
          bytes: bytes.length,
          path: args.path,
        });
        return { dataHandles: [handle] };
      },
    },

    snapshot_code: {
      description:
        "Read every matching text file in a repository into one reviewable snapshot (single fan-out run).",
      arguments: SnapshotCodeArgs,
      execute: async (
        args: z.infer<typeof SnapshotCodeArgs>,
        context: Context,
      ) => {
        const { host, token } = context.globalArgs;
        context.logger.info("Snapshotting code for {owner}/{repo} at {ref}", {
          owner: args.owner,
          repo: args.repo,
          ref: args.ref,
        });

        const { sha, entries, truncated: treeTruncated } = await fetchTree(
          host,
          token,
          args.owner,
          args.repo,
          args.ref,
          20000,
        );

        const excludes = args.no_default_excludes
          ? args.exclude
          : [...DEFAULT_EXCLUDES, ...args.exclude];

        const skipped: z.infer<typeof SkippedFileSchema>[] = [];
        const candidates: z.infer<typeof TreeEntrySchema>[] = [];

        for (const entry of entries) {
          if (entry.type !== "blob") continue;
          const size = entry.size ?? 0;
          if (!matchesAny(entry.path, args.include)) {
            skipped.push({ path: entry.path, size, reason: "not_included" });
          } else if (matchesAny(entry.path, excludes)) {
            skipped.push({ path: entry.path, size, reason: "excluded" });
          } else if (size > args.max_file_bytes * 4) {
            // Far beyond the truncation cap — not worth a round trip.
            skipped.push({ path: entry.path, size, reason: "too_large" });
          } else {
            candidates.push(entry);
          }
        }

        // Smallest first: under a byte budget, more files beats fewer big ones.
        candidates.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));

        const selected = candidates.slice(0, args.max_files);
        for (const entry of candidates.slice(args.max_files)) {
          skipped.push({
            path: entry.path,
            size: entry.size ?? 0,
            reason: "over_budget",
          });
        }

        const files: z.infer<typeof CodeFileSchema>[] = [];
        let totalBytes = 0;
        let budgetHit = false;
        let cursor = 0;

        const worker = async () => {
          while (true) {
            if (budgetHit) return;
            const index = cursor++;
            if (index >= selected.length) return;
            const entry = selected[index];

            const bytes = await apiGetRaw(
              host,
              token,
              `/repos/${args.owner}/${args.repo}/raw/${
                encodePath(entry.path)
              }` +
                `?ref=${encodeURIComponent(args.ref)}`,
            );
            if (bytes === null) {
              skipped.push({
                path: entry.path,
                size: entry.size ?? 0,
                reason: "missing",
              });
              continue;
            }
            if (looksBinary(bytes)) {
              skipped.push({
                path: entry.path,
                size: bytes.length,
                reason: "binary",
              });
              continue;
            }
            if (totalBytes + bytes.length > args.max_total_bytes) {
              budgetHit = true;
              skipped.push({
                path: entry.path,
                size: bytes.length,
                reason: "over_budget",
              });
              return;
            }

            const { content, truncated } = decodeCapped(
              bytes,
              args.max_file_bytes,
            );
            totalBytes += content.length;
            files.push({
              path: entry.path,
              sha: entry.sha,
              size: bytes.length,
              content,
              truncated,
            });
          }
        };

        await Promise.all(
          Array.from(
            { length: Math.min(args.concurrency, selected.length) },
            worker,
          ),
        );

        // Restore tree order so the snapshot reads like the repo, not the queue.
        // Codepoint order, not localeCompare: locale-dependent sorting would
        // reorder identical content across machines and churn data versions.
        files.sort((a, b) => byPath(a.path, b.path));
        skipped.sort((a, b) => byPath(a.path, b.path));

        const handle = await context.writeResource(
          "codebase",
          instanceName("code", args.owner, args.repo),
          {
            owner: args.owner,
            repo: args.repo,
            ref: args.ref,
            sha,
            files,
            skipped,
            fileCount: files.length,
            skippedCount: skipped.length,
            totalBytes,
            truncated: treeTruncated || budgetHit,
            readAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Snapshotted {fileCount} files ({totalBytes} bytes), skipped {skippedCount}",
          {
            fileCount: files.length,
            totalBytes,
            skippedCount: skipped.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
