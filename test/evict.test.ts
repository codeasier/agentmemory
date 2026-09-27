import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  getEvictionIntervalMs,
  getIndexReclaimBootMaxDeletes,
  isEvictionEnabled,
  parsePositiveIntervalMs,
  TIMER_MAX_INTERVAL_MS,
} from "../src/config.js";
import type {
  CompressedObservation,
  RawObservation,
  Session,
} from "../src/types.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import {
  getSearchIndex,
  setIndexPersistence,
} from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The recovered-session consolidation pass is gated on isConsolidationEnabled
// (keyless installs skip it); force it on so these tests exercise the pass.
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  isConsolidationEnabled: () => true,
}));

type Store = Map<string, Map<string, unknown>>;
type Handler = (payload: unknown) => unknown | Promise<unknown>;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeSession(id: string): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    startedAt: daysAgo(31),
    status: "active",
    observationCount: 1,
  };
}

function makeObservation(sessionId: string): CompressedObservation {
  return {
    id: "obs_1",
    sessionId,
    timestamp: daysAgo(31),
    type: "decision",
    title: "Chose sqlite storage",
    facts: ["Use sqlite for local state"],
    narrative: "The session chose sqlite for local state.",
    concepts: ["sqlite"],
    files: ["src/state/kv.ts"],
    importance: 8,
  };
}

function makeRawObservation(sessionId: string): RawObservation {
  return {
    id: "raw_1",
    sessionId,
    timestamp: daysAgo(31),
    hookType: "post_tool_use",
    toolName: "Edit",
    raw: { file_path: "src/state/kv.ts" },
  };
}

