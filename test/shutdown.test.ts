import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  SHUTDOWN_ENGINE_GRACE_MS,
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
    expect(SHUTDOWN_ENGINE_GRACE_MS).toBeGreaterThan(5000);
    expect(SHUTDOWN_WORKER_GRACE_MS + SHUTDOWN_ENGINE_GRACE_MS + 1000).toBeLessThan(120000);
  });

  it("uses the shared grace for native, Docker, removal and orphan worker stops", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(source).toContain('signalAndWait(pid, "SIGTERM", SHUTDOWN_WORKER_GRACE_MS)');
    expect(source).toContain("stopNativeWorkerPid(workerPid)");
    expect(source.match(/stopWorkerPid\(workerPid\)/g)).toHaveLength(1);
    expect(source).toContain("stopNativeWorkerPid(pid)");
    expect(source).toContain("stopWorkerPid(pid)");
    expect(source).not.toMatch(/stopWorkerPid\([^\n]+,\s*5000\)/);
    expect(source).toContain('signalAndWait(pid, "SIGTERM", SHUTDOWN_ENGINE_GRACE_MS)');
    expect(source).not.toContain('signalAndWait(pid, "SIGTERM", 3000)');
    expect(source).toContain('String(SHUTDOWN_ENGINE_GRACE_MS / 1000)');
  });

  it("does not force-kill a slow flush or clear lifecycle state after a failed stop", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const signal = source.slice(source.indexOf("async function signalAndWait("), source.indexOf("async function stopWorkerPid("));
    const stop = source.slice(source.indexOf("async function runStop()"), source.indexOf("async function runMcp()"));
    expect(signal).not.toContain('process.kill(pid, "SIGKILL")');
    expect(signal).toContain("preserving it for investigation rather than forcing a potentially incomplete flush");
    expect(stop).toMatch(/if \(!\(await stopNativeWorkerPid\(pid\)\)\) \{[\s\S]*?process\.exit\(1\);/);
    expect(stop).toMatch(/if \(!ok\) \{[\s\S]*?Engine shutdown timed out\.[\s\S]*?process\.exit\(1\);/);
    expect(stop.indexOf("clearEnginePidfile();", stop.indexOf("Engine shutdown timed out.")))
      .toBeGreaterThan(stop.indexOf("if (skippedForeign.length > 0)"));
  });

  it("checks a running proof before SIGTERM and successful completion before native engine stop", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const nativeWorker = source.slice(source.indexOf("async function stopNativeWorkerPid("), source.indexOf("type NativeRemovalStopResult"));
    expect(nativeWorker).toContain("captureRunningWorkerProof(pid)");
    expect(nativeWorker).toContain("workerShutdownSucceeded(proof)");
    expect(nativeWorker.indexOf("captureRunningWorkerProof(pid)"))
      .toBeLessThan(nativeWorker.indexOf("await stopWorkerPid(pid)"));
    expect(nativeWorker.indexOf("await stopWorkerPid(pid)"))
      .toBeLessThan(nativeWorker.indexOf("workerShutdownSucceeded(proof)"));
    const stop = source.slice(source.indexOf("async function runStop()"), source.indexOf("async function runMcp()"));
    expect(stop).toContain("await stopNativeWorkerPid(pid)");
    expect(stop.indexOf("await stopNativeWorkerPid(pid)"))
      .toBeLessThan(stop.indexOf("Stopping iii-engine"));
    expect(stop).toContain("Worker PID is missing; cannot prove native worker shutdown");
    expect(stop).toContain("Native engine state remains but no worker PID is available");
    const removal = source.slice(source.indexOf("async function stopNativeEngineForRemoval()"), source.indexOf("function pidCommand("));
    expect(removal).toContain("await stopNativeWorkerPid(workerPid)");
    expect(removal.indexOf("await stopNativeWorkerPid(workerPid)"))
      .toBeLessThan(removal.indexOf("Stopping iii-engine"));
    expect(removal).toContain("worker PID is missing; no engine or files were removed");
  });

  it("publishes failure on a failed flush/SDK shutdown and no completion on hard exit", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const shutdown = source.slice(source.indexOf("const shutdown = async () =>"), source.indexOf('process.on("SIGTERM", shutdown)'));
    expect(shutdown.indexOf("flushIndexOnShutdown(indexPersistence)"))
      .toBeLessThan(shutdown.indexOf("completeWorkerShutdownProof(shutdownProof"));
    expect(shutdown.indexOf("sdk.shutdown()"))
      .toBeLessThan(shutdown.indexOf("completeWorkerShutdownProof(shutdownProof"));
    expect(shutdown).toContain('completeWorkerShutdownProof(shutdownProof, exitCode === 0 ? "success" : "failure")');
    expect(shutdown).toMatch(/const hardExit = setTimeout\(\(\) => \{[\s\S]*?process\.exit\(1\);[\s\S]*?\}, SHUTDOWN_HARD_EXIT_MS\)/);
    expect(shutdown).toMatch(/catch \(err\) \{\s*exitCode = 1;\s*console\.error\("\[agentmemory\] Could not write worker shutdown proof:/);
    expect(shutdown).not.toContain("clearWorkerPidfile()");
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
