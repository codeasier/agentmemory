import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureWorkerRuntime,
  planWorkerRuntime,
  type WorkerRuntime,
} from "../src/cli/worker-runtime.js";

function runtime(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  return {
    platform: "linux",
    execPath: "/opt/node/bin/node",
    execArgv: [],
    argv: ["/opt/node/bin/node", "/opt/agentmemory/dist/cli.mjs"],
    env: { PATH: "/opt/node/bin:/usr/bin", HOME: "/home/user" },
    execve: vi.fn(),
    ...overrides,
  };
}

describe("worker runtime launch plan", () => {
  it("preserves the Node executable, runtime flags, CLI arguments, and inherited environment", () => {
    const input = runtime({
      execArgv: ["--max-old-space-size=4096", "--import", "file:///opt/preload module.mjs"],
      argv: [
        "/opt/node/bin/node",
        "/opt/agent memory/dist/cli.mjs",
        "--no-engine",
        "--data-dir",
        "/data/agent memory",
        "--port=3211",
        "--verbose",
      ],
      env: { PATH: "/usr/bin", NODE_OPTIONS: "--enable-source-maps", CUSTOM: "a=b c", UNSET: undefined },
    });
    const original = {
      execArgv: [...input.execArgv],
      argv: [...input.argv],
      env: { ...input.env },
    };

    expect(planWorkerRuntime(input)).toEqual({
      action: "execve",
      file: "/opt/node/bin/node",
      args: [
        "/opt/node/bin/node",
        "--max-old-space-size=4096",
        "--import",
        "file:///opt/preload module.mjs",
        "/opt/agent memory/dist/cli.mjs",
        "--no-engine",
        "--data-dir",
        "/data/agent memory",
        "--port=3211",
        "--verbose",
      ],
      env: { PATH: "/usr/bin", NODE_OPTIONS: "--enable-source-maps", CUSTOM: "a=b c", MALLOC_ARENA_MAX: "2" },
    });
    expect(input.execArgv).toEqual(original.execArgv);
    expect(input.argv).toEqual(original.argv);
    expect(input.env).toEqual(original.env);
    expect(input.execve).not.toHaveBeenCalled();
  });

  it.each([[], ["--no-engine"], ["--instance", "1"], ["-v"], ["--reset"]])(
    "plans the existing default/flag-first daemon route for %j",
    (...args) => {
      const input = runtime();
      input.argv = [...input.argv, ...args];
      expect(planWorkerRuntime(input).action).toBe("execve");
    },
  );

  it.each([
    "init", "connect", "status", "console", "doctor", "demo", "upgrade", "stop",
    "remove", "mcp", "import-jsonl", "capture", "start", "daemon", "unknown-command",
  ])("leaves the named command %s alone", (command) => {
    const input = runtime();
    input.argv = [...input.argv, command, "--verbose"];
    expect(planWorkerRuntime(input)).toEqual({ action: "none" });
    expect(planWorkerRuntime({ ...input, execve: undefined })).toEqual({ action: "none" });
  });

  it.each(["--help", "-h", "--version", "-V"])("skips the early exit %s anywhere in the arguments", (flag) => {
    const input = runtime();
    expect(planWorkerRuntime({ ...input, argv: [...input.argv, flag] })).toEqual({ action: "none" });
    expect(planWorkerRuntime({ ...input, argv: [...input.argv, "--verbose", flag], execve: undefined }))
      .toEqual({ action: "none" });
  });

  it.each(["darwin", "win32", "freebsd"] as const)("is a no-op on %s", (platform) => {
    const input = runtime({ platform });
    expect(planWorkerRuntime(input)).toEqual({ action: "none" });
    expect(planWorkerRuntime({ ...input, execve: undefined })).toEqual({ action: "none" });
  });

  it.each(["8", "2", "0", "", "custom"])("respects an explicitly set value %j, including on Node 20", (value) => {
    const input = runtime({ env: { MALLOC_ARENA_MAX: value } });
    expect(planWorkerRuntime(input)).toEqual({ action: "none" });
    expect(planWorkerRuntime({ ...input, execve: undefined })).toEqual({ action: "none" });
    expect(input.env["MALLOC_ARENA_MAX"]).toBe(value);
  });

  it("requires launch-time configuration when execve is unavailable without mutating the environment", () => {
    const input = runtime({ execve: undefined });
    const plan = planWorkerRuntime(input);
    expect(plan.action).toBe("warn");
    if (plan.action !== "warn") throw new Error("Expected a launch-environment warning");
    expect(plan.message).toContain("process.execve is unavailable");
    expect(plan.message).toContain("MALLOC_ARENA_MAX=2 agentmemory");
    expect(plan.message).toContain("before Node starts");
    expect(input.env["MALLOC_ARENA_MAX"]).toBeUndefined();
  });
});

