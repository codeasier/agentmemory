import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

type Handler = (req: unknown) => Promise<{ status_code: number; body: Record<string, unknown> }>;

function setup(extractResult: unknown, batches = 1) {
  const store = new Map<string, Map<string, unknown>>();
  const observations = new Map<string, unknown>();
  for (let i = 0; i < batches; i++) {
    observations.set(`obs_${i}`, {
      id: `obs_${i}`,
      sessionId: "ses_build",
      timestamp: "2026-09-01T00:00:00Z",
      type: "file_edit",
      title: `Edit ${i}`,
      facts: [],
      narrative: "edited",
      concepts: [],
      files: [],
      importance: 5,
    });
  }
  store.set(KV.sessions, new Map([
    ["ses_build", { id: "ses_build", project: "p", cwd: "/p", startedAt: "2026-09-01T00:00:00Z", status: "active", observationCount: batches }],
  ]));
  store.set(KV.observations("ses_build"), observations);

  const kv = {
    get: vi.fn(async (scope: string, key: string) => store.get(scope)?.get(key) ?? null),
    set: vi.fn(async (_scope: string, _key: string, value: unknown) => value),
    delete: vi.fn(async () => {}),
    list: vi.fn(async (scope: string) => Array.from(store.get(scope)?.values() ?? [])),
  };
  const handlers = new Map<string, Handler>();
  const sdk = {
    registerFunction: (id: string, fn: Handler) => handlers.set(id, fn),
    registerTrigger: () => {},
    trigger: vi.fn(async () => extractResult),
    on: () => {},
  };
  registerApiTriggers(sdk as never, kv as never);
  return (body: Record<string, unknown>) =>
    handlers.get("api::graph-build")!({ headers: {}, query_params: {}, body, method: "POST" });
}

describe("POST /agentmemory/graph/build", () => {
  it("counts nodes and edges from a batch that reports a partial LLM failure", async () => {
    const call = setup({
      success: false,
      error: "LLM timeout",
      nodesAdded: 2,
      edgesAdded: 1,
    });

    const response = await call({ batchSize: 25 });

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      sessions: 1,
      batches: 1,
      nodes: 2,
      edges: 1,
    });
  });
});
