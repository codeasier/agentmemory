#!/usr/bin/env node
import { resolveProject, hookCwd } from "./_project.js";

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;

  const sessionId = ((data.session_id || data.sessionId || data.conversation_id) as string) || "unknown";
  const toolName = data.tool_name ?? data.toolName;
  const toolInput = data.tool_input ?? data.toolArgs;

  const { imageData, cleanOutput } = extractImageData(toolOutput(data));
  const cwd = hookCwd(data) || process.cwd();

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "post_tool_use",
      sessionId,
      project: resolveProject(cwd),
      cwd,
      timestamp: new Date().toISOString(),
      data: {
        tool_name: toolName,
        tool_input: toolInput,
        // The larger ingress cap lets the server preserve structured output within its 8k default.
        tool_output: truncate(cleanOutput, 32000),
        ...(imageData ? { image_data: imageData } : {}),
      },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}

function toolOutput(data: Record<string, unknown>): unknown {
  if (data.tool_response !== undefined) return data.tool_response;
  if (data.tool_output !== undefined) return data.tool_output;
  const result = data.tool_result ?? data.toolResult;
  if (typeof result === "object" && result !== null) {
    const obj = result as Record<string, unknown>;
    return obj.text_result_for_llm ?? obj.textResultForLlm ?? result;
  }
  return result;
}

function isBase64Image(val: unknown): val is string {
  return typeof val === "string" && (
    val.startsWith("data:image/") ||
    val.startsWith("iVBORw0KGgo") ||
    val.startsWith("/9j/")
  );
}

function extractImageData(output: unknown): { imageData: string | undefined; cleanOutput: unknown } {
  if (isBase64Image(output)) {
    return { imageData: output, cleanOutput: "[image data extracted]" };
  }

  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>;
    let imageData: string | undefined;
    const clean: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      if (!imageData && isBase64Image(val)) {
        imageData = val;
        clean[key] = "[image data extracted]";
      } else {
        clean[key] = val;
      }
    }

    return { imageData, cleanOutput: clean };
  }

  return { imageData: undefined, cleanOutput: output };
}

const TRUNCATION_MARKER = "...[truncated]";

// Structure-preserving client-side bound. A flat JSON.stringify+slice kept
// the wire small but destroyed object shape for outputs over the cap — the
// largest payloads lost the very fields (file_path etc.) the server's
// structure-preserving truncation exists to keep. Walk the value and keep as
// many whole entries as fit the budget; strings get sliced. The server bound
// (AGENTMEMORY_OBSERVE_TOOL_OUTPUT_CHARS) remains authoritative — this cap
// only limits wire size and ingress parse memory.
function truncate(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    if (value.length + TRUNCATION_MARKER.length <= max) return value;
    return value.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
  }
  if (Array.isArray(value)) {
    if (JSON.stringify(value).length <= max) return value;
    const bounded: unknown[] = [];
    let remaining = Math.max(0, max - 2);
    for (const item of value) {
      const comma = bounded.length > 0 ? 1 : 0;
      if (remaining <= comma) break;
      const next = truncate(item, remaining - comma);
      const cost = comma + JSON.stringify(next).length;
      if (cost > remaining) break;
      bounded.push(next);
      remaining -= cost;
    }
    return bounded;
  }
  if (typeof value === "object" && value !== null) {
    if (JSON.stringify(value).length <= max) return value;
    const bounded: Record<string, unknown> = {};
    let remaining = Math.max(0, max - 2);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const overhead =
        (Object.keys(bounded).length > 0 ? 1 : 0) + JSON.stringify(key).length + 1;
      if (remaining <= overhead) break;
      const next = truncate(item, remaining - overhead);
      const cost = overhead + JSON.stringify(next).length;
      if (cost > remaining) break;
      bounded[key] = next;
      remaining -= cost;
    }
    return bounded;
  }
  return value;
}

main().catch(() => process.exit(0));
