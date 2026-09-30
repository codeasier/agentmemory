import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureRunningWorkerProof,
  completeWorkerShutdownProof,
  processStartToken,
  startWorkerShutdownProof,
  workerShutdownProofPath,
  workerShutdownSucceeded,
} from "../src/worker-shutdown-proof.js";
import { flushIndexOnShutdown } from "../src/shutdown.js";

describe("native worker shutdown completion proof", () => {
  let dir: string;
  let path: string;
  const pid = 12345;
  const start = "test-process-start";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentmemory-worker-proof-"));
    path = join(dir, "worker-shutdown.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes running at startup and accepts only the matching successful completion", () => {
    const proof = startWorkerShutdownProof(path, pid, start);
    expect(proof.runId).toMatch(/^[\da-f-]{36}$/);
    expect(captureRunningWorkerProof(pid, path, start)).toEqual(proof);
    expect(workerShutdownSucceeded(proof, path)).toBe(false);
    completeWorkerShutdownProof(proof, "success", path);
    expect(workerShutdownSucceeded(proof, path)).toBe(true);
    expect(captureRunningWorkerProof(pid, path, start)).toBeNull();
    expect(readdirSync(dir)).toEqual(["worker-shutdown.json"]);
  });

  it("rejects a failed final flush rather than accepting the process exit", async () => {
    const proof = startWorkerShutdownProof(path, pid, start);
    const flush = await flushIndexOnShutdown({
      save: async () => { throw new Error("disk unavailable"); },
      status: () => ({ saving: false, pendingChanges: 0, orphanDeletes: 0, vector: null }),
    });
    expect(flush.status).toBe("failed");
    completeWorkerShutdownProof(proof, flush.status === "saved" ? "success" : "failure", path);
    expect(workerShutdownSucceeded(proof, path)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("failure");
  });

  it("rejects missing, malformed, and stale success markers", () => {
    const stale = startWorkerShutdownProof(path, pid, start);
    completeWorkerShutdownProof(stale, "success", path);
    expect(captureRunningWorkerProof(pid, path, start)).toBeNull();
    const current = startWorkerShutdownProof(path, pid, start);
    expect(current.runId).not.toBe(stale.runId);
    expect(workerShutdownSucceeded(stale, path)).toBe(false);
    expect(captureRunningWorkerProof(pid + 1, path, start)).toBeNull();
    expect(captureRunningWorkerProof(pid, path, "reused-pid")).toBeNull();
    expect(workerShutdownSucceeded({ ...current, runId: stale.runId }, path)).toBe(false);
    writeFileSync(path, "{not-json", "utf8");
    expect(captureRunningWorkerProof(pid, path, start)).toBeNull();
    expect(workerShutdownSucceeded(current, path)).toBe(false);
    rmSync(path);
    expect(captureRunningWorkerProof(pid, path, start)).toBeNull();
    expect(workerShutdownSucceeded(current, path)).toBe(false);
  });

  it("leaves no completion evidence if a hard exit interrupts the running worker", () => {
    const proof = startWorkerShutdownProof(path, pid, start);
    expect(workerShutdownSucceeded(proof, path)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("running");
  });

  it("throws when the final proof cannot be replaced atomically", () => {
    const proof = startWorkerShutdownProof(path, pid, start);
    const occupiedPath = join(dir, "occupied");
    mkdirSync(occupiedPath);
    expect(() => completeWorkerShutdownProof(proof, "success", occupiedPath)).toThrow();
    expect(workerShutdownSucceeded(proof, path)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["occupied", "worker-shutdown.json"]);
  });

  it("separates runtime instances and validates the current OS process identity", () => {
    const first = join(dir, "instance-1", "worker-shutdown.json");
    const second = join(dir, "instance-2", "worker-shutdown.json");
    const proof = startWorkerShutdownProof(first, pid, start);
    completeWorkerShutdownProof(proof, "success", first);
    expect(workerShutdownSucceeded(proof, first)).toBe(true);
    expect(workerShutdownSucceeded(proof, second)).toBe(false);
    expect(workerShutdownProofPath()).toContain("worker-shutdown.json");
    expect(processStartToken(process.pid)).toBeTruthy();
    expect(processStartToken(0)).toBeNull();
  });
});
