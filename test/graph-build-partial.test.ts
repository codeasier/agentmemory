import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("api::graph-build partial extraction", () => {
  it("reports persisted heuristic work even when LLM extraction fails", async () => {
    const handlers = new Map<string, Function>();
    const sdk = {
      registerFunction: (id: string, handler: Function) => handlers.set(id, handler),
      registerTrigger: vi.fn(),
      trigger: vi.fn()
        .mockResolvedValueOnce({ success: false, nodesAdded: 2, edgesAdded: 1 })
        .mockResolvedValueOnce({ success: true, nodesAdded: 3, edgesAdded: 4 }),
    };
    const kv = {
      list: vi.fn(async (scope: string) =>
        scope === KV.sessions
          ? [{ id: "session-1" }]
          : [{ id: "obs-1", title: "One" }, { id: "obs-2", title: "Two" }],
      ),
    };
    registerApiTriggers(sdk as never, kv as never, "test-secret");

    const response = await handlers.get("api::graph-build")!({
      headers: { authorization: "Bearer test-secret" },
      body: { batchSize: 1 },
    });

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      sessions: 1, batches: 2, nodes: 5, edges: 5,
    });
    expect(sdk.trigger).toHaveBeenCalledTimes(2);
  });
});