describe("worker runtime launcher", () => {
  it("executes the plan once and does not re-exec after the new process inherits the default", () => {
    const input = runtime();
    const warn = vi.fn();
    ensureWorkerRuntime(input, warn);
    expect(input.execve).toHaveBeenCalledExactlyOnceWith(
      input.execPath,
      [input.execPath, ...input.argv.slice(1)],
      { ...input.env, MALLOC_ARENA_MAX: "2" },
    );
    expect(warn).not.toHaveBeenCalled();

    const inheritedEnv = vi.mocked(input.execve!).mock.calls[0]![2];
    const restarted = runtime({ env: inheritedEnv });
    expect(planWorkerRuntime(restarted)).toEqual({ action: "none" });
    ensureWorkerRuntime(restarted, warn);
    expect(restarted.execve).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("forwards flags, arguments and environment to execve without shell interpretation", () => {
    const input = runtime({
      execArgv: ["--trace-warnings", "--max-old-space-size=2048"],
      argv: ["/opt/node/bin/node", "/tmp/agent memory/cli.mjs", "--data-dir=/tmp/a; b"],
      env: { CUSTOM: "$HOME; value" },
    });
    ensureWorkerRuntime(input, vi.fn());
    expect(input.execve).toHaveBeenCalledExactlyOnceWith(
      "/opt/node/bin/node",
      ["/opt/node/bin/node", "--trace-warnings", "--max-old-space-size=2048", "/tmp/agent memory/cli.mjs", "--data-dir=/tmp/a; b"],
      { CUSTOM: "$HOME; value", MALLOC_ARENA_MAX: "2" },
    );
    expect(input.env).toEqual({ CUSTOM: "$HOME; value" });
  });

  it("warns for a daemon without execve and leaves other commands quiet", () => {
    const input = runtime({ execve: undefined });
    const warn = vi.fn();
    ensureWorkerRuntime(input, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(input.env["MALLOC_ARENA_MAX"]).toBeUndefined();

    warn.mockClear();
    ensureWorkerRuntime({ ...input, argv: [...input.argv, "status"] }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not retry or claim success when execve throws", () => {
    const failure = new Error("execve failed");
    const execve = vi.fn(() => { throw failure; });
    const input = runtime({ execve });
    const warn = vi.fn();
    expect(() => ensureWorkerRuntime(input, warn)).toThrow(failure);
    expect(execve).toHaveBeenCalledOnce();
    expect(input.env["MALLOC_ARENA_MAX"]).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("runs in the CLI before environment hydration or worker startup", () => {
    const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf-8");
    const launch = cli.indexOf("ensureWorkerRuntime();");
    expect(launch).toBeGreaterThan(cli.indexOf("const args = process.argv.slice(2);"));
    expect(launch).toBeLessThan(cli.indexOf("hydrateProcessEnvFromFile();"));
    expect(launch).toBeLessThan(cli.indexOf('await import("./index.js")'));
  });
});
