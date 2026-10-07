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
import { engineFlushWaitMs } from "../src/cli/engine-config.js";

function cliSource(): string {
  return readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
}

function indexSource(): string {
  return readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
}

function shutdownHandler(): string {
  const source = indexSource();
  return source.slice(
    source.indexOf("const shutdown = async () =>"),
    source.indexOf('process.on("SIGTERM", shutdown)'),
  );
}

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
  it("allows a slow first checkpoint and leaves teardown headroom before the hard exit", () => {
    expect(SHUTDOWN_FLUSH_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(SHUTDOWN_VIEWER_TIMEOUT_MS + SHUTDOWN_FLUSH_TIMEOUT_MS + SHUTDOWN_SDK_TIMEOUT_MS)
      .toBeLessThan(SHUTDOWN_HARD_EXIT_MS);
  });

  it("covers the hard exit in CLI grace and still reaps the engine inside the service deadline", () => {
    expect(SHUTDOWN_ENGINE_GRACE_MS).toBeGreaterThan(5000);
    expect(SHUTDOWN_WORKER_GRACE_MS).toBe(SHUTDOWN_HARD_EXIT_MS + 1000);
    expect(SHUTDOWN_WORKER_GRACE_MS).toBeGreaterThan(SHUTDOWN_ENGINE_GRACE_MS);
    const engineFlushMs = engineFlushWaitMs("file", []);
    expect(engineFlushMs).toBeGreaterThan(0);
    // The production unit's TimeoutStopSec is 150s: worker grace, the engine
    // flush window and the engine grace must fit with reaping headroom.
    expect(SHUTDOWN_WORKER_GRACE_MS + engineFlushMs + SHUTDOWN_ENGINE_GRACE_MS + 1000)
      .toBeLessThan(150000);
  });

  it("wires every worker-side budget into the shutdown handler", () => {
    const shutdown = shutdownHandler();
    expect(shutdown).toContain("if (shuttingDown) return;");
    expect(shutdown).toContain("capture.stop();");
    expect(shutdown).toContain("settleWithin(viewerClosed, SHUTDOWN_VIEWER_TIMEOUT_MS)");
    expect(shutdown).toContain("flushIndexOnShutdown(indexPersistence)");
    expect(shutdown).toContain("settleWithin(sdk.shutdown(), SHUTDOWN_SDK_TIMEOUT_MS)");
    expect(shutdown).toContain("}, SHUTDOWN_HARD_EXIT_MS)");
    expect(shutdown).toContain("SHUTDOWN_FLUSH_TIMEOUT_MS");
    expect(shutdown).toContain("process.exit(exitCode)");
    expect(shutdown).toMatch(
      /if \(!\(await settleWithin\(viewerClosed, SHUTDOWN_VIEWER_TIMEOUT_MS\)\)\) \{\s*exitCode = 1;/,
    );
    expect(shutdown).toMatch(/if \(flush\.status !== "saved"\) \{\s*exitCode = 1;/);
    expect(shutdown).toMatch(
      /if \(!\(await settleWithin\(sdk\.shutdown\(\), SHUTDOWN_SDK_TIMEOUT_MS\)\)\) \{\s*exitCode = 1;/,
    );
    expect(shutdown).toMatch(/catch \(err\) \{\s*exitCode = 1;\s*console\.warn\(`\[agentmemory\] SDK shutdown failed:/);
    expect(shutdown).not.toContain("process.exit(0)");
  });

  it("uses the shared worker grace for native, Docker, removal and orphan worker stops", () => {
    const source = cliSource();
    expect(source.match(/stopNativeWorkerPid\(pid\)/g)).toHaveLength(1);
    expect(source.match(/stopNativeWorkerPid\(workerPid\)/g)).toHaveLength(2);
    expect(source.match(/stopWorkerPid\(workerPid\)/g)).toHaveLength(1);
    expect(source).not.toMatch(/stopWorkerPid\([^\n]+,\s*5000\)/);
    expect(source.match(/await stopWorkerPid\(/g)).toHaveLength(2);
    expect(source).not.toContain("SHUTDOWN_HARD_EXIT_MS");
    expect(source).not.toMatch(/SHUTDOWN_WORKER_GRACE_MS\s*\+/);
    expect(source.match(/SIGTERM", SHUTDOWN_WORKER_GRACE_MS/g)).toHaveLength(1);
  });

  it("keeps the engine-flush window between the worker stop and the engine stop", () => {
    const source = cliSource();
    const stop = source.slice(
      source.indexOf("async function runStop()"),
      source.indexOf("async function runMcp()"),
    );
    expect(stop).toContain("await waitForEngineFlush()");
    expect(stop.indexOf("await stopNativeWorkerPid(pid)"))
      .toBeLessThan(stop.indexOf("await waitForEngineFlush()"));
    expect(stop.indexOf("await waitForEngineFlush()"))
      .toBeLessThan(stop.indexOf("Stopping iii-engine"));
  });
});

describe("worker shutdown proof gating", () => {
  it("does not force-kill a slow flush", () => {
    const source = cliSource();
    const signal = source.slice(
      source.indexOf("async function signalAndWait("),
      source.indexOf("async function stopWorkerPid("),
    );
    expect(signal).not.toContain('process.kill(pid, "SIGKILL")');
    expect(signal).toContain(
      "preserving it for investigation rather than forcing a potentially incomplete flush",
    );
    expect(source).not.toContain('"SIGKILL"');
  });

  it("checks a running proof before SIGTERM and a success proof before stopping the engine", () => {
    const source = cliSource();
    const nativeWorker = source.slice(
      source.indexOf("async function stopNativeWorkerPid("),
      source.indexOf("type NativeRemovalStopResult"),
    );
    expect(nativeWorker).toContain("captureRunningWorkerProof(pid)");
    expect(nativeWorker).toContain("workerShutdownSucceeded(proof)");
    expect(nativeWorker.indexOf("captureRunningWorkerProof(pid)"))
      .toBeLessThan(nativeWorker.indexOf("await stopWorkerPid(pid)"));
    expect(nativeWorker.indexOf("await stopWorkerPid(pid)"))
      .toBeLessThan(nativeWorker.indexOf("workerShutdownSucceeded(proof)"));
  });

  it("preserves the engine and lifecycle state when the worker stop is unproven", () => {
    const source = cliSource();
    const stop = source.slice(
      source.indexOf("async function runStop()"),
      source.indexOf("async function runMcp()"),
    );
    expect(stop).toContain("await stopNativeWorkerPid(pid)");
    expect(stop.indexOf("await stopNativeWorkerPid(pid)"))
      .toBeLessThan(stop.indexOf("Stopping iii-engine"));
    expect(stop).toContain("Worker PID is missing; cannot prove native worker shutdown");
    expect(stop).toContain("Native engine state remains but no worker PID is available");
    expect(stop).toMatch(/if \(!\(await stopNativeWorkerPid\(pid\)\)\) \{[\s\S]*?process\.exit\(1\);/);
    expect(stop).toMatch(/if \(!ok\) \{[\s\S]*?Engine shutdown timed out\.[\s\S]*?process\.exit\(1\);/);
    expect(stop.indexOf("clearEnginePidfile();", stop.indexOf("Engine shutdown timed out.")))
      .toBeGreaterThan(stop.indexOf("if (skippedForeign.length > 0)"));
    expect(stop).not.toContain("survived SIGKILL");

    const removal = source.slice(
      source.indexOf("async function stopNativeEngineForRemoval()"),
      source.indexOf("function pidCommand("),
    );
    expect(removal).toContain("await stopNativeWorkerPid(workerPid)");
    expect(removal.indexOf("await stopNativeWorkerPid(workerPid)"))
      .toBeLessThan(removal.indexOf("Stopping iii-engine"));
    expect(removal).toContain("worker PID is missing; no engine or files were removed");
  });

  it("gates the engine stop on the owner's engine grace instead of a 3s force kill", () => {
    const source = cliSource();
    expect(source).toContain('signalAndWait(pid, "SIGTERM", SHUTDOWN_ENGINE_GRACE_MS)');
    expect(source).not.toContain('signalAndWait(pid, "SIGTERM", 3000)');
    expect(source).toContain('String(SHUTDOWN_ENGINE_GRACE_MS / 1000)');
  });

  it("starts the proof at boot and publishes failure on a failed flush or hard exit", () => {
    const source = indexSource();
    expect(source).toContain("startWorkerShutdownProof();");
    expect(source).not.toContain("clearWorkerPidfile()");
    const shutdown = shutdownHandler();
    expect(shutdown.indexOf("flushIndexOnShutdown(indexPersistence)"))
      .toBeLessThan(shutdown.indexOf("completeWorkerShutdownProof(shutdownProof"));
    expect(shutdown.indexOf("sdk.shutdown()"))
      .toBeLessThan(shutdown.indexOf("completeWorkerShutdownProof(shutdownProof"));
    expect(shutdown).toContain('completeWorkerShutdownProof(shutdownProof, exitCode === 0 ? "success" : "failure")');
    expect(shutdown).toMatch(/const hardExit = setTimeout\(\(\) => \{[\s\S]*?process\.exit\(1\);[\s\S]*?\}, SHUTDOWN_HARD_EXIT_MS\)/);
    expect(shutdown).toMatch(/catch \(err\) \{\s*exitCode = 1;\s*console\.error\("\[agentmemory\] Could not write worker shutdown proof:/);
  });
});

describe("flushIndexOnShutdown", () => {
  const cleanStatus = {
    saving: false,
    pendingChanges: 0,
    orphanDeletes: 0,
    pendingLog: 0,
    pendingLogError: null as string | null,
    firstCheckpointPending: false,
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

  it("reports a save that never settles as timed out", async () => {
    vi.useFakeTimers();
    try {
      const flush = flushIndexOnShutdown({
        save: () => new Promise<void>(() => {}),
        status: () => cleanStatus,
      });
      await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_TIMEOUT_MS);
      expect(await flush).toEqual({ status: "timed-out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ saving: true }, "pending vector writes or deletes remain"],
    [{ pendingChanges: 1 }, "pending vector writes or deletes remain"],
    [{ orphanDeletes: 1 }, "pending vector writes or deletes remain"],
    [{ pendingLog: 2 }, "2 pending vector journal entries remain"],
    [{ pendingLogError: "journal delete failed" }, "pending vector journal: journal delete failed"],
    [{ firstCheckpointPending: true }, "the first vector checkpoint was never published"],
    [{ vector: { lastError: "bucket write failed" } }, "bucket write failed"],
  ])("does not report success when persistence remains unfinished: %o", async (pending, error) => {
    expect(await flushIndexOnShutdown({
      save: async () => {},
      status: () => ({ ...cleanStatus, ...pending }),
    })).toEqual({ status: "failed", error });
  });

  it("reports a successful write error clear as saved", async () => {
    expect(await flushIndexOnShutdown({
      save: async () => {},
      status: () => ({ ...cleanStatus, vector: { lastError: null } }),
    })).toEqual({ status: "saved" });
  });
});
