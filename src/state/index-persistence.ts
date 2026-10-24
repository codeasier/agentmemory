import {
  VectorIndex,
  base64ToFloat32,
  decodePersistedEmbedding,
  float32ToBase64,
  float32ToFloat16Base64,
  base64ToFloat16,
  float16ToBase64,
  type VectorEntry,
} from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { logger } from "../logger.js";
import { safeAudit } from "../functions/audit.js";
import { getIndexSaveIntervalMs, getVectorBucketSize } from "../config.js";

const FAILURE_LOG_THROTTLE_MS = 60_000;
const INDEX_PERSISTENCE_FUNCTION_ID = "mem::index-persistence";
const LEGACY_BM25_KEY = "data";
const LEGACY_BM25_MANIFEST_KEY = "data:manifest";
const LEGACY_VECTOR_KEY = "vectors";
const LEGACY_VECTOR_MANIFEST_KEY = "vectors:manifest";
const VECTOR_META_KEY = "vectors:meta";
const VECTOR_BUCKET_SCOPE_PREFIX = `${KV.bm25Index}:vec:`;
const WRITE_CONCURRENCY = 32;
const LOAD_CONCURRENCY = 8;
const FIRST_CHECKPOINT_DELAY_MS = 5_000;
const PENDING_CLEAR_KEY = "~clear";
const PENDING_LOG_SAVE_THRESHOLD = 500;
const EARLY_SAVE_MIN_GAP_MS = 5_000;
const BACKFILL_MARKER_KEY = "vectors:backfill";
const MEMORY_ID_PREFIX = "mem_";

function auditIndexPersistEnabled(): boolean {
  const raw = process.env.AGENTMEMORY_AUDIT_INDEX_PERSIST;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

type IndexShardManifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number }>;
  chars: number;
};

type VectorMeta = {
  v: 3 | 4;
  bucketCount: number;
  savedAt: string;
  count: number;
};

type PersistedVector = {
  id: string;
  s: string;
  e: string;
  c?: "f16";
};

type PendingVectorRow = {
  q: number;
  id?: string;
  s?: string;
  k?: "memory" | "observation";
  e?: string;
  t?: 1;
  c?: 1;
};

type BackfillMarker = {
  v: 1;
  since: string;
};

export interface PendingReplayResult {
  entries: number;
  added: number;
  removed: number;
  cleared: boolean;
  skipped: number;
}

type IndexPersistenceOptions = {
  saveIntervalMs?: number;
  bucketSize?: number;
  now?: () => number;
  shouldLoadVector?: (id: string) => boolean;
};

export interface IndexLegStatus {
  lastSavedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  dirtySince: string | null;
}

export interface VectorCountShortfall {
  expected: number;
  loaded: number;
}

export interface IndexPersistenceStatus {
  saveIntervalMs: number;
  firstCheckpointPending?: boolean;
  nextSaveAt?: string | null;
  saving: boolean;
  buckets: number;
  pendingChanges: number;
  orphanDeletes: number;
  vector: IndexLegStatus | null;
  vectorCountShortfall: VectorCountShortfall | null;
  pendingLog?: number;
  pendingLogError?: string | null;
}

export type VectorLoadState = "buckets" | "migrated" | "none" | "unavailable";

export interface VectorLoadResult {
  vector: VectorIndex | null;
  state: VectorLoadState;
  savedAt: string | null;
  expectedCount?: number;
  loadedCount?: number;
}

export function vectorBucketScope(bucket: number): string {
  return `${VECTOR_BUCKET_SCOPE_PREFIX}${String(bucket).padStart(4, "0")}`;
}

