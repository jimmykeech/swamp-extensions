/** Read-only, bounded project snapshots. Symlinks and private paths are rejected. @module */
import * as path from "node:path";

const TEXT_LIMIT = 1024 * 1024;
const SOURCE_LIMIT = 50 * 1024 * 1024;
const FILE_LIMIT = 5000;
const ENTRY_LIMIT = 10000;
const PRIVATE_COMPONENTS = new Set([
  ".git",
  ".swamp",
  ".swamp.yaml",
  ".env",
  ".envrc",
  "vaults",
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  "__pycache__",
]);

/** Compute a lowercase SHA-256 digest for text or binary content. */
export async function sha256(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string"
    ? new TextEncoder().encode(text)
    : new Uint8Array(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Serialize JSON values with recursively sorted object keys. */
export function canonical(value: unknown): string {
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (entry) => canonical(entry)).join(",")}]`;
  }
  if (
    typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(record[key])}`
      ).join(",")
    }}`;
  }
  throw new Error("Canonical snapshots require finite JSON values.");
}

function relativeParts(value: string, allowRoot = false): string[] {
  if (allowRoot && value === ".") return [];
  if (
    !value || value.includes("\\") || value.includes("\0") ||
    path.isAbsolute(value) || path.win32.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new Error("Expected a safe project-relative path.");
  }
  const parts = value.split("/");
  if (
    parts.some((part) =>
      !part || part === "." || part === ".." ||
      PRIVATE_COMPONENTS.has(part.toLowerCase()) ||
      part.toLowerCase().startsWith(".env.")
    )
  ) {
    throw new Error("Project path contains a private or disallowed component.");
  }
  return parts;
}

async function inspectPath(absolutePath: string): Promise<Deno.FileInfo> {
  const parsed = path.parse(absolutePath);
  let cursor = parsed.root;
  let info = await Deno.lstat(cursor);
  const parts = absolutePath.slice(parsed.root.length).split(path.sep).filter(
    Boolean,
  );
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    info = await Deno.lstat(cursor);
    if (info.isSymlink) {
      throw new Error("Project paths must not contain symlinks.");
    }
    if (index < parts.length - 1 && !info.isDirectory) {
      throw new Error("Project path ancestor is not a directory.");
    }
  }
  return info;
}

async function projectRoot(repoDir: string): Promise<string> {
  if (!path.isAbsolute(repoDir)) {
    throw new Error("Project root must be absolute.");
  }
  // Inspect before normalization so a symlink followed by '..' cannot disappear.
  await inspectPath(repoDir);
  const root = path.resolve(repoDir);
  const info = await inspectPath(root);
  if (!info.isDirectory) throw new Error("Project root is not a directory.");
  return root;
}

function unchanged(before: Deno.FileInfo, after: Deno.FileInfo): boolean {
  return before.size === after.size && before.ino === after.ino &&
    before.dev === after.dev &&
    before.mtime?.getTime() === after.mtime?.getTime() &&
    before.ctime?.getTime() === after.ctime?.getTime();
}

async function readBytes(
  absolutePath: string,
  limit: number,
): Promise<Uint8Array> {
  const before = await inspectPath(absolutePath);
  if (!before.isFile) throw new Error("Snapshot path is not a regular file.");
  if (before.size > limit) throw new Error("Snapshot byte limit exceeded.");
  const file = await Deno.open(absolutePath, { read: true });
  try {
    const opened = await file.stat();
    if (!opened.isFile || !unchanged(before, opened)) {
      throw new Error(
        "Snapshot file changed while opening; retry from stable files.",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = new Uint8Array(Math.min(64 * 1024, limit - size + 1));
      const count = await file.read(chunk);
      if (count === null) break;
      size += count;
      if (size > limit) throw new Error("Snapshot byte limit exceeded.");
      chunks.push(chunk.subarray(0, count));
    }
    const after = await inspectPath(absolutePath);
    if (
      !after.isFile || !unchanged(before, after) ||
      !unchanged(before, await file.stat())
    ) {
      throw new Error(
        "Snapshot file changed while reading; retry from stable files.",
      );
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    file.close();
  }
}

/** Read a regular UTF-8 project file of at most 1 MiB, without following symlinks. */
export async function readProjectText(
  repoDir: string,
  relativePath: string,
): Promise<string> {
  const parts = relativeParts(relativePath);
  const root = await projectRoot(repoDir);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readBytes(path.join(root, ...parts), TEXT_LIMIT),
  );
}

/** Resolve an existing project-contained directory; only a literal '.' selects the root. */
export async function resolveWorkspace(
  repoDir: string,
  relativePath: string,
): Promise<string> {
  const parts = relativeParts(relativePath, true);
  const root = await projectRoot(repoDir);
  const workspace = path.join(root, ...parts);
  if (!(await inspectPath(workspace)).isDirectory) {
    throw new Error("Workspace is not a directory.");
  }
  return workspace;
}

/** Validate explicit source-root syntax without requiring files to exist yet. */
export function validateSourcePaths(sourcePaths: string[]): void {
  if (sourcePaths.length === 0 || sourcePaths.length > FILE_LIMIT) {
    throw new Error("Select between one and 5,000 explicit source roots.");
  }
  for (const entry of sourcePaths) relativeParts(entry);
}

/**
 * Hash sorted workspace-relative filenames and exact binary content under explicit roots.
 * Reject missing roots, symlinks, private/dependency paths, more than 5,000 files,
 * more than 10,000 entries, or more than 50 MiB. No matching files are silently excluded.
 * Overlapping roots are de-duplicated. Callers must keep the workspace stable during capture.
 */
export async function sourceDigest(
  repoDir: string,
  workspace: string,
  sourcePaths: string[],
): Promise<{ sourceDigest: string; fileCount: number }> {
  const root = await projectRoot(repoDir);
  if (path.isAbsolute(workspace)) await inspectPath(workspace);
  const workspaceRelative = path.isAbsolute(workspace)
    ? path.relative(root, workspace).split(path.sep).join("/") || "."
    : workspace;
  const resolved = await resolveWorkspace(root, workspaceRelative);
  validateSourcePaths(sourcePaths);
  const roots = [
    ...new Set(sourcePaths.map((entry) => relativeParts(entry).join("/"))),
  ].sort();
  const seen = new Set<string>();
  const records: { path: string; sha256: string }[] = [];
  let totalBytes = 0;

  const visit = async (relative: string): Promise<void> => {
    relativeParts(relative);
    if (seen.has(relative)) return;
    seen.add(relative);
    if (seen.size > ENTRY_LIMIT) {
      throw new Error("Snapshot entry limit exceeded.");
    }
    const absolute = path.join(resolved, ...relative.split("/"));
    const info = await inspectPath(absolute);
    if (info.isDirectory) {
      const entries: string[] = [];
      for await (const entry of Deno.readDir(absolute)) {
        entries.push(entry.name);
        if (entries.length + seen.size > ENTRY_LIMIT) {
          throw new Error("Snapshot entry limit exceeded.");
        }
      }
      for (const entry of entries.sort()) await visit(`${relative}/${entry}`);
      if (!unchanged(info, await inspectPath(absolute))) {
        throw new Error(
          "Snapshot directory changed during capture; retry from stable files.",
        );
      }
    } else if (info.isFile) {
      if (records.length >= FILE_LIMIT) {
        throw new Error("Snapshot file limit exceeded.");
      }
      const bytes = await readBytes(absolute, SOURCE_LIMIT - totalBytes);
      totalBytes += bytes.byteLength;
      records.push({ path: relative, sha256: await sha256(bytes) });
    } else {
      throw new Error("Snapshot path is not a regular file or directory.");
    }
  };
  for (const entry of roots) await visit(entry);
  records.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  return {
    sourceDigest: await sha256(
      canonical({ format: "bootstrap-source-v1", files: records }),
    ),
    fileCount: records.length,
  };
}
