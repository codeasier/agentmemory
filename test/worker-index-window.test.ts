import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompressedObservation, HookPayload, Memory, Session } from "../src/types.js";
import type { StateKV } from "../src/state/kv.js";
import type { IndexPersistence } from "../src/state/index-persistence.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bootLog: vi.fn(),
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    backend: "file" as const,
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      structuredClone((store.get(scope)?.get(key) as T) ?? null),
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(value));
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: vi.fn(async <T>(scope: string): Promise<T[]> =>
      structuredClone([...store.get(scope)?.values() ?? []]) as T[],
    ),
    update: async (
      scope: string,
      key: string,
      updates: Array<{ type: string; path: string; value?: unknown }>,
    ) => {
      const row = structuredClone(store.get(scope)?.get(key) ?? {}) as Record<string, unknown>;
      for (const update of updates) {
        if (update.type === "remove") delete row[update.path];
        else row[update.path] = update.value;
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, row);
      return row;
    },
  };
}

type MockKV = ReturnType<typeof mockKV>;

function mockSdk() {
  const functions = new Map<string, (payload: any) => unknown>();
  return {
    registerFunction: (id: string, fn: (payload: any) => unknown) => functions.set(id, fn),
    registerTrigger: vi.fn(),
    trigger: async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
      const fn = functions.get(function_id);
      if (fn) return await fn(payload);
      if (function_id.startsWith("stream::")) return null;
      if (function_id === "mem::graph-stats") return { totalNodes: 0, totalEdges: 0 };
      throw new Error(`Unexpected trigger: ${function_id}`);
    },
  };
}

