import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { IndexPersistence, vectorBucketScope } from "../src/state/index-persistence.js";
import { KV } from "../src/state/schema.js";
import { VectorIndex } from "../src/state/vector-index.js";
import {
  SHUTDOWN_FLUSH_TIMEOUT_MS,
  SHUTDOWN_HARD_EXIT_MS,
  SHUTDOWN_SDK_TIMEOUT_MS,
  flushIndexOnShutdown,
  settleWithin,
} from "../src/shutdown.js";

const META_KEY = "vectors:meta";

function mockKV(options: {
  bucketDelayMs?: number;
  blockBuckets?: boolean;
  metadataError?: Error;
} = {}) {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope.startsWith(`${KV.bm25Index}:vec:`)) {
        if (options.blockBuckets) await new Promise<void>(() => {});
        if (options.bucketDelayMs) {
          await new Promise<void>((resolve) => setTimeout(resolve, options.bucketDelayMs));
        }
      }
      if (scope === KV.bm25Index && key === META_KEY && options.metadataError) {
        throw options.metadataError;
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function localVector(): Float32Array {
  const embedding = new Float32Array(384).fill(0.125);
  embedding[0] = 0.5;
  embedding[1] = 0.25;
  return embedding;
}

function firstSave(kv: ReturnType<typeof mockKV>) {
  const vector = new VectorIndex();
  vector.add("obs_shutdown", "ses_shutdown", localVector());
  const persistence = new IndexPersistence(kv as never, vector, {
    bucketSize: 16,
    saveIntervalMs: 600000,
  });
  persistence.stop();
  return { vector, persistence };
}

describe("shutdown vector persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([4100, 4500, 4900])(
    "publishes first-save metadata before SDK teardown when bucket writes take %ims",
    async (bucketDelayMs) => {
      const kv = mockKV({ bucketDelayMs });
      await kv.set(KV.observations("ses_shutdown"), "obs_shutdown", {
        id: "obs_shutdown",
        sessionId: "ses_shutdown",
        title: "shutdown canary",
        narrative: "acknowledged observation with a local vector",
      });
      const { persistence } = firstSave(kv);
      const sdkShutdown = vi.fn(async () => {});
      const shutdown = (async () => {
        const flush = await flushIndexOnShutdown(persistence);
        await settleWithin(sdkShutdown(), SHUTDOWN_SDK_TIMEOUT_MS);
        return flush;
      })();

      await vi.advanceTimersByTimeAsync(4000);
      expect(sdkShutdown).not.toHaveBeenCalled();
      expect(await kv.get(KV.bm25Index, META_KEY)).toBeNull();
      expect(persistence.status().saving).toBe(true);

      await vi.advanceTimersByTimeAsync(bucketDelayMs - 4000);
      expect(await shutdown).toEqual({ status: "saved" });
      expect(sdkShutdown).toHaveBeenCalledOnce();
      expect(await kv.get(KV.bm25Index, META_KEY)).toMatchObject({
        v: 4,
        bucketCount: 1,
        count: 1,
      });
      const row = await kv.get<{ c: string; e: string }>(vectorBucketScope(0), "obs_shutdown");
      expect(row?.c).toBe("f16");
      expect(Buffer.from(row!.e, "base64")).toHaveLength(384 * 2);

      const reboot = new IndexPersistence(kv as never, new VectorIndex(), {
        bucketSize: 16,
        saveIntervalMs: 600000,
      });
      const loaded = await reboot.load();
      expect(loaded.state).toBe("buckets");
      expect(loaded.expectedCount).toBe(1);
      expect(loaded.vector?.size).toBe(1);
      expect(loaded.vector?.get("obs_shutdown")?.embedding).toHaveLength(384);
      const recalled = loaded.vector!.search(localVector(), 1);
      expect(recalled[0].obsId).toBe("obs_shutdown");
      expect(recalled[0].score).toBeCloseTo(1, 6);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a dead engine's first flush and blocked SDK teardown without publishing metadata", async () => {
    const kv = mockKV({ blockBuckets: true });
    const { persistence } = firstSave(kv);
    const startedAt = Date.now();
    const sdkShutdown = vi.fn(() => new Promise<void>(() => {}));
    let completed = false;
    const shutdown = (async () => {
      const flush = await flushIndexOnShutdown(persistence);
      const sdkStopped = await settleWithin(sdkShutdown(), SHUTDOWN_SDK_TIMEOUT_MS);
      completed = true;
      return { flush, sdkStopped };
    })();

    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_TIMEOUT_MS - 1);
    expect(completed).toBe(false);
    expect(sdkShutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sdkShutdown).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(await kv.get(KV.bm25Index, META_KEY)).toBeNull();

    await vi.advanceTimersByTimeAsync(SHUTDOWN_SDK_TIMEOUT_MS);
    expect(await shutdown).toEqual({
      flush: { status: "timed-out" },
      sdkStopped: false,
    });
    expect(Date.now() - startedAt).toBe(SHUTDOWN_FLUSH_TIMEOUT_MS + SHUTDOWN_SDK_TIMEOUT_MS);
    expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_HARD_EXIT_MS);
    expect(await kv.get(KV.bm25Index, META_KEY)).toBeNull();
    expect(persistence.status().saving).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["metadata write failed", ""])(
    "reports a metadata write failure even though IndexPersistence.save resolves: %j",
    async (message) => {
      const kv = mockKV({ metadataError: new Error(message) });
      const { persistence } = firstSave(kv);

      expect(await flushIndexOnShutdown(persistence)).toEqual({
        status: "failed",
        error: message,
      });
      expect(await kv.get(KV.bm25Index, META_KEY)).toBeNull();
      expect(await kv.get(vectorBucketScope(0), "obs_shutdown")).not.toBeNull();
      expect(persistence.status().pendingChanges).toBe(0);
      expect(persistence.status().vector?.lastError).toBe(message);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not report a complete flush when new vectors arrive during its final snapshot", async () => {
    const kv = mockKV({ bucketDelayMs: 4500 });
    const { vector, persistence } = firstSave(kv);
    const flush = flushIndexOnShutdown(persistence);

    await vi.advanceTimersByTimeAsync(4000);
    vector.add("obs_late", "ses_shutdown", localVector());
    await vi.advanceTimersByTimeAsync(500);

    expect(await flush).toEqual({
      status: "failed",
      error: "pending vector writes or deletes remain",
    });
    expect(persistence.status().pendingChanges).toBe(1);
    expect(await kv.get(vectorBucketScope(0), "obs_late")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
