import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompressedObservation, Memory, Session } from "../src/types.js";
import type { StateKV } from "../src/state/kv.js";
import type { IndexPersistence } from "../src/state/index-persistence.js";
import type { VectorBackfillJob } from "../src/functions/search.js";
import { flushIndexOnShutdown } from "../src/shutdown.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bootLog: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const seed = (scope: string, key: string, value: unknown) => {
    if (!store.has(scope)) store.set(scope, new Map());
    store.get(scope)!.set(key, structuredClone(value));
  };
  const kv = {
    backend: "file" as const,
    store,
    seed,
    beforeSet: undefined as ((scope: string, key: string, value: unknown) => Promise<void> | void) | undefined,
    get: vi.fn(async (scope: string, key: string): Promise<unknown> =>
      structuredClone(store.get(scope)?.get(key) ?? null),
    ),
    set: vi.fn(async (scope: string, key: string, value: unknown): Promise<unknown> => {
      await kv.beforeSet?.(scope, key, value);
      seed(scope, key, value);
      return value;
    }),
    delete: vi.fn(async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    }),
    list: vi.fn(async (scope: string): Promise<unknown[]> =>
      structuredClone([...store.get(scope)?.values() ?? []]),
    ),
  };
  return kv;
}

function observation(id: string, day: number, sessionId = "ses_recovery"): CompressedObservation {
  return {
    id, sessionId, timestamp: new Date(Date.UTC(2025, 0, day)).toISOString(),
    type: "decision", title: `Record ${id}`, narrative: `Searchable evidence ${id}`,
    facts: [], concepts: [], files: [], importance: 5,
  };
}

function memory(id = "mem_keep"): Memory {
  return {
    id, title: `Explicit ${id}`, content: `Permanent knowledge ${id}`,
    createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
    type: "fact", concepts: [], files: [], sessionIds: [], strength: 5,
    version: 1, isLatest: true,
  };
}

const persistences: IndexPersistence[] = [];

async function runtime(limit = 0) {
  vi.stubEnv("AGENTMEMORY_MAX_INDEXED_OBSERVATIONS", String(limit));
  vi.resetModules();
  const search = await import("../src/functions/search.js");
  const vectors = await import("../src/state/vector-index.js");
  const persistenceModule = await import("../src/state/index-persistence.js");
  const { KV } = await import("../src/state/schema.js");
  const kv = mockKV();
  const state = kv as unknown as StateKV;
  const vector = new vectors.VectorIndex();
  const embed = vi.fn(async () => new Float32Array([1, 0.5, 0.25]));
  const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0.5, 0.25])));
  search.setVectorIndex(vector);
  search.setEmbeddingProvider({ name: "recovery-test", dimensions: 3, embed, embedBatch });
  const index = search.getSearchIndex();
  const persistence = (
    target = vector,
    options: ConstructorParameters<typeof persistenceModule.IndexPersistence>[2] = {},
  ) => {
    const result = new persistenceModule.IndexPersistence(state, target, {
      bucketSize: 2, saveIntervalMs: 600_000, ...options,
    });
    persistences.push(result);
    if (target === vector) search.setIndexPersistence(result);
    return result;
  };
  return { kv, state, KV, search, vector, index, embed, embedBatch, persistence, ...vectors, ...persistenceModule };
}

type Runtime = Awaited<ReturnType<typeof runtime>>;

function seedRecords(r: Runtime, observations: CompressedObservation[], memories: Memory[] = []) {
  for (const sessionId of new Set(observations.map((row) => row.sessionId))) {
    r.kv.seed(r.KV.sessions, sessionId, {
      id: sessionId, project: "worker-recovery", cwd: "/tmp/worker-recovery",
      startedAt: "2025-01-01T00:00:00.000Z", status: "active",
      observationCount: observations.filter((row) => row.sessionId === sessionId).length,
    } satisfies Session);
  }
  for (const row of observations) r.kv.seed(r.KV.observations(row.sessionId), row.id, row);
  for (const row of memories) r.kv.seed(r.KV.memories, row.id, row);
}

function keys(index: { keys(): IterableIterator<string> }): string[] {
  return [...index.keys()].sort();
}

async function restored(r: Runtime) {
  const vector = new r.VectorIndex();
  const persistence = r.persistence(vector);
  const loaded = await persistence.load();
  if (loaded.vector) vector.restoreFrom(loaded.vector);
  const replay = await persistence.replayPendingLog(3);
  return { vector, persistence, loaded, replay };
}