function statePath(scope: string, key: string): string {
  return `${scope}/${key}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function generationTime(generation: string | undefined): string | null {
  const stamp = generation?.split("_")[1];
  if (!stamp) return null;
  const ms = parseInt(stamp, 36);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function isValidShardDescriptor(
  shard: unknown,
): shard is IndexShardManifest["shards"][number] {
  if (!shard || typeof shard !== "object") return false;
  const candidate = shard as { scope?: unknown; key?: unknown; chars?: unknown };
  return (
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    Number.isInteger(candidate.chars) &&
    (candidate.chars as number) >= 0
  );
}

function isPersistedVector(row: unknown): row is PersistedVector {
  if (!row || typeof row !== "object") return false;
  const candidate = row as Partial<PersistedVector>;
  if (typeof candidate.id !== "string" || typeof candidate.s !== "string" || typeof candidate.e !== "string") {
    return false;
  }
  return candidate.c === undefined || candidate.c === "f16";
}

function isBucketMeta(meta: unknown): meta is VectorMeta {
  if (!meta || typeof meta !== "object") return false;
  const candidate = meta as Partial<VectorMeta>;
  return (
    (candidate.v === 3 || candidate.v === 4) &&
    Number.isInteger(candidate.bucketCount) &&
    (candidate.bucketCount as number) >= 0
  );
}

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const results = await Promise.allSettled(items.slice(offset, offset + size).map(run));
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  return failures;
}

function isPendingVectorRow(row: unknown): row is PendingVectorRow {
  if (!row || typeof row !== "object") return false;
  const candidate = row as PendingVectorRow;
  if (typeof candidate.q !== "number" || !Number.isFinite(candidate.q)) return false;
  if (candidate.c === 1) return true;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
  return candidate.t === 1 || typeof candidate.e === "string";
}

function emptyLegStatus(): IndexLegStatus {
  return { lastSavedAt: null, lastError: null, lastErrorAt: null, dirtySince: null };
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFailureLogAt = 0;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private stopped = false;
  private lastSaveAt: number;
  private dirtyEpoch = 0;
  private markedDuringRunAt: number | null = null;
  private metaWritten = false;
  private firstSaveAttempted = false;
  private nextSaveAt: number | null = null;
  private leg: IndexLegStatus = emptyLegStatus();
  private readonly saveIntervalMs: number;
  private readonly bucketSize: number;
  private readonly now: () => number;
  private bucketOfId: Map<string, number> = new Map();
  private bucketCounts: Map<number, number> = new Map();
  private highestBucket = 0;
  private hasOpenBucket = false;
  private vectorCountShortfall: VectorCountShortfall | null = null;
  private orphanDeletes: Array<{ bucket: number; id: string }> = [];
  private seq = 0;
  private pendingLog: Map<string, number> = new Map();
  private logChains: Map<string, Promise<void>> = new Map();
  private logSuppressed = false;
  private pendingLogUnknown = false;
  private pendingLogError: string | null = null;
  private earlySaveQueued = false;
  private readonly shouldLoadVector: (id: string) => boolean;
  private retryLogRows = new Map<string, PendingVectorRow>();

  constructor(
    private kv: StateKV,
    private vector: VectorIndex | null,
    options: IndexPersistenceOptions = {},
  ) {
    this.vector?.setChangeListener((id, entry) => this.logChange(id, entry));
    this.now = options.now ?? Date.now;
    this.shouldLoadVector = options.shouldLoadVector ?? (() => true);
    const interval = options.saveIntervalMs;
    this.saveIntervalMs =
      typeof interval === "number" && Number.isFinite(interval) && interval > 0
        ? interval
        : getIndexSaveIntervalMs();
    const bucketSize = options.bucketSize;
    this.bucketSize =
      typeof bucketSize === "number" && Number.isInteger(bucketSize) && bucketSize > 0
        ? bucketSize
        : getVectorBucketSize();
    this.lastSaveAt = this.now();
  }

  scheduleSave(): void {
    if (this.stopped || !this.vector?.pendingChanges) return;
    const now = this.now();
    this.dirtyEpoch++;
    if (this.running && this.markedDuringRunAt === null) this.markedDuringRunAt = now;
    if (this.leg.dirtySince === null) this.leg.dirtySince = new Date(now).toISOString();
    this.queueSave();
  }

  save(): Promise<void> {
    this.clearTimer();
    if (this.queued) return this.queued;
    if (this.running) {
      const queued = this.running.then(() => {
        this.queued = null;
        return this.startRun();
      });
      this.queued = queued;
      return queued;
    }
    return this.startRun();
  }

  status(): IndexPersistenceStatus {
    return {
      saveIntervalMs: this.saveIntervalMs,
      firstCheckpointPending: Boolean(this.vector && !this.metaWritten && (this.vector.pendingChanges > 0 || this.running)),
      nextSaveAt: this.nextSaveAt === null ? null : new Date(this.nextSaveAt).toISOString(),
      saving: this.running !== null,
      buckets: this.bucketCountInUse(),
      pendingChanges: this.vector?.pendingChanges ?? 0,
      orphanDeletes: this.orphanDeletes.length,
      vector: this.vector ? { ...this.leg } : null,
      vectorCountShortfall: this.vectorCountShortfall,
      pendingLog: this.vector ? this.pendingLog.size : 0,
      pendingLogError: this.pendingLogError,
    };
  }

  async replayPendingLog(expectedDimensions = 0): Promise<PendingReplayResult> {
    const result: PendingReplayResult = { entries: 0, added: 0, removed: 0, cleared: false, skipped: 0 };
    const vector = this.vector;
    if (!vector) return result;
    let rows: unknown[];
    try {
      rows = await this.kv.list<unknown>(KV.vectorPendingLog);
    } catch (err) {
      this.pendingLogUnknown = true;
      this.pendingLogError = errorMessage(err);
      logger.warn("index persistence: could not read the pending vector log", { message: this.pendingLogError });
      return result;
    }
    const valid = (Array.isArray(rows) ? rows : []).filter(isPendingVectorRow).sort((a, b) => a.q - b.q);
    this.logSuppressed = true;
    try {
      for (const row of valid) {
        result.entries++;
        const key = row.c === 1 ? PENDING_CLEAR_KEY : row.id!;
        if ((this.pendingLog.get(key) ?? -Infinity) < row.q) this.pendingLog.set(key, row.q);
        if (row.q > this.seq) this.seq = row.q;
        if (row.c === 1) {
          vector.clear();
          for (const id of this.bucketOfId.keys()) vector.markRemoved(id);
          for (const id of this.pendingLog.keys()) {
            if (id !== PENDING_CLEAR_KEY) vector.markRemoved(id);
          }
          result.cleared = true;
          continue;
        }
        const id = row.id!;
        if (row.t === 1) {
          if (vector.has(id) || this.bucketOfId.has(id)) {
            vector.remove(id);
            result.removed++;
          }
          continue;
        }
        let embedding: Float32Array;
        try {
          embedding = base64ToFloat32(row.e!);
        } catch {
          result.skipped++;
          continue;
        }
        if (embedding.length === 0 || (expectedDimensions > 0 && embedding.length !== expectedDimensions)) {
          result.skipped++;
          continue;
        }
        vector.add(id, typeof row.s === "string" ? row.s : "", embedding);
        if (!this.shouldLoadVector(id)) vector.evictResident(id);
        result.added++;
      }
    } finally {
      this.logSuppressed = false;
    }
    if (result.added + result.removed > 0 || result.cleared) this.scheduleSave();
    return result;
  }

  async readBackfillMarker(): Promise<string | null> {
    if (!this.vector) return null;
    try {
      const marker = await this.kv.get<BackfillMarker>(KV.bm25Index, BACKFILL_MARKER_KEY);
      return marker && typeof marker.since === "string" && !Number.isNaN(Date.parse(marker.since)) ? marker.since : null;
    } catch (err) {
      logger.warn("index persistence: vector backfill marker read failed", { message: errorMessage(err) });
      return null;
    }
  }

  async markBackfillSince(since: string): Promise<void> {
    if (!this.vector || Number.isNaN(Date.parse(since))) return;
    const current = await this.readBackfillMarker();
    if (current !== null && Date.parse(current) <= Date.parse(since)) return;
    await this.kv.set<BackfillMarker>(KV.bm25Index, BACKFILL_MARKER_KEY, { v: 1, since });
  }

  async clearBackfillMarker(): Promise<void> {
    if (!this.vector) return;
    await this.kv.delete(KV.bm25Index, BACKFILL_MARKER_KEY);
  }

  async flushPendingLog(): Promise<void> {
    await Promise.all([...this.logChains.values()]);
    const rows = [...this.retryLogRows];
    await Promise.all(rows.map(([key, row]) => this.writeLogRow(key, row)));
    if (this.retryLogRows.size === 0) this.pendingLogError = null;
  }

  reconcileIndex(keep: (id: string) => boolean): number {
    const removed = new Set<string>();
    for (const id of this.bucketOfId.keys()) {
      if (keep(id)) continue;
      this.vector?.evictResident(id);
      this.vector?.markRemoved(id);
      removed.add(id);
    }
    if (this.vector) {
      for (const id of [...this.vector.keys()]) {
        if (keep(id)) continue;
        this.vector.evictResident(id);
        this.vector.markRemoved(id);
        removed.add(id);
      }
    }
    if (removed.size > 0) this.scheduleSave();
    return removed.size;
  }

  private nextSeq(): number {
    this.seq = Math.max(this.seq + 1, this.now() * 1000);
    return this.seq;
  }

  private logChange(id: string | null, entry: VectorEntry | null): void {
    if (this.logSuppressed) return;
    const key = id ?? PENDING_CLEAR_KEY;
    const q = this.nextSeq();
    let row: PendingVectorRow;
    if (id === null) {
      for (const storedId of this.bucketOfId.keys()) this.vector?.markRemoved(storedId);
      for (const pendingId of this.pendingLog.keys()) {
        if (pendingId !== PENDING_CLEAR_KEY) this.vector?.markRemoved(pendingId);
      }
      row = { q, c: 1 };
    } else if (entry) {
      row = {
        q,
        id,
        s: entry.sessionId,
        k: id.startsWith(MEMORY_ID_PREFIX) ? "memory" : "observation",
        e: float32ToBase64(entry.embedding),
      };
    } else {
      row = { q, id, t: 1 };
    }
    this.pendingLog.set(key, q);
    this.retryLogRows.set(key, row);
    this.writeLogRow(key, row).then(
      () => {
        this.pendingLogError = null;
      },
      (err) => {
        this.pendingLogError = errorMessage(err);
        this.logFailure(err);
      },
    );
    this.maybeEarlySave();
  }

  private writeLogRow(key: string, row: PendingVectorRow): Promise<void> {
    return this.enqueueLog(key, async () => {
      if (this.retryLogRows.get(key)?.q !== row.q) return;
      await this.kv.set<PendingVectorRow>(KV.vectorPendingLog, key, row);
      if (this.retryLogRows.get(key)?.q === row.q) this.retryLogRows.delete(key);
    });
  }

  private enqueueLog(key: string, op: () => Promise<void>): Promise<void> {
    const run = (this.logChains.get(key) ?? Promise.resolve()).then(op);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.logChains.set(key, tail);
    void tail.then(() => {
      if (this.logChains.get(key) === tail) this.logChains.delete(key);
    });
    return run;
  }

  private maybeEarlySave(): void {
    if (this.stopped || this.running || this.earlySaveQueued) return;
    if (this.pendingLog.size < PENDING_LOG_SAVE_THRESHOLD) return;
    if (this.now() - this.lastSaveAt < EARLY_SAVE_MIN_GAP_MS) return;
    this.earlySaveQueued = true;
    setTimeout(() => {
      this.earlySaveQueued = false;
      this.save().catch((err) => this.logFailure(err));
    }, 0);
  }

  private deletePendingKey(key: string, q: number | undefined): Promise<void> {
    return this.enqueueLog(key, async () => {
      if (this.pendingLog.get(key) !== q) return;
      await this.kv.delete(KV.vectorPendingLog, key);
      if (this.pendingLog.get(key) === q) this.pendingLog.delete(key);
    });
  }

  private async clearCoveredPendingLog(coveredSeq: number): Promise<void> {
    const clearSeq = this.pendingLog.get(PENDING_CLEAR_KEY);
    if (clearSeq !== undefined ? clearSeq <= coveredSeq : this.pendingLogUnknown) {
      await this.deletePendingKey(PENDING_CLEAR_KEY, clearSeq);
    }
    const covered = [...this.pendingLog].filter(([key, q]) => key !== PENDING_CLEAR_KEY && q <= coveredSeq);
    const failures = await inBatches(covered, WRITE_CONCURRENCY, ([key, q]) => this.deletePendingKey(key, q));
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${covered.length} pending vector log deletes failed: ${errorMessage(failures[0])}`);
    }
    this.pendingLogUnknown = false;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  async load(): Promise<VectorLoadResult> {
    if (!this.vector) {
      await this.removeLegacyBm25Snapshot();
      return { vector: null, state: "none", savedAt: null };
    }

    let meta: VectorMeta | null;
    try {
      meta = await this.kv.get<VectorMeta>(KV.bm25Index, VECTOR_META_KEY);
    } catch (err) {
      logger.warn("index persistence: vector metadata read failed", { message: errorMessage(err) });
      return { vector: null, state: "unavailable", savedAt: null };
    }

    if (isBucketMeta(meta)) {
      const loaded = await this.loadBuckets(meta.bucketCount, meta.v);
      if (!loaded) return { vector: null, state: "unavailable", savedAt: null };
      this.metaWritten = true;
      await this.removeLegacyVectorSnapshotIfPresent();
      await this.removeLegacyBm25Snapshot();
      const expectedCount = Number.isInteger(meta.count) ? meta.count : undefined;
      this.vectorCountShortfall =
        expectedCount !== undefined && this.bucketOfId.size < expectedCount
          ? { expected: expectedCount, loaded: this.bucketOfId.size }
          : null;
      if (this.vectorCountShortfall) {
        logger.warn("index persistence: loaded fewer vectors than the last save recorded", {
          ...this.vectorCountShortfall,
        });
      }
      return { vector: loaded, state: "buckets", savedAt: meta.savedAt ?? null, expectedCount, loadedCount: this.bucketOfId.size };
    }

    return this.migrateLegacy();
  }

  private bucketCountInUse(): number {
    return this.hasOpenBucket ? this.highestBucket + 1 : 0;
  }

  private assignBucket(id: string): number {
    const existing = this.bucketOfId.get(id);
    if (existing !== undefined) return existing;
    if (!this.hasOpenBucket) {
      this.hasOpenBucket = true;
      this.highestBucket = 0;
    } else if ((this.bucketCounts.get(this.highestBucket) ?? 0) >= this.bucketSize) {
      this.highestBucket++;
    }
    this.bucketOfId.set(id, this.highestBucket);
    this.bucketCounts.set(this.highestBucket, (this.bucketCounts.get(this.highestBucket) ?? 0) + 1);
    return this.highestBucket;
  }

  private releaseBucket(id: string): void {
    const bucket = this.bucketOfId.get(id);
    if (bucket === undefined) return;
    this.bucketOfId.delete(id);
    const remaining = (this.bucketCounts.get(bucket) ?? 1) - 1;
    if (remaining > 0) this.bucketCounts.set(bucket, remaining);
    else this.bucketCounts.delete(bucket);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextSaveAt = null;
  }

  private queueSave(): void {
    if (this.stopped || this.timer || !this.vector?.pendingChanges) return;
    const now = this.now();
    const remaining = Math.max(0, this.lastSaveAt + this.saveIntervalMs - now);
    const delay = !this.metaWritten && !this.firstSaveAttempted
      ? Math.min(FIRST_CHECKPOINT_DELAY_MS, remaining)
      : remaining;
    this.nextSaveAt = now + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextSaveAt = null;
      this.save().catch((err) => this.logFailure(err));
    }, delay);
  }

  private startRun(): Promise<void> {
    const run = this.runSave().finally(() => {
      if (this.running === run) this.running = null;
      if (!this.queued) this.queueSave();
    });
    this.running = run;
    return run;
  }

  private async runSave(): Promise<void> {
    const vector = this.vector;
    if (!vector) return;
    if (vector.pendingChanges === 0 && this.orphanDeletes.length === 0 && this.pendingLog.size === 0 && this.retryLogRows.size === 0) return;
    const epoch = this.dirtyEpoch;
    this.markedDuringRunAt = null;
    this.lastSaveAt = this.now();
    this.firstSaveAttempted = true;
    const coveredSeq = this.seq;
    try {
      await this.writeChanges(vector);
      await this.flushPendingLog();
      await this.clearCoveredPendingLog(coveredSeq).catch((err) => {
        this.pendingLogError = errorMessage(err);
        this.logFailure(err);
      });
      if (this.pendingLog.size === 0 && this.retryLogRows.size === 0) this.pendingLogError = null;
      this.leg.lastSavedAt = new Date(this.now()).toISOString();
      this.leg.lastError = null;
      this.leg.lastErrorAt = null;
      if (this.dirtyEpoch === epoch || vector.pendingChanges === 0) {
        this.leg.dirtySince = null;
      } else if (this.markedDuringRunAt !== null) {
        this.leg.dirtySince = new Date(this.markedDuringRunAt).toISOString();
      }
    } catch (err) {
      this.leg.lastError = errorMessage(err);
      this.leg.lastErrorAt = new Date(this.now()).toISOString();
      if (this.leg.dirtySince === null) this.leg.dirtySince = this.leg.lastErrorAt;
      this.lastSaveAt = this.now();
      this.clearTimer();
      this.logFailure(err);
    }
  }

  private async writeChanges(vector: VectorIndex): Promise<void> {
    const changes = vector.takeChanges();
    if (changes.size === 0 && this.orphanDeletes.length === 0) return;
    const failed = new Map<string, boolean>();
    const orphans = this.orphanDeletes;
    this.orphanDeletes = [];
    const orphanFailures = await inBatches(orphans, WRITE_CONCURRENCY, async ({ bucket, id }) => {
      try {
        await this.kv.delete(vectorBucketScope(bucket), id);
      } catch (err) {
        this.orphanDeletes.push({ bucket, id });
        throw err;
      }
    });
    if (orphanFailures.length > 0) {
      vector.returnChanges(changes);
      throw new Error(
        `${orphanFailures.length} of ${orphans.length} orphan vector deletes failed: ${errorMessage(orphanFailures[0])}`,
      );
    }
    const failures = await inBatches([...changes], WRITE_CONCURRENCY, async ([id, present]) => {
      const entry = present ? vector.get(id) : undefined;
      const half = entry ? vector.getFloat16(id) : undefined;
      try {
        if (present) {
          let sessionId = entry?.sessionId;
          let encoded: string;
          if (entry) {
            encoded = float16ToBase64(half!);
          } else {
            await this.flushPendingLog();
            const row = await this.kv.get<PendingVectorRow>(KV.vectorPendingLog, id);
            if (!row?.e || row.t === 1 || row.c === 1) {
              throw new Error(`Cannot checkpoint nonresident vector ${id}: pending embedding unavailable`);
            }
            sessionId = row.s ?? "";
            encoded = float32ToFloat16Base64(base64ToFloat32(row.e));
          }
          const bucket = this.assignBucket(id);
          await this.kv.set<PersistedVector>(vectorBucketScope(bucket), id, {
            id,
            s: sessionId!,
            e: encoded,
            c: "f16",
          });
        } else {
          const bucket = this.bucketOfId.get(id);
          if (bucket !== undefined) {
            await this.kv.delete(vectorBucketScope(bucket), id);
            this.releaseBucket(id);
          }
        }
      } catch (err) {
        failed.set(id, present);
        throw err;
      }
    });
    if (failures.length > 0) {
      vector.returnChanges(failed);
      throw new Error(
        `${failures.length} of ${changes.size} vector writes failed: ${errorMessage(failures[0])}`,
      );
    }
    try {
      await this.kv.set<VectorMeta>(KV.bm25Index, VECTOR_META_KEY, {
        v: 4,
        bucketCount: this.bucketCountInUse(),
        savedAt: new Date(this.now()).toISOString(),
        count: this.bucketOfId.size,
      });
    } catch (err) {
      vector.returnChanges(changes);
      throw err;
    }
    this.metaWritten = true;
  }

  private async loadBuckets(bucketCount: number, metaVersion: 3 | 4): Promise<VectorIndex | null> {
    const loaded = new VectorIndex();
    const bucketOfId = new Map<string, number>();
    const bucketCodec = new Map<string, "f16" | undefined>();
    const orphans: Array<{ bucket: number; id: string }> = [];
    const bucketIds = Array.from({ length: bucketCount }, (_, bucket) => bucket);
    const failures = await inBatches(bucketIds, LOAD_CONCURRENCY, async (bucket) => {
      const rows = await this.kv.list<unknown>(vectorBucketScope(bucket));
      for (const raw of rows) {
        if (!isPersistedVector(raw)) continue;
        const codec = raw.c === "f16" ? "f16" : undefined;
        const prevBucket = bucketOfId.get(raw.id);
        if (prevBucket !== undefined) {
          if (codec === "f16" && bucketCodec.get(raw.id) !== "f16") {
            orphans.push({ bucket: prevBucket, id: raw.id });
          } else {
            orphans.push({ bucket, id: raw.id });
            continue;
          }
        }
        try {
          if (codec === "f16") {
            const embedding = base64ToFloat16(raw.e);
            if (this.shouldLoadVector(raw.id)) loaded.loadPersistedFloat16(raw.id, raw.s, embedding);
          } else {
            const embedding = decodePersistedEmbedding(raw.e, codec);
            if (this.shouldLoadVector(raw.id)) loaded.loadPersisted(raw.id, raw.s, embedding);
          }
        } catch {
          continue;
        }
        bucketOfId.set(raw.id, bucket);
        bucketCodec.set(raw.id, codec);
      }
    });
    if (failures.length > 0) {
      logger.warn("index persistence: vector bucket read failed", {
        failed: failures.length,
        message: errorMessage(failures[0]),
      });
      return null;
    }
    const bucketCounts = new Map<number, number>();
    for (const bucket of bucketOfId.values()) {
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    }
    this.bucketOfId = bucketOfId;
    this.bucketCounts = bucketCounts;
    this.highestBucket = bucketCount > 0 ? bucketCount - 1 : 0;
    this.hasOpenBucket = bucketCount > 0;
    this.orphanDeletes = orphans;
    if (orphans.length > 0) {
      logger.info("index persistence: duplicate vector rows queued for delete", {
        orphans: orphans.length,
        kept: loaded.size,
      });
    }
    let sawLegacyCodec = false;
    for (const codec of bucketCodec.values()) {
      if (codec !== "f16") {
        sawLegacyCodec = true;
        break;
      }
    }
    if (metaVersion === 3 || sawLegacyCodec) {
      loaded.markAllChanged();
    }
    return loaded;
  }

  private async migrateLegacy(): Promise<VectorLoadResult> {
    const manifest = await this.readIndexValue<IndexShardManifest>(
      KV.bm25Index,
      LEGACY_VECTOR_MANIFEST_KEY,
      "vector",
      "manifest",
    );
    const legacyKey = await this.readIndexValue<string>(KV.bm25Index, LEGACY_VECTOR_KEY, "vector", "legacy");
    if (!manifest.ok || !legacyKey.ok) return { vector: null, state: "unavailable", savedAt: null };
    const legacyPresent = manifest.value != null || (typeof legacyKey.value === "string" && legacyKey.value.length > 0);
    if (!legacyPresent) {
      await this.removeLegacyBm25Snapshot();
      return { vector: null, state: "none", savedAt: null };
    }

    const data = await this.loadShardedData(LEGACY_VECTOR_KEY, LEGACY_VECTOR_MANIFEST_KEY, "vector");
    if (typeof data !== "string") {
      logger.warn("index persistence: legacy vector snapshot is unreadable; keeping it and skipping migration");
      return { vector: null, state: "unavailable", savedAt: null };
    }
    const legacy = VectorIndex.deserialize(data);
    const savedAt =
      (manifest.value && typeof manifest.value === "object" ? generationTime(manifest.value.generation) : null) ??
      new Date(this.now()).toISOString();

    const staging = new VectorIndex();
    for (const [id, entry] of legacy.entries()) staging.add(id, entry.sessionId, entry.embedding);
    try {
      await this.writeChanges(staging);
    } catch (err) {
      logger.warn("index persistence: migrating the legacy vector snapshot failed; it stays in place and the next save retries", {
        message: errorMessage(err),
      });
      legacy.markAllChanged();
      return { vector: legacy, state: "unavailable", savedAt };
    }

    await this.removeLegacyVectorSnapshot(manifest.value);
    await this.removeLegacyBm25Snapshot();
    await this.auditIndexPersistence("migrate", [statePath(KV.bm25Index, VECTOR_META_KEY)], {
      vectors: legacy.size,
      buckets: this.bucketCountInUse(),
    });
    logger.info("index persistence: migrated the vector index to bucketed storage", {
      vectors: legacy.size,
      buckets: this.bucketCountInUse(),
    });
    const migrated = new VectorIndex();
    for (const [id, entry] of legacy.entries()) {
      if (this.shouldLoadVector(id)) migrated.loadPersisted(id, entry.sessionId, entry.embedding);
    }
    return { vector: migrated, state: "migrated", savedAt, loadedCount: legacy.size };
  }

  private async removeLegacyVectorSnapshot(manifest: IndexShardManifest | null): Promise<void> {
    if (manifest && Array.isArray(manifest.shards)) {
      await this.deleteShards(manifest.shards.filter(isValidShardDescriptor), "legacy_vector_cleanup");
    }
    await this.deleteKey(KV.bm25Index, LEGACY_VECTOR_MANIFEST_KEY, "legacy_vector_cleanup");
    await this.deleteKey(KV.bm25Index, LEGACY_VECTOR_KEY, "legacy_vector_cleanup");
  }

  private async removeLegacyVectorSnapshotIfPresent(): Promise<void> {
    const manifest = await this.readIndexValue<IndexShardManifest>(KV.bm25Index, LEGACY_VECTOR_MANIFEST_KEY, "vector", "manifest");
    const legacy = await this.readIndexValue<string>(KV.bm25Index, LEGACY_VECTOR_KEY, "vector", "legacy");
    if (!manifest.ok || !legacy.ok) return;
    if (manifest.value == null && legacy.value == null) return;
    await this.removeLegacyVectorSnapshot(manifest.value ?? null);
  }

  private async removeLegacyBm25Snapshot(): Promise<void> {
    const manifestRead = await this.readIndexValue<IndexShardManifest>(KV.bm25Index, LEGACY_BM25_MANIFEST_KEY, "bm25", "manifest");
    const legacyRead = await this.readIndexValue<string>(KV.bm25Index, LEGACY_BM25_KEY, "bm25", "legacy");
    if (!manifestRead.ok || !legacyRead.ok) return;
    const manifest = manifestRead.value ?? null;
    const legacy = legacyRead.value ?? null;
    if (manifest == null && legacy == null) return;
    if (manifest && Array.isArray(manifest.shards)) {
      await this.deleteShards(manifest.shards.filter(isValidShardDescriptor), "legacy_bm25_cleanup");
    }
    if (manifest != null) await this.deleteKey(KV.bm25Index, LEGACY_BM25_MANIFEST_KEY, "legacy_bm25_cleanup");
    if (legacy != null) await this.deleteKey(KV.bm25Index, LEGACY_BM25_KEY, "legacy_bm25_cleanup");
  }

  private logFailure(err: unknown): void {
    const now = this.now();
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    logger.warn("index persistence: failed to save the vector index", {
      code,
      message: errorMessage(err),
      hint:
        code === "TIMEOUT"
          ? "iii-engine state::set timed out; unsaved vectors stay in memory and retry on the next save"
          : undefined,
    });
  }

  private async auditIndexPersistence(
    action: string,
    targetIds: string[],
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!auditIndexPersistEnabled()) return;
    await safeAudit(this.kv, "index_persist", INDEX_PERSISTENCE_FUNCTION_ID, targetIds, {
      action,
      ...details,
    });
  }

  private async deleteKey(scope: string, key: string, reason: string): Promise<void> {
    let result = "deleted";
    let error: string | undefined;
    try {
      await this.kv.delete(scope, key);
    } catch (err) {
      result = "failed";
      error = errorMessage(err);
    }
    await this.auditIndexPersistence("delete", [statePath(scope, key)], {
      scope,
      key,
      reason,
      result,
      error,
    });
  }

  private async deleteShards(shards: IndexShardManifest["shards"], reason: string): Promise<void> {
    await inBatches(shards, WRITE_CONCURRENCY, (shard) => this.deleteKey(shard.scope, shard.key, reason));
  }

  private async loadShardedData(legacyKey: string, manifestKey: string, label: string): Promise<string | null> {
    const manifest = await this.readIndexValue<IndexShardManifest>(KV.bm25Index, manifestKey, label, "manifest");
    if (!manifest.ok) return null;
    if (manifest.value != null && typeof manifest.value === "object") {
      return this.loadManifestData(manifest.value, label);
    }
    const legacy = await this.readIndexValue<string>(KV.bm25Index, legacyKey, label, "legacy");
    if (!legacy.ok) return null;
    if (legacy.value && typeof legacy.value === "string") return legacy.value;
    return null;
  }

  private async readIndexValue<T>(
    scope: string,
    key: string,
    label: string,
    source: "manifest" | "legacy",
  ): Promise<{ ok: true; value: T | null } | { ok: false }> {
    try {
      return { ok: true, value: await this.kv.get<T>(scope, key) };
    } catch (err) {
      logger.warn(`index persistence: ${label} ${source} read failed`, {
        scope,
        key,
        message: errorMessage(err),
      });
      return { ok: false };
    }
  }

  private async loadManifestData(manifest: IndexShardManifest, label: string): Promise<string | null> {
    if (
      manifest.v !== 1 ||
      !Array.isArray(manifest.shards) ||
      manifest.shards.length === 0 ||
      !Number.isInteger(manifest.chars) ||
      manifest.chars < 0
    ) {
      logger.warn(`index persistence: ${label} shard manifest invalid`);
      return null;
    }
    for (const shard of manifest.shards) {
      if (!isValidShardDescriptor(shard)) {
        logger.warn(`index persistence: ${label} shard manifest invalid`);
        return null;
      }
    }
    const loadedShards = await Promise.all(
      manifest.shards.map(async (shard) => ({
        shard,
        chunk: await this.kv.get<string>(shard.scope, shard.key).catch(() => null),
      })),
    );
    const chunks: string[] = [];
    let chars = 0;
    for (const { shard, chunk } of loadedShards) {
      if (typeof chunk !== "string") {
        logger.warn(`index persistence: ${label} shard missing`, { scope: shard.scope, key: shard.key });
        return null;
      }
      if (chunk.length !== shard.chars) {
        logger.warn(`index persistence: ${label} shard length mismatch`, {
          scope: shard.scope,
          key: shard.key,
          expected: shard.chars,
          actual: chunk.length,
        });
        return null;
      }
      chunks.push(chunk);
      chars += chunk.length;
    }
    if (chars !== manifest.chars) {
      logger.warn(`index persistence: ${label} total length mismatch`, { expected: manifest.chars, actual: chars });
      return null;
    }
    return chunks.join("");
  }
}
