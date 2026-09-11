import {
  type AnyBulkWriteOperation,
  Binary,
  type Collection,
} from "npm:mongodb@6.17.0";
import type { ClientHandle } from "./client.ts";
import { createControlPlaneStore } from "./control_plane.ts";
type ControlPlaneStore = ReturnType<typeof createControlPlaneStore>;
import {
  blobsCollectionName,
  type MongoDatastoreConfig,
  pathsCollectionName,
} from "./config.ts";
import {
  getSidecar,
  type PushSnapshot,
  reconcileWatermark,
  type SidecarState,
} from "./sidecar.ts";

// Mirrors @systeminit/swamp's domain/datastore/datastore_sync_service.ts.
export interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

export interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  namespacedSync?: boolean;
  configRefresh?: boolean;
  controlPlane?: boolean;
}

export interface DatastoreSyncOptions {
  signal?: AbortSignal;
  namespace?: string;
  subdirs?: readonly string[];
  relPath?: string;
  // Domain-level sync context, passed by core only when capabilities()
  // advertises scopedSync. Meaningful on pull/push; ignored on markDirty.
  context?: SyncContext;
  // When true (set by core on a `--hydration-strategy lazy` setup pull),
  // pullChanged downloads catalog metadata only and skips `data/.../raw`
  // content. Honored only when capabilities() advertises lazyHydration.
  metadataOnly?: boolean;
}

export interface DatastoreSyncService {
  controlPlaneStore?(): ControlPlaneStore;
  pullChanged(options?: DatastoreSyncOptions): Promise<number>;
  pushChanged(options?: DatastoreSyncOptions): Promise<number>;
  capabilities?(): SyncCapabilities;
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  // Downloads a single cache-relative file the lazy setup pull skipped.
  // Core calls this transparently when a read-only command needs missing
  // content. Returns true if downloaded (or already present), false if the
  // remote has no live manifest doc for relPath.
  hydrateFile?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<boolean>;
}

// `secrets` is deliberately absent: the `local_encryption` vault stores each
// vault's symmetric `.key` right next to its `.enc` ciphertext, so syncing the
// tier would land both in the shared MongoDB and let anyone with read access
// decrypt every secret (encryption-at-rest defeated). Secrets stay per-host;
// use a real KMS-backed vault if secrets must travel. See isSecretsPath, which
// also blocks any pre-existing remote `secrets/*` docs from being pulled back
// into a cache. (Repo-root `.swamp/secrets` relocation/deletion during
// `datastore setup` is a swamp-core migration concern, not this extension's.)
const DATASTORE_SUBDIRS = [
  "config",
  "definitions-evaluated",
  "workflows-evaluated",
  "data",
  "outputs",
  "workflow-runs",
  "bundles",
  "vault-bundles",
  "driver-bundles",
  "report-bundles",
  "audit",
  "telemetry",
  "logs",
  "files",
] as const;

interface PathDoc {
  _id: string;
  hash: string;
  size: number;
  updatedAt: Date;
  deletedAt: Date | null;
}

// Blob storage layout:
//   * Inline blob (size <= BLOB_INLINE_MAX):
//       { _id: <sha256>, size, createdAt, data: <Binary> }
//   * Chunked blob (size > BLOB_INLINE_MAX):
//       Header doc:  { _id: <sha256>, size, createdAt, chunkCount }  (no data)
//       Chunk docs:  { _id: "<sha256>:<i>", size, createdAt, data }  (i = 0..N-1)
// `data` and `chunkCount` are mutually exclusive: a doc is either inline,
// header, or chunk. Chunk ids use `:` which is not a sha256 hex character,
// so chunk ids never collide with hash-only ids.
//
// `createdAt` exists solely for the orphan sweep's grace window: a blob is
// written before the path doc that references it, so a sweep must not judge a
// freshly-inserted blob unreachable. See maintenance.ts. Docs written before
// 2026.08.19.1 lack the field and are treated as old.
interface BlobDoc {
  _id: string;
  size: number;
  createdAt?: Date;
  data?: Binary;
  chunkCount?: number;
}

// Deliberately carries no `bytes`: both push paths walk for metadata first
// and re-read only the files whose hashes the remote turns out to lack, so a
// 100k-file tree never has all of its contents in RAM at once.
interface LocalMeta {
  relPath: string;
  hash: string;
  size: number;
}

interface RemotePathSlim {
  hash: string;
  deletedAt: Date | null;
  updatedAt: Date;
}

const PUSH_BULK = 500;
const BLOB_QUERY_BATCH = 5000;
// Dirty roots folded into a single manifest query. Each root contributes two
// `$or` clauses (exact id + prefix regex), so this keeps the query under a
// few hundred clauses while cutting round-trips by the same factor.
const ROOT_QUERY_BATCH = 100;
// Dirty roots reconciled before retiring that slice from the journal. Small
// enough that an interrupted push loses little work, large enough that the
// journal rewrite is amortized.
const PUSH_ROOT_SLICE = 500;
// BSON doc cap is 16 MiB. Reserve ~1 MiB headroom for `_id`, `size`,
// `chunkCount`, field-name overhead, and Binary subtype byte.
const BLOB_INLINE_MAX = 15 * 1024 * 1024;
// Each chunk doc is roughly this size; the last chunk is smaller.
const BLOB_CHUNK_BYTES = 8 * 1024 * 1024;
// Per-bulkWrite payload bound for inline blobs (stays under wire protocol cap).
const BULK_INLINE_BYTES = 14 * 1024 * 1024;
// MongoDB error codes we tolerate per-op without aborting the batch.
const ERR_DUP_KEY = 11000;
const ERR_DOC_TOO_LARGE = 10334;
// Cache-relative paths holding model content bytes: `data/<type>/<id>/.../raw`.
// A metadataOnly pull excludes these and leaves them to lazy hydration.
const RAW_CONTENT_RE = /^(?:[^/]+\/)?data\/.*\/raw$/;

// Fresh regex per call: a `RegExp` carries `lastIndex` state and is reused
// across queries here, so we hand Mongo its own instance each time.
export function rawContentRegex(): RegExp {
  return new RegExp(RAW_CONTENT_RE.source);
}

// True for cache-relative paths a metadataOnly pull skips (model content
// bytes). Catalog files (`metadata.yaml`, `latest`) return false.
export function isRawContentPath(relPath: string): boolean {
  return RAW_CONTENT_RE.test(relPath);
}

