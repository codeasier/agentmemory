import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname } from "node:path";
import { runtimeMetadataPath } from "./runtime-paths.js";

type WorkerShutdownStatus = "running" | "success" | "failure";

export interface WorkerShutdownProof {
  pid: number;
  runId: string;
  processStart: string;
}

interface WorkerShutdownRecord extends WorkerShutdownProof {
  status: WorkerShutdownStatus;
}

export function workerShutdownProofPath(): string {
  return runtimeMetadataPath("worker-shutdown.json");
}

export function processStartToken(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform() === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return startTicks && /^\d+$/.test(startTicks) && bootId
        ? `linux:${bootId}:${startTicks}` : null;
    }
    if (platform() === "win32") {
      const ticks = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().Ticks`,
      ], { encoding: "utf8", timeout: 3000 }).trim();
      return /^\d+$/.test(ticks) ? `win:${ticks}` : null;
    }
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 3000,
    }).trim();
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

function atomicWrite(record: WorkerShutdownRecord, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (err) {
    try { unlinkSync(temporary); } catch {}
    throw err;
  }
}

function readRecord(path: string): WorkerShutdownRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkerShutdownRecord>;
    if (
      !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0 ||
      typeof record.runId !== "string" ||
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(record.runId) ||
      typeof record.processStart !== "string" || !record.processStart ||
      (record.status !== "running" && record.status !== "success" && record.status !== "failure")
    ) return null;
    return record as WorkerShutdownRecord;
  } catch {
    return null;
  }
}

export function startWorkerShutdownProof(
  path = workerShutdownProofPath(),
  pid = process.pid,
  start = processStartToken(pid),
): WorkerShutdownProof {
  if (!start || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Cannot identify worker process ${pid} for shutdown proof`);
  }
  const proof = { pid, runId: randomUUID(), processStart: start };
  atomicWrite({ ...proof, status: "running" }, path);
  return proof;
}

export function completeWorkerShutdownProof(
  proof: WorkerShutdownProof,
  status: "success" | "failure",
  path = workerShutdownProofPath(),
): void {
  atomicWrite({ ...proof, status }, path);
}

export function captureRunningWorkerProof(
  pid: number,
  path = workerShutdownProofPath(),
  start = processStartToken(pid),
): WorkerShutdownProof | null {
  if (!start) return null;
  const record = readRecord(path);
  if (record?.pid !== pid || record.processStart !== start || record.status !== "running") {
    return null;
  }
  return { pid: record.pid, runId: record.runId, processStart: record.processStart };
}

export function workerShutdownSucceeded(
  proof: WorkerShutdownProof,
  path = workerShutdownProofPath(),
): boolean {
  const record = readRecord(path);
  return record?.pid === proof.pid && record.runId === proof.runId &&
    record.processStart === proof.processStart && record.status === "success";
}
