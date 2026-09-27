import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

type Options = {
  url: string;
  label: string;
  sessions: number;
  perSession: number;
  payloadChars: number;
  settleMs: number;
  pids: number[];
  dataDir?: string;
};

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${name}`);
  }
  const value = process.argv[index + 1];
  if (!value) throw new Error(`missing ${name} value`);
  return value;
}

function options(name: string): string[] {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1]
      ? [process.argv[index + 1]]
      : [],
  );
}

const pids = options("--pid").map(Number);
const dataDir = option("--data-dir", "");
const parsed: Options = {
  url: option("--url", "http://127.0.0.1:3111").replace(/\/+$/, ""),
  label: option("--label", "local"),
  sessions: Number(option("--sessions", "8")),
  perSession: Number(option("--per-session", "250")),
  payloadChars: Number(option("--payload-chars", "12000")),
  settleMs: Number(option("--settle-ms", "15000")),
  pids,
  dataDir: dataDir || undefined,
};

if (!Number.isInteger(parsed.sessions) || parsed.sessions < 1) {
  throw new Error("--sessions must be a positive integer");
}
if (!Number.isInteger(parsed.perSession) || parsed.perSession < 1) {
  throw new Error("--per-session must be a positive integer");
}
if (!Number.isInteger(parsed.payloadChars) || parsed.payloadChars < 1) {
  throw new Error("--payload-chars must be a positive integer");
}
if (!Number.isInteger(parsed.settleMs) || parsed.settleMs < 0) {
  throw new Error("--settle-ms must be a non-negative integer");
}
if (pids.some((pid) => !Number.isInteger(pid) || pid < 1)) {
  throw new Error("--pid must be a positive integer");
}

const secret = process.env.BENCH_SECRET || "";
const headers: Record<string, string> = { "content-type": "application/json" };
if (secret) headers.authorization = `Bearer ${secret}`;
const blob = "x".repeat(parsed.payloadChars);
const outcomes = { stored: 0, deduplicated: 0, rejected: 0 };

function rssKiB(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

function dataBytes(path: string): number {
  return Number(execFileSync("du", ["-sb", path], { encoding: "utf8" }).split(/\s+/)[0]);
}

function combinedRssKiB(): number {
  return pids.reduce((total, pid) => total + rssKiB(pid), 0);
}

const dataBytesBefore = parsed.dataDir ? dataBytes(parsed.dataDir) : undefined;
let maxRssKiB = combinedRssKiB();
const sampler = setInterval(() => {
  maxRssKiB = Math.max(maxRssKiB, combinedRssKiB());
}, 200);

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${parsed.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function runSession(index: number): Promise<void> {
  const sessionId = `bench_${parsed.label}_${index}_${Date.now()}`;
  const project = `/tmp/bench-${parsed.label}`;
  await post("/agentmemory/session/start", { sessionId, project, cwd: project });

  for (let i = 0; i < parsed.perSession; i++) {
    const hookTypes = [
      "post_tool_use",
      "session_diff",
      "llm_params",
      "session_status",
      "prompt_submit",
    ];
    const observed = await post("/agentmemory/observe", {
      hookType: hookTypes[i % hookTypes.length],
      sessionId,
      project,
      cwd: project,
      timestamp: new Date(Date.now() + i).toISOString(),
      data: {
        nonce: `${sessionId}-${i}`,
        tool_name: "Edit",
        tool_input: {
          nonce: `${sessionId}-${i}`,
          path: `src/file-${i}.ts`,
          detail: "d".repeat(64),
        },
        tool_output: {
          blob,
          diffs: Array.from({ length: 20 }, () => ({ blob })),
        },
        prompt: `benchmark prompt ${i} ${"p".repeat(parsed.payloadChars)}`,
      },
    });
    if (observed.observationId) outcomes.stored++;
    else if (observed.deduplicated) outcomes.deduplicated++;
    else if (observed.success === false) outcomes.rejected++;
    if ((i + 1) % 25 === 0) {
      await post("/agentmemory/session/end", { sessionId });
    }
  }

  await post("/agentmemory/session/end", { sessionId });
}

const startedAt = Date.now();
await Promise.all(
  Array.from({ length: parsed.sessions }, (_, index) => runSession(index)),
);
if (parsed.settleMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, parsed.settleMs));
}
clearInterval(sampler);
maxRssKiB = Math.max(maxRssKiB, combinedRssKiB());
const settledRssKiB = combinedRssKiB();
const dataBytesAfter = parsed.dataDir ? dataBytes(parsed.dataDir) : undefined;

console.log(
  JSON.stringify({
    schemaVersion: 2,
    url: parsed.url,
    label: parsed.label,
    sessions: parsed.sessions,
    perSession: parsed.perSession,
    observations: parsed.sessions * parsed.perSession,
    payloadChars: parsed.payloadChars,
    pids: parsed.pids,
    outcomes,
    maxRssKiB: pids.length > 0 ? maxRssKiB : undefined,
    settledRssKiB: pids.length > 0 ? settledRssKiB : undefined,
    dataBytesBefore,
    dataBytesAfter,
    dataGrowthBytes:
      dataBytesBefore !== undefined && dataBytesAfter !== undefined
        ? dataBytesAfter - dataBytesBefore
        : undefined,
    elapsedMs: Date.now() - startedAt,
  }),
);