// True for the vault `secrets/` tier, which must never be synced to the shared
// MongoDB (see DATASTORE_SUBDIRS). Enforced on both legs: push never walks the
// tier (it's out of DATASTORE_SUBDIRS) and is guarded in markDirty/pushOneRel;
// pull skips these docs so a deployment that synced secrets under an older
// version cannot re-hydrate them into a cache.
export function isSecretsPath(relPath: string, namespace?: string): boolean {
  if (namespace && relPath.startsWith(`${namespace}/`)) {
    return relPath.slice(namespace.length + 1).split("/")[0] === "secrets";
  }
  const parts = relPath.split("/");
  // Solo sync can contain namespace trees, including namespaces named
  // "data" or "outputs". Ambiguous secrets paths must remain host-local.
  return parts[0] === "secrets" || parts[1] === "secrets";
}

// Host-local files that must never sync, matched on the basename.
//
//   *.db / *.db-wal / *.db-shm — swamp's SQLite catalogs (`data/_catalog.db`
//     and friends). The `-shm` file is a mmap'd shared-memory region whose
//     contents are meaningless off the machine that created it, and `-wal`
//     only makes sense paired with the exact `.db` that wrote it. They also
//     churn on every single write, so syncing them re-uploads a multi-MB blob
//     per command for data the remote can never correctly consume. The `.db`
//     itself is a rebuildable local index.
//   *.tmp.<pid>.<uuid> — in-flight writeFileAtomic / sidecar staging files.
//     Catching one mid-write pushes a torn blob.
const EXCLUDED_BASENAME_RE =
  /(?:\.db|\.db-wal|\.db-shm)$|\.tmp\.\d+\.[0-9a-f-]+$/;

export function isExcludedPath(relPath: string): boolean {
  const slash = relPath.lastIndexOf("/");
  const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  return EXCLUDED_BASENAME_RE.test(base) ||
    base === ".lock" || base === ".namespace.json" ||
    base.startsWith(".datastore-") || base === ".env" ||
    base === "auth.json";
}

// Everything the push side refuses to carry.
function isUnsyncable(relPath: string, namespace?: string): boolean {
  return !isSafeRelativePath(relPath) ||
    isSecretsPath(relPath, namespace) || isExcludedPath(relPath);
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((p) => p === "" || p === "." || p === "..");
}

