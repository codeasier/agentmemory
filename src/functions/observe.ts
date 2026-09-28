import { TriggerAction, type ISdk } from "iii-sdk";
import type { RawObservation, HookPayload, Origin } from "../types.js";

const TOOL_HOOKS = new Set(["pre_tool_use", "post_tool_use", "post_tool_failure"]);
import { KV, STREAM, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { getAgentId, getEnvVar, isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex, scheduleIndexSave, vectorIndexAddGuarded } from "./search.js";
import { logger } from "../logger.js";
import { saveImageToDisk } from "../utils/image-store.js";

function envLimit(name: string, fallback: number): number {
  const raw = getEnvVar(name);
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return value === 0 ? Number.POSITIVE_INFINITY : Math.max(2, value);
}

export const OBSERVE_PAYLOAD_LIMITS = {
  toolInputChars: envLimit("AGENTMEMORY_OBSERVE_TOOL_INPUT_CHARS", 4_000),
  toolOutputChars: envLimit("AGENTMEMORY_OBSERVE_TOOL_OUTPUT_CHARS", 8_000),
  userPromptChars: envLimit("AGENTMEMORY_OBSERVE_PROMPT_CHARS", 8_000),
  rawChars: envLimit("AGENTMEMORY_OBSERVE_RAW_CHARS", 16_000),
};

function serializedSize(value: unknown): number {
  if (typeof value === "string") return JSON.stringify(value).length;
  if (Array.isArray(value)) {
    return (
      2 +
      value.reduce(
        (total, item, index) =>
          total + (index > 0 ? 1 : 0) + serializedSize(item),
        0,
      )
    );
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      2 +
      entries.reduce(
        (total, [key, item], index) =>
          total +
          (index > 0 ? 1 : 0) +
          JSON.stringify(key).length +
          1 +
          serializedSize(item),
        0,
      )
    );
  }
  return JSON.stringify(value)?.length ?? 0;
}

function boundString(value: string, maxChars: number): string {
  if (JSON.stringify(value).length <= maxChars) return value;
  const marker = JSON.stringify("...[truncated]").length <= maxChars
    ? "...[truncated]"
    : "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, mid) + marker;
    if (JSON.stringify(candidate).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low) + marker;
}

