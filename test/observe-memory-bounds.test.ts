import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawObservation } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
}));

const LIMIT_KEYS = [
  "AGENTMEMORY_OBSERVE_TOOL_INPUT_CHARS",
  "AGENTMEMORY_OBSERVE_TOOL_OUTPUT_CHARS",
  "AGENTMEMORY_OBSERVE_PROMPT_CHARS",
  "AGENTMEMORY_OBSERVE_RAW_CHARS",
];

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
  const functions = new Map<string, (payload: unknown) => unknown>();
  const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    registerFunction: (id: string, fn: (payload: unknown) => unknown) => {
      functions.set(id, fn);
    },
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
      const payload = (
        typeof input === "string" ? data : input.payload
      ) as Record<string, unknown>;
      calls.push({ id, payload });
      const fn = functions.get(id);
      return fn ? await fn(payload) : null;
    },
  };
}

function payloadFor(sessionId: string, data: Record<string, unknown>) {
  return {
    sessionId,
    project: "/repo",
    cwd: "/repo",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data,
  };
}

function storedRaw(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
): RawObservation {
  return kv.writes.find((write) => write.scope === `mem:obs:${sessionId}`)!
    .data as RawObservation;
}

describe("observe payload bounds", () => {
  beforeEach(async () => {
    vi.resetModules();
    for (const key of LIMIT_KEYS) delete process.env[key];
    const { getSearchIndex, setIndexPersistence } = await import(
      "../src/functions/search.js"
    );
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  afterEach(() => {
    for (const key of LIMIT_KEYS) delete process.env[key];
  });

  it("keeps an oversized tool output's small fields within the budget", async () => {
    const { OBSERVE_PAYLOAD_LIMITS, registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger(
      "mem::observe",
      payloadFor("ses_bounds", {
        tool_name: "Bash",
        tool_input: { command: "rg auth src" },
        tool_output: { file_path: "src/auth.ts", stdout: "o".repeat(9_000) },
        extra: { blob: "r".repeat(20_000) },
      }),
    );

    const rawWrite = storedRaw(kv, "ses_bounds");
    expect(rawWrite.toolOutput).toMatchObject({ file_path: "src/auth.ts" });
    expect(rawWrite.toolInput).toMatchObject({ command: "rg auth src" });
    expect(JSON.stringify(rawWrite.toolOutput).length).toBeLessThanOrEqual(
      OBSERVE_PAYLOAD_LIMITS.toolOutputChars,
    );
    expect(JSON.stringify(rawWrite.raw).length).toBeLessThanOrEqual(
      OBSERVE_PAYLOAD_LIMITS.rawChars,
    );
  });

  it("publishes an unbounded tool output when its budget is zero", async () => {
    process.env.AGENTMEMORY_OBSERVE_TOOL_OUTPUT_CHARS = "0";
    const { OBSERVE_PAYLOAD_LIMITS, registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const stdout = "o".repeat(20_000);
    await sdk.trigger(
      "mem::observe",
      payloadFor("ses_unbounded", { tool_name: "Bash", tool_output: stdout }),
    );

    expect(OBSERVE_PAYLOAD_LIMITS.toolOutputChars).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(storedRaw(kv, "ses_unbounded").toolOutput).toBe(stdout);
  });

  it.each([1, 3])(
    "clamps a %i-char string budget to the smallest serialized string",
    async (limit) => {
      process.env.AGENTMEMORY_OBSERVE_TOOL_INPUT_CHARS = String(limit);
      const { registerObserveFunction } = await import(
        "../src/functions/observe.js"
      );
      const sdk = mockSdk();
      const kv = mockKV();
      registerObserveFunction(sdk as never, kv as never);

      await sdk.trigger(
        "mem::observe",
        payloadFor("ses_tiny", {
          tool_name: "Read",
          tool_input: "\\n".repeat(200),
        }),
      );

      const rawWrite = storedRaw(kv, "ses_tiny");
      expect(JSON.stringify(rawWrite.toolInput).length).toBeLessThanOrEqual(
        Math.max(2, limit),
      );
    },
  );

  it("honors a configured tool input bound while preserving file metadata", async () => {
    process.env.AGENTMEMORY_OBSERVE_TOOL_INPUT_CHARS = "32";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger(
      "mem::observe",
      payloadFor("ses_env_bound", {
        tool_name: "Read",
        tool_input: { file_path: "src/auth.ts", content: "x".repeat(500) },
      }),
    );

    const rawWrite = storedRaw(kv, "ses_env_bound");
    expect(rawWrite.toolInput).toMatchObject({ file_path: "src/auth.ts" });
    expect(JSON.stringify(rawWrite.toolInput).length).toBeLessThanOrEqual(32);
  });

  it("bounds the user prompt on a prompt_submit capture", async () => {
    process.env.AGENTMEMORY_OBSERVE_PROMPT_CHARS = "64";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      ...payloadFor("ses_prompt", { prompt: "x".repeat(5_000) }),
      hookType: "prompt_submit",
    });

    const rawWrite = storedRaw(kv, "ses_prompt");
    expect(JSON.stringify(rawWrite.userPrompt).length).toBeLessThanOrEqual(64);
  });
});
