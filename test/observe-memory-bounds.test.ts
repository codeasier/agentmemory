import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawObservation } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const writes: Array<{ scope: string; key: string; data: unknown }> = [];
  return {
    store,
    writes,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      writes.push({ scope, key, data });
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const row = store.get(scope)?.get(key) as Record<string, unknown> | undefined;
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
  const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    registerFunction: (id: string, fn: Function) => functions.set(id, fn),
    trigger: async (
      input:
        | string
        | {
            function_id: string;
            payload?: Record<string, unknown>;
            action?: unknown;
          },
      data?: unknown,
    ) => {
      const id = typeof input === "string" ? input : input.function_id;
      const payload =
        (typeof input === "string" ? data : input.payload) as Record<
          string,
          unknown
        >;
      calls.push({ id, payload });
      const fn = functions.get(id);
      return fn ? fn(payload) : null;
    },
  };
}

describe("observe memory bounds", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { getSearchIndex, setIndexPersistence } = await import(
      "../src/functions/search.js"
    );
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_OBSERVE_TOOL_INPUT_CHARS;
  });

  it.each([1, 3])("keeps tiny configured string budget %i within the serialized limit", async (limit) => {
    process.env.AGENTMEMORY_OBSERVE_TOOL_INPUT_CHARS = String(limit);
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_tiny",
      project: "/repo",
      cwd: "/repo",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: "\\n".repeat(200) },
    });

    const rawWrite = kv.writes.find((write) => write.scope === "mem:obs:ses_tiny")!.data as RawObservation;
    expect(JSON.stringify(rawWrite.toolInput).length).toBeLessThanOrEqual(Math.max(2, limit));
  });

  it("reconciles the session counter on reaching the cap", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_counted", {
      id: "ses_counted",
      observationCount: 2,
      status: "active",
    });
    await kv.set("mem:obs:ses_counted", "obs_1", { id: "obs_1" });
    await kv.set("mem:obs:ses_counted", "obs_2", { id: "obs_2" });
    registerObserveFunction(sdk as never, kv as never, undefined, 2);
    const listSpy = vi.spyOn(kv, "list");

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_counted",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    expect(result).toEqual({
      success: false,
      error: "Session observation limit reached (2)",
    });
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("allows capture after an observation is deleted from a capped session", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_deleted", {
      id: "ses_deleted",
      observationCount: 2,
      status: "active",
    });
    await kv.set("mem:obs:ses_deleted", "old", { id: "old" });
    registerObserveFunction(sdk as never, kv as never, undefined, 2);
    const listSpy = vi.spyOn(kv, "list");

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_deleted",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    expect(result).toMatchObject({ observationId: expect.any(String) });
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect((await kv.get<{ observationCount: number }>("mem:sessions", "ses_deleted"))?.observationCount).toBe(2);
    expect((await kv.list("mem:obs:ses_deleted"))).toHaveLength(2);
  });

  it("falls back to listing only when the session counter is missing", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_legacy", {
      id: "ses_legacy",
      status: "active",
    });
    await kv.set("mem:obs:ses_legacy", "obs_1", { id: "obs_1" });
    await kv.set("mem:obs:ses_legacy", "obs_2", { id: "obs_2" });
    registerObserveFunction(sdk as never, kv as never, undefined, 2);
    const listSpy = vi.spyOn(kv, "list");

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_legacy",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    expect(result).toMatchObject({ success: false });
    expect(listSpy).toHaveBeenCalledWith("mem:obs:ses_legacy");
  });

  it("reconciles a zero counter from an older migrated session before enforcing the cap", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_migrated", {
      id: "ses_migrated",
      observationCount: 0,
      status: "completed",
    });
    await kv.set("mem:obs:ses_migrated", "old_1", { id: "old_1" });
    await kv.set("mem:obs:ses_migrated", "old_2", { id: "old_2" });
    registerObserveFunction(sdk as never, kv as never, undefined, 2);

    const result = await sdk.trigger("mem::observe", {
      sessionId: "ses_migrated",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    expect(result).toMatchObject({ success: false, error: "Session observation limit reached (2)" });
    expect(await kv.list("mem:obs:ses_migrated")).toHaveLength(2);
  });

  it("retains the recounted observations when creating a missing session", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:obs:ses_missing", "old_1", { id: "old_1" });
    await kv.set("mem:obs:ses_missing", "old_2", { id: "old_2" });
    registerObserveFunction(sdk as never, kv as never, undefined, 3);

    const payload = {
      sessionId: "ses_missing",
      project: "/repo",
      cwd: "/repo",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    };
    expect(await sdk.trigger("mem::observe", payload)).toMatchObject({ observationId: expect.any(String) });
    expect((await kv.get<{ observationCount: number }>("mem:sessions", "ses_missing"))?.observationCount).toBe(3);
    expect(await sdk.trigger("mem::observe", payload)).toMatchObject({
      success: false,
      error: "Session observation limit reached (3)",
    });
  });

  it("counts surviving observations on implicit create when the cap is disabled", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set("mem:obs:ses_uncapped", "old_1", { id: "old_1" });
    registerObserveFunction(sdk as never, kv as never, undefined, 0);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_uncapped",
      project: "/repo",
      cwd: "/repo",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });
    expect((await kv.get<{ observationCount: number }>("mem:sessions", "ses_uncapped"))?.observationCount).toBe(2);
  });

  it("bounds tool payloads and the duplicated raw envelope", async () => {
    const { OBSERVE_PAYLOAD_LIMITS, registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_bounds",
      project: "/repo",
      cwd: "/repo",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Read",
        tool_input: { file_path: "src/auth.ts", blob: "i".repeat(5_000) },
        tool_output: { file_path: "src/auth.ts", blob: "o".repeat(9_000) },
        extra: { blob: "r".repeat(20_000) },
      },
    });

    const rawWrite = kv.writes.find(
      (write) => write.scope === "mem:obs:ses_bounds",
    )!.data as RawObservation;
    expect(rawWrite.toolInput).toMatchObject({ file_path: "src/auth.ts" });
    expect(rawWrite.toolOutput).toMatchObject({ file_path: "src/auth.ts" });
    expect(JSON.stringify(rawWrite.toolInput).length).toBeLessThanOrEqual(
      OBSERVE_PAYLOAD_LIMITS.toolInputChars,
    );
    expect(JSON.stringify(rawWrite.toolOutput).length).toBeLessThanOrEqual(
      OBSERVE_PAYLOAD_LIMITS.toolOutputChars,
    );
    expect(JSON.stringify(rawWrite.raw).length).toBeLessThanOrEqual(
      OBSERVE_PAYLOAD_LIMITS.rawChars,
    );
  });

  it("honors a configured tool input bound while preserving file metadata", async () => {
    process.env.AGENTMEMORY_OBSERVE_TOOL_INPUT_CHARS = "32";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_env_bound",
      project: "/repo",
      cwd: "/repo",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Read",
        tool_input: { file_path: "src/auth.ts", content: "x".repeat(500) },
      },
    });

    const rawWrite = kv.writes.find(
      (write) => write.scope === "mem:obs:ses_env_bound",
    )!.data as RawObservation;
    expect(rawWrite.toolInput).toMatchObject({ file_path: "src/auth.ts" });
    expect(JSON.stringify(rawWrite.toolInput).length).toBeLessThanOrEqual(32);
  });

  it("publishes observation events without persisting stream entries", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_stream",
      project: "/repo",
      cwd: "/repo",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "x".repeat(10_000) },
    });

    const rawWrite = kv.writes.find(
      (write) => write.scope === "mem:obs:ses_stream",
    )!.data as RawObservation;
    expect(rawWrite.userPrompt!.length).toBeLessThanOrEqual(8_020);
    expect(sdk.calls.filter((call) => call.id === "stream::set")).toHaveLength(0);
    expect(sdk.calls.filter((call) => call.id === "stream::send")).toHaveLength(4);
  });
});
