import { describe, it, expect, vi, beforeEach } from "vitest";

// Daemon starts do not enable verbose boot logs, so the armed-sweep
// confirmation must also reach the regular logger.
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
}));

import { logger, bootLog } from "../src/logger.js";
import { reportEvictionScheduled } from "../src/functions/evict.js";

describe("reportEvictionScheduled (the eviction-armed confirmation from src/index.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs the schedule via logger.info with the interval in minutes", () => {
    reportEvictionScheduled(86400000);

    expect(logger.info).toHaveBeenCalledWith("Eviction sweep scheduled", {
      intervalMinutes: 1440,
    });
    expect(bootLog).toHaveBeenCalledWith("Eviction: enabled (every 1440m)");
  });
});
