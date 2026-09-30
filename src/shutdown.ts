export const SHUTDOWN_VIEWER_TIMEOUT_MS = 5000;
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 80000;
export const SHUTDOWN_SDK_TIMEOUT_MS = 10000;
// Reserve time to reap the engine before systemd's 120s stop deadline.
export const SHUTDOWN_HARD_EXIT_MS = 100000;
export const SHUTDOWN_WORKER_GRACE_MS = SHUTDOWN_HARD_EXIT_MS + 1000;
export const SHUTDOWN_ENGINE_GRACE_MS = 15000;

interface ShutdownIndexPersistence {
  save(): Promise<void>;
  status(): {
    saving: boolean;
    pendingChanges: number;
    orphanDeletes: number;
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
