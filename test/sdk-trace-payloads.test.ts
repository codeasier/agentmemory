import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  afterEach, beforeEach, describe, expect, it, vi, type MockInstance,
} from "vitest";

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("iii-sdk");
const sdkRequire = createRequire(sdkEntry);
const sdkPackage = sdkRequire(join(dirname(sdkEntry), "..", "package.json")) as {
  version: string;
};

// CJS exposes live dependency properties, so only the transport is replaced;
// the installed SDK constructor, wrapper, and payload serializer still run.
const { registerWorker } = sdkRequire("iii-sdk") as typeof import("iii-sdk");
const observability = sdkRequire("@iii-dev/helpers/observability") as typeof import("@iii-dev/helpers/observability");
const { getTracer } = sdkRequire("@iii-dev/helpers/observability/internal") as {
  getTracer: () => unknown;
};

class InertWebSocket {
  static OPEN = 1;
  readyState = 0;
  on = () => this;
  removeAllListeners = () => this;
  close = () => { this.readyState = 3; };
}

const transport = sdkRequire("ws") as { WebSocket: typeof InertWebSocket };

type Handler = (input: unknown, metadata?: unknown) => unknown;
type WrappedHandler = (input: unknown, metadata?: unknown) => Promise<unknown>;
type RuntimeClient = {
  registerFunction: (id: string, handler: Handler) => unknown;
  functions: Map<string, { handler?: WrappedHandler }>;
  shutdown: () => Promise<void>;
};

function watchedPayload(value: string) {
  const getter = vi.fn(() => value);
  const ownKeys = vi.fn((target: object) => Reflect.ownKeys(target));
  const target = Object.defineProperty({}, "value", {
    enumerable: true,
    get: getter,
  });
  return { payload: new Proxy(target, { ownKeys }), getter, ownKeys };
}

