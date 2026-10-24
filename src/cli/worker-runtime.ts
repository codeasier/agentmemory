export interface WorkerRuntime {
  platform: NodeJS.Platform;
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  execve?: (file: string, args: string[], env: Record<string, string>) => void;
}

export type WorkerRuntimePlan =
  | { action: "none" }
  | { action: "warn"; message: string }
  | { action: "execve"; file: string; args: string[]; env: Record<string, string> };

export function planWorkerRuntime(runtime: WorkerRuntime): WorkerRuntimePlan {
  const args = runtime.argv.slice(2);
  const first = args[0] ?? "";
  if (
    runtime.platform !== "linux" ||
    (first !== "" && !first.startsWith("-")) ||
    args.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg)) ||
    runtime.env["MALLOC_ARENA_MAX"] !== undefined
  ) {
    return { action: "none" };
  }

  if (typeof runtime.execve !== "function") {
    return {
      action: "warn",
      message:
        "[agentmemory] Cannot apply the worker's MALLOC_ARENA_MAX=2 default: process.execve is unavailable. " +
        "Set MALLOC_ARENA_MAX=2 in the launch environment before Node starts (e.g. MALLOC_ARENA_MAX=2 agentmemory). " +
        "Changing process.env or loading .env after startup is too late for glibc allocator initialization.",
    };
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtime.env)) {
    if (value !== undefined) env[key] = value;
  }
  env["MALLOC_ARENA_MAX"] = "2";

  return {
    action: "execve",
    file: runtime.execPath,
    args: [runtime.execPath, ...runtime.execArgv, ...runtime.argv.slice(1)],
    env,
  };
}

export function ensureWorkerRuntime(
  runtime: WorkerRuntime = process,
  warn: (message: string) => void = console.warn,
): void {
  const plan = planWorkerRuntime(runtime);
  if (plan.action === "warn") {
    warn(plan.message);
  } else if (plan.action === "execve") {
    runtime.execve!(plan.file, plan.args, plan.env);
  }
}
