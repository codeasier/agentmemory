export const SHUTDOWN_VIEWER_TIMEOUT_MS = 5000;
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 80000;
export const SHUTDOWN_SDK_TIMEOUT_MS = 10000;
// Bounds the whole worker teardown, leaving the CLI time to reap the engine
// inside the service's stop deadline.
export const SHUTDOWN_HARD_EXIT_MS = 100000;
export const SHUTDOWN_WORKER_GRACE_MS = SHUTDOWN_HARD_EXIT_MS + 1000;
export const SHUTDOWN_ENGINE_GRACE_MS = 15000;

interface ShutdownIndexPersistence {
  save(): Promise<void>;
  status(): {
    saving: boolean;
    pendingChanges: number;
    orphanDeletes: number;
    pendingLog?: number;
    pendingLogError?: string | null;
    firstCheckpointPending?: boolean;
    vector: { lastError: string | null } | null;
  };
}

export type ShutdownFlushResult =
  | { status: "saved" }
  | { status: "timed-out" }
  | { status: "failed"; error: string };

export async function flushIndexOnShutdown(
  persistence: ShutdownIndexPersistence,
): Promise<ShutdownFlushResult> {
  try {
    if (!(await settleWithin(persistence.save(), SHUTDOWN_FLUSH_TIMEOUT_MS))) {
      return { status: "timed-out" };
    }
    const status = persistence.status();
    // IndexPersistence.save records write errors in status instead of rejecting.
    if (status.vector && status.vector.lastError !== null) {
      return { status: "failed", error: status.vector.lastError };
    }
    if (status.saving || status.pendingChanges > 0 || status.orphanDeletes > 0) {
      return { status: "failed", error: "pending vector writes or deletes remain" };
    }
    if (status.pendingLogError) {
      return { status: "failed", error: `pending vector journal: ${status.pendingLogError}` };
    }
    if ((status.pendingLog ?? 0) > 0) {
      return {
        status: "failed",
        error: `${status.pendingLog} pending vector journal entries remain`,
      };
    }
    if (status.firstCheckpointPending) {
      return { status: "failed", error: "the first vector checkpoint was never published" };
    }
    return { status: "saved" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function settleWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), expiry]);
  } finally {
    clearTimeout(timer);
  }
}
