// Structure-preserving client-side bound for hook payloads. A flat
// JSON.stringify+slice kept the wire small but destroyed object shape for
// outputs over the cap — the largest payloads lost the very fields
// (file_path etc.) the server's structure-preserving truncation exists to
// keep. Walk the value and keep as many whole entries as fit the budget;
// strings get sliced. The server bound
// (AGENTMEMORY_OBSERVE_TOOL_OUTPUT_CHARS) remains authoritative — this cap
// only limits wire size and ingress parse memory.

export const TRUNCATION_MARKER = "...[truncated]";

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

export function truncate(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    if (serializedLength(value) <= max) return value;
    // Escape expansion (quotes, backslashes, control characters) makes the
    // serialized form up to six times the raw character count, so slicing by
    // character count alone overshoots the budget — and inside an object that
    // overshoot made the caller's cost check reject the field and drop every
    // field after it, so escape-heavy tool outputs arrived as {}. Find the
    // longest prefix whose serialized form still fits by binary search, the
    // same way the server's boundString does.
    let keep = 0;
    let hi = value.length;
    while (keep < hi) {
      const mid = Math.ceil((keep + hi) / 2);
      const candidate = value.slice(0, mid) + TRUNCATION_MARKER;
      if (serializedLength(candidate) <= max) keep = mid;
      else hi = mid - 1;
    }
    return value.slice(0, keep) + TRUNCATION_MARKER;
  }
  if (Array.isArray(value)) {
    if (serializedLength(value) <= max) return value;
    const bounded: unknown[] = [];
    let remaining = Math.max(0, max - 2);
    for (const item of value) {
      const comma = bounded.length > 0 ? 1 : 0;
      if (remaining <= comma) break;
      const next = truncate(item, remaining - comma);
      const cost = comma + serializedLength(next);
      // Skip, not stop: one entry that cannot fit (long primitives, a
      // string against a sub-budget smaller than the marker) must not
      // discard later entries that still fit.
      if (cost > remaining) continue;
      bounded.push(next);
      remaining -= cost;
    }
    return bounded;
  }
  if (typeof value === "object" && value !== null) {
    if (serializedLength(value) <= max) return value;
    const bounded: Record<string, unknown> = {};
    let remaining = Math.max(0, max - 2);
    // Smallest fields first, mirroring the server's boundValue: a huge
    // stdout must not crowd out file_path / exit_code when the budget runs
    // out. Field order is not semantic for the wire — the server re-bounds
    // and re-orders anyway.
    const sized = Object.entries(value as Record<string, unknown>).map(
      (entry) => ({ entry, size: serializedLength(entry[1]) }),
    );
    sized.sort((a, b) => a.size - b.size);
    for (const { entry } of sized) {
      const [key, item] = entry;
      const overhead =
        (Object.keys(bounded).length > 0 ? 1 : 0) + JSON.stringify(key).length + 1;
      // Long keys can outlive the budget while later short keys still fit.
      if (remaining <= overhead) continue;
      const next = truncate(item, remaining - overhead);
      const cost = overhead + serializedLength(next);
      if (cost > remaining) continue;
      bounded[key] = next;
      remaining -= cost;
    }
    return bounded;
  }
  return value;
}
