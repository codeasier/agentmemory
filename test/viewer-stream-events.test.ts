import { readFileSync } from "node:fs";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("viewer stream event contract", () => {
  it("routes nested observation events but not unrelated stream messages", () => {
    const html = readFileSync("src/viewer/index.html", "utf8");
    const start = html.indexOf("function looksLikeObservation(");
    const end = html.indexOf("function routeWsMessage(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const routed: unknown[] = [];
    const context = {
      routeWsMessage: (message: unknown) => routed.push(message),
      // Defined just above the extracted region in the viewer script; the
      // live-buffer cap the sync branch slices to (upstream #1407).
      LIVE_BUFFER_MAX: 200,
    };
    vm.runInNewContext(html.slice(start, end), context);
    const handle = (context as typeof context & { handleStreamEvent: (msg: unknown) => void }).handleStreamEvent;
    const raw = { id: "raw_1", timestamp: "2026-01-01T00:00:00Z" };
    const compressed = { id: "cmp_1", timestamp: "2026-01-01T00:00:01Z" };

    handle({ event: { type: "event", event: { type: "raw_observation", data: { observation: raw } } } });
    handle({ event: { type: "event", event: { type: "compressed_observation", data: { observation: compressed } } } });
    handle({ event: { type: "event", event: { type: "session.activity", data: { observation: raw } } } });
    handle({ event: { type: "create", data: { observation: raw } } });
    handle({ event: { type: "sync", data: [{ data: { observation: compressed } }] } });

    expect(routed).toEqual([
      { observation: raw },
      { observation: compressed },
      { observation: raw },
      { observation: compressed },
    ]);
  });
});
