import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Duplicate vector rows are queued for deletion while the buckets load, but
// the deletes are deferred until after the worker reports ready: running
// them inline pushed boot past the CLI ready watchdog. The wiring lives in
// src/index.ts, so it is asserted against the source the way the other
// startup-wiring tests in this directory do.
describe("deferred orphan vector flush", () => {
  const source = readFileSync("src/index.ts", "utf8");

  it("schedules the flush after the ready lines, not during the load", () => {
    const loadAt = source.indexOf("await indexPersistence.load()");
    const readyAt = source.indexOf("`Ready. ${embeddingProvider");
    const scheduleAt = source.indexOf("orphanFlushTimer = setTimeout(");

    expect(loadAt).toBeGreaterThan(0);
    expect(readyAt).toBeGreaterThan(loadAt);
    expect(scheduleAt).toBeGreaterThan(readyAt);
    expect(source).toContain("const ORPHAN_VECTOR_FLUSH_DELAY_MS = 60_000;");
    expect(source).toContain("if (indexPersistence.status().orphanDeletes > 0) {");
  });

  it("does not keep the process alive for the flush", () => {
    const scheduleAt = source.indexOf("orphanFlushTimer = setTimeout(");
    const endAt = source.indexOf("}, ORPHAN_VECTOR_FLUSH_DELAY_MS);", scheduleAt);
    expect(endAt).toBeGreaterThan(scheduleAt);
    expect(source.slice(endAt, endAt + 120)).toContain("orphanFlushTimer.unref();");
  });

  it("cancels and guards the flush once shutdown starts", () => {
    const shutdownAt = source.indexOf("const shutdown = async () => {");
    const shutdownEnd = source.indexOf('process.on("SIGINT", shutdown)', shutdownAt);
    expect(shutdownAt).toBeGreaterThan(0);
    const shutdownBody = source.slice(shutdownAt, shutdownEnd);
    expect(shutdownBody).toContain("shuttingDown = true;");
    expect(shutdownBody).toContain("clearTimeout(orphanFlushTimer);");
    expect(shutdownBody).toContain("orphanFlushTimer = null;");
    expect(shutdownBody.indexOf("clearTimeout(orphanFlushTimer);")).toBeLessThan(
      shutdownBody.indexOf("indexPersistence.stop();"),
    );

    const scheduleAt = source.indexOf("orphanFlushTimer = setTimeout(");
    const callback = source.slice(scheduleAt, source.indexOf("}, ORPHAN_VECTOR_FLUSH_DELAY_MS);", scheduleAt));
    expect(callback).toContain("if (shuttingDown) return;");
    expect(callback).toContain("indexPersistence.save()");
  });
});