describe("installed iii-sdk 0.22.1 trace payload switch", () => {
  let client: RuntimeClient | undefined;
  let serialize: MockInstance<typeof observability.redactAndTruncate>;
  let recordEvent: MockInstance<typeof observability.recordSpanEvent>;

  beforeEach(() => {
    vi.stubEnv("OTEL_ENABLED", "false");
    vi.stubEnv("III_DISABLE_TRACE_PAYLOADS", undefined);
    vi.stubEnv("III_TRACE_PAYLOAD_MAX_BYTES", undefined);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const socketConstructor = vi.spyOn(transport, "WebSocket")
      .mockImplementation(InertWebSocket);
    serialize = vi.spyOn(observability, "redactAndTruncate");
    recordEvent = vi.spyOn(observability, "recordSpanEvent");

    // A missed mock fails protocol validation rather than opening a socket.
    client = registerWorker("mock://sdk-trace-payloads", {
      workerName: "sdk-trace-payloads-test",
      enableMetricsReporting: false,
    }) as unknown as RuntimeClient;

    expect(socketConstructor).toHaveBeenCalledTimes(1);
    expect(getTracer()).toBeNull();
  });

  afterEach(async () => {
    try {
      await client?.shutdown();
    } finally {
      client = undefined;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  function register(handler: Handler): WrappedHandler {
    client!.registerFunction("test::trace-payloads", handler);
    const wrapper = client!.functions.get("test::trace-payloads")?.handler;
    expect(wrapper).toBeTypeOf("function");
    expect(wrapper).not.toBe(handler);
    return wrapper!;
  }

  it("loads the installed 0.22.1 SDK artifact rather than an SDK mock", () => {
    expect(sdkPackage.version).toBe("0.22.1");
    expect(sdkEntry).toMatch(/[/\\]iii-sdk[/\\]dist[/\\]index\.cjs$/);
  });

  const disabledValues = ["1", "true", "TRUE", "TrUe"];

  it.each(disabledValues)("%s skips input/output copying and serialization without changing the result", async (value) => {
    vi.stubEnv("III_DISABLE_TRACE_PAYLOADS", value);
    const input = watchedPayload("input");
    const output = watchedPayload("output");
    const metadata = { requestId: "request-1" };
    const handler = vi.fn((_input: unknown, _metadata?: unknown) => output.payload);

    const result = await register(handler)(input.payload, metadata);

    expect(result).toBe(output.payload);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(input.payload);
    expect(handler.mock.calls[0][1]).toBe(metadata);
    expect(serialize).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(input.ownKeys).not.toHaveBeenCalled();
    expect(input.getter).not.toHaveBeenCalled();
    expect(output.ownKeys).not.toHaveBeenCalled();
    expect(output.getter).not.toHaveBeenCalled();
  });

  it.each(disabledValues)("%s skips input/error serialization and preserves the thrown error", async (value) => {
    vi.stubEnv("III_DISABLE_TRACE_PAYLOADS", value);
    const input = watchedPayload("input");
    const error = new Error("original handler error");
    const handler = vi.fn((_input: unknown) => { throw error; });

    await expect(register(handler)(input.payload)).rejects.toBe(error);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(input.payload);
    expect(serialize).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(input.ownKeys).not.toHaveBeenCalled();
    expect(input.getter).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "false", "FALSE"])("OTEL_ENABLED=false still traverses and serializes payloads with switch %s", async (value) => {
    vi.stubEnv("III_DISABLE_TRACE_PAYLOADS", value);
    const input = watchedPayload("input");
    const output = watchedPayload("output");
    const handler = vi.fn(() => output.payload);

    expect(await register(handler)(input.payload)).toBe(output.payload);

    expect(serialize).toHaveBeenCalledTimes(2);
    expect(serialize.mock.calls[0][0]).toBe(input.payload);
    expect(serialize.mock.calls[1][0]).toBe(output.payload);
    expect(serialize.mock.results.map((result) => result.value)).toEqual([
      { json: '{"value":"input"}', truncated: false },
      { json: '{"value":"output"}', truncated: false },
    ]);
    expect(recordEvent.mock.calls.map(([name]) => name)).toEqual([
      "iii.invocation.input", "iii.invocation.output",
    ]);
    expect(input.ownKeys).toHaveBeenCalledTimes(1);
    expect(input.getter).toHaveBeenCalledTimes(1);
    expect(output.ownKeys).toHaveBeenCalledTimes(1);
    expect(output.getter).toHaveBeenCalledTimes(1);
  });

  it("OTEL_ENABLED=false alone still serializes errors without replacing the thrown error", async () => {
    const input = watchedPayload("input");
    const error = new Error("original handler error");
    const handler = vi.fn(() => { throw error; });

    await expect(register(handler)(input.payload)).rejects.toBe(error);

    expect(serialize).toHaveBeenCalledTimes(2);
    expect(serialize.mock.calls[1][0]).toEqual({ error: error.message });
    expect(recordEvent.mock.calls[1]).toEqual([
      "iii.invocation.output",
      {
        "iii.payload.json": '{"error":"original handler error"}',
        "iii.payload.truncated": false,
        "iii.payload.ok": false,
      },
    ]);
    expect(input.ownKeys).toHaveBeenCalledTimes(1);
    expect(input.getter).toHaveBeenCalledTimes(1);
  });

  it("reads the switch when the stored wrapper executes, not just at registration", async () => {
    const input = watchedPayload("input");
    const output = watchedPayload("output");
    const wrapper = register(() => output.payload);

    vi.stubEnv("III_DISABLE_TRACE_PAYLOADS", "true");
    expect(await wrapper(input.payload)).toBe(output.payload);
    expect(serialize).not.toHaveBeenCalled();
    expect(input.ownKeys).not.toHaveBeenCalled();
    expect(output.ownKeys).not.toHaveBeenCalled();

    vi.stubEnv("III_DISABLE_TRACE_PAYLOADS", "false");
    expect(await wrapper(input.payload)).toBe(output.payload);
    expect(serialize).toHaveBeenCalledTimes(2);
    expect(input.ownKeys).toHaveBeenCalledTimes(1);
    expect(output.ownKeys).toHaveBeenCalledTimes(1);
  });
});