function timestamp(day: number): string {
  return `2025-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}

function observation(id: string, day: number, sessionId = "ses_window"): CompressedObservation {
  return {
    id, sessionId, timestamp: timestamp(day), type: "decision",
    title: `Window record ${id}`, narrative: `Durable searchable evidence for ${id}`,
    facts: [], concepts: [], files: [], importance: 5,
  };
}

function memory(id: string): Memory {
  return {
    id, title: `Explicit ${id}`, content: `Durable explicit knowledge ${id}`,
    createdAt: timestamp(1), updatedAt: timestamp(1), type: "fact",
    concepts: [], files: [], sessionIds: ["ses_window"], strength: 5,
    version: 1, isLatest: true,
  };
}

function payload(id: string, day: number, sessionId = "ses_window"): HookPayload {
  return {
    observationId: id, sessionId, timestamp: timestamp(day),
    project: "worker-window", cwd: "/tmp/worker-window", hookType: "post_tool_use",
    data: { tool_name: "Read", tool_input: { file_path: `src/${id}.ts` }, tool_output: `Evidence ${id}` },
  };
}

async function seedRecords(kv: MockKV, observations: CompressedObservation[], memories: Memory[] = []) {
  const { KV } = await import("../src/state/schema.js");
  for (const sessionId of new Set(observations.map((obs) => obs.sessionId))) {
    await kv.set(KV.sessions, sessionId, {
      id: sessionId, project: "worker-window", cwd: "/tmp/worker-window",
      startedAt: timestamp(1), status: "active",
      observationCount: observations.filter((obs) => obs.sessionId === sessionId).length,
    } satisfies Session);
  }
  for (const obs of observations) await kv.set(KV.observations(obs.sessionId), obs.id, obs);
  for (const mem of memories) await kv.set(KV.memories, mem.id, mem);
}

const persistences: IndexPersistence[] = [];

async function startRuntime(limit: number, kv = mockKV(), restore = false) {
  vi.stubEnv("AGENTMEMORY_MAX_INDEXED_OBSERVATIONS", String(limit));
  vi.resetModules();
  const search = await import("../src/functions/search.js");
  const observe = await import("../src/functions/observe.js");
  const { registerRememberFunction } = await import("../src/functions/remember.js");
  const { VectorIndex } = await import("../src/state/vector-index.js");
  const { SearchIndex } = await import("../src/state/search-index.js");
  const { IndexPersistence } = await import("../src/state/index-persistence.js");
  const { KV } = await import("../src/state/schema.js");
  const vector = new VectorIndex();
  const embed = vi.fn(async (_text: string) => new Float32Array([1, 0.5, 0.25]));
  const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0.5, 0.25])));
  search.setVectorIndex(vector);
  search.setEmbeddingProvider({ name: "window-test", dimensions: 3, embed, embedBatch });
  const index = search.getSearchIndex();
  expect(index).toBeInstanceOf(SearchIndex);
  if (restore) await search.rebuildKeywordIndex(kv as unknown as StateKV, undefined, { reconcileVectors: false });
  const persistence = new IndexPersistence(kv as unknown as StateKV, vector, {
    bucketSize: 2, saveIntervalMs: 600_000,
    shouldLoadVector: limit > 0 ? (id) => index.has(id) : undefined,
  });
  persistences.push(persistence);
  search.setIndexPersistence(persistence);
  let loaded;
  if (restore) {
    loaded = await persistence.load();
    if (loaded.vector) vector.restoreFrom(loaded.vector);
  }
  const sdk = mockSdk();
  observe.registerObserveFunction(sdk as never, kv as unknown as StateKV);
  registerRememberFunction(sdk as never, kv as unknown as StateKV);
  search.registerSearchFunction(sdk as never, kv as unknown as StateKV);
  return { kv, KV, sdk, search, observe, vector, index, persistence, embed, embedBatch, loaded };
}

type Runtime = Awaited<ReturnType<typeof startRuntime>>;

async function checkpoint(runtime: Runtime) {
  await runtime.persistence.flushPendingLog();
  await runtime.persistence.save();
  expect(runtime.persistence.status()).toMatchObject({
    saving: false, pendingChanges: 0, pendingLog: 0, pendingLogError: null,
    vector: { lastError: null, dirtySince: null, lastSavedAt: expect.any(String) },
  });
}

async function loadAllVectors(kv: MockKV) {
  const { VectorIndex } = await import("../src/state/vector-index.js");
  const { IndexPersistence } = await import("../src/state/index-persistence.js");
  const persistence = new IndexPersistence(kv as unknown as StateKV, new VectorIndex());
  persistences.push(persistence);
  const loaded = await persistence.load();
  expect(loaded.state).toBe("buckets");
  expect(persistence.status().vectorCountShortfall).toBeNull();
  return loaded;
}

function keys(index: { keys(): IterableIterator<string> }): string[] {
  return [...index.keys()].sort();
}

async function expectDurableVectors(kv: MockKV, ids: string[]) {
  const loaded = await loadAllVectors(kv);
  expect(keys(loaded.vector!)).toEqual([...ids].sort());
  expect(loaded).toMatchObject({ expectedCount: ids.length, loadedCount: ids.length });
  return loaded.vector!;
}

async function recall(runtime: Runtime, query: string) {
  const result = await runtime.sdk.trigger({
    function_id: "mem::search", payload: { query, format: "compact", limit: 100 },
  }) as { format: string; results: Array<{ obsId: string }>; truncated: boolean };
  expect(result).toMatchObject({ format: "compact", truncated: false });
  return result.results.map((hit) => hit.obsId).sort();
}

async function apiStatus(runtime: Runtime) {
  const { createStatusReporter } = await import("../src/triggers/api.js");
  return createStatusReporter(runtime.sdk as never, runtime.kv as unknown as StateKV, {})({
    health: { status: "healthy", alerts: [], connectionState: "connected" } as never,
  });
}

beforeEach(() => {
  vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
  vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "shared");
  vi.stubEnv("AGENTMEMORY_VECTOR_BACKFILL", "all");
});

afterEach(async () => {
  for (const persistence of persistences) persistence.stop();
  await Promise.all(persistences.map((persistence) => persistence.flushPendingLog()));
  persistences.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("worker observation window: capture and recall", () => {
  it.each(["session_end", "notification", "subagent_start", "task_completed"] as const)(
    "retains %s metadata in KV without indexing or embedding it, including durable duplicate recovery",
    async (hookType) => {
      const runtime = await startRuntime(2);
      const { kv, KV, sdk, index, vector, embed, embedBatch } = runtime;
      const capture = { ...payload("obs_metadata_0001", 1), hookType, data: { marker: "metadata-proof", exit_code: 0 } };
      expect(await sdk.trigger({ function_id: "mem::observe", payload: capture })).toEqual({ observationId: capture.observationId });
      const stored = await kv.get<CompressedObservation>(KV.observations(capture.sessionId), capture.observationId!);
      expect(stored).toMatchObject({
        id: capture.observationId, title: hookType, narrative: "",
        source: { hookType, payload: capture.data },
      });
      expect(await sdk.trigger({ function_id: "mem::observe", payload: capture })).toEqual({
        observationId: capture.observationId, deduplicated: true, existing: true,
      });
      await runtime.observe.restoreIndexEntries(stored!);
      expect(index.size).toBe(0);
      expect(vector.size).toBe(0);
      expect(embed).not.toHaveBeenCalled();
      expect(embedBatch).not.toHaveBeenCalled();
      expect(await kv.list(KV.vectorPendingLog)).toEqual([]);
      expect(await kv.get(KV.observations(capture.sessionId), capture.observationId!)).toEqual(stored);
      expect(await kv.get(KV.sessions, capture.sessionId)).toMatchObject({ observationCount: 1 });
      expect(await runtime.search.rebuildKeywordIndex(kv as unknown as StateKV, null)).toEqual({
        documents: 0, vectorJobs: [], fullBackfillPending: 0,
      });

      expect(await sdk.trigger({ function_id: "mem::observe", payload: payload("obs_content_0001", 2) })).toEqual({
        observationId: "obs_content_0001",
      });
      expect(await recall(runtime, "Read")).toEqual(["obs_content_0001"]);
      expect(await recall(runtime, hookType)).toEqual([]);
      expect(embed).toHaveBeenCalledTimes(1);
      await checkpoint(runtime);
      await expectDurableVectors(kv, ["obs_content_0001"]);
      expect(await kv.list(KV.observations(capture.sessionId))).toHaveLength(2);
    },
  );

  it("keeps the newest observations globally across out-of-order live inserts while explicit memories remain unlimited", async () => {
    const runtime = await startRuntime(2);
    const { kv, KV, sdk, index, vector } = runtime;
    for (const [id, day, sessionId] of [
      ["obs_newest_0001", 9, "ses_a"], ["obs_oldest_0001", 1, "ses_b"],
      ["obs_middle_0001", 5, "ses_b"], ["obs_delayed_0001", 2, "ses_a"],
    ] as const) {
      expect(await sdk.trigger({ function_id: "mem::observe", payload: payload(id, day, sessionId) })).toEqual({ observationId: id });
    }
    const contents = ["Orchids thrive indoors", "Postgres transaction isolation", "Train journeys through mountains", "Sourdough fermentation timing"];
    const memoryIds: string[] = [];
    for (const content of contents) {
      const result = await sdk.trigger({ function_id: "mem::remember", payload: { content, type: "fact" } }) as { success: boolean; memory: Memory };
      expect(result.success).toBe(true);
      expect(result.memory.content).toBe(content);
      memoryIds.push(result.memory.id);
    }
    expect(new Set(memoryIds).size).toBe(4);
    const resident = ["obs_newest_0001", "obs_middle_0001", ...memoryIds].sort();
    expect(index.observationLimit).toBe(2);
    expect(index.observationCount).toBe(2);
    expect(keys(index)).toEqual(resident);
    expect(keys(vector)).toEqual(resident);
    expect(await recall(runtime, "Read")).toEqual(["obs_middle_0001", "obs_newest_0001"]);
    expect(await recall(runtime, "Sourdough")).toEqual([memoryIds[3]]);
    expect(await kv.list(KV.observations("ses_a"))).toHaveLength(2);
    expect(await kv.list(KV.observations("ses_b"))).toHaveLength(2);
    expect(await kv.list(KV.memories)).toHaveLength(4);
    await checkpoint(runtime);
    const durable = await expectDurableVectors(kv, [...resident, "obs_oldest_0001"]);
    for (const id of keys(durable)) expect([...durable.get(id)!.embedding]).toEqual([1, 0.5, 0.25]);

    const report = await apiStatus(runtime);
    expect(report.index).toMatchObject({
      observationLimit: 2, observationsIndexed: 2, memoriesIndexed: 4,
      bm25Documents: 6, vectorDocuments: 6, missingObservations: 0, bm25Incomplete: false,
    });
    expect(report.problems).toContainEqual(expect.objectContaining({ code: "observation_index_window", level: "info" }));
    expect(report.problems.map((problem) => problem.code)).not.toContain("index-missing-observations");
  });

  it("filters boot restore to the chronological window, preserves all durable vectors, and recovers cold rows when the cap rises", async () => {
    const original = await startRuntime(0);
    const observations = [observation("obs_z_old", 1), observation("obs_a_new", 9, "ses_other"), observation("obs_m_middle", 5)];
    const memories = [memory("mem_first"), memory("mem_second"), memory("mem_third")];
    await seedRecords(original.kv, observations, memories);
    const expected = new Map<string, number[]>();
    for (const [i, row] of [...observations, ...memories].entries()) {
      const values = [i + 1, 0.5, 0.25];
      expected.set(row.id, values);
      original.vector.add(row.id, "sessionId" in row ? row.sessionId : "ses_window", new Float32Array(values));
    }
    await checkpoint(original);
    original.persistence.stop();

    const bounded = await startRuntime(1, original.kv, true);
    expect(bounded.loaded).toMatchObject({ state: "buckets", expectedCount: 6, loadedCount: 6 });
    expect(keys(bounded.index)).toEqual(["mem_first", "mem_second", "mem_third", "obs_a_new"]);
    expect(keys(bounded.vector)).toEqual(keys(bounded.index));
    expect(bounded.persistence.status().vectorCountShortfall).toBeNull();
    expect(await bounded.search.rebuildKeywordIndex(bounded.kv as unknown as StateKV)).toMatchObject({ documents: 4 });
    await bounded.persistence.save();
    await expectDurableVectors(bounded.kv, [...expected.keys()]);
    expect(bounded.embed).not.toHaveBeenCalled();
    expect(bounded.embedBatch).not.toHaveBeenCalled();
    bounded.persistence.stop();

    const raised = await startRuntime(3, original.kv, true);
    expect(keys(raised.index)).toEqual([...expected.keys()].sort());
    expect(keys(raised.vector)).toEqual([...expected.keys()].sort());
    for (const [id, values] of expected) expect([...raised.vector.get(id)!.embedding]).toEqual(values);
    expect(await recall(raised, "Window")).toEqual(observations.map((obs) => obs.id).sort());
    expect(raised.embed).not.toHaveBeenCalled();
    expect(raised.embedBatch).not.toHaveBeenCalled();
    for (const obs of observations) expect(await raised.kv.get(raised.KV.observations(obs.sessionId), obs.id)).toEqual(obs);
    for (const mem of memories) expect(await raised.kv.get(raised.KV.memories, mem.id)).toEqual(mem);
  });
});

describe("worker observation window: conservative vector reconciliation", () => {
  async function staleFixture() {
    const runtime = await startRuntime(1);
    const records = [
      observation("obs_cold", 1, "ses_cold"), observation("obs_current", 9),
      { ...observation("obs_metadata", 10), narrative: " \n\t" },
    ];
    await seedRecords(runtime.kv, records, [memory("mem_keep")]);
    for (const id of ["obs_cold", "obs_current", "obs_metadata", "obs_deleted", "mem_keep", "mem_deleted"]) {
      runtime.vector.add(id, "ses_window", new Float32Array([1, 0.5, 0.25]));
    }
    await checkpoint(runtime);
    return { runtime, records };
  }

  it("prunes deleted and empty-narrative vectors after a complete scan without deleting eligible cold vectors or source records", async () => {
    const { runtime, records } = await staleFixture();
    const result = await runtime.search.rebuildKeywordIndex(runtime.kv as unknown as StateKV, null);
    expect(result).toMatchObject({ documents: 2, vectorJobs: [], fullBackfillPending: 0 });
    expect(runtime.search.isBm25RebuildIncomplete()).toBe(false);
    expect(keys(runtime.index)).toEqual(["mem_keep", "obs_current"]);
    expect(keys(runtime.vector)).toEqual(["mem_keep", "obs_current"]);
    await checkpoint(runtime);
    await expectDurableVectors(runtime.kv, ["mem_keep", "obs_cold", "obs_current"]);
    for (const obs of records) expect(await runtime.kv.get(runtime.KV.observations(obs.sessionId), obs.id)).toEqual(obs);
    expect(runtime.embed).not.toHaveBeenCalled();
    expect(runtime.embedBatch).not.toHaveBeenCalled();
  });

  it.each(["memories", "sessions", "observations"] as const)(
    "does not prune durable vectors after a partial %s read; a later complete scan can prune them",
    async (failure) => {
      const { runtime } = await staleFixture();
      const { kv, KV, search } = runtime;
      const failedScope = failure === "memories" ? KV.memories : failure === "sessions" ? KV.sessions : KV.observations("ses_window");
      const list = kv.list.getMockImplementation()!;
      kv.list.mockImplementation(async (scope) => {
        if (scope === failedScope) throw new Error(`Unavailable ${failure}`);
        return list(scope);
      });
      await search.rebuildKeywordIndex(kv as unknown as StateKV);
      expect(search.isBm25RebuildIncomplete()).toBe(true);
      expect(search.isMemoryIndexReady()).toBe(failure !== "memories");
      const report = await apiStatus(runtime);
      expect(report.status).toBe("error");
      expect(report.index.bm25Incomplete).toBe(true);
      expect(report.problems).toContainEqual(expect.objectContaining({ code: "bm25-rebuild-incomplete", level: "error" }));
      await runtime.persistence.save();
      await expectDurableVectors(kv, ["obs_cold", "obs_current", "obs_metadata", "obs_deleted", "mem_keep", "mem_deleted"]);
      kv.list.mockImplementation(list);
      await search.rebuildKeywordIndex(kv as unknown as StateKV);
      expect(search.isBm25RebuildIncomplete()).toBe(false);
      await checkpoint(runtime);
      await expectDurableVectors(kv, ["obs_cold", "obs_current", "mem_keep"]);
    },
  );

  it.each(["add", "remove"] as const)("does not prune after a live vector %s during the observation scan", async (mutation) => {
    const { runtime } = await staleFixture();
    const { kv, KV, sdk, search, vector } = runtime;
    const list = kv.list.getMockImplementation()!;
    let release!: () => void;
    let scanned!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const snapshotTaken = new Promise<void>((resolve) => { scanned = resolve; });
    let intercept = true;
    kv.list.mockImplementation(async (scope) => {
      const rows = await list(scope);
      if (scope === KV.observations("ses_window") && intercept) {
        intercept = false;
        scanned();
        await blocked;
      }
      return rows;
    });
    const rebuild = search.rebuildKeywordIndex(kv as unknown as StateKV);
    try {
      await snapshotTaken;
      if (mutation === "add") {
        expect(await sdk.trigger({ function_id: "mem::observe", payload: payload("obs_concurrent_0001", 12) })).toEqual({
          observationId: "obs_concurrent_0001",
        });
      } else {
        expect(await sdk.trigger({
          function_id: "mem::forget", payload: { sessionId: "ses_cold", observationIds: ["obs_cold"] },
        })).toMatchObject({ success: true, deleted: 1, failed: 0 });
        expect(await kv.get(KV.observations("ses_cold"), "obs_cold")).toBeNull();
      }
    } finally {
      release();
    }
    await rebuild;
    expect(search.isBm25RebuildIncomplete()).toBe(false);
    expect(vector.has("obs_concurrent_0001")).toBe(mutation === "add");
    await checkpoint(runtime);
    await expectDurableVectors(kv, mutation === "add"
      ? ["obs_cold", "obs_current", "obs_metadata", "obs_deleted", "mem_keep", "mem_deleted", "obs_concurrent_0001"]
      : ["obs_current", "obs_metadata", "obs_deleted", "mem_keep", "mem_deleted"]);
    kv.list.mockImplementation(list);
    await search.rebuildKeywordIndex(kv as unknown as StateKV);
    await checkpoint(runtime);
    await expectDurableVectors(kv, mutation === "add"
      ? ["obs_cold", "obs_current", "mem_keep", "obs_concurrent_0001"]
      : ["obs_current", "mem_keep"]);
  });
});

describe("worker observation window: durable eviction and crash recovery", () => {
  it.each([false, true])("preserves cap evictions and truly deletes a cold observation (checkpoint-before-eviction=%s)", async (savedBeforeEviction) => {
    const runtime = await startRuntime(1);
    const { kv, KV, sdk, index, vector } = runtime;
    for (const [id, day] of [["obs_cold_0001", 1], ["obs_warmer_0001", 2], ["obs_hot_0001", 3]] as const) {
      expect(await sdk.trigger({ function_id: "mem::observe", payload: payload(id, day) })).toEqual({ observationId: id });
      if (savedBeforeEviction && day === 1) await checkpoint(runtime);
    }
    expect(keys(index)).toEqual(["obs_hot_0001"]);
    expect(keys(vector)).toEqual(["obs_hot_0001"]);
    await checkpoint(runtime);
    await expectDurableVectors(kv, ["obs_cold_0001", "obs_warmer_0001", "obs_hot_0001"]);
    expect(await sdk.trigger({
      function_id: "mem::forget", payload: { sessionId: "ses_window", observationIds: ["obs_cold_0001"] },
    })).toMatchObject({ success: true, deleted: 1, failed: 0, notFound: [], cleanupFailed: 0 });
    expect(await kv.get(KV.observations("ses_window"), "obs_cold_0001")).toBeNull();
    expect(await kv.list(KV.observations("ses_window"))).toHaveLength(2);
    await expectDurableVectors(kv, ["obs_warmer_0001", "obs_hot_0001"]);
    runtime.persistence.stop();
    const restored = await startRuntime(0, kv, true);
    expect(keys(restored.vector)).toEqual(["obs_hot_0001", "obs_warmer_0001"]);
    expect(await recall(restored, "Read")).toEqual(["obs_hot_0001", "obs_warmer_0001"]);
  });

  it("replays a force-kill pending log, checkpoints a now-cold newer vector, and restores it when the cap rises", async () => {
    const original = await startRuntime(1);
    const { kv, KV, sdk } = original;
    await sdk.trigger({ function_id: "mem::observe", payload: payload("obs_checkpoint_0001", 1) });
    await checkpoint(original);
    for (const [id, day] of [["obs_pending_0001", 2], ["obs_latest_0001", 3]] as const) {
      expect(await sdk.trigger({ function_id: "mem::observe", payload: payload(id, day) })).toEqual({ observationId: id });
    }
    await original.persistence.flushPendingLog();
    expect(await kv.list(KV.vectorPendingLog)).toHaveLength(2);
    const storedObservations = await kv.list(KV.observations("ses_window"));
    original.persistence.stop();

    const recovered = await startRuntime(1, kv, true);
    expect(recovered.loaded).toMatchObject({ state: "buckets", expectedCount: 1, loadedCount: 1 });
    expect(recovered.vector.size).toBe(0);
    expect(await recovered.persistence.replayPendingLog(3)).toEqual({
      entries: 2, added: 2, removed: 0, cleared: false, skipped: 0,
    });
    expect(keys(recovered.vector)).toEqual(["obs_latest_0001"]);
    expect(recovered.embed).not.toHaveBeenCalled();
    expect(recovered.embedBatch).not.toHaveBeenCalled();
    await checkpoint(recovered);
    const all = await expectDurableVectors(kv, ["obs_checkpoint_0001", "obs_pending_0001", "obs_latest_0001"]);
    for (const id of keys(all)) expect([...all.get(id)!.embedding]).toEqual([1, 0.5, 0.25]);
    expect(await kv.list(KV.vectorPendingLog)).toEqual([]);
    expect(await kv.list(KV.observations("ses_window"))).toEqual(storedObservations);
    recovered.persistence.stop();

    const raised = await startRuntime(3, kv, true);
    expect(keys(raised.vector)).toEqual(["obs_checkpoint_0001", "obs_latest_0001", "obs_pending_0001"]);
    expect(await recall(raised, "Read")).toEqual(keys(raised.vector));
    expect(raised.embed).not.toHaveBeenCalled();
    expect(raised.embedBatch).not.toHaveBeenCalled();
  });

  it.each([false, true])("clears resident and cold vectors, including pending cold rows (uncheckpointed=%s)", async (uncheckpointed) => {
    const original = await startRuntime(1);
    const { kv, KV } = original;
    await original.sdk.trigger({ function_id: "mem::observe", payload: payload("obs_clear_cold_0001", 1) });
    await checkpoint(original);
    await original.sdk.trigger({ function_id: "mem::observe", payload: payload("obs_clear_warm_0001", 2) });
    await original.sdk.trigger({ function_id: "mem::observe", payload: payload("obs_clear_hot_0001", 3) });
    const storedObservations = await kv.list(KV.observations("ses_window"));
    if (!uncheckpointed) await checkpoint(original);
    original.vector.clear();
    original.index.clear();
    await checkpoint(original);
    await expectDurableVectors(kv, []);
    expect(await kv.list(KV.vectorPendingLog)).toEqual([]);
    expect(await kv.list(KV.observations("ses_window"))).toEqual(storedObservations);
    original.persistence.stop();
    const restored = await startRuntime(0, kv, true);
    expect(restored.loaded).toMatchObject({ state: "buckets", expectedCount: 0, loadedCount: 0 });
    expect(restored.vector.size).toBe(0);
    expect(await restored.persistence.replayPendingLog(3)).toEqual({ entries: 0, added: 0, removed: 0, cleared: false, skipped: 0 });
  });
});

describe("worker observation window configuration", () => {
  it.each([
    ["", 0], ["invalid", 0], ["-1", 0], ["1.5", 0], ["2records", 0],
    ["Infinity", 0], ["9007199254740992", 0], ["0", 0], ["1", 1], [" 250 ", 250],
  ] as const)("parses %j as %i before the function module initializes", async (raw, expected) => {
    vi.stubEnv("AGENTMEMORY_MAX_INDEXED_OBSERVATIONS", raw);
    vi.resetModules();
    const { getMaxIndexedObservations } = await import("../src/config.js");
    expect(getMaxIndexedObservations()).toBe(expected);
    const { getSearchIndex } = await import("../src/functions/search.js");
    expect(getSearchIndex().observationLimit).toBe(expected === 0 ? Infinity : expected);
  });
});
