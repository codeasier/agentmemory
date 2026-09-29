import { TriggerAction, type ISdk } from "iii-sdk";
import type { CompressedObservation, HookPayload, Memory, Session } from "../types.js";
import { KV, STREAM, fingerprintId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isReflectEnabled } from "../functions/slots.js";
import {
  detectLlmProviderKind,
  getAgentId,
  getConsolidationCooldownMs,
  getGraphExtractionRetryMs,
  isAgentScopeIsolated,
  isConsolidationEnabled,
  isIncrementalGraphExtractionEnabled,
} from "../config.js";
import { logger } from "../logger.js";

// Global marker recording when corpus consolidation last ran, used to debounce
// the per-turn session-stop fan-out.
const CONSOLIDATION_MARKER_KEY = "consolidation:lastRun";

// Order-independent fingerprint of an observation set: tells whether the
// already-extracted half of a session still looks the way it did at the last
// graph extract. Over ids, not counts or timestamps — evict's per-project cap
// (evict.ts, age- and status-independent) can delete an observation from the
// live session in the same window a late compression lands another, and if the
// two share a millisecond only the ids tell the sets apart.
const observationFingerprint = (obs: CompressedObservation[]): string =>
  fingerprintId("gx", obs.map((o) => o.id).sort().join(","));

// The watermark-stale log fires on the incremental graph path, i.e. on every
// agent turn while a session's extracted digest keeps mismatching (future-
// stamped observations, replayed sessions). Throttle per session so the
// signal survives without per-turn volume, mirroring index-persistence's
// lastFailureLogAt. Scoped to the registration so each engine start (and
// each test harness registration) starts unthrottled.
const WATERMARK_LOG_THROTTLE_MS = 60_000;

let sessionActivitySeq = 0;

async function consolidationDueUnserialized(kv: StateKV): Promise<boolean> {
  const cooldownMs = getConsolidationCooldownMs();
  if (cooldownMs <= 0) return true; // debounce disabled
  const now = Date.now();
  const marker = await kv
    .get<{ at?: number }>(KV.config, CONSOLIDATION_MARKER_KEY)
    .catch(() => null);
  const lastAt = typeof marker?.at === "number" ? marker.at : 0;
  if (now - lastAt < cooldownMs) return false;
  await kv.set(KV.config, CONSOLIDATION_MARKER_KEY, { at: now }).catch(() => {});
  return true;
}

// Concurrent session-stop events would otherwise interleave the marker
// read-check-write above and both pass the cooldown. Serialize the whole
// check through an in-process chain so exactly one concurrent caller wins.
let consolidationCheckChain: Promise<unknown> = Promise.resolve();

function consolidationDue(kv: StateKV): Promise<boolean> {
  const result = consolidationCheckChain.then(() =>
    consolidationDueUnserialized(kv),
  );
  consolidationCheckChain = result.catch(() => false);
  return result;
}

