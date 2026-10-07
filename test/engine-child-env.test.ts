import { describe, expect, it } from "vitest";
import { ENGINE_MALLOC_ARENA_MAX, engineChildEnv } from "../src/cli/engine-launch.js";

describe("engineChildEnv", () => {
  it("turns the engine's anonymous usage telemetry off when the user has not chosen", () => {
    const env = engineChildEnv({ PATH: "/usr/bin" });

    expect(env["III_TELEMETRY_ENABLED"]).toBe("false");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("keeps an explicit opt-in or opt-out", () => {
    expect(engineChildEnv({ III_TELEMETRY_ENABLED: "true" })["III_TELEMETRY_ENABLED"]).toBe("true");
    expect(engineChildEnv({ III_TELEMETRY_ENABLED: "false" })["III_TELEMETRY_ENABLED"]).toBe("false");
  });

  // Ported from upstream b3d6cf5 (rohitg00/agentmemory#1457).
  it("bounds the engine's glibc arenas on Linux", () => {
    const env = engineChildEnv({ PATH: "/usr/bin" }, "linux");

    expect(env["MALLOC_ARENA_MAX"]).toBe(ENGINE_MALLOC_ARENA_MAX);
    expect(ENGINE_MALLOC_ARENA_MAX).toBe("2");
  });

  it("keeps a user-chosen arena cap", () => {
    expect(engineChildEnv({ MALLOC_ARENA_MAX: "8" }, "linux")["MALLOC_ARENA_MAX"]).toBe("8");
    expect(engineChildEnv({ MALLOC_ARENA_MAX: "1" }, "linux")["MALLOC_ARENA_MAX"]).toBe("1");
  });

  it("does not touch arenas off Linux, where the variable is meaningless", () => {
    expect(engineChildEnv({ PATH: "/usr/bin" }, "darwin")["MALLOC_ARENA_MAX"]).toBeUndefined();
    expect(engineChildEnv({ PATH: "/usr/bin" }, "win32")["MALLOC_ARENA_MAX"]).toBeUndefined();
  });
});
