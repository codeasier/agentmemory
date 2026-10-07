import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SEEDED_BUILTIN_WORKERS = [
  "http",
  "iii-http",
  "state",
  "iii-state",
  "queue",
  "iii-queue",
  "pubsub",
  "iii-pubsub",
  "cron",
  "iii-cron",
  "iii-stream",
  "iii-observability",
  "iii-worker-manager",
];

export function configuredPersistDir(renderedConfig: string): string | null {
  const lines = renderedConfig.split("\n");
  const block = workerBlock(lines, "configuration");
  if (!block) return null;
  for (let i = block.start + 1; i < block.end; i++) {
    const match = lines[i]!.trim().match(/^directory:\s*(.+?)\s*$/);
    if (match) return match[1]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return null;
}

export function persistedBuiltinConfigDirs(
  engineCwd: string,
  configPath: string,
  renderedConfig?: string,
): string[] {
  const dirs = [
    join(engineCwd, "config"),
    join(dirname(configPath), "config"),
    join(engineCwd, "data", "configuration"),
  ];
  const custom = renderedConfig ? configuredPersistDir(renderedConfig) : null;
  if (custom) dirs.unshift(resolve(engineCwd, custom));
  return [...new Set(dirs)];
}

export function persistedBuiltinConfigPaths(
  engineCwd: string,
  configPath: string,
  renderedConfig?: string,
): string[] {
  return persistedBuiltinConfigDirs(engineCwd, configPath, renderedConfig).flatMap((dir) =>
    SEEDED_BUILTIN_WORKERS.map((id) => join(dir, `${id}.yaml`)),
  );
}

export function isPersistedBuiltinEntry(content: string, id: string): boolean {
  const firstLine = content.split("\n").find((line) => line.trim() !== "");
  return firstLine?.trim() === `id: ${id}`;
}

export function clearPersistedBuiltinConfig(
  engineCwd: string,
  configPath: string,
  renderedConfig?: string,
): string[] {
  const cleared: string[] = [];
  for (const path of persistedBuiltinConfigPaths(engineCwd, configPath, renderedConfig)) {
    try {
      const content = readFileSync(path, "utf8");
      if (!isPersistedBuiltinEntry(content, basename(path, ".yaml"))) continue;
      rmSync(path);
      cleared.push(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        `could not remove persisted engine config ${path}: ${String(err)}`,
      );
    }
  }
  return cleared;
}

export interface EngineConfigOptions {
  dataDir: string;
  ports?: EngineRuntimePorts;
  // Ported from upstream b3d6cf5 (rohitg00/agentmemory#1457). The engine's own
  // default for a file_based kv save cadence is 5000 ms; 2000 ms bounds the
  // window between accepted writes and their on-disk flush. AGENTMEMORY_STATE_
  // SAVE_INTERVAL_MS overrides it. The engine strips the runtime config block
  // into its configuration worker, so this must be present at render time.
  saveIntervalMs?: number;
}

export const AGENTMEMORY_STATE_SAVE_INTERVAL_MS = 2000;

export interface EngineRuntimePorts {
  restPort: number;
  streamPort: number;
  viewerPort: number;
  enginePort: number;
}

function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function workerBlock(
  lines: string[],
  name: string,
): { start: number; end: number; indent: string } | null {
  const marker = `- name: ${name}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start === -1) return null;
  const indent = lines[start]!.match(/^\s*/)?.[0] ?? "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(indent) && line.trim().startsWith("- name: ")) {
      end = i;
      break;
    }
  }
  return { start, end, indent };
}

function setWorkerPort(lines: string[], name: string, port: number): void {
  let block = workerBlock(lines, name);
  if (!block && name === "iii-worker-manager") {
    const workersIndex = lines.findIndex((line) => line.trim() === "workers:");
    if (workersIndex === -1) return;
    lines.splice(
      workersIndex + 1,
      0,
      "  - name: iii-worker-manager",
      "    config:",
      `      port: ${port}`,
      "      host: 127.0.0.1",
    );
    return;
  }
  if (!block) return;

  const portIndex = lines.findIndex(
    (line, index) =>
      index > block!.start &&
      index < block!.end &&
      line.trim().startsWith("port:"),
  );
  if (portIndex !== -1) {
    const indent = lines[portIndex]!.match(/^\s*/)?.[0] ?? `${block.indent}    `;
    lines[portIndex] = `${indent}port: ${port}`;
    return;
  }

  const configIndex = lines.findIndex(
    (line, index) =>
      index > block!.start && index < block!.end && line.trim() === "config:",
  );
  if (configIndex !== -1) {
    const configIndent = lines[configIndex]!.match(/^\s*/)?.[0] ?? `${block.indent}  `;
    lines.splice(configIndex + 1, 0, `${configIndent}  port: ${port}`);
  }
}

function setManagedCorsOrigins(
  lines: string[],
  restPort: number,
  viewerPort: number,
): void {
  const block = workerBlock(lines, "iii-http");
  if (!block) return;
  const originsIndex = lines.findIndex(
    (line, index) =>
      index > block.start &&
      index < block.end &&
      line.trim().startsWith("allowed_origins:"),
  );
  if (originsIndex === -1) return;
  const indent = lines[originsIndex]!.match(/^\s*/)?.[0] ?? "        ";
  lines[originsIndex] =
    `${indent}allowed_origins: [` +
    `"http://localhost:${restPort}", ` +
    `"http://localhost:${viewerPort}", ` +
    `"http://127.0.0.1:${restPort}", ` +
    `"http://127.0.0.1:${viewerPort}"]`;
}

// Insert (or override) save_interval_ms directly after the worker's
// `store_method: file_based` line, so the key always sits next to the adapter
// config it belongs to and keeps that block's indentation.
function setFileStoreSaveInterval(
  lines: string[],
  workerName: string,
  override: number | undefined,
): void {
  const block = workerBlock(lines, workerName);
  if (!block) return;
  const methodIndex = lines.findIndex(
    (line, index) =>
      index > block.start &&
      index < block.end &&
      line.trim() === "store_method: file_based",
  );
  if (methodIndex === -1) return;
  const indent = lines[methodIndex]!.match(/^\s*/)?.[0] ?? "";
  const intervalIndex = lines.findIndex(
    (line, index) =>
      index > block.start &&
      index < block.end &&
      line.trim().startsWith("save_interval_ms:"),
  );
  if (intervalIndex !== -1) {
    if (override === undefined) return;
    const existingIndent = lines[intervalIndex]!.match(/^\s*/)?.[0] ?? indent;
    lines[intervalIndex] = `${existingIndent}save_interval_ms: ${override}`;
    return;
  }
  lines.splice(
    methodIndex + 1,
    0,
    `${indent}save_interval_ms: ${override ?? AGENTMEMORY_STATE_SAVE_INTERVAL_MS}`,
  );
}

export function renderEngineConfig(
  template: string,
  options: EngineConfigOptions,
): string {
  const rendered = template
    .replace(
      "file_path: ./data/state_store.db",
      `file_path: ${yamlSingleQuote(join(options.dataDir, "state_store.db"))}`,
    )
    .replace(
      "file_path: ./data/stream_store",
      `file_path: ${yamlSingleQuote(join(options.dataDir, "stream_store"))}`,
    );

  const lines = rendered.split("\n");
  setFileStoreSaveInterval(lines, "iii-state", options.saveIntervalMs);
  setFileStoreSaveInterval(lines, "iii-stream", options.saveIntervalMs);
  if (!options.ports) return lines.join("\n");

  setWorkerPort(lines, "iii-http", options.ports.restPort);
  setWorkerPort(lines, "iii-stream", options.ports.streamPort);
  setWorkerPort(lines, "iii-worker-manager", options.ports.enginePort);
  setManagedCorsOrigins(lines, options.ports.restPort, options.ports.viewerPort);
  return lines.join("\n");
}
