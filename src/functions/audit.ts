import type { ISdk } from "iii-sdk";
import type { AuditEntry } from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { getEnvVar } from "../config.js";

// Audit coverage policy (issue #125).
//
// Every structural deletion of a memory, observation, session, or
// semantic row MUST call recordAudit. Two shapes are allowed, keyed to
// whether the caller is scoped or bulk:
//
//   Scoped deletions — a user-visible, per-call action removing a
//   bounded set of items. Emit ONE audit row per call with targetIds
//   populated. Examples: mem::governance-delete, mem::forget.
//
//   Bulk deletions — automatic sweeps (retention, TTL eviction,
//   auto-forget) that can remove hundreds of rows per invocation.
//   Emit ONE batched audit row per invocation with targetIds listing
//   every removed id and details.evicted holding the count. Per-item
//   audit rows would flood the audit log during routine sweeps.
//
//   Either shape is required; silent deletes are not acceptable.
//
// operation field:
//   - "delete"          — permanent removal (governance, retention sweep, evict).
//   - "forget"          — forget/removal flows. Scoped when emitted by
//                         mem::forget (user-initiated); bulk-batched when
//                         emitted by mem::auto-forget (automatic sweep).
//   - everything else   — see AuditEntry["operation"] union in src/types.ts.
//
// When adding a new deletion path, add an explicit recordAudit call
// BEFORE kv.delete(...) and match one of the two shapes above.
//
// mem::audit-sweep is the one exception: it trims audit rows themselves and
// reports through logger instead of writing a self-referential audit row.

const DEFAULT_AUDIT_MAX = 5000;
const DEFAULT_AUDIT_SWEEP_DELETE_BATCH = 2000;
const DEFAULT_AUDIT_SWEEP_CONCURRENCY = 16;
export const MAX_AUDIT_QUERY_LIMIT = 1000;

function envCounter(name: string, fallback: number): number {
  const raw = getEnvVar(name);
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function auditMax(): number {
  return envCounter("AGENTMEMORY_AUDIT_MAX", DEFAULT_AUDIT_MAX);
}

function auditTimestamp(entry: AuditEntry): number {
  const value = Date.parse(entry.timestamp);
  return Number.isFinite(value) ? value : 0;
}

async function deleteAuditRows(
  kv: StateKV,
  ids: string[],
  concurrency: number,
): Promise<number> {
  let failed = 0;
  for (let offset = 0; offset < ids.length; offset += concurrency) {
    const results = await Promise.allSettled(
      ids
        .slice(offset, offset + concurrency)
        .map((id) => kv.delete(KV.audit, id)),
    );
    failed += results.filter((result) => result.status === "rejected").length;
  }
  return failed;
}

export async function sweepAuditLog(
  kv: StateKV,
): Promise<{
  scanned: number;
  removed: number;
  failed: number;
  remaining: number;
  max: number;
  more: boolean;
}> {
  const max = auditMax();
  const all = await kv.list<AuditEntry>(KV.audit);
  if (max === 0 || all.length <= max) {
    return {
      scanned: all.length,
      removed: 0,
      failed: 0,
      remaining: all.length,
      max,
      more: false,
    };
  }

  const batchSize = envCounter(
    "AGENTMEMORY_AUDIT_SWEEP_DELETE_BATCH",
    DEFAULT_AUDIT_SWEEP_DELETE_BATCH,
  );
  const concurrency = Math.max(
    1,
    envCounter(
      "AGENTMEMORY_AUDIT_SWEEP_CONCURRENCY",
      DEFAULT_AUDIT_SWEEP_CONCURRENCY,
    ),
  );
  const newestFirst = [...all].sort(
    (a, b) => auditTimestamp(b) - auditTimestamp(a),
  );
  const cutoff = newestFirst[max - 1];
  const targets = cutoff
    ? newestFirst
        .filter((entry) => auditTimestamp(entry) < auditTimestamp(cutoff))
        .slice(0, batchSize)
    : [];
  const failed =
    batchSize === 0
      ? 0
      : await deleteAuditRows(
          kv,
          targets.map((entry) => entry.id),
          concurrency,
        );
  const removed = targets.length - failed;
  const remaining = all.length - removed;

  logger.info("audit log sweep complete", {
    scanned: all.length,
    removed,
    failed,
    remaining,
    max,
  });
  return {
    scanned: all.length,
    removed,
    failed,
    remaining,
    max,
    more: remaining > max || failed > 0,
  };
}

export function registerAuditSweepFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::audit-sweep", async () => sweepAuditLog(kv));
}

export async function recordAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: generateId("aud"),
    timestamp: new Date().toISOString(),
    operation,
    userId,
    functionId,
    targetIds,
    details,
    qualityScore,
  };
  await kv.set(KV.audit, entry.id, entry);
  return entry;
}

export async function safeAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<void> {
  try {
    await recordAudit(kv, operation, functionId, targetIds, details, qualityScore, userId);
  } catch (err) {
    try {
      logger.warn("audit write failed", {
        functionId,
        operation,
        targetIds,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

export async function queryAudit(
  kv: StateKV,
  filter?: {
    operation?: AuditEntry["operation"];
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<AuditEntry[]> {
  const all = await kv.list<AuditEntry>(KV.audit);
  let entries = [...all].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  if (filter?.operation) {
    entries = entries.filter((e) => e.operation === filter.operation);
  }
  if (filter?.dateFrom) {
    const from = new Date(filter.dateFrom).getTime();
    if (Number.isNaN(from)) {
      throw new Error(`Invalid dateFrom: ${filter.dateFrom}`);
    }
    entries = entries.filter((e) => new Date(e.timestamp).getTime() >= from);
  }
  if (filter?.dateTo) {
    const to = new Date(filter.dateTo).getTime();
    if (Number.isNaN(to)) {
      throw new Error(`Invalid dateTo: ${filter.dateTo}`);
    }
    entries = entries.filter((e) => new Date(e.timestamp).getTime() <= to);
  }

  const limit = Math.min(
    Math.max(1, Math.floor(filter?.limit ?? 100)),
    MAX_AUDIT_QUERY_LIMIT,
  );
  return entries.slice(0, limit);
}