async function expectCleanCheckpoint(persistence: IndexPersistence) {
  await persistence.save();
  expect.soft(persistence.status()).toMatchObject({
    saving: false, pendingChanges: 0, pendingLog: 0, pendingLogError: null,
    vector: { lastError: null },
  });
  expect(await flushIndexOnShutdown(persistence)).toEqual({ status: "saved" });
}

async function addLive(r: Runtime, row: CompressedObservation) {
  await r.kv.set(r.KV.observations(row.sessionId), row.id, row);
  expect(r.index.add(row)).toBe(true);
  expect(await r.search.vectorIndexAddGuarded(
    row.id, row.sessionId, `${row.title} ${row.narrative}`,
    { kind: "observation", logId: row.id },
  )).toBe(true);
}

beforeEach(() => {
  vi.stubEnv("AGENTMEMORY_VECTOR_BACKFILL", "false");
  vi.stubEnv("AGENTMEMORY_VECTOR_BACKFILL_MAX", "2");
});

afterEach(() => {
  for (const persistence of persistences) persistence.stop();
  persistences.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("worker index recovery: retryable evicted embeddings", () => {
  it("retries a failed journal payload after eviction without requiring another live write", async () => {
    const r = await runtime(1);
    const p = r.persistence();
    const old = observation("obs_retry", 1);
    const newer = observation("obs_newer", 2);
    seedRecords(r, [old, newer]);
    let failing = true;
    r.kv.beforeSet = (scope) => {
      if (scope === r.KV.vectorPendingLog && failing) throw new Error("journal temporarily unavailable");
    };
    r.index.add(old);
    const source = new Float32Array([1, 0.5, 0.25]);
    r.vector.add(old.id, old.sessionId, source);
    await expect(p.flushPendingLog()).rejects.toThrow("journal temporarily unavailable");
    expect(p.status().pendingLogError).toContain("journal temporarily unavailable");
    r.index.add(newer);
    source.fill(99);
    expect(r.vector.has(old.id)).toBe(false);
    await p.save();
    expect(p.status()).toMatchObject({ pendingChanges: 1, vector: { lastError: expect.any(String) } });

    failing = false;
    await p.save();
    const recovered = await restored(r);
    expect(keys(recovered.vector)).toEqual([old.id]);
    expect([...recovered.vector.get(old.id)!.embedding]).toEqual([1, 0.5, 0.25]);
    expect(recovered.replay.entries).toBe(0);
    expect(await r.kv.get(r.KV.observations(old.sessionId), old.id)).toEqual(old);
    await expectCleanCheckpoint(p);
  });

  it.each(["add", "remove"] as const)("does not let an in-flight retry overwrite a newer %s for the same ID", async (mutation) => {
    const r = await runtime();
    const p = r.persistence();
    const initialFailure = deferred();
    const retryStarted = deferred();
    const releaseRetry = deferred();
    let attempts = 0;
    r.kv.beforeSet = async (scope, key) => {
      if (scope !== r.KV.vectorPendingLog || key !== "obs_race") return;
      attempts++;
      if (attempts === 1) {
        initialFailure.resolve();
        throw new Error("first journal write failed");
      }
      if (attempts === 2) {
        retryStarted.resolve();
        await releaseRetry.promise;
      }
    };
    r.vector.add("obs_race", "ses_old", new Float32Array([1, 0, 0]));
    await initialFailure.promise;
    const flushing = p.flushPendingLog();
    try {
      await retryStarted.promise;
      if (mutation === "add") {
        r.vector.add("obs_race", "ses_new", new Float32Array([0, 1, 0]));
        r.vector.evictResident("obs_race");
      } else {
        r.vector.remove("obs_race");
      }
    } finally {
      releaseRetry.resolve();
    }
    await flushing;
    await p.flushPendingLog();
    const journal = await r.kv.get(r.KV.vectorPendingLog, "obs_race") as { e?: string; t?: number; s?: string };
    expect(attempts).toBe(3);
    if (mutation === "add") {
      expect(journal.s).toBe("ses_new");
      expect([...r.base64ToFloat32(journal.e!)]).toEqual([0, 1, 0]);
    } else {
      expect(journal).toMatchObject({ t: 1 });
      expect(journal.e).toBeUndefined();
    }
    const crashRecovery = await restored(r);
    expect(keys(crashRecovery.vector)).toEqual(mutation === "add" ? ["obs_race"] : []);
    if (mutation === "add") expect([...crashRecovery.vector.get("obs_race")!.embedding]).toEqual([0, 1, 0]);
    await expectCleanCheckpoint(p);
    expect(keys((await restored(r)).vector)).toEqual(mutation === "add" ? ["obs_race"] : []);
  });

  it("does not dispatch a superseded queued add after a same-tick delete", async () => {
    const r = await runtime();
    const p = r.persistence();
    r.vector.add("obs_queued", "ses_old", new Float32Array([1, 0, 0]));
    r.vector.remove("obs_queued");
    await p.flushPendingLog();
    const writes = r.kv.set.mock.calls.filter(([scope]) => scope === r.KV.vectorPendingLog);
    expect(writes).toHaveLength(1);
    expect(writes[0][2]).toMatchObject({ id: "obs_queued", t: 1 });
    expect(keys((await restored(r)).vector)).toEqual([]);
    await expectCleanCheckpoint(p);
  });

  it.each([false, true])("keeps a global clear ordered while a save waits for journal ACK (readd=%s)", async (readd) => {
    const r = await runtime();
    const p = r.persistence();
    r.vector.add("obs_cold", "ses_old", new Float32Array([1, 0, 0]));
    await p.save();
    r.vector.evictResident("obs_cold");
    const started = deferred();
    const release = deferred();
    let intercept = true;
    r.kv.beforeSet = async (scope, key) => {
      if (scope === r.KV.vectorPendingLog && key === "obs_inflight" && intercept) {
        intercept = false;
        started.resolve();
        await release.promise;
      }
    };
    r.vector.add("obs_inflight", "ses_before_clear", new Float32Array([1, 0, 0]));
    await started.promise;
    const saving = p.save();
    try {
      r.vector.clear();
      if (readd) r.vector.add("obs_inflight", "ses_after_clear", new Float32Array([0, 1, 0]));
    } finally {
      release.resolve();
    }
    await saving;
    await p.flushPendingLog();
    const recovered = await restored(r);
    expect(keys(recovered.vector)).toEqual(readd ? ["obs_inflight"] : []);
    if (readd) expect(recovered.vector.get("obs_inflight")).toEqual({
      sessionId: "ses_after_clear", embedding: new Float32Array([0, 1, 0]),
    });
    await expectCleanCheckpoint(p);
    expect(await r.kv.list(r.KV.vectorPendingLog)).toEqual([]);
  });

  it.each([false, true])("keeps a global clear ordered while a bucket write is in flight (readd=%s)", async (readd) => {
    const r = await runtime();
    const p = r.persistence();
    r.vector.add("obs_cold", "ses_old", new Float32Array([1, 0, 0]));
    await p.save();
    r.vector.evictResident("obs_cold");
    r.vector.add("obs_inflight", "ses_before_clear", new Float32Array([1, 0, 0]));
    const started = deferred();
    const release = deferred();
    let intercept = true;
    r.kv.beforeSet = async (scope, key) => {
      if (scope.startsWith(r.vectorBucketScope(0).slice(0, -4)) && key === "obs_inflight" && intercept) {
        intercept = false;
        started.resolve();
        await release.promise;
      }
    };
    const saving = p.save();
    try {
      await started.promise;
      r.vector.clear();
      if (readd) r.vector.add("obs_inflight", "ses_after_clear", new Float32Array([0, 1, 0]));
    } finally {
      release.resolve();
    }
    await saving;
    await p.flushPendingLog();
    const recovered = await restored(r);
    expect(keys(recovered.vector)).toEqual(readd ? ["obs_inflight"] : []);
    if (readd) expect([...recovered.vector.get("obs_inflight")!.embedding]).toEqual([0, 1, 0]);
    await expectCleanCheckpoint(p);
    const checkpoint = await restored(r);
    expect(keys(checkpoint.vector)).toEqual(readd ? ["obs_inflight"] : []);
    expect(checkpoint.replay.entries).toBe(0);
  });

  it("can drain a late write included in the checkpoint after the save began awaiting its journal", async () => {
    const r = await runtime();
    const p = r.persistence();
    const started = deferred();
    const release = deferred();
    r.kv.beforeSet = async (scope, key) => {
      if (scope === r.KV.vectorPendingLog && key === "obs_first") {
        started.resolve();
        await release.promise;
      }
    };
    r.vector.add("obs_first", "ses_first", new Float32Array([1, 0, 0]));
    await started.promise;
    const saving = p.save();
    try {
      r.vector.add("obs_late", "ses_late", new Float32Array([0, 1, 0]));
    } finally {
      release.resolve();
    }
    await saving;
    expect(keys((await restored(r)).vector)).toEqual(["obs_first", "obs_late"]);
    await expectCleanCheckpoint(p);
  });
});

describe("worker index recovery: residency independent of destructive GC", () => {
  it.each(["observations", "sessions", "revision"] as const)("trims residents but preserves durable cold rows when cleanup is deferred by %s", async (reason) => {
    const r = await runtime(1);
    const p = r.persistence();
    const old = observation("obs_old", 1);
    const fresh = observation("obs_fresh", 2);
    seedRecords(r, [old], [memory()]);
    r.index.add(old);
    for (const id of [old.id, "obs_stale", "mem_keep"]) {
      r.vector.add(id, "ses_recovery", new Float32Array([1, 0.5, 0.25]));
    }
    await p.save();
    if (reason === "revision") {
      r.kv.seed(r.KV.observations(old.sessionId), old.id, { ...old, narrative: "" });
    }
    const read = r.kv.list.getMockImplementation()!;
    const started = deferred();
    const release = deferred();
    const scopeToBlock = reason === "sessions" ? r.KV.sessions : r.KV.observations(old.sessionId);
    let intercepted = false;
    r.kv.list.mockImplementation(async (scope) => {
      const rows = await read(scope);
      if (scope !== scopeToBlock) return rows;
      if (!intercepted) {
        intercepted = true;
        started.resolve();
        await release.promise;
      }
      if (reason !== "revision") throw new Error(`partial ${reason} scan`);
      return rows;
    });
    const rebuilding = r.search.rebuildKeywordIndex(r.state);
    try {
      await started.promise;
      await addLive(r, fresh);
    } finally {
      release.resolve();
    }
    await rebuilding;
    expect(r.search.isBm25RebuildIncomplete()).toBe(reason !== "revision");
    expect(keys(r.index)).toEqual(["mem_keep", fresh.id].sort());
    expect(keys(r.vector)).toEqual(keys(r.index));
    expect(r.index.observationCount).toBe(1);
    await expectCleanCheckpoint(p);
    const recovered = await restored(r);
    expect(keys(recovered.vector)).toEqual(["mem_keep", fresh.id, old.id, "obs_stale"].sort());
    expect(await r.kv.get(r.KV.observations(old.sessionId), old.id)).not.toBeNull();
  });
});

describe("worker index recovery: complete bootstrap selection", () => {
  it.each(["memories", "observations", "sessions"] as const)("recovers a transient %s prepass failure before filtered vector loading", async (failure) => {
    const r = await runtime(2);
    const observations = [observation("obs_a", 1, "ses_a"), observation("obs_b", 2, "ses_b")];
    seedRecords(r, observations, [memory()]);
    for (const id of ["obs_a", "obs_b", "mem_keep"]) {
      r.kv.seed(r.vectorBucketScope(0), id, {
        id, s: "ses_recovery", c: "f16",
        e: r.float32ToFloat16Base64(new Float32Array([1, 0.5, 0.25])),
      });
    }
    r.kv.seed(r.KV.bm25Index, "vectors:meta", {
      v: 4, bucketCount: 1, count: 3, savedAt: "2025-02-01T00:00:00.000Z",
    });
    const failedScope = failure === "memories" ? r.KV.memories
      : failure === "sessions" ? r.KV.sessions : r.KV.observations("ses_b");
    const read = r.kv.list.getMockImplementation()!;
    let failuresLeft = failure === "sessions" ? 3 : 1;
    r.kv.list.mockImplementation(async (scope) => {
      if (scope === failedScope && failuresLeft-- > 0) throw new Error("transient bootstrap read failure");
      return read(scope);
    });
    await r.search.prepareObservationWindow(r.state);
    expect(r.search.isBm25RebuildIncomplete()).toBe(false);
    expect(keys(r.index)).toEqual(["mem_keep", "obs_a", "obs_b"]);
    expect(r.kv.list.mock.calls.filter(([scope]) => scope === failedScope)).toHaveLength(failure === "sessions" ? 4 : 2);
    const p = r.persistence(r.vector, { shouldLoadVector: (id) => r.index.has(id) });
    const loaded = await p.load();
    expect(loaded).toMatchObject({ state: "buckets", expectedCount: 3, loadedCount: 3 });
    r.vector.restoreFrom(loaded.vector!);
    const rebuilt = await r.search.rebuildKeywordIndex(r.state, loaded.savedAt);
    expect(keys(r.vector)).toEqual(keys(r.index));
    expect(rebuilt.vectorJobs).toEqual([]);
    expect(p.status().vectorCountShortfall).toBeNull();
    expect(r.embed).not.toHaveBeenCalled();
    expect(r.embedBatch).not.toHaveBeenCalled();
  });

  it("rejects bootstrap after three incomplete scans and leaves durable vectors intact", async () => {
    const r = await runtime(1);
    const row = observation("obs_unavailable", 1);
    seedRecords(r, [row]);
    const encoded = { id: row.id, s: row.sessionId, c: "f16", e: r.float32ToFloat16Base64(new Float32Array([1, 0, 0])) };
    r.kv.seed(r.vectorBucketScope(0), row.id, encoded);
    const read = r.kv.list.getMockImplementation()!;
    r.kv.list.mockImplementation(async (scope) => {
      if (scope === r.KV.observations(row.sessionId)) throw new Error("observation store unavailable");
      return read(scope);
    });
    await expect(r.search.prepareObservationWindow(r.state)).rejects.toThrow("state scan is incomplete");
    expect(r.kv.list.mock.calls.filter(([scope]) => scope === r.KV.observations(row.sessionId))).toHaveLength(3);
    expect(r.search.isBm25RebuildIncomplete()).toBe(true);
    expect(await r.kv.get(r.vectorBucketScope(0), row.id)).toEqual(encoded);
    expect(r.kv.set).not.toHaveBeenCalled();
    expect(r.kv.delete).not.toHaveBeenCalled();
  });
});

describe("worker index recovery: missing observations inside the window", () => {
  it("finds and restores a genuinely missing observation when the cap has spare capacity", async () => {
    const r = await runtime(2);
    const rows = [observation("obs_old", 1), observation("obs_missing", 2)];
    seedRecords(r, rows);
    r.index.add(rows[0]);
    expect((await r.search.findUnindexedObservations(r.state)).missing).toEqual([rows[1]]);
    expect(keys(r.index)).toEqual([rows[0].id]);
    expect(await r.search.reconcileIndex(r.state)).toBe(1);
    expect(keys(r.index)).toEqual(rows.map((row) => row.id).sort());
    expect(keys(r.vector)).toEqual([rows[1].id]);
  });

  it("uses timestamp and ID cutoff at a full cap while excluding genuinely cold records", async () => {
    const r = await runtime(2);
    const oldest = observation("obs_m", 2);
    const latest = observation("obs_latest", 4);
    const cold = observation("obs_cold", 1);
    const lowerTie = observation("obs_a", 2);
    const higherTie = { ...observation("obs_z", 2), timestamp: "2025-01-02T02:00:00+02:00" };
    const newest = observation("obs_newest", 5);
    seedRecords(r, [oldest, latest, cold, lowerTie, higherTie, newest]);
    r.index.add(oldest);
    r.index.add(latest);
    const before = keys(r.index);
    const missing = await r.search.findUnindexedObservations(r.state);
    expect(missing.missing.map((row) => row.id)).toEqual([higherTie.id, newest.id]);
    expect(keys(r.index)).toEqual(before);
    expect(await r.search.reconcileIndex(r.state)).toBe(2);
    expect(keys(r.index)).toEqual([latest.id, newest.id].sort());
    expect(keys(r.vector)).toEqual([newest.id]);
    expect((await r.search.findUnindexedObservations(r.state)).missing).toEqual([]);
  });
});

async function measureBackfillQueue<T>(work: () => Promise<T>) {
  const push = Array.prototype.push;
  let peakJobs = 0;
  let enqueuedJobs = 0;
  Array.prototype.push = function (...items: unknown[]) {
    const jobs = items.filter((item): item is VectorBackfillJob => {
      if (!item || typeof item !== "object") return false;
      const row = item as Partial<VectorBackfillJob>;
      return typeof row.text === "string" && row.context?.logId === row.id;
    });
    if (jobs.length > 0) {
      peakJobs = Math.max(peakJobs, this.length + items.length);
      enqueuedJobs += jobs.length;
    }
    return Reflect.apply(push, this, items);
  };
  try {
    return { result: await work(), metrics: () => ({ peakJobs, enqueuedJobs }) };
  } finally {
    Array.prototype.push = push;
  }
}

describe("worker index recovery: bounded whole-store backfill", () => {
  it.each([0, 2])("counts gated backfill without materializing text jobs (observation cap=%s)", async (limit) => {
    const r = await runtime(limit);
    const rows = Array.from({ length: 64 }, (_, i) => observation(`obs_${String(i).padStart(3, "0")}`, i + 1));
    seedRecords(r, rows, [memory()]);
    const measured = await measureBackfillQueue(() => r.search.rebuildKeywordIndex(r.state, null));
    expect(measured.result).toMatchObject({
      vectorJobs: [], fullBackfillPending: limit === 0 ? 65 : 3,
      documents: limit === 0 ? 65 : 3,
    });
    expect(measured.metrics()).toEqual({ peakJobs: 0, enqueuedJobs: 0 });
    expect(r.embed).not.toHaveBeenCalled();
    expect(r.embedBatch).not.toHaveBeenCalled();
  });

  it("bounds retained whole-store jobs before returning rather than slicing an unbounded queue", async () => {
    const r = await runtime();
    vi.stubEnv("AGENTMEMORY_VECTOR_BACKFILL", "all");
    const rows = Array.from({ length: 64 }, (_, i) => observation(`obs_${String(i).padStart(3, "0")}`, i + 1));
    seedRecords(r, rows, [memory()]);
    const measured = await measureBackfillQueue(() => r.search.rebuildKeywordIndex(r.state, null));
    expect(measured.result.vectorJobs).toHaveLength(2);
    expect(measured.result.fullBackfillPending).toBe(0);
    expect(measured.metrics()).toEqual({ peakJobs: 2, enqueuedJobs: 2 });
    expect(measured.result.vectorJobs.every((job) => r.index.has(job.id))).toBe(true);
  });

  it.each([1, 2])("fills a backfill budget of %s from the final resident window after same-batch evictions", async (budget) => {
    const r = await runtime(2);
    vi.stubEnv("AGENTMEMORY_VECTOR_BACKFILL", "all");
    vi.stubEnv("AGENTMEMORY_VECTOR_BACKFILL_MAX", String(budget));
    seedRecords(r, [observation("obs_old", 1), observation("obs_mid", 2), observation("obs_new", 3)]);
    const measured = await measureBackfillQueue(() => r.search.rebuildKeywordIndex(r.state, null));
    expect(keys(r.index)).toEqual(["obs_mid", "obs_new"]);
    expect(measured.metrics().peakJobs).toBeLessThanOrEqual(budget);
    expect(measured.result.vectorJobs).toHaveLength(budget);
    expect(measured.result.vectorJobs.every((job) => r.index.has(job.id))).toBe(true);
    expect(await r.search.backfillVectors(measured.result.vectorJobs)).toBe(budget);
    expect(r.vector.size).toBe(budget);
  });

  it("refills the budget when an already-vectorized record evicts an earlier candidate", async () => {
    const r = await runtime(2);
    vi.stubEnv("AGENTMEMORY_VECTOR_BACKFILL", "all");
    vi.stubEnv("AGENTMEMORY_VECTOR_BACKFILL_MAX", "1");
    seedRecords(r, [observation("obs_old", 1), observation("obs_mid", 2), observation("obs_new", 3)]);
    r.vector.loadPersisted("obs_new", "ses_recovery", new Float32Array([1, 0, 0]));
    const result = await r.search.rebuildKeywordIndex(r.state, null);
    expect(keys(r.index)).toEqual(["obs_mid", "obs_new"]);
    expect(result.vectorJobs.map((job) => job.id)).toEqual(["obs_mid"]);
    expect(await r.search.backfillVectors(result.vectorJobs)).toBe(1);
    expect(keys(r.vector)).toEqual(["obs_mid", "obs_new"]);
  });
});
