import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import type { CompressedObservation } from "../src/types.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: vi.fn(async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
      const fn = functions.get(function_id);
      if (!fn) throw new Error(`No function: ${function_id}`);
      return fn(payload);
    }),
    getFunction: (id: string) => functions.get(id)!,
  };
}

describe("MCP smart-search contract", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: InMemoryKV;
  let observation: CompressedObservation;
  const search = vi.fn();

  const call = (args: Record<string, unknown>, name = "memory_smart_search", headers = {}) =>
    sdk.getFunction("mcp::tools::call")({ body: { name, arguments: args }, headers });

  beforeEach(async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "shared");
    sdk = mockSdk();
    kv = new InMemoryKV();
    observation = {
      id: "obs_1", sessionId: "ses_1", timestamp: "2026-10-01T00:00:00Z",
      type: "file_edit", title: "Auth fix", facts: ["Keep details"], narrative: "Full auth details",
      concepts: ["auth"], files: ["src/auth.ts"], importance: 7,
      agentId: "agent-a", source: {
        hookType: "post_tool_use", originalBytes: 14, truncated: false, toolOutput: "private source",
      },
    };
    await kv.set("mem:sessions", "ses_1", { id: "ses_1" });
    await kv.set("mem:obs:ses_1", observation.id, observation);
    search.mockReset().mockResolvedValue([{
      observation, sessionId: "ses_1", bm25Score: 1, vectorScore: 0, combinedScore: 1,
    }]);
    registerSmartSearchFunction(sdk as never, kv as never, search);
    registerMcpEndpoints(sdk as never, kv as never);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("advertises query OR expandIds, while recall still requires query", () => {
    const tools = getAllTools();
    const schema = tools.find((tool) => tool.name === "memory_smart_search")!.inputSchema;
    expect(schema.required).toBeUndefined();
    expect(schema).toMatchObject({ anyOf: [
      { required: ["query"], properties: { query: { pattern: "\\S" } } },
      { required: ["expandIds"] },
    ] });
    expect(schema.properties.expandIds).toMatchObject({ type: "string", pattern: "[^,\\s]" });
    expect(tools.find((tool) => tool.name === "memory_recall")!.inputSchema.required).toEqual(["query"]);
  });

  it.each([undefined, " auth ", "   "])("expands CSV IDs with query %j, giving expansion precedence", async (query) => {
    const result = await call({ ...(query !== undefined && { query }), expandIds: " , obs_1, ,missing, " });
    expect(result.status_code).toBe(200);
    const expanded = JSON.parse(result.body.content[0].text);
    expect(expanded).toMatchObject({
      mode: "expanded", truncated: false,
      results: [{ obsId: "obs_1", observation: { narrative: "Full auth details" } }],
    });
    expect(expanded.results).toHaveLength(1);
    expect(expanded.results[0].observation).not.toHaveProperty("source");
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps expansion bounded to 20 and reports truncation", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `obs_${i}`);
    for (const id of ids) await kv.set("mem:obs:ses_1", id, { ...observation, id });
    const get = vi.spyOn(kv, "get");
    const result = await call({ expandIds: ids.join(",") });
    expect(result.status_code).toBe(200);
    const expanded = JSON.parse(result.body.content[0].text);
    expect(expanded).toMatchObject({ mode: "expanded", truncated: true });
    expect(expanded.results.map((entry: { obsId: string }) => entry.obsId)).toEqual(ids.slice(0, 20));
    expect(get.mock.calls.some(([scope, id]) => scope === "mem:obs:ses_1" && id === "obs_20")).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "query or expandIds is required"],
    [{ query: " \t " }, "query or expandIds is required"],
    [{ expandIds: " , , " }, "expandIds must contain at least one observation ID"],
    [{ query: "auth", expandIds: "" }, "expandIds must contain at least one observation ID"],
    [{ query: "auth", expandIds: ["obs_1"] }, "expandIds must be a comma-separated string"],
    [{ expandIds: { obsId: "obs_1" } }, "expandIds must be a comma-separated string"],
    [{ expandIds: 42 }, "expandIds must be a comma-separated string"],
    [{ expandIds: null }, "expandIds must be a comma-separated string"],
    [{ query: 42, expandIds: "obs_1" }, "query must be a string"],
    [{ query: null, expandIds: "obs_1" }, "query must be a string"],
  ])("rejects invalid input without dispatch: %j", async (args, error) => {
    const result = await call(args);
    expect(result.status_code).toBe(400);
    expect(result.body.error).toContain(error);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("keeps normal compact query search working", async () => {
    const result = await call({ query: " auth ", limit: 3 });
    expect(result.status_code).toBe(200);
    expect(JSON.parse(result.body.content[0].text)).toMatchObject({
      mode: "compact", results: [{ obsId: "obs_1", title: "Auth fix" }],
    });
    expect(search).toHaveBeenCalledWith("auth", 3);
  });

  it.each([undefined, "", "   ", 42])("recall still rejects missing/invalid query %j even with IDs", async (query) => {
    const result = await call({ query, expandIds: "obs_1" }, "memory_recall");
    expect(result.status_code).toBe(400);
    expect(result.body.error).toBe("query is required for memory_recall");
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("preserves agent isolation during ID-only expansion", async () => {
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    vi.stubEnv("AGENT_ID", "agent-b");
    const result = await call({ expandIds: "obs_1" });
    expect(result.status_code).toBe(200);
    expect(JSON.parse(result.body.content[0].text)).toEqual({ mode: "expanded", results: [], truncated: false });
  });

  it("requires authentication before expanding IDs", async () => {
    registerMcpEndpoints(sdk as never, kv as never, "test-secret");
    expect((await call({ expandIds: "obs_1" })).status_code).toBe(401);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });
});
