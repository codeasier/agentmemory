import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

vi.mock("iii-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("iii-sdk")>();
  return {
    ...actual,
    TriggerAction: {
      ...actual.TriggerAction,
      Void: vi.fn(() => ({ type: "void" })),
    },
  };
});

import {
  getSearchIndex,
  indexRecords,
  setIndexPersistence,
} from "../src/functions/search.js";
import type { CompressedObservation } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const row = store.get(scope)?.get(key) as
        | Record<string, unknown>
        | undefined;
      if (!row) return;
      for (const update of updates) row[update.path] = update.value;
      store.get(scope)!.set(key, row);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const rows = store.get(scope);
      return rows ? (Array.from(rows.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, fn: Function) => {
      functions.set(id, fn);
    },
    registerTrigger: () => {},
    trigger: async (
      input: string | { function_id: string; payload?: unknown },
      data?: unknown,
    ) => {
      const id = typeof input === "string" ? input : input.function_id;
      const payload = typeof input === "string" ? data : input.payload;
      const fn = functions.get(id);
      if (!fn) return {};
      return fn(payload);
    },
  };
}

function makeObs(id: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_sched",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: `auth handler ${id}`,
    subtitle: "",
    facts: [],
    narrative: `scheduled save ${id}`,
    concepts: [],
    files: [],
    importance: 5,
  };
}

// Every index *addition* path must ask persistence for a debounced save.
// Without the wiring the additions only live in memory: a crash or SIGKILL
// reloads a snapshot that predates them and nothing rebuilds it, because the
// non-empty BM25 index skips the restart rebuild.
describe("index additions schedule a persistence save", () => {
  let scheduleSave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getSearchIndex().clear();
    scheduleSave = vi.fn();
    setIndexPersistence({
      scheduleSave,
      save: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    setIndexPersistence(null);
  });

  it("mem::observe schedules a save for the synthetic compression path", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_sched",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: "scheduling check" },
    })) as { observationId?: string; deduplicated?: boolean };

    expect(result.observationId).toBeTypeOf("string");
    expect(scheduleSave).toHaveBeenCalled();
  });

  it("mem::remember schedules a save once the memory is indexed", async () => {
    const { registerRememberFunction } = await import(
      "../src/functions/remember.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::remember", {
      content: "index additions must schedule a persistence save",
      type: "lesson",
    })) as { success?: boolean };

    expect(result.success).toBe(true);
    expect(scheduleSave).toHaveBeenCalled();
  });

  it("indexRecords schedules a save when it indexes records", async () => {
    const count = await indexRecords([makeObs("obs_sched")], []);

    expect(count).toBe(1);
    expect(scheduleSave).toHaveBeenCalled();
  });

  it("indexRecords leaves persistence untouched when there is nothing to index", async () => {
    const count = await indexRecords([], []);

    expect(count).toBe(0);
    expect(scheduleSave).not.toHaveBeenCalled();
  });
});
