import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  SHUTDOWN_FLUSH_TIMEOUT_MS,
  SHUTDOWN_HARD_EXIT_MS,
  SHUTDOWN_SDK_TIMEOUT_MS,
  SHUTDOWN_VIEWER_TIMEOUT_MS,
  SHUTDOWN_WORKER_GRACE_MS,
  flushIndexOnShutdown,
  settleWithin,
} from "../src/shutdown.js";

describe("settleWithin", () => {
  it("resolves true when the work settles in time", async () => {
    expect(await settleWithin(Promise.resolve("ok"), 1000)).toBe(true);
  });

  it("propagates a rejection instead of reporting success", async () => {
    await expect(settleWithin(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });

  it("resolves false when the work never settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = settleWithin(new Promise(() => {}), 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shutdown budgets", () => {
  it("allows a slow first flush and leaves teardown headroom before the hard exit", () => {
    expect(SHUTDOWN_FLUSH_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(
      SHUTDOWN_VIEWER_TIMEOUT_MS + SHUTDOWN_FLUSH_TIMEOUT_MS + SHUTDOWN_SDK_TIMEOUT_MS,
    ).toBeLessThan(SHUTDOWN_HARD_EXIT_MS);
  });

  it("covers the hard exit in CLI grace and leaves engine-reap time under 120s", () => {
    expect(SHUTDOWN_WORKER_GRACE_MS).toBeGreaterThan(SHUTDOWN_HARD_EXIT_MS);
    expect(SHUTDOWN_WORKER_GRACE_MS + 10000 + 1000).toBeLessThan(120000);
  });

  it("uses the shared grace for native, Docker, removal and orphan worker stops", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(source).toContain('signalAndWait(pid, "SIGTERM", SHUTDOWN_WORKER_GRACE_MS)');
    expect(source).toContain('signalAndWait(workerPid, "SIGTERM", SHUTDOWN_WORKER_GRACE_MS)');
    expect(source.match(/stopWorkerPid\(workerPid\)/g)).toHaveLength(2);
    expect(source).toContain("stopWorkerPid(pid)");
    expect(source).not.toMatch(/stopWorkerPid\([^\n]+,\s*5000\)/);
  });
});

describe("flushIndexOnShutdown", () => {
  const cleanStatus = {
    saving: false,
    pendingChanges: 0,
    orphanDeletes: 0,
    vector: null,
  };

  it("handles an absent vector index without claiming unfinished work", async () => {
    expect(await flushIndexOnShutdown({
      save: async () => {},
      status: () => cleanStatus,
    })).toEqual({ status: "saved" });
  });

  it("reports a rejected save as failed", async () => {
    expect(await flushIndexOnShutdown({
      save: async () => { throw new Error("state unavailable"); },
      status: () => cleanStatus,
    })).toEqual({ status: "failed", error: "state unavailable" });
  });

  it.each([
    { saving: true },
    { pendingChanges: 1 },
    { orphanDeletes: 1 },
  ])("does not report success when persistence remains unfinished: %o", async (pending) => {
    expect(await flushIndexOnShutdown({
      save: async () => {},
      status: () => ({ ...cleanStatus, ...pending }),
    })).toEqual({ status: "failed", error: "pending vector writes or deletes remain" });
  });
});