export function createSyncService(
  cfg: MongoDatastoreConfig,
  getClient: (repoDir: string) => Promise<ClientHandle>,
  repoDir: string,
  cachePath: string,
): DatastoreSyncService {
  // Interned per cachePath: core builds a fresh sync service per invocation,
  // and two Sidecars over one cache would not serialize with each other.
  const sidecar = getSidecar(cachePath);
  let updatedAtIndexEnsured = false;
  let namespace: string | undefined;
  let namespaceBound = false;

  function bindNamespace(options?: DatastoreSyncOptions): void {
    const requested = options?.namespace || undefined;
    if (
      requested && (!isSafeRelativePath(requested) || requested.includes("/"))
    ) {
      throw new Error("Namespace must be a single safe path segment");
    }
    if (namespaceBound && namespace !== requested) {
      throw new Error(
        `Namespace mismatch: bound to ${namespace}, received ${requested}`,
      );
    }
    namespace = requested;
    namespaceBound = true;
  }

  function inNamespace(path: string): boolean {
    return !namespace || path.startsWith(`${namespace}/`);
  }

  function reconcileKey(): string {
    // Reserved non-path key; unlike a hydration watermark, a push only
    // establishes that the remote manifest has been observed.
    return `@reconciled/${namespace}/`;
  }

  async function walkRoots(allNamespaces = false): Promise<string[]> {
    const roots = DATASTORE_SUBDIRS.map((sub) =>
      namespace && !allNamespaces ? `${namespace}/${sub}` : sub
    );
    if (namespace && !allNamespaces) return roots;
    // Solo sync covers the whole cache, including existing namespace trees.
    // Walk only recognized datastore tiers; never arbitrary repository files.
    try {
      for await (const entry of Deno.readDir(cachePath)) {
        if (
          !entry.isDirectory || entry.name.startsWith(".") ||
          DATASTORE_SUBDIRS.some((sub) => sub === entry.name) ||
          entry.name === "secrets"
        ) continue;
        for (const sub of DATASTORE_SUBDIRS) roots.push(`${entry.name}/${sub}`);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return roots;
  }

  async function lazyPullActive(): Promise<boolean> {
    // Solo hydration covers all namespaces; its incomplete-cache flag also
    // protects namespace-scoped pushes. A solo push must likewise respect
    // any incomplete namespace subtree it would otherwise reconcile.
    if ((await sidecar.read()).lazyPullActive) return true;
    if (namespace) {
      return (await getSidecar(`${cachePath}/${namespace}`).read())
        .lazyPullActive;
    }
    try {
      for await (const entry of Deno.readDir(cachePath)) {
        if (!entry.isDirectory || entry.name.startsWith(".")) continue;
        if (
          (await getSidecar(`${cachePath}/${entry.name}`).read()).lazyPullActive
        ) {
          return true;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return false;
  }

  async function finishPush(
    observed: PushSnapshot,
    full: boolean,
  ): Promise<void> {
    const foreign: string[] = [];
    if (namespace && full && observed.state.bulkInvalidated) {
      const roots = new Set(await walkRoots(true));
      // A bulk mark can represent deleting an entire namespace directory.
      // Its previous push/hydration watermarks still identify the remote
      // roots that must be reconciled even though no directory remains.
      for (const key of Object.keys(observed.state.scopeWatermarks)) {
        const parts = key.split("/");
        const explicitNamespace = parts[0] === "@pushed" ||
          parts[0] === "@reconciled";
        const candidate = explicitNamespace ? parts[1] : parts[0];
        if (
          !candidate || candidate.startsWith("@") ||
          candidate.startsWith(".") ||
          (!explicitNamespace &&
            (candidate === "secrets" ||
              DATASTORE_SUBDIRS.some((sub) => sub === candidate)))
        ) continue;
        for (const sub of DATASTORE_SUBDIRS) roots.add(`${candidate}/${sub}`);
      }
      foreign.push(...[...roots].filter((path) => !inNamespace(path)));
    }
    await sidecar.retirePush(observed, inNamespace, foreign);
  }

  async function resources(): Promise<{
    paths: Collection<PathDoc>;
    blobs: Collection<BlobDoc>;
  }> {
    const { client } = await getClient(repoDir);
    const db = client.db(cfg.database);
    const paths = db.collection<PathDoc>(pathsCollectionName(cfg));
    const blobs = db.collection<BlobDoc>(blobsCollectionName(cfg));
    if (!updatedAtIndexEnsured) {
      await paths.createIndex({ updatedAt: 1 }).catch(() => undefined);
      updatedAtIndexEnsured = true;
    }
    return { paths, blobs };
  }

  function poolConcurrency(): number {
    return parseInt(
      Deno.env.get("MONGO_DATASTORE_PULL_CONCURRENCY") ?? "32",
      10,
    );
  }

  // `prefixes`, when present, scopes the pull to `_paths` docs whose `_id`
  // begins with one of the given cache-relative prefixes (e.g.
  // `data/<modelType>/<modelId>/`). A scoped pull is a pure read
  // optimization, and — critically — it does NOT advance the `lastPulledAt`
  // watermark. The global watermark stays owned exclusively by the full,
  // unscoped pull; bumping it here would make a later full pull skip every
  // out-of-scope change in this window.
  //
  // It does keep its own floor per prefix (`scopeWatermarks`), which is what
  // makes it incremental: without one it re-fetched every path doc under the
  // prefix — tombstones included, since they carry no age filter — and
  // re-hashed the whole local subtree, on every per-model lock. Core takes
  // those locks per workflow step, so that cost multiplied by step count.
  // See scopeFloor for why `lastPulledAt` alone can't serve as the floor.
  async function pull(opts?: {
    prefixes?: string[];
    metadataOnly?: boolean;
    namespaceFull?: boolean;
  }): Promise<number> {
    const prefixes = opts?.prefixes;
    const metadataOnly = opts?.metadataOnly === true;
    const scoped = prefixes !== undefined && prefixes.length > 0;
    const { paths, blobs } = await resources();
    // A metadataOnly pull leaves data/.../raw un-hydrated. Mark the cache so
    // a later pushChanged won't read those absent raw files as deletions and
    // tombstone the whole corpus. Set before the no-op early return so even a
    // metadataOnly pull that finds nothing new still records lazy mode.
    const hydrationSidecar = namespace
      ? getSidecar(`${cachePath}/${namespace}`)
      : sidecar;
    if (metadataOnly) await hydrationSidecar.setLazyPullActive(true);
    const state = await sidecar.read();

    if (!scoped && state.lastPulledAt !== null) {
      const since = new Date(state.lastPulledAt);
      const probe = await paths.findOne(
        { updatedAt: { $gte: since } },
        { projection: { _id: 1 } },
      );
      if (probe === null) return 0;
    }

    const baseFilter = scoped
      ? scopedPullFilter(prefixes!, state)
      : state.lastPulledAt !== null
      ? { updatedAt: { $gte: new Date(state.lastPulledAt) } }
      : {};
    // metadataOnly: keep the catalog (metadata.yaml, latest) but skip the
    // bulky `data/<type>/<id>/.../raw` content so `data list`/`query`/CEL
    // work immediately. The skipped files are fetched on demand by
    // hydrateFile when a read actually needs them.
    const filter = metadataOnly
      ? { $and: [baseFilter, { _id: { $not: rawContentRegex() } }] }
      : baseFilter;
    // A scoped pull always hash-compares against local state: its floor says
    // the prefix was in sync at that instant, not that every doc past it is
    // absent locally, so the cold-start bulk path (skip the compare, fetch
    // everything) would re-download files the cache already holds.
    const coldStart = !scoped && state.lastPulledAt === null;

    // Empty scopes keep an epoch floor: a local wall clock is not proof
    // that a remote writer's older timestamp has already been observed.
    const openedAt = new Date(0).toISOString();
    const pathDocs: PathDoc[] = [];
    // Per-prefix max updatedAt, for the scope watermarks this pull records.
    const scopeMaxMs = new Map<string, number>();
    let maxUpdatedAtMs = state.lastPulledAt !== null
      ? new Date(state.lastPulledAt).getTime()
      : 0;
    for await (const doc of paths.find(filter)) {
      const ms = doc.updatedAt.getTime();
      if (ms > maxUpdatedAtMs) maxUpdatedAtMs = ms;
      if (scoped) {
        const owner = prefixes!.find((p) => doc._id.startsWith(p));
        if (owner !== undefined && ms > (scopeMaxMs.get(owner) ?? 0)) {
          scopeMaxMs.set(owner, ms);
        }
      }
      // Never hydrate vault secrets or host-local files, even if an older
      // version synced them. Advance the watermark past the doc (above) so it
      // isn't re-scanned, but don't write or delete it locally — a stale
      // `-wal`/`-shm` landing next to a live SQLite catalog is worse than
      // having no copy at all.
      if (isUnsyncable(doc._id, namespace)) continue;
      pathDocs.push(doc);
    }

    const concurrency = poolConcurrency();
    let changes = 0;

    const deletes = pathDocs.filter((d) => d.deletedAt !== null);
    await runPool(deletes, concurrency, async (doc) => {
      if (await removeSilentlyExisting(`${cachePath}/${doc._id}`)) changes++;
    });

    const needs = pathDocs.filter((d) => d.deletedAt === null);
    const pathsByHash = new Map<string, PathDoc[]>();
    if (coldStart) {
      for (const doc of needs) addToBucket(pathsByHash, doc.hash, doc);
    } else {
      await runPool(needs, concurrency, async (doc) => {
        const local = await readFileOrNull(`${cachePath}/${doc._id}`);
        if (local !== null && (await sha256Hex(local)) === doc.hash) return;
        addToBucket(pathsByHash, doc.hash, doc);
      });
    }

    const hashesNeeded = [...pathsByHash.keys()];
    for (let i = 0; i < hashesNeeded.length; i += BLOB_QUERY_BATCH) {
      const hashBatch = hashesNeeded.slice(i, i + BLOB_QUERY_BATCH);
      const writeJobs: Array<{ relPath: string; bytes: Uint8Array }> = [];
      const chunkedHeaders: BlobDoc[] = [];
      for await (const blob of blobs.find({ _id: { $in: hashBatch } })) {
        if (blob.data) {
          const bytes = blob.data.buffer;
          const dependents = pathsByHash.get(blob._id) ?? [];
          for (const doc of dependents) {
            writeJobs.push({ relPath: doc._id, bytes });
          }
        } else {
          chunkedHeaders.push(blob);
        }
      }
      for (const header of chunkedHeaders) {
        const bytes = await assembleChunkedBlob(blobs, header);
        const dependents = pathsByHash.get(header._id) ?? [];
        for (const doc of dependents) {
          writeJobs.push({ relPath: doc._id, bytes });
        }
      }
      await runPool(writeJobs, concurrency, async ({ relPath, bytes }) => {
        await writeFileAtomic(`${cachePath}/${relPath}`, bytes);
        changes++;
      });
    }

    if (scoped && !metadataOnly) {
      // Every path under these prefixes is now hydrated up to the point we
      // reached. Recorded per prefix, never as `lastPulledAt`: this pull saw
      // one slice of the manifest, and the global watermark means the whole
      // of it. A metadataOnly pull is excluded — it skipped `data/.../raw`,
      // so its position would hide those docs from the next scoped pull.
      const advanced: Record<string, string> = {};
      for (const p of prefixes!) {
        const seen = scopeMaxMs.get(p);
        // Nothing matched: the floor held, so carry it forward. On the first
        // pull of a prefix there is no floor yet, and `openedAt` records that
        // the prefix was empty as of then.
        advanced[p] = seen !== undefined
          ? new Date(seen).toISOString()
          : scopeFloor(state, p) ?? openedAt;
      }
      await sidecar.advanceScopeWatermarks(advanced);
    }

    if (opts?.namespaceFull && !metadataOnly) {
      const watermark = maxUpdatedAtMs > 0
        ? new Date(maxUpdatedAtMs).toISOString()
        : openedAt;
      await sidecar.advanceScopeWatermarks({ [reconcileKey()]: watermark });
      await hydrationSidecar.setLazyPullActive(false);
    }

    if (!scoped && !metadataOnly) {
      // Full unscoped pull: the cache now mirrors the remote, so advance the
      // watermark and clear lazy mode — the next push may safely tombstone
      // absent paths again.
      const watermark = maxUpdatedAtMs > 0
        ? new Date(maxUpdatedAtMs).toISOString()
        : openedAt;
      await sidecar.setLastPulledAt(watermark);
      // The cache also mirrors the remote *path list* as of this point — the
      // pull applied every tombstone and hydrated every addition in the
      // window — so it is a reconcile point for the push tombstone pass too.
      await sidecar.setLastReconciledAt(watermark);
      await sidecar.setLazyPullActive(false);
    }
    // A metadataOnly pull deliberately does NOT advance the watermark: doing
    // so would move it past the skipped data/.../raw docs, and a later full
    // pull (filtered by updatedAt > watermark) would then never re-fetch
    // them. Leaving the watermark put keeps those raw docs reachable.
    return changes;
  }

  async function fullWalkPush(
    paths: Collection<PathDoc>,
    blobs: Collection<BlobDoc>,
    watermarkIso: string | null,
    lazyPullActive: boolean,
    observedState: SidecarState,
  ): Promise<{ changes: number; reconciledAt: string }> {
    // Stamped before the manifest read, not after: anything a peer writes
    // while we are streaming the cursor must stay newer than this watermark
    // so the *next* reconcile still considers it, rather than being silently
    // treated as already-seen.
    const reconciledAt = new Date().toISOString();

    // Pull the path manifest with a projection so the in-memory map carries
    // only the fields the diff/tombstone passes use.
    const remotePaths = new Map<string, RemotePathSlim>();
    for await (
      const doc of paths.find(
        namespace ? { _id: { $regex: `^${escapeRegex(namespace)}/` } } : {},
        { projection: { hash: 1, deletedAt: 1, updatedAt: 1 } },
      )
    ) {
      if (isUnsyncable(doc._id, namespace)) continue;
      remotePaths.set(doc._id, {
        hash: doc.hash,
        deletedAt: doc.deletedAt,
        updatedAt: doc.updatedAt,
      });
    }

    // Pass 1 — walk for metadata only, remembering where each distinct hash
    // can be re-read from.
    //
    // This used to pre-fetch every `_id` in the blobs collection so the walk
    // could decide push-or-skip inline. That cursor scales with the *blob
    // store*, not the repo: proxmox-manager's had grown to 931k docs, so a
    // push of ~21k files began by streaming ~60 MB of hashes and building a
    // 931k-entry Set. Probing only the hashes we actually hold is bounded by
    // the working set instead.
    const localMetas: LocalMeta[] = [];
    const hashToAbs = new Map<string, string>();
    for (const sub of await walkRoots()) {
      await walkMetas(
        `${cachePath}/${sub}`,
        sub,
        localMetas,
        hashToAbs,
        namespace,
      );
    }

    // Pass 2 — probe blob existence for the distinct local hashes, then
    // re-read and upload only what's missing. Chunk docs carry `:<n>` in
    // their `_id`, so an `$in` over bare hashes only ever matches
    // inline/header docs — exactly the "is this blob present" question.
    let blobsPushed = 0;
    const distinctHashes = [...hashToAbs.keys()];
    const missingHashes: string[] = [];
    for (let i = 0; i < distinctHashes.length; i += BLOB_QUERY_BATCH) {
      const batch = distinctHashes.slice(i, i + BLOB_QUERY_BATCH);
      const present = new Set<string>();
      for await (
        const b of blobs.find(
          { _id: { $in: batch } },
          { projection: { _id: 1 } },
        )
      ) {
        present.add(b._id);
      }
      for (const h of batch) if (!present.has(h)) missingHashes.push(h);
    }
    for (let i = 0; i < missingHashes.length; i += PUSH_BULK) {
      const batch = missingHashes.slice(i, i + PUSH_BULK);
      const byHash = new Map<string, Uint8Array>();
      let batchBytes = 0;
      for (const h of batch) {
        const bytes = await readFileOrNull(hashToAbs.get(h)!);
        if (bytes === null) continue; // vanished mid-walk (autoGc)
        byHash.set(h, bytes);
        batchBytes += bytes.byteLength;
        if (batchBytes >= BULK_INLINE_BYTES) {
          blobsPushed += await pushBlobsByHash(
            blobs,
            [...byHash.keys()],
            byHash,
          );
          byHash.clear();
          batchBytes = 0;
        }
      }
      if (byHash.size > 0) {
        blobsPushed += await pushBlobsByHash(blobs, [...byHash.keys()], byHash);
      }
    }

    // Path upserts — no bytes needed, just the metadata collected above.
    let pathsPushed = 0;
    let pathOps: AnyBulkWriteOperation<PathDoc>[] = [];
    const flushPathOps = async () => {
      if (pathOps.length === 0) return;
      const res = await paths.bulkWrite(pathOps, { ordered: false });
      pathsPushed += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
      pathOps = [];
    };
    const now = new Date();
    for (const f of localMetas) {
      const existing = remotePaths.get(f.relPath);
      if (
        existing && (existing.hash !== f.hash || existing.deletedAt !== null)
      ) {
        const explicitlyDirty = observedState.dirtyPaths.some((root) =>
          f.relPath === root || f.relPath.startsWith(`${root}/`)
        );
        let hydratedAt = observedState.lastPulledAt;
        for (
          const [prefix, seen] of Object.entries(observedState.scopeWatermarks)
        ) {
          if (
            f.relPath.startsWith(prefix) &&
            (hydratedAt === null || seen > hydratedAt)
          ) {
            hydratedAt = seen;
          }
        }
        // A first/bulk push walks undirtied files too. A stale cached file
        // must not replace a peer's newer value merely because this writer
        // changed a different model and only refreshed that model's scope.
        if (
          !explicitlyDirty && (hydratedAt === null ||
            existing.updatedAt >= new Date(hydratedAt))
        ) continue;
      }
      if (
        existing &&
        existing.deletedAt === null &&
        existing.hash === f.hash
      ) continue;
      pathOps.push({
        updateOne: {
          filter: { _id: f.relPath },
          update: {
            $set: {
              hash: f.hash,
              size: f.size,
              updatedAt: now,
              deletedAt: null,
            },
          },
          upsert: true,
        },
      });
      if (pathOps.length >= PUSH_BULK) await flushPathOps();
    }
    await flushPathOps();

    // Reconciliation tombstones: skipped entirely while a lazy pull is active.
    // The local cache is then an incomplete mirror (data/.../raw is absent),
    // so an absent path is "never hydrated," not "deleted." Deletions resume
    // propagating once a full pull clears lazyPullActive.
    if (watermarkIso !== null && !lazyPullActive) {
      const watermark = new Date(watermarkIso);
      const localPaths = new Set(localMetas.map((f) => f.relPath));
      const tombstoneOps: AnyBulkWriteOperation<PathDoc>[] = [];
      for (const [relPath, doc] of remotePaths) {
        if (localPaths.has(relPath) || doc.deletedAt !== null) continue;
        if (doc.updatedAt > watermark) continue;
        tombstoneOps.push({
          updateOne: {
            filter: { _id: relPath },
            update: { $set: { deletedAt: now, updatedAt: now } },
          },
        });
        pathsPushed++;
      }
      for (let i = 0; i < tombstoneOps.length; i += PUSH_BULK) {
        await paths.bulkWrite(
          tombstoneOps.slice(i, i + PUSH_BULK),
          { ordered: false },
        );
      }
    }
    return { changes: pathsPushed + blobsPushed, reconciledAt };
  }

  // Reconciles a batch of dirty roots in one shot.
  //
  // The previous implementation handled one root per call from a serial loop,
  // costing a `stat` plus a manifest `find` per root. With ~86k dirty entries
  // — 99% of them version directories autoGc had already reaped — that was
  // ~86k sequential round-trips holding the global lock, which is what made
  // pushes time out and, because clearDirty only ran at the very end, left the
  // dirty set to grow into the next run. Batching collapses that to a handful
  // of queries: one manifest fetch per ROOT_QUERY_BATCH roots, one blob
  // existence probe per BLOB_QUERY_BATCH hashes, and bulkWrites throughout.
  async function pushRoots(
    paths: Collection<PathDoc>,
    blobs: Collection<BlobDoc>,
    roots: string[],
    watermarkIso: string | null,
    lazyPullActive: boolean,
  ): Promise<number> {
    // Belt-and-suspenders: markDirty already drops these, so this only fires
    // if a dirty path slipped through from an older sidecar.
    const live = roots.filter((r) => !isUnsyncable(r, namespace));
    if (live.length === 0) return 0;

    // Pass 1 — walk every root for metadata only. Bytes are re-read later,
    // and only for the hashes the remote is actually missing, so a dirty
    // directory holding 15k files never lands in RAM all at once.
    const localMetas: LocalMeta[] = [];
    const hashToAbs = new Map<string, string>();
    for (const root of live) {
      const absPath = `${cachePath}/${root}`;
      let stat: Deno.FileInfo | null = null;
      try {
        stat = await Deno.stat(absPath);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      if (stat?.isFile) {
        const bytes = await Deno.readFile(absPath);
        const hash = await sha256Hex(bytes);
        localMetas.push({ relPath: root, hash, size: bytes.byteLength });
        if (!hashToAbs.has(hash)) hashToAbs.set(hash, absPath);
      } else if (stat?.isDirectory) {
        await walkMetas(absPath, root, localMetas, hashToAbs, namespace);
      }
      // A missing root is a deletion: it contributes no local metas, and the
      // tombstone pass below reconciles whatever the remote still lists.
    }

    // Pass 2 — one manifest query per batch of roots instead of per root.
    const remoteByPath = new Map<string, PathDoc>();
    for (let i = 0; i < live.length; i += ROOT_QUERY_BATCH) {
      const batch = live.slice(i, i + ROOT_QUERY_BATCH);
      const clauses: Array<Record<string, unknown>> = [];
      for (const root of batch) {
        clauses.push({ _id: root });
        clauses.push({ _id: { $regex: `^${escapeRegex(root)}/` } });
      }
      for await (const doc of paths.find({ $or: clauses })) {
        remoteByPath.set(doc._id, doc);
      }
    }

    let changes = 0;

    // Pass 3 — probe blob existence in bulk, then re-read and push only the
    // bytes the remote lacks.
    const distinctHashes = [...hashToAbs.keys()];
    const missingHashes: string[] = [];
    for (let i = 0; i < distinctHashes.length; i += BLOB_QUERY_BATCH) {
      const batch = distinctHashes.slice(i, i + BLOB_QUERY_BATCH);
      const present = new Set<string>();
      for await (
        const b of blobs.find(
          { _id: { $in: batch } },
          { projection: { _id: 1 } },
        )
      ) {
        present.add(b._id);
      }
      for (const h of batch) if (!present.has(h)) missingHashes.push(h);
    }
    for (let i = 0; i < missingHashes.length; i += PUSH_BULK) {
      const batch = missingHashes.slice(i, i + PUSH_BULK);
      const byHash = new Map<string, Uint8Array>();
      let batchBytes = 0;
      for (const h of batch) {
        const bytes = await readFileOrNull(hashToAbs.get(h)!);
        // Vanished between walk and read (autoGc): the path upsert below is
        // skipped for it too, since its meta no longer resolves to bytes.
        if (bytes === null) continue;
        byHash.set(h, bytes);
        batchBytes += bytes.byteLength;
        if (batchBytes >= BULK_INLINE_BYTES) {
          changes += await pushBlobsByHash(blobs, [...byHash.keys()], byHash);
          byHash.clear();
          batchBytes = 0;
        }
      }
      if (byHash.size > 0) {
        changes += await pushBlobsByHash(blobs, [...byHash.keys()], byHash);
      }
    }

    // Pass 4 — path upserts, skipping anything the remote already has at the
    // same hash.
    const now = new Date();
    let pathOps: AnyBulkWriteOperation<PathDoc>[] = [];
    const flushPathOps = async () => {
      if (pathOps.length === 0) return;
      await paths.bulkWrite(pathOps, { ordered: false });
      pathOps = [];
    };
    for (const f of localMetas) {
      const existing = remoteByPath.get(f.relPath);
      if (
        existing &&
        existing.deletedAt === null &&
        existing.hash === f.hash
      ) continue;
      pathOps.push({
        updateOne: {
          filter: { _id: f.relPath },
          update: {
            $set: {
              hash: f.hash,
              size: f.size,
              updatedAt: now,
              deletedAt: null,
            },
          },
          upsert: true,
        },
      });
      changes++;
      if (pathOps.length >= PUSH_BULK) await flushPathOps();
    }
    await flushPathOps();

    const hydrated = await sidecar.read();
    // Pass 5 — same lazy guard as fullWalkPush: don't tombstone within these
    // subtrees while the cache is an incomplete (lazy) mirror.
    if (!lazyPullActive) {
      const localPaths = new Set(localMetas.map((f) => f.relPath));
      let tombstoneOps: AnyBulkWriteOperation<PathDoc>[] = [];
      const flushTombstones = async () => {
        if (tombstoneOps.length === 0) return;
        await paths.bulkWrite(tombstoneOps, { ordered: false });
        tombstoneOps = [];
      };
      for (const [relPath, doc] of remoteByPath) {
        if (localPaths.has(relPath) || doc.deletedAt !== null) continue;
        let floor = watermarkIso;
        for (const [prefix, seen] of Object.entries(hydrated.scopeWatermarks)) {
          if (relPath.startsWith(prefix) && (floor === null || seen > floor)) {
            floor = seen;
          }
        }
        if (floor === null || doc.updatedAt > new Date(floor)) continue;
        tombstoneOps.push({
          updateOne: {
            filter: { _id: relPath },
            update: { $set: { deletedAt: now, updatedAt: now } },
          },
        });
        changes++;
        if (tombstoneOps.length >= PUSH_BULK) await flushTombstones();
      }
      await flushTombstones();
    }

    return changes;
  }

  return {
    capabilities(): SyncCapabilities {
      return {
        scopedSync: true,
        lazyHydration: true,
        namespacedSync: true,
        configRefresh: true,
        controlPlane: true,
      };
    },

    // The dirty sidecar remains the authoritative source of what to push;
    // `context.models` is advisory (matches the s3 reference, whose push
    // stays diff-driven). We don't scope the push by it.
    async pushChanged(options?: DatastoreSyncOptions): Promise<number> {
      bindNamespace(options);
      options?.signal?.throwIfAborted();
      const { paths, blobs } = await resources();
      const observed = await sidecar.beginPush();
      const state = observed.state;
      const lazy = await lazyPullActive();

      // First push from this cache must be a full walk so whatever is already
      // on disk gets bootstrapped to the remote — the per-path dirty tracker
      // only knows about writes since it started. `markDirty` on a missing
      // sidecar sets bulkInvalidated, but a `pullChanged` that runs first
      // (e.g. setup migrates files, then hydrates) writes a *clean* sidecar
      // and erases that signal, so the migrated cache would never be pushed
      // (issue #4). `pushBootstrapped` survives a pull and is only set true
      // by a completed push, so it closes that gap and also re-pushes the
      // content of any deployment that already hit the bug.
      const watermark = namespace
        ? state.scopeWatermarks[reconcileKey()] ??
          scopeFloor(state, `${namespace}/`)
        : reconcileWatermark(state);
      const bootstrapped = namespace
        ? state.scopeWatermarks[`@pushed/${namespace}/`] !== undefined
        : state.pushBootstrapped;
      if (state.bulkInvalidated || !bootstrapped) {
        const { changes, reconciledAt } = await fullWalkPush(
          paths,
          blobs,
          watermark,
          lazy,
          state,
        );
        await finishPush(observed, true);
        if (namespace) {
          // Hydration never proves that preexisting local files were pushed.
          await sidecar.advanceScopeWatermarks({
            [`@pushed/${namespace}/`]: new Date().toISOString(),
          });
        }
        // A full walk enumerated every remote path doc, so this cache has now
        // genuinely observed the complete remote list — record it so the next
        // push may tombstone paths this host itself wrote earlier. A lazy
        // cache is exempt: it never had the full local side to compare.
        if (!lazy) {
          if (namespace) {
            await sidecar.advanceScopeWatermarks({
              [reconcileKey()]: reconciledAt,
            });
          } else await sidecar.setLastReconciledAt(reconciledAt);
        }
        return changes;
      }

      // `dirtyPaths` arrives already coalesced: descendants of a dirty
      // directory are dropped, because pushRoots walks a dirty directory in
      // full. That is what turns the per-version markDirty storm into a
      // handful of roots.
      const roots = state.dirtyPaths.filter(inNamespace);
      if (roots.length === 0) return 0;

      let changes = 0;
      // Retire progress in slices. clearDirty used to run only after every
      // root had been reconciled, so a push that timed out or was killed
      // re-did all of its work next run — and the dirty set kept growing in
      // the meantime. Forgetting each slice as it lands makes an interrupted
      // push resume roughly where it stopped.
      for (let i = 0; i < roots.length; i += PUSH_ROOT_SLICE) {
        const slice = roots.slice(i, i + PUSH_ROOT_SLICE);
        changes += await pushRoots(
          paths,
          blobs,
          slice,
          watermark,
          lazy,
        );
        await sidecar.retirePush(
          observed,
          (path) =>
            slice.some((root) => path === root || path.startsWith(`${root}/`)),
          [],
          false,
        );
      }
      await finishPush(observed, false);
      return changes;
    },

    pullChanged(options?: DatastoreSyncOptions): Promise<number> {
      bindNamespace(options);
      options?.signal?.throwIfAborted();
      const nsPrefix = namespace ? `${namespace}/` : "";
      let prefixes: string[] | undefined;
      if (options?.subdirs !== undefined) {
        for (const sub of options.subdirs) {
          if (!isSafeRelativePath(sub)) {
            throw new Error("Invalid sync subdirectory");
          }
        }
        if (options.subdirs.length === 0) return Promise.resolve(0);
        prefixes = options.subdirs.map((sub) => `${nsPrefix}${sub}/`);
      } else {
        const models = modelPrefixes(options?.context?.models);
        if (models.length > 0) {
          prefixes = models.flatMap((path) => [
            `${nsPrefix}${path}`,
            `${nsPrefix}${path.replace(/^data\//, "outputs/")}`,
            `${nsPrefix}${path.replace(/^data\//, "definitions-evaluated/")}`,
          ]);
        } else if (namespace) prefixes = [`${namespace}/`];
      }
      return pull({
        prefixes,
        metadataOnly: options?.metadataOnly,
        namespaceFull: !!namespace && prefixes?.length === 1 &&
          prefixes[0] === `${namespace}/`,
      });
    },

    controlPlaneStore(): ControlPlaneStore {
      return createControlPlaneStore(cfg, getClient, repoDir, namespace);
    },

    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      const relPath = options?.relPath;
      // Drop dirty signals for the vault tier and host-local files — neither
      // ever syncs (see isSecretsPath / isExcludedPath). Filtering here keeps
      // per-command SQLite catalog churn out of the journal entirely. A bulk
      // invalidation (no relPath) still records.
      if (relPath !== undefined && isUnsyncable(relPath, namespace)) {
        return Promise.resolve();
      }
      return sidecar.recordDirty(relPath).then(() => undefined);
    },

    // Single-file hydration: one manifest lookup by path key, then one blob
    // fetch by content hash (assembling chunks for >15 MB blobs). No
    // watermark or sidecar interaction — this is a pure on-demand read of a
    // file the lazy setup pull deliberately skipped.
    async hydrateFile(relPath: string): Promise<boolean> {
      // The vault tier never syncs, so there's nothing to hydrate.
      if (isUnsyncable(relPath, namespace) || !inNamespace(relPath)) {
        return false;
      }
      const { paths, blobs } = await resources();
      const doc = await paths.findOne({ _id: relPath });
      if (doc === null || doc.deletedAt !== null) return false;

      const absPath = `${cachePath}/${relPath}`;
      const local = await readFileOrNull(absPath);
      if (local !== null && (await sha256Hex(local)) === doc.hash) return true;

      const bytes = await fetchBlobBytes(blobs, doc.hash);
      if (bytes === null) return false;
      await writeFileAtomic(absPath, bytes);
      return true;
    },
  };
}

// The instant up to which this cache is known to hold every path under
// `prefix` — the floor a scoped pull filters on.
//
// It is the later of two facts. `scopeWatermarks[prefix]` is what a previous
// scoped pull of this prefix established. `lastPulledAt` also qualifies:
// only a full, non-metadataOnly, unscoped pull sets it, and that pull
// hydrated everything — including this prefix.
//
// Neither alone is enough. `lastPulledAt` is untouched by scoped pulls, and
// core scopes nearly every pull once `scopedSync` is advertised, so on a host
// that mostly runs methods and workflows it can sit months behind while the
// repo is written to daily — every doc under every prefix then reads as new
// and no probe against it can ever fire. Conversely a brand-new prefix has no
// scope watermark, but a full pull may already have covered it.
export function scopeFloor(
  state: Pick<SidecarState, "scopeWatermarks" | "lastPulledAt">,
  prefix: string,
): string | null {
  const own = state.scopeWatermarks[prefix] ?? null;
  const global = state.lastPulledAt;
  if (own === null) return global;
  if (global === null) return own;
  return own > global ? own : global;
}

// Filter for a scoped pull: each prefix carries its own floor, so a step that
// locks a hot model and a dormant one doesn't rescan the dormant one.
//
// A prefix with no floor matches everything beneath it — the pre-watermark
// behavior, paid once, after which the pull records a floor.
export function scopedPullFilter(
  prefixes: string[],
  state: Pick<SidecarState, "scopeWatermarks" | "lastPulledAt">,
): { $or: Array<Record<string, unknown>> } {
  return {
    $or: prefixes.map((p) => {
      // Anchored and un-escaped at the leading `^`, so MongoDB can turn the
      // regex into index bounds on `_id` rather than scanning the collection.
      const clause: Record<string, unknown> = {
        _id: { $regex: `^${escapeRegex(p)}` },
      };
      const floor = scopeFloor(state, p);
      if (floor !== null) clause.updatedAt = { $gte: new Date(floor) };
      return clause;
    }),
  };
}

// Maps a scoped-sync model list to the cache-relative path prefixes that hold
// each model's bytes. Mirrors swamp core's per-model lock key root
// (`data/<modelType>/<modelId>/.lock`) and the s3 reference's pull scope.
export function modelPrefixes(
  models: ReadonlyArray<{ modelType: string; modelId: string }> | undefined,
): string[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => `data/${m.modelType}/${m.modelId}/`);
}

async function pushBlobsByHash(
  blobs: Collection<BlobDoc>,
  hashes: string[],
  localByHash: Map<string, Uint8Array>,
): Promise<number> {
  if (hashes.length === 0) return 0;
  const inlineHashes: string[] = [];
  const chunkedHashes: string[] = [];
  for (const h of hashes) {
    const bytes = localByHash.get(h);
    if (bytes === undefined) continue;
    if (bytes.byteLength <= BLOB_INLINE_MAX) inlineHashes.push(h);
    else chunkedHashes.push(h);
  }

  let pushed = 0;
  let i = 0;
  while (i < inlineHashes.length) {
    const ops: AnyBulkWriteOperation<BlobDoc>[] = [];
    let batchBytes = 0;
    while (
      i < inlineHashes.length &&
      ops.length < PUSH_BULK &&
      batchBytes < BULK_INLINE_BYTES
    ) {
      const h = inlineHashes[i++];
      const bytes = localByHash.get(h)!;
      batchBytes += bytes.byteLength + 64;
      ops.push({
        insertOne: {
          document: {
            _id: h,
            size: bytes.byteLength,
            createdAt: new Date(),
            data: new Binary(bytes),
          },
        },
      });
    }
    pushed += await safeBulkInsertBlobs(blobs, ops);
  }

  for (const h of chunkedHashes) {
    const bytes = localByHash.get(h)!;
    pushed += await pushChunkedBlob(blobs, h, bytes);
  }
  return pushed;
}

async function pushChunkedBlob(
  blobs: Collection<BlobDoc>,
  hash: string,
  bytes: Uint8Array,
): Promise<number> {
  const size = bytes.byteLength;
  const chunkCount = Math.ceil(size / BLOB_CHUNK_BYTES);

  // Insert chunks first. Dup-key on any chunk is tolerated so a previously
  // interrupted push can finish without re-uploading completed chunks.
  let chunksWritten = 0;
  for (let i = 0; i < chunkCount; i++) {
    const start = i * BLOB_CHUNK_BYTES;
    const end = Math.min(start + BLOB_CHUNK_BYTES, size);
    const chunkBytes = bytes.subarray(start, end);
    chunksWritten += await safeBulkInsertBlobs(blobs, [{
      insertOne: {
        document: {
          _id: `${hash}:${i}`,
          size: chunkBytes.byteLength,
          createdAt: new Date(),
          data: new Binary(chunkBytes),
        },
      },
    }]);
  }

  // Header written last so readers never see a header pointing at missing
  // chunks. If the header already exists, another writer beat us — treat as
  // success.
  const headerWritten = await safeBulkInsertBlobs(blobs, [{
    insertOne: {
      document: { _id: hash, size, createdAt: new Date(), chunkCount },
    },
  }]);
  return chunksWritten + headerWritten;
}

// Fetches a blob's full bytes by content hash, transparently assembling
// chunked blobs. Returns null when no blob doc exists for the hash.
async function fetchBlobBytes(
  blobs: Collection<BlobDoc>,
  hash: string,
): Promise<Uint8Array | null> {
  const blob = await blobs.findOne({ _id: hash });
  if (blob === null) return null;
  if (blob.data) return blob.data.buffer;
  return await assembleChunkedBlob(blobs, blob);
}

async function assembleChunkedBlob(
  blobs: Collection<BlobDoc>,
  header: BlobDoc,
): Promise<Uint8Array> {
  const chunkCount = header.chunkCount;
  if (chunkCount === undefined || chunkCount <= 0) {
    throw new Error(
      `Blob ${header._id} has neither inline data nor a positive chunkCount`,
    );
  }
  const chunkIds = Array.from(
    { length: chunkCount },
    (_, i) => `${header._id}:${i}`,
  );
  const parts = new Map<number, Uint8Array>();
  for await (
    const doc of blobs.find({ _id: { $in: chunkIds } })
  ) {
    if (!doc.data) {
      throw new Error(`Blob chunk ${doc._id} has no data field`);
    }
    const colon = doc._id.lastIndexOf(":");
    const idx = parseInt(doc._id.slice(colon + 1), 10);
    parts.set(idx, doc.data.buffer);
  }
  const out = new Uint8Array(header.size);
  let offset = 0;
  for (let i = 0; i < chunkCount; i++) {
    const part = parts.get(i);
    if (!part) {
      throw new Error(`Missing chunk ${i} for blob ${header._id}`);
    }
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function safeBulkInsertBlobs(
  blobs: Collection<BlobDoc>,
  ops: AnyBulkWriteOperation<BlobDoc>[],
): Promise<number> {
  if (ops.length === 0) return 0;
  try {
    const res = await blobs.bulkWrite(ops, { ordered: false });
    return res.insertedCount ?? 0;
  } catch (err) {
    const wErr = err as {
      writeErrors?: Array<{ code: number; errmsg?: string; index?: number }>;
      insertedCount?: number;
    };
    const writeErrors = wErr.writeErrors ?? [];
    const fatal = writeErrors.find(
      (e) => e.code !== ERR_DUP_KEY && e.code !== ERR_DOC_TOO_LARGE,
    );
    if (fatal) throw err;
    if (writeErrors.length === 0) throw err;
    return wErr.insertedCount ?? 0;
  }
}

function addToBucket<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        await worker(items[i]);
      }
    }),
  );
}

// Metadata-only walk: hashes each file and drops its bytes immediately,
// recording where to find them again if the remote turns out to need them.
// Both push paths share it — the old walkInto accumulated every file's bytes,
// so one dirty data-name directory holding 15k versions pinned all of them in
// RAM, and the old walkAndStream had to decide push-or-skip inline, which
// forced the whole blob-id prefetch.
async function walkMetas(
  root: string,
  relRoot: string,
  out: LocalMeta[],
  hashToAbs: Map<string, string>,
  namespace?: string,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isSymlink) continue;
      const childAbs = `${root}/${entry.name}`;
      const childRel = `${relRoot}/${entry.name}`;
      if (isUnsyncable(childRel, namespace)) continue;
      if (entry.isDirectory) {
        await walkMetas(childAbs, childRel, out, hashToAbs, namespace);
        continue;
      }
      if (!entry.isFile) continue;
      if (isExcludedPath(childRel)) continue;
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(childAbs);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) continue;
        throw err;
      }
      const hash = await sha256Hex(bytes);
      out.push({ relPath: childRel, hash, size: bytes.byteLength });
      if (!hashToAbs.has(hash)) hashToAbs.set(hash, childAbs);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function removeSilentlyExisting(path: string): Promise<boolean> {
  try {
    await Deno.remove(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function readFileOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function writeFileAtomic(
  absPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const slash = absPath.lastIndexOf("/");
  const dir = slash > 0 ? absPath.slice(0, slash) : ".";
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, absPath);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type { SidecarState };