export function registerEventTriggers(sdk: ISdk, kv: StateKV): void {
  const watermarkLogAt = new Map<string, number>();

  // A failed graph extraction used to set graphExtractRetryAt and then rely
  // on the NEXT event::session::stopped to retry. When the failing stop was
  // the session's last one, nothing ever fired again: the session's graph
  // stayed unextracted forever. Arm an in-process wake-up timer per session
  // so the retry happens even with no further stop events, and re-arm at
  // boot for sessions whose retryAt outlived a restart. Scoped to the
  // registration, mirroring watermarkLogAt.
  const graphRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const graphExtractInFlight = new Set<string>();

  const disarmGraphRetry = (sessionId: string): void => {
    const timer = graphRetryTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      graphRetryTimers.delete(sessionId);
    }
  };

  const armGraphRetry = (sessionId: string, delayMs: number): void => {
    disarmGraphRetry(sessionId);
    const timer = setTimeout(() => {
      graphRetryTimers.delete(sessionId);
      runGraphExtraction(sessionId).catch((err: unknown) => {
        logger.warn("graph-extract retry failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);
    graphRetryTimers.set(sessionId, timer);
  };

  const runGraphExtraction = async (sessionId: string): Promise<void> => {
    if (graphExtractInFlight.has(sessionId)) return;
    graphExtractInFlight.add(sessionId);
    try {
      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const compressed = observations.filter((o) => o.title);
      const session = compressed.length > 0
        ? await kv.get<Session>(KV.sessions, sessionId).catch(() => null)
        : null;
      if (
        compressed.length > 0 &&
        !(session?.graphExtractRetryAt && Date.now() < session.graphExtractRetryAt)
      ) {
        // /session/end is posted by the per-turn Stop hook, so this handler
        // runs every agent turn. Re-sending the whole session each time makes
        // persistGraphDelta re-merge turns 1..N-1 on turn N — quadratic engine
        // calls, and per #843 every kv.set stays resident in the engine, so
        // that is quadratic permanent heap. Send only what landed since the
        // last extract.
        //
        // The digest is what makes the timestamp watermark safe. mem::compress
        // is dispatched fire-and-forget (observe.ts) and stamps the capture
        // time, not the write time, so a slow compression can land an OLDER
        // timestamp after a newer one was already extracted; evict can also
        // remove one at any point. Whenever the already-extracted half no
        // longer fingerprints the same, we re-send the whole session rather
        // than skip it. Missing a memory is worse than re-merging one.
        const at = session?.graphExtractedAt;
        const mark = session?.graphExtractedDigest;
        const incremental = isIncrementalGraphExtractionEnabled();
        const atMs = typeof at === "string" ? Date.parse(at) : Number.NaN;
        const nowMs = Date.now();
        const times = compressed.map((observation) => {
          const parsed = Date.parse(observation.timestamp);
          return Number.isFinite(parsed) ? parsed : 0;
        });
        let batch = compressed;
        let persistWatermark = false;
        if (incremental) {
          if (!Number.isFinite(atMs)) {
            persistWatermark = true;
          } else {
            // A future-stamped observation (client clock skew, replayed
            // session) never satisfies t <= watermark, so it would fall out
            // of the "already extracted" set and trip the digest mismatch
            // below on every turn. Treat anything above wall-clock time as
            // part of the extracted half: a NEW future-stamped observation
            // still mismatches the digest (full re-extract), but an already
            // extracted one costs only its own delta re-merge per turn until
            // real time passes its stamp.
            const seen = compressed.filter(
              (_, index) => times[index] <= atMs || times[index] > nowMs,
            );
            if (observationFingerprint(seen) === mark) {
              batch = compressed.filter((_, index) => times[index] > atMs);
              persistWatermark = true;
            } else {
              persistWatermark = true;
              const lastLogAt = watermarkLogAt.get(sessionId) ?? 0;
              if (nowMs - lastLogAt >= WATERMARK_LOG_THROTTLE_MS) {
                watermarkLogAt.set(sessionId, nowMs);
                logger.info("graph-extract watermark stale, re-extracting session", {
                  sessionId,
                  atOrBelow: seen.length,
                  total: compressed.length,
                });
              }
            }
          }
        }
        if (batch.length > 0) {
          try {
            const result = await sdk.trigger<{ observations: CompressedObservation[] }, { success: boolean; error?: string }>({
              function_id: "mem::graph-extract",
              payload: { observations: batch },
            });
            if (result?.success !== true) {
              throw new Error(result?.error ?? "graph extraction did not confirm success");
            }
            if (persistWatermark || session?.graphExtractRetryAt) {
              // Clamp to wall-clock: a future-stamped observation must never
              // pin the watermark above every subsequent real timestamp,
              // which would permanently block incremental extraction.
              const newest = times.reduce(
                (max, time) => Math.max(max, Math.min(time, nowMs)),
                0,
              );
              await kv.update(KV.sessions, sessionId, [
                ...(persistWatermark ? [
                  { type: "set", path: "graphExtractedAt", value: new Date(newest).toISOString() },
                  { type: "set", path: "graphExtractedDigest", value: observationFingerprint(compressed) },
                ] : []),
                ...(session?.graphExtractRetryAt ? [
                  { type: "set", path: "graphExtractRetryAt", value: 0 },
                ] : []),
              ]);
            }
            disarmGraphRetry(sessionId);
          } catch (err) {
            await kv.update(KV.sessions, sessionId, [
              { type: "set", path: "graphExtractRetryAt", value: Date.now() + getGraphExtractionRetryMs() },
            ]);
            armGraphRetry(sessionId, getGraphExtractionRetryMs());
            throw err;
          }
        }
      }
    } finally {
      graphExtractInFlight.delete(sessionId);
    }
  };

  sdk.registerFunction(
    "event::session::started",
    async (data: {
      sessionId: string;
      project: string;
      cwd: string;
      agentId?: string;
    }) => {
      const requestAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim().slice(0, 128)
          : undefined;
      const agentId = requestAgentId ?? getAgentId();
      const session: Session = {
        id: data.sessionId,
        project: data.project,
        cwd: data.cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
        ...(agentId ? { agentId } : {}),
      };
      await kv.set(KV.sessions, data.sessionId, session);
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string; agentId?: string },
        { context: string }
      >({
        function_id: "mem::context",
        payload: {
          sessionId: data.sessionId,
          project: data.project,
          ...(agentId ? { agentId } : {}),
        },
      });
      return { session, context: contextResult.context };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::started",
    config: { topic: "agentmemory.session.started" },
  });

  sdk.registerFunction("event::observation", async (data: HookPayload) =>
    sdk.trigger({ function_id: "mem::observe", payload: data }),
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::observation",
    config: { topic: "agentmemory.observation" },
  });

  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string; skipConsolidation?: boolean }) => {
    const summary = await sdk.trigger({ function_id: "mem::summarize", payload: data });
    const fireVoid = (function_id: string, payload: unknown) =>
      sdk
        .trigger({ function_id, payload, action: TriggerAction.Void() })
        .catch((err) =>
          logger.warn(function_id + " trigger failed", {
            sessionId: data.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    if (isReflectEnabled()) {
      fireVoid("mem::slot-reflect", { sessionId: data.sessionId });
    }
    // Unconditional: mem::graph-extract gates its LLM pass internally.
    // runGraphExtraction arms its own wake-up timer on failure, so a failed
    // extract no longer depends on a future stop event to retry.
    try {
      await runGraphExtraction(data.sessionId);
    } catch (err) {
      logger.warn("graph-extract trigger failed", {
        sessionId: data.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Crystals + lessons consolidation. The stop lifecycle is the single
    // source of truth: event::session::stopped fires for ALL agents (the
    // client-side session-end hook no longer drives consolidation directly).
    // Gated so keyless/zero-LLM users don't fire no-op LLM calls.
    //
    // skipConsolidation suppresses the fan-out when this handler is driven
    // by eviction's stale-session recovery: evict calls session::stopped
    // once per recovered session, then runs ONE final consolidation pass.
    // Without this guard, N recovered sessions launch N concurrent forced
    // full-corpus consolidations plus N crystallizations.
    //
    // Debounce: /session/end is posted by the per-turn Stop hook, so this
    // handler fires on every agent turn. consolidate-pipeline + auto-crystallize
    // are full-corpus LLM work with no internal "nothing changed" guard, so
    // firing them every turn is a cost/latency storm for connected agents.
    // Bound the global corpus consolidation to once per cooldown window.
    if (isConsolidationEnabled() && !data.skipConsolidation) {
      if (await consolidationDue(kv)) {
        fireVoid("mem::consolidate-pipeline", { tier: "all", force: true });
        fireVoid("mem::auto-crystallize", { olderThanDays: 0 });
        if (detectLlmProviderKind() === "llm") {
          fireVoid("mem::skill-extract", { sessionId: data.sessionId });
        }
      }
    }
    return summary;
  });
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::stopped",
    config: { topic: "agentmemory.session.stopped" },
  });

  sdk.registerFunction(
    "event::session::ended",
    async (data: { sessionId: string }) => {
      await kv.update(KV.sessions, data.sessionId, [
        { type: "set", path: "endedAt", value: new Date().toISOString() },
        { type: "set", path: "status", value: "completed" },
      ]);
      return { success: true };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::ended",
    config: { topic: "agentmemory.session.ended" },
  });

  // React to observation count changes and emit a lightweight live event for dashboards/viewer.
  sdk.registerFunction(
    "event::session::observation-count-changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Session;
      new_value?: Session;
    }) => {
      if (isOutOfAgentScope(payload.new_value ?? payload.old_value)) {
        return { emitted: false };
      }
      if (isStateDelete(payload)) {
        await sendViewerEvent(sdk, `session-deleted-${payload.key}-${Date.now()}`, "session.deleted", {
          sessionId: payload.key,
        });
        return { emitted: true };
      }
      if (payload.new_value) {
        await sendViewerEvent(sdk, `session-updated-${payload.key}-${Date.now()}`, "session.updated", {
          session: payload.new_value,
        });
      }
      const oldCount = payload.old_value?.observationCount ?? 0;
      const newCount = payload.new_value?.observationCount ?? 0;
      if (newCount <= oldCount) return { emitted: Boolean(payload.new_value) };

      await sendViewerEvent(sdk, `session-activity-${payload.key}-${Date.now()}-${sessionActivitySeq++}`, "session.activity", {
        sessionId: payload.key,
        observationCount: newCount,
        delta: newCount - oldCount,
        updatedAt: payload.new_value?.updatedAt ?? new Date().toISOString(),
      });

      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::session::observation-count-changed",
    config: { scope: KV.sessions },
  });

  sdk.registerFunction(
    "event::memory::changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Memory;
      new_value?: Memory;
    }) => {
      if (isOutOfAgentScope(payload.new_value ?? payload.old_value)) {
        return { emitted: false };
      }
      const deleted = isStateDelete(payload);
      const memory = payload.new_value;
      await sendViewerEvent(
        sdk,
        `memory-${deleted ? "deleted" : "updated"}-${payload.key}-${Date.now()}`,
        deleted ? "memory.deleted" : "memory.updated",
        deleted
          ? { memoryId: payload.key }
          : {
              memoryId: payload.key,
              type: memory?.type,
              title: memory?.title,
              isLatest: memory?.isLatest,
              updatedAt: memory?.updatedAt,
            },
      );
      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::memory::changed",
    config: { scope: KV.memories },
  });

  // Restart recovery: re-arm wake-up timers for sessions whose
  // graphExtractRetryAt outlived the process. Already-expired retries arm at
  // zero delay; the gate inside runGraphExtraction still applies, and a
  // session with nothing left to extract no-ops without re-arming.
  if (typeof kv.list === "function") {
    void kv
      .list<Session>(KV.sessions)
    .then((sessions) => {
      const now = Date.now();
      for (const session of sessions) {
        if (
          typeof session?.id === "string" &&
          typeof session.graphExtractRetryAt === "number" &&
          session.graphExtractRetryAt > 0
        ) {
          armGraphRetry(session.id, Math.max(0, session.graphExtractRetryAt - now));
        }
      }
    })
    .catch((err: unknown) => {
      logger.warn("graph-extract retry sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// Engine 0.22 reports state deletes as "state:deleted" with a null
// new_value; this line's engine 0.11.2 reports "delete". Accept both, and
// treat a missing new_value as a delete for snapshots written before the
// engine normalized either spelling.
function isStateDelete(payload: { event_type: string; new_value?: unknown }): boolean {
  return (
    payload.event_type === "delete" ||
    payload.event_type === "state:deleted" ||
    !payload.new_value
  );
}

function isOutOfAgentScope(record: { agentId?: string } | undefined): boolean {
  return isAgentScopeIsolated() && record?.agentId !== getAgentId();
}

async function sendViewerEvent(
  sdk: ISdk,
  id: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await sdk.trigger({
    function_id: "stream::send",
    payload: { stream_name: STREAM.name, group_id: STREAM.viewerGroup, id, type, data },
    action: TriggerAction.Void(),
  });
}