function boundValue(value: unknown, maxChars: number): unknown {
  if (!Number.isFinite(maxChars) || serializedSize(value) <= maxChars) {
    return value;
  }
  if (typeof value === "string") return boundString(value, maxChars);
  if (Array.isArray(value)) {
    const bounded: unknown[] = [];
    let remaining = Math.max(0, maxChars - 2);
    for (const item of value) {
      const comma = bounded.length > 0 ? 1 : 0;
      if (remaining <= comma) break;
      const next = boundValue(item, remaining - comma);
      const cost = comma + serializedSize(next);
      if (cost > remaining) break;
      bounded.push(next);
      remaining -= cost;
    }
    return bounded;
  }
  if (value !== null && typeof value === "object") {
    let remaining = Math.max(0, maxChars - 2);
    const entries: Array<[string, unknown]> = [];
    // Decorate-sort-undecorate: computing serializedSize inside the
    // comparator calls the recursive size walk O(k log k) times. This is the
    // hottest path in the system (every observe request), so size each entry
    // once and sort the precomputed sizes instead.
    const sized = Object.entries(value as Record<string, unknown>).map(
      (entry) => ({ entry, size: serializedSize(entry[1]) }),
    );
    sized.sort((a, b) => a.size - b.size);
    for (const { entry } of sized) {
      const [key, item] = entry;
      const comma = entries.length > 0 ? 1 : 0;
      const overhead = comma + JSON.stringify(key).length + 1;
      if (remaining <= overhead) break;
      const next = boundValue(item, remaining - overhead);
      const cost = overhead + serializedSize(next);
      if (cost > remaining) break;
      entries.push([key, next]);
      remaining -= cost;
    }
    return Object.fromEntries(entries);
  }
  return value;
}

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction("mem::observe", 
    async (payload: HookPayload) => {

      if (
        !payload?.sessionId ||
        typeof payload.sessionId !== "string" ||
        !payload.hookType ||
        typeof payload.hookType !== "string" ||
        !payload.timestamp ||
        typeof payload.timestamp !== "string"
      ) {
        return {
          success: false,
          error:
            "Invalid payload: sessionId, hookType, and timestamp are required",
        };
      }

      const obsId = generateId("obs");

      // A future-stamped timestamp (client clock skew, misconfigured clock)
      // would pin the graph-extraction watermark above every subsequent real
      // observation and permanently block incremental extraction. Clamp to
      // ingest time; past timestamps (jsonl replay) pass through untouched.
      const ingestAtMs = Date.now();
      const parsedPayloadTs = Date.parse(payload.timestamp);
      if (
        Number.isFinite(parsedPayloadTs) &&
        parsedPayloadTs > ingestAtMs
      ) {
        payload.timestamp = new Date(ingestAtMs).toISOString();
      }

      let dedupHash: string | undefined;
      if (dedupMap) {
        const dataIsObject =
          typeof payload.data === "object" && payload.data !== null;
        const d = dataIsObject
          ? (payload.data as Record<string, unknown>)
          : {};
        const toolName = (d["tool_name"] as string) || payload.hookType;
        // Hash the full payload when tool_input is absent so distinct
        // events never collapse onto one key.
        const dedupInput =
          d["tool_input"] !== undefined
            ? d["tool_input"]
            : dataIsObject
              ? d
              : payload.data;
        dedupHash = dedupMap.computeHash(
          payload.sessionId,
          toolName,
          dedupInput,
        );
        if (dedupMap.isDuplicate(dedupHash)) {
          return { deduplicated: true, sessionId: payload.sessionId };
        }
      }

      let sanitizedRaw: unknown = payload.data;
      try {
        const jsonStr = JSON.stringify(payload.data);
        const sanitized = stripPrivateData(jsonStr);
        sanitizedRaw = JSON.parse(sanitized);
      } catch {
        sanitizedRaw = stripPrivateData(String(payload.data));
      }

      let originChannel: Origin["channel"] = "agent";
      if (payload.hookType === "prompt_submit") originChannel = "user";
      else if (TOOL_HOOKS.has(payload.hookType)) originChannel = "tool";
      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: boundValue(sanitizedRaw, OBSERVE_PAYLOAD_LIMITS.rawChars),
        origin: {
          channel: originChannel,
          capturedAt: payload.timestamp,
        },
      };

      let extractedImage: string | undefined;

      if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
        const d = sanitizedRaw as Record<string, unknown>;
        if (
          payload.hookType === "post_tool_use" ||
          payload.hookType === "post_tool_failure"
        ) {
          raw.toolName = d["tool_name"] as string | undefined;
          raw.toolInput = boundValue(
            d["tool_input"],
            OBSERVE_PAYLOAD_LIMITS.toolInputChars,
          );
          raw.toolOutput = boundValue(
            d["tool_output"] || d["error"],
            OBSERVE_PAYLOAD_LIMITS.toolOutputChars,
          );
          if (raw.origin && raw.toolName) raw.origin.detail = raw.toolName;
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = boundValue(
            d["prompt"],
            OBSERVE_PAYLOAD_LIMITS.userPromptChars,
          ) as string | undefined;
        }

        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt) ? "mixed" : "image";
        }
      } else if (typeof sanitizedRaw === "string") {
        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = "image";
        }
      }

      const pendingImageData = extractedImage;

      return withKeyedLock(`obs:${payload.sessionId}`, async () => {
        const existingSession = await kv.get<{
          agentId?: string;
          observationCount?: number;
          firstPrompt?: string;
        }>(KV.sessions, payload.sessionId);
        let observationCount = 0;

        if (maxObservationsPerSession && maxObservationsPerSession > 0) {
          const savedCount = existingSession?.observationCount;
          const needsRecount = typeof savedCount !== "number" || !Number.isSafeInteger(savedCount) || savedCount <= 0;
          observationCount =
            needsRecount
              ? (await kv.list(KV.observations(payload.sessionId))).length
              : savedCount!;
          if (observationCount >= maxObservationsPerSession) {
            if (!needsRecount) {
              observationCount = (await kv.list(KV.observations(payload.sessionId))).length;
            }
            if (observationCount >= maxObservationsPerSession) {
              return {
                success: false,
                error: `Session observation limit reached (${maxObservationsPerSession})`,
              };
            }
          }
          if (existingSession) existingSession.observationCount = observationCount;
        }

        // Existing session is the source of truth for agentId (even
        // undefined). Env AGENT_ID only fires when no session row
        // exists yet — otherwise an unscoped session would get
        // retroactively scoped by a later AGENT_ID export.
        const inheritedAgentId = existingSession
          ? existingSession.agentId
          : getAgentId();
        if (inheritedAgentId) {
          raw.agentId = inheritedAgentId;
        }

        // Advance the session counter BEFORE writing the observation. If the
        // observation write then fails, the counter over-counts by one — the
        // safe direction, since over-counts self-heal at the cap recount.
        // The previous order (write first, count afterwards) let a failed
        // session-row update leave the store ahead of the counter, and
        // repeated update failures grew the session past
        // MAX_OBS_PER_SESSION.
        if (existingSession) {
          const updates: Array<{ type: "set"; path: string; value: unknown }> = [
            { type: "set", path: "updatedAt", value: new Date().toISOString() },
            {
              type: "set",
              path: "observationCount",
              value: (existingSession.observationCount || 0) + 1,
            },
          ];
          if (!existingSession.firstPrompt && typeof raw.userPrompt === "string") {
            const trimmed = raw.userPrompt.replace(/\s+/g, " ").trim();
            if (trimmed.length > 0) {
              updates.push({
                type: "set",
                path: "firstPrompt",
                value: trimmed.slice(0, 200),
              });
            }
          }
          await kv.update(KV.sessions, payload.sessionId, updates);
        } else if (
          typeof payload.project === "string" &&
          payload.project.trim().length > 0 &&
          typeof payload.cwd === "string" &&
          payload.cwd.trim().length > 0
        ) {
          // OpenCode (and any plugin that skips POST /session/start)
          // can fire observations before the session record exists. Without
          // an implicit create, those observations stack up but
          // `memory_sessions` never lists them, and summarize bails with
          // "Session not found for summarize". Create the session now from
          // the observation payload — but only when project + cwd are
          // present (HookPayload contract). Older test payloads without
          // those fields keep their original no-op behaviour.
          const trimmedPrompt =
            typeof raw.userPrompt === "string"
              ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
              : undefined;
          const ts = new Date().toISOString();
          await kv.set(KV.sessions, payload.sessionId, {
            id: payload.sessionId,
            project: payload.project,
            cwd: payload.cwd,
            startedAt: payload.timestamp ?? ts,
            updatedAt: ts,
            status: "active",
            // +1 for the observation written below this create: the list
            // cannot have seen it yet.
            observationCount: maxObservationsPerSession && maxObservationsPerSession > 0
              ? observationCount + 1
              : (await kv.list(KV.observations(payload.sessionId))).length + 1,
            ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
            ...(trimmedPrompt && trimmedPrompt.length > 0
              ? { firstPrompt: trimmedPrompt }
              : {}),
          });
        }

        if (pendingImageData && (pendingImageData.startsWith("data:image/") || pendingImageData.startsWith("iVBORw0KGgo") || pendingImageData.startsWith("/9j/"))) {
          const { filePath, bytesWritten } = await saveImageToDisk(pendingImageData);
          raw.imageData = filePath;
          const { incrementImageRef } = await import("./image-refs.js");
          await incrementImageRef(kv, filePath);
          sdk.trigger({
            function_id: "mem::disk-size-delta",
            payload: { deltaBytes: bytesWritten },
            action: TriggerAction.Void(),
          });
          if (process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] === "true") {
            sdk.trigger({
              function_id: "mem::vision-embed",
              payload: {
                imageRef: filePath,
                sessionId: payload.sessionId,
                observationId: obsId,
              },
              action: TriggerAction.Void(),
            });
          }
        }

        try {

          await kv.set(KV.observations(payload.sessionId), obsId, raw);

        } catch (error) {
          if (raw.imageData) {
            // Roll back the ref taken above. decrementImageRef deletes the file
            // only when no other observation still references it (deduped images
            // survive) and emits the disk-size delta itself — deleting the file
            // directly here would orphan shared images and leave a stale ref.
            // If the rollback itself fails, log it but still surface the
            // original write error (the more useful failure to diagnose).
            try {
              const { decrementImageRef } = await import("./image-refs.js");
              await decrementImageRef(kv, sdk, raw.imageData);
            } catch (rollbackError) {
              logger.error("Failed to roll back image ref after observation write failure", {
                imageRef: raw.imageData,
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              });
            }
          }
          throw error;
        }

        if (dedupMap && dedupHash) {
          dedupMap.record(dedupHash);
        }

        await sdk.trigger({
          function_id: "stream::send",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.group(payload.sessionId),
            id: `raw-${obsId}`,
            type: "raw_observation",
            data: { type: "raw", observation: raw },
          },
        });

        await sdk.trigger({
          function_id: "stream::send",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            id: `raw-${obsId}`,
            type: "raw_observation",
            data: { type: "raw", observation: raw, sessionId: payload.sessionId },
          },
          action: TriggerAction.Void(),
        });

        // Per-observation LLM compression is opt-in as of 0.8.8.
        // Default path: build a zero-LLM synthetic compression so recall
        // and BM25 search still work without burning the user's Claude
        // token allocation on every tool invocation.
        if (isAutoCompressEnabled()) {
          await sdk.trigger({
            function_id: "mem::compress",
            payload: {
              observationId: obsId,
              sessionId: payload.sessionId,
              raw,
            },
            action: TriggerAction.Void(),
          });
        } else {
          const synthetic = buildSyntheticCompression(raw);
          await kv.set(
            KV.observations(payload.sessionId),
            obsId,
            synthetic,
          );
          getSearchIndex().add(synthetic);
          scheduleIndexSave();
          await vectorIndexAddGuarded(
            synthetic.id,
            synthetic.sessionId,
            synthetic.title + " " + (synthetic.narrative || ""),
            { kind: "synthetic", logId: synthetic.id },
          );
          await sdk.trigger({
            function_id: "stream::send",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.group(payload.sessionId),
              id: `compressed-${synthetic.id}`,
              type: "compressed_observation",
              data: { type: "compressed", observation: synthetic },
            },
          });
          await sdk.trigger({
            function_id: "stream::send",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.viewerGroup,
              id: `compressed-${synthetic.id}`,
              type: "compressed_observation",
              data: {
                type: "compressed",
                observation: synthetic,
                sessionId: payload.sessionId,
              },
            },
          });
        }

        logger.info("Observation captured", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
          compress: isAutoCompressEnabled() ? "llm" : "synthetic",
        });
        return { observationId: obsId };
      });
    },
  );
}