function mockKV(store: Store, listFailures: Set<string> = new Set()) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      if (listFailures.has(scope)) {
        throw new Error(`list failed for ${scope}`);
      }
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ function_id: string; payload: unknown }> = [];
  return {
    calls,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

function storeForObservations(
  sessionId: string,
  observations: Array<CompressedObservation | RawObservation>,
): Store {
  const session = makeSession(sessionId);
  return new Map([
    [KV.sessions, new Map([[session.id, session]])],
    [KV.summaries, new Map()],
    [
      KV.observations(session.id),
      new Map(observations.map((observation) => [observation.id, observation])),
    ],
    [KV.config, new Map()],
    [KV.audit, new Map()],
  ]);
}

function storeForObservedSession(sessionId: string): Store {
  return storeForObservations(sessionId, [makeObservation(sessionId)]);
}

describe("mem::evict stale sessions", () => {
  beforeEach(() => {
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  it("runs session recovery before deleting a stale observed session", async () => {
    const sessionId = "ses_stale";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", async (payload) => {
      // Recovery must pass skipConsolidation so the per-session fan-out is
      // suppressed (evict runs a single corpus-wide pass afterwards).
      expect(payload).toEqual({ sessionId, skipConsolidation: true });
      expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
        id: sessionId,
      });
      return { success: true };
    });
    sdk.registerFunction("mem::consolidate-pipeline", () => ({
      success: true,
    }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(1);
    expect(await kv.get(KV.sessions, sessionId)).toBeNull();
    const audits = await kv.list<{
      details: { reason: string };
    }>(KV.audit);
    expect(audits[0].details.reason).toBe(
      "stale_session_recovered_then_evicted",
    );
    expect(calls.map((call) => call.function_id)).toContain(
      "event::session::stopped",
    );
    expect(calls.map((call) => call.function_id)).toContain(
      "mem::consolidate-pipeline",
    );
  });

  it("bounds consolidation to one pass regardless of how many stale sessions are recovered", async () => {
    // Regression (P1): before the skipConsolidation guard, N recovered
    // sessions each triggered a forced full-corpus consolidate + crystallize
    // via the session::stopped fan-out, on top of evict's final pass — an
    // N+1 amplification of an expensive LLM path. Recovery must stay O(1).
    const ids = ["ses_a", "ses_b", "ses_c"];
    const store: Store = new Map([
      [
        KV.sessions,
        new Map(ids.map((id) => [id, makeSession(id)])),
      ],
      [KV.summaries, new Map()],
      [KV.config, new Map()],
      [KV.audit, new Map()],
    ]);
    for (const id of ids) {
      store.set(
        KV.observations(id),
        new Map([["obs_1", makeObservation(id)]]),
      );
    }
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    const stoppedPayloads: unknown[] = [];
    sdk.registerFunction("event::session::stopped", (payload) => {
      stoppedPayloads.push(payload);
      return { success: true };
    });
    sdk.registerFunction("mem::consolidate-pipeline", () => ({ success: true }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    await sdk.trigger({ function_id: "mem::evict", payload: {} });

    // session::stopped fires once per recovered session, each suppressing its
    // own fan-out...
    expect(stoppedPayloads).toHaveLength(3);
    for (const p of stoppedPayloads) {
      expect(p).toMatchObject({ skipConsolidation: true });
    }
    // ...and the corpus-wide consolidation + crystallization run exactly once.
    const fnIds = calls.map((c) => c.function_id);
    expect(fnIds.filter((f) => f === "mem::consolidate-pipeline")).toHaveLength(1);
    expect(fnIds.filter((f) => f === "mem::auto-crystallize")).toHaveLength(1);
  });

  it("keeps a stale observed session when recovery fails", async () => {
    const sessionId = "ses_unrecovered";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", () => ({
      success: false,
      error: "no_provider",
    }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
      id: sessionId,
    });
    expect(calls.map((call) => call.function_id)).toContain(
      "event::session::stopped",
    );
    expect(calls.map((call) => call.function_id)).not.toContain(
      "mem::consolidate-pipeline",
    );
  });

  it("keeps a stale session when observation scanning fails", async () => {
    const sessionId = "ses_scan_failed";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store, new Set([KV.observations(sessionId)]));
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", () => ({
      success: true,
    }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
      id: sessionId,
    });
    expect(calls.map((call) => call.function_id)).not.toContain(
      "event::session::stopped",
    );
  });

  it("keeps a stale session that only has raw observations", async () => {
    const sessionId = "ses_raw_only";
    const store = storeForObservations(sessionId, [
      makeRawObservation(sessionId),
    ]);
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", () => ({
      success: true,
    }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
      id: sessionId,
    });
    expect(calls.map((call) => call.function_id)).not.toContain(
      "event::session::stopped",
    );
  });

  it("removes evicted observations from the search index and flushes once", async () => {
    const sessionId = "ses_index_cleanup";
    const session = makeSession(sessionId);
    session.startedAt = daysAgo(1);
    const observation = makeObservation(sessionId);
    observation.id = "obs_index_cleanup";
    observation.timestamp = daysAgo(100);
    observation.importance = 1;
    const store = storeForObservations(sessionId, [observation]);
    store.get(KV.sessions)!.set(sessionId, session);
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    const save = vi.fn(async () => {});
    setIndexPersistence({ scheduleSave: vi.fn(), save });
    getSearchIndex().add(observation);
    registerEvictFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { lowImportanceObs: number };

    expect(result.lowImportanceObs).toBe(1);
    expect(getSearchIndex().has(observation.id)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite indexes on an idle eviction sweep", async () => {
    const kv = mockKV(new Map([
      [KV.sessions, new Map()],
      [KV.summaries, new Map()],
      [KV.memories, new Map()],
      [KV.config, new Map()],
    ]));
    const { sdk } = mockSdk();
    const save = vi.fn(async () => {});
    setIndexPersistence({ scheduleSave: vi.fn(), save });
    registerEvictFunction(sdk as never, kv as never);

    await sdk.trigger({ function_id: "mem::evict", payload: {} });

    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the search index untouched during a dry run", async () => {
    const sessionId = "ses_dry_run";
    const session = makeSession(sessionId);
    session.startedAt = daysAgo(1);
    const observation = makeObservation(sessionId);
    observation.id = "obs_dry_run";
    observation.timestamp = daysAgo(100);
    observation.importance = 1;
    const store = storeForObservations(sessionId, [observation]);
    store.get(KV.sessions)!.set(sessionId, session);
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    const save = vi.fn(async () => {});
    setIndexPersistence({ scheduleSave: vi.fn(), save });
    getSearchIndex().add(observation);
    registerEvictFunction(sdk as never, kv as never);

    await sdk.trigger({
      function_id: "mem::evict",
      payload: { dryRun: true },
    });

    expect(getSearchIndex().has(observation.id)).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("eviction scheduling", () => {
  const src = readFileSync("src/index.ts", "utf-8");

  beforeEach(() => {
    delete process.env.AGENTMEMORY_EVICTION_ENABLED;
    delete process.env.AGENTMEMORY_EVICTION_INTERVAL_MS;
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_EVICTION_ENABLED;
    delete process.env.AGENTMEMORY_EVICTION_INTERVAL_MS;
  });

  it("is opt-in and defaults to a 24 hour interval", () => {
    expect(isEvictionEnabled()).toBe(false);
    expect(getEvictionIntervalMs()).toBe(86400000);
  });

  it("reads explicit scheduler settings", () => {
    process.env.AGENTMEMORY_EVICTION_ENABLED = "true";
    process.env.AGENTMEMORY_EVICTION_INTERVAL_MS = "3600000";
    expect(isEvictionEnabled()).toBe(true);
    expect(getEvictionIntervalMs()).toBe(3600000);
  });

  it("bounds boot index-reclaim deletes to a safe non-negative integer", () => {
    delete process.env.AGENTMEMORY_INDEX_RECLAIM_BOOT_MAX_SHARDS;
    expect(getIndexReclaimBootMaxDeletes()).toBe(200);

    process.env.AGENTMEMORY_INDEX_RECLAIM_BOOT_MAX_SHARDS = "50";
    expect(getIndexReclaimBootMaxDeletes()).toBe(50);

    process.env.AGENTMEMORY_INDEX_RECLAIM_BOOT_MAX_SHARDS = "0";
    expect(getIndexReclaimBootMaxDeletes()).toBe(0);

    for (const bogus of ["abc", "-5", "1.5", "9999999999999999999999"]) {
      process.env.AGENTMEMORY_INDEX_RECLAIM_BOOT_MAX_SHARDS = bogus;
      expect(getIndexReclaimBootMaxDeletes()).toBe(200);
    }
    delete process.env.AGENTMEMORY_INDEX_RECLAIM_BOOT_MAX_SHARDS;
  });

  it("registers an unref'd interval with completion logging and an overlap guard", () => {
    expect(src).toMatch(/if\s*\(\s*isEvictionEnabled\(\)\s*\)/);
    expect(src).toMatch(/const\s+evictionTimer\s*=\s*setInterval/);
    expect(src).toMatch(/evictionTimer\.unref\(\)/);
    expect(src).toMatch(/logger\.info\(\s*"Scheduled eviction sweep complete"/);
    expect(src).toMatch(/logger\.warn\(\s*"Scheduled eviction sweep failed"/);
    expect(src).toMatch(/let\s+evictionInFlight\s*=\s*false;/);
  });
});

describe("parsePositiveIntervalMs", () => {
  it("accepts a plain positive decimal integer", () => {
    expect(parsePositiveIntervalMs("21600000", 1)).toBe(21600000);
    expect(parsePositiveIntervalMs(String(TIMER_MAX_INTERVAL_MS), 1)).toBe(
      TIMER_MAX_INTERVAL_MS,
    );
  });

  it("falls back on unset, non-numeric, zero and negative values", () => {
    expect(parsePositiveIntervalMs(undefined, 7)).toBe(7);
    expect(parsePositiveIntervalMs("abc", 7)).toBe(7);
    expect(parsePositiveIntervalMs("0", 7)).toBe(7);
    expect(parsePositiveIntervalMs("-5", 7)).toBe(7);
  });

  it("rejects values parseInt would silently truncate", () => {
    // parseInt("1e3") and parseInt("1.5") are both 1 - a 1ms destructive
    // loop if either were accepted.
    expect(parsePositiveIntervalMs("1e3", 7)).toBe(7);
    expect(parsePositiveIntervalMs("1.5", 7)).toBe(7);
  });

  it("rejects values above Node's 32-bit timer delay ceiling", () => {
    // setInterval coerces delays above 2^31 - 1 to 1ms, so an oversized
    // configured interval would run the sweep every millisecond.
    expect(parsePositiveIntervalMs("2147483648", 7)).toBe(7);
  });
});
