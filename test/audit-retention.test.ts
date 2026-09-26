import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const list = vi.fn(async <T>(scope: string): Promise<T[]> => {
    const rows = store.get(scope);
    return rows ? (Array.from(rows.values()) as T[]) : [];
  });
  return {
    store,
    list,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
  };
}

async function writeN(
  recordAudit: Function,
  kv: ReturnType<typeof mockKV>,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await recordAudit(kv, "observe", "mem::observe", [`t${i}`]);
  }
}

async function seedAudit(
  kv: ReturnType<typeof mockKV>,
  count: number,
): Promise<void> {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < count; i++) {
    const id = `aud_${i.toString().padStart(4, "0")}`;
    await kv.set("mem:audit", id, {
      id,
      timestamp: new Date(start + i * 1000).toISOString(),
      operation: "observe",
      functionId: "mem::observe",
      targetIds: [`t${i}`],
    });
  }
}

describe("audit log retention", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AGENTMEMORY_AUDIT_MAX;
    delete process.env.AGENTMEMORY_AUDIT_SWEEP_DELETE_BATCH;
    delete process.env.AGENTMEMORY_AUDIT_SWEEP_CONCURRENCY;
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_AUDIT_MAX;
    delete process.env.AGENTMEMORY_AUDIT_SWEEP_DELETE_BATCH;
    delete process.env.AGENTMEMORY_AUDIT_SWEEP_CONCURRENCY;
  });

  it("keeps audit writes off the list and delete paths", async () => {
    process.env.AGENTMEMORY_AUDIT_MAX = "10";
    const { recordAudit } = await import("../src/functions/audit.js");
    const kv = mockKV();
    const deleteSpy = vi.spyOn(kv, "delete");

    await writeN(recordAudit, kv, 200);

    expect(kv.store.get("mem:audit")!.size).toBe(200);
    expect(kv.list).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("removes the oldest rows in bounded batches", async () => {
    process.env.AGENTMEMORY_AUDIT_MAX = "50";
    process.env.AGENTMEMORY_AUDIT_SWEEP_DELETE_BATCH = "100";
    process.env.AGENTMEMORY_AUDIT_SWEEP_CONCURRENCY = "8";
    const { sweepAuditLog } = await import("../src/functions/audit.js");
    const kv = mockKV();
    await seedAudit(kv, 300);

    const first = await sweepAuditLog(kv as never);
    expect(first).toMatchObject({
      scanned: 300,
      removed: 100,
      failed: 0,
      remaining: 200,
      max: 50,
      more: true,
    });
    expect(kv.store.get("mem:audit")!.size).toBe(200);

    const second = await sweepAuditLog(kv as never);
    expect(second).toMatchObject({ removed: 100, remaining: 100, more: true });

    const third = await sweepAuditLog(kv as never);
    expect(third).toMatchObject({ removed: 50, remaining: 50, more: false });
    const kept = new Set(
      Array.from(kv.store.get("mem:audit")!.values()).map(
        (entry) => (entry as { targetIds: string[] }).targetIds[0],
      ),
    );
    expect(kept.has("t299")).toBe(true);
    expect(kept.has("t0")).toBe(false);
  });

  it("keeps rows that share the newest retained timestamp", async () => {
    process.env.AGENTMEMORY_AUDIT_MAX = "10";
    const { recordAudit, sweepAuditLog } = await import(
      "../src/functions/audit.js"
    );
    const kv = mockKV();
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 30; i++) {
      const id = `aud_same_${i}`;
      await kv.set("mem:audit", id, {
        id,
        timestamp: new Date(start).toISOString(),
        operation: "observe",
        functionId: "mem::observe",
        targetIds: [`t${i}`],
      });
    }

    expect(await sweepAuditLog(kv as never)).toMatchObject({
      removed: 0,
      remaining: 30,
      more: true,
    });
    expect(kv.store.get("mem:audit")!.size).toBe(30);

    const fresh = await recordAudit(
      kv as never,
      "observe",
      "mem::observe",
      ["fresh"],
    );
    process.env.AGENTMEMORY_AUDIT_MAX = "1";
    const result = await sweepAuditLog(kv as never);
    expect(result.remaining).toBe(1);
    expect(kv.store.get("mem:audit")!.has(fresh.id)).toBe(true);
  });

  it("treats 0 as unbounded", async () => {
    process.env.AGENTMEMORY_AUDIT_MAX = "0";
    const { recordAudit, sweepAuditLog } = await import(
      "../src/functions/audit.js"
    );
    const kv = mockKV();
    await writeN(recordAudit, kv, 250);

    expect(await sweepAuditLog(kv as never)).toMatchObject({
      scanned: 250,
      removed: 0,
      remaining: 250,
      more: false,
    });
    expect(kv.store.get("mem:audit")!.size).toBe(250);
  });

  it("retains rows whose delete fails for a later sweep", async () => {
    process.env.AGENTMEMORY_AUDIT_MAX = "10";
    const { sweepAuditLog } = await import("../src/functions/audit.js");
    const kv = mockKV();
    await seedAudit(kv, 30);
    let attempts = 0;
    const failing = {
      ...kv,
      delete: async (scope: string, key: string) => {
        if (++attempts <= 2) throw new Error("delete failed");
        return kv.delete(scope, key);
      },
    };

    const result = await sweepAuditLog(failing as never);
    expect(result.failed).toBe(2);
    expect(result.more).toBe(true);
  });

  it("caps audit query limits", async () => {
    const { recordAudit, queryAudit } = await import(
      "../src/functions/audit.js"
    );
    const kv = mockKV();
    await writeN(recordAudit, kv, 1100);

    expect(await queryAudit(kv as never, { limit: 5000 })).toHaveLength(1000);
  });

  it("drains a bounded number of passes and requests a near-term follow-up", async () => {
    const { drainAuditSweeps } = await import("../src/functions/audit.js");
    const sweep = vi.fn(async () => ({
      scanned: 20000, removed: 2000, failed: 0, remaining: 18000,
      max: 5000, more: true,
    }));

    expect((await drainAuditSweeps(sweep)).followUp).toBe(true);
    expect(sweep).toHaveBeenCalledTimes(4);
  });

  it("stops draining when timestamp ties or deletion failures prevent progress", async () => {
    const { drainAuditSweeps } = await import("../src/functions/audit.js");
    for (const stats of [
      { removed: 0, failed: 0 },
      { removed: 10, failed: 1 },
    ]) {
      const sweep = vi.fn(async () => ({
        scanned: 30, remaining: 30 - stats.removed, max: 10,
        more: true, ...stats,
      }));
      expect((await drainAuditSweeps(sweep)).followUp).toBe(false);
      expect(sweep).toHaveBeenCalledTimes(1);
    }
  });
});
