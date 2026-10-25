import { describe, it, expect, beforeEach, vi } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { segmentCjk } from "../src/state/cjk-segmenter.js";
import type { CompressedObservation } from "../src/types.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

function textObs(
  id: string,
  title: string,
  timestamp = "2026-10-01T00:00:00.000Z",
  sessionId = "ses_1",
): CompressedObservation {
  return makeObs({
    id,
    title,
    timestamp,
    sessionId,
    type: "other",
    subtitle: "",
    narrative: "",
    facts: [],
    concepts: [],
    files: [],
  });
}

const corpus = [
  textObs("obs_a", "red red db"),
  textObs("obs_b", "redwood database database"),
  textObs("obs_c", "blue db database"),
  textObs("obs_d", "red red red redwood blue"),
];

const corpusScores: Array<Record<string, Array<[string, number]>>> = [
  {
    red: [
      ["obs_d", 1.321600624267629],
      ["obs_a", 0.9838218046657289],
      ["obs_b", 0.36307709457901904],
    ],
    db: [
      ["obs_c", 1.2344621215686646],
      ["obs_a", 0.7261541891580381],
      ["obs_b", 0.6886752632660101],
    ],
    "red db": [
      ["obs_a", 1.7099759938237669],
      ["obs_d", 1.321600624267629],
      ["obs_c", 1.2344621215686646],
      ["obs_b", 1.0517523578450292],
    ],
  },
  {
    red: [
      ["obs_d", 0.9063755140016154],
      ["obs_a", 0.6733075246869145],
      ["obs_b", 0.2495881341511838],
    ],
    db: [["obs_a", 1.041708310095213], ["obs_b", 0.9835664509271079]],
    "red db": [
      ["obs_a", 1.7150158347821274],
      ["obs_b", 1.2331545850782917],
      ["obs_d", 0.9063755140016154],
    ],
  },
  {
    red: [["obs_d", 1.695190456238647], ["obs_b", 0.2559425703813412]],
    db: [["obs_a", 0.5170039921703091], ["obs_b", 0.4793414496943264]],
    "red db": [
      ["obs_d", 1.695190456238647],
      ["obs_b", 0.7352840200756676],
      ["obs_a", 0.5170039921703091],
    ],
  },
];

const v2Snapshot = {
  v: 2,
  entries: [
    ["obs_a", { obsId: "obs_a", sessionId: "ses_1", termCount: 4 }],
    ["obs_b", { obsId: "obs_b", sessionId: "ses_1", termCount: 4 }],
    ["obs_c", { obsId: "obs_c", sessionId: "ses_1", termCount: 4 }],
    ["obs_d", { obsId: "obs_d", sessionId: "ses_1", termCount: 6 }],
  ],
  inverted: [
    ["red", ["obs_a", "obs_d"]],
    ["db", ["obs_a", "obs_c"]],
    ["other", ["obs_a", "obs_b", "obs_c", "obs_d"]],
    ["redwood", ["obs_b", "obs_d"]],
    ["databas", ["obs_b", "obs_c"]],
    ["blue", ["obs_c", "obs_d"]],
  ],
  docTerms: [
    ["obs_a", [["red", 2], ["db", 1], ["other", 1]]],
    ["obs_b", [["redwood", 1], ["databas", 2], ["other", 1]]],
    ["obs_c", [["blue", 1], ["db", 1], ["databas", 1], ["other", 1]]],
    ["obs_d", [["red", 3], ["redwood", 1], ["blue", 1], ["other", 1]]],
  ],
  totalDocLength: 18,
};

function expectCorpusScores(index: SearchIndex, phase: number): void {
  for (const [query, expected] of Object.entries(corpusScores[phase])) {
    const results = index.search(query);
    expect(results.map(({ obsId }) => obsId)).toEqual(expected.map(([id]) => id));
    results.forEach((result, i) => {
      expect(result.sessionId).toBe("ses_1");
      expect(result.score).toBeCloseTo(expected[i][1], 13);
    });
  }
  expect(index.search("red red db db")).toEqual(index.search("red db"));
}

interface TestEntry {
  obsId: string;
  timestamp: number;
  terms: string[];
  heapIndex?: number;
}

function internals(index: SearchIndex) {
  return index as unknown as {
    entries: Map<string, TestEntry>;
    invertedIndex: Map<string, Map<string, number>>;
    observationHeap: TestEntry[];
  };
}

function expectHeap(index: SearchIndex, ids: string[]): void {
  const { entries, observationHeap } = internals(index);
  expect(index.observationCount).toBe(ids.length);
  expect(observationHeap).toHaveLength(ids.length);
  expect(observationHeap.length).toBeLessThanOrEqual(index.observationLimit);
  expect(observationHeap.map(({ obsId }) => obsId).sort()).toEqual([...ids].sort());
  observationHeap.forEach((entry, position) => {
    expect(entry).toBe(entries.get(entry.obsId));
    expect(entry.heapIndex).toBe(position);
    if (position > 0) {
      const parent = observationHeap[(position - 1) >>> 1];
      expect(parent.timestamp).toBeLessThanOrEqual(entry.timestamp);
      if (parent.timestamp === entry.timestamp) {
        expect(parent.obsId <= entry.obsId).toBe(true);
      }
    }
  });
}

describe("SearchIndex", () => {
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex();
  });

  it("counts memory and lesson documents apart from observations", () => {
    index.add(makeObs({ id: "obs_1" }));
    index.add(makeObs({ id: "mem_1", sessionId: "memory" }));
    index.add(makeObs({ id: "mem_2", sessionId: "ses_1" }));
    index.add(makeObs({ id: "lsn_1", sessionId: "lesson" }));

    expect(index.documentKindCounts()).toEqual({ memories: 2, lessons: 1 });
  });

  it("matches precomputed BM25 scores for repeats, prefixes, synonyms, removals and updates", () => {
    corpus.forEach((obs) => index.add(obs));
    expectCorpusScores(index, 0);
    index.remove("obs_c");
    expectCorpusScores(index, 1);
    index.add(textObs("obs_a", "blue database database database"));
    expectCorpusScores(index, 2);
  });

  it("stores frequencies only in postings and unique shared terms on entries", () => {
    corpus.forEach((obs) => index.add(obs));
    const { entries, invertedIndex } = internals(index);
    expect(index).not.toHaveProperty("docTermCounts");
    expect(invertedIndex.get("red")).toBeInstanceOf(Map);
    expect([...invertedIndex.get("red")!]).toEqual([["obs_a", 2], ["obs_d", 3]]);
    expect(entries.get("obs_a")!.terms).toEqual(["red", "db", "other"]);
    for (const entry of entries.values()) {
      expect(new Set(entry.terms).size).toBe(entry.terms.length);
      for (const term of entry.terms) expect(invertedIndex.get(term)?.has(entry.obsId)).toBe(true);
    }
  });

  describe("snapshots and ownership", () => {
    it("migrates a fixed v2 snapshot without losing term frequencies or removal data", () => {
      const restored = SearchIndex.deserialize(JSON.stringify(v2Snapshot));
      expect(restored.size).toBe(4);
      expect(restored.observationCount).toBe(4);
      expectCorpusScores(restored, 0);
      const migrated = JSON.parse(restored.serialize());
      expect(migrated.v).toBe(3);
      expect(migrated).not.toHaveProperty("docTerms");
      expect(migrated.inverted).toContainEqual(["red", [["obs_a", 2], ["obs_d", 3]]]);
      restored.remove("obs_c");
      expectCorpusScores(restored, 1);
      restored.add(textObs("obs_a", "blue database database database"));
      expectCorpusScores(restored, 2);
    });

    it("round-trips v3 scores, timestamps, counts and unique term arrays", () => {
      corpus.forEach((obs) => index.add(obs));
      const snapshot = JSON.parse(index.serialize());
      expect(snapshot.v).toBe(3);
      expect(snapshot.entries[0][1]).toEqual({
        obsId: "obs_a",
        sessionId: "ses_1",
        termCount: 4,
        terms: ["red", "db", "other"],
        timestamp: Date.parse(corpus[0].timestamp),
      });
      expect(snapshot.entries[0][1]).not.toHaveProperty("heapIndex");
      expect(snapshot).not.toHaveProperty("docTerms");
      const restored = SearchIndex.deserialize(JSON.stringify(snapshot));
      expect([...restored.keys()]).toEqual(corpus.map(({ id }) => id));
      expect(restored.observationCount).toBe(4);
      expectCorpusScores(restored, 0);
      restored.remove("obs_c");
      expectCorpusScores(restored, 1);
      restored.add(textObs("obs_a", "blue database database database"));
      expectCorpusScores(restored, 2);
      expectCorpusScores(index, 0);
    });

    it("owns restored entries, term arrays, postings and heap independently", () => {
      const source = new SearchIndex({ maxObservations: 4 });
      corpus.forEach((obs) => source.add(obs));
      const restored = new SearchIndex({ maxObservations: 4 });
      restored.add(textObs("obs_previous", "obsolete"));
      restored.restoreFrom(source);
      expect(restored.has("obs_previous")).toBe(false);
      expectCorpusScores(restored, 0);
      for (const [id, entry] of internals(source).entries) {
        expect(internals(restored).entries.get(id)).not.toBe(entry);
        expect(internals(restored).entries.get(id)!.terms).not.toBe(entry.terms);
      }
      for (const [term, postings] of internals(source).invertedIndex) {
        expect(internals(restored).invertedIndex.get(term)).not.toBe(postings);
      }
      expect(internals(restored).observationHeap).not.toBe(internals(source).observationHeap);
      restored.restoreFrom(restored);
      expectCorpusScores(restored, 0);
      restored.remove("obs_c");
      expectCorpusScores(restored, 1);
      expectCorpusScores(source, 0);
      source.clear();
      restored.add(textObs("obs_a", "blue database database database"));
      expectCorpusScores(restored, 2);
      expectHeap(restored, ["obs_a", "obs_b", "obs_d"]);
    });

    it.each(["not json", "null", "{}", '{"v":4,"entries":[],"inverted":[]}'])(
      "returns an empty usable index for an unreadable snapshot: %s",
      (snapshot) => {
        const restored = SearchIndex.deserialize(snapshot);
        expect(restored.size).toBe(0);
        expect(restored.observationCount).toBe(0);
        expect(restored.add(corpus[0])).toBe(true);
      },
    );
  });

  describe("observation window", () => {
    it("defaults to unlimited and preserves memory, lesson and session counts", () => {
      corpus.forEach((obs) => index.add(obs));
      index.add(textObs("mem_1", "permanent", undefined, "ses_1"));
      index.add(textObs("mem_2", "permanent", undefined, "lesson"));
      index.add(textObs("lsn_1", "permanent", undefined, "lesson"));
      index.add(textObs("obs_lesson", "permanent", undefined, "lesson"));
      expect(index.observationLimit).toBe(Infinity);
      expect(index.observationCount).toBe(4);
      expect(index.size).toBe(8);
      expect(internals(index).observationHeap).toEqual([]);
      expect(index.documentKindCounts()).toEqual({ memories: 2, lessons: 2 });
      expect(index.observationCountsBySession()).toEqual(new Map([["ses_1", 4], ["lesson", 2]]));
      expect(index.sessionOf("obs_lesson")).toBe("lesson");
    });

    it.each([-1, 0.5, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
      "rejects an invalid observation limit: %s",
      (maxObservations) => expect(() => new SearchIndex({ maxObservations })).toThrow(RangeError),
    );

    it("supports a zero window and reports rejected incoming observations only", () => {
      const onEvict = vi.fn();
      const bounded = new SearchIndex({ maxObservations: 0, onEvict });
      expect(bounded.add(corpus[0])).toBe(false);
      expect(bounded.add(corpus[1])).toBe(false);
      expect(bounded.add(textObs("mem_1", "permanent"))).toBe(true);
      expect(bounded.add(textObs("lsn_1", "permanent", undefined, "lesson"))).toBe(true);
      expect(bounded.add(textObs("obs_lesson", "permanent", undefined, "lesson"))).toBe(true);
      expect([...bounded.keys()]).toEqual(["mem_1", "lsn_1", "obs_lesson"]);
      expectHeap(bounded, []);
      bounded.remove("mem_1");
      bounded.remove("obs_missing");
      bounded.clear();
      expect(onEvict.mock.calls).toEqual([["obs_a"], ["obs_b"]]);
    });

    it("retains the newest timestamp and id regardless of boot insertion order", () => {
      const observations = [
        textObs("obs_a", "oldest", "2026-10-01T00:00:00Z"),
        textObs("obs_b", "newest", "2026-10-03T00:00:00Z"),
        textObs("obs_c", "middle", "2026-10-02T00:00:00Z"),
        textObs("obs_d", "newest", "2026-10-03T00:00:00Z"),
        textObs("obs_e", "oldest", "2026-09-01T00:00:00Z"),
        textObs("obs_f", "middle", "2026-10-02T00:00:00Z"),
      ];
      for (let offset = 0; offset < observations.length; offset++) {
        const order = [...observations.slice(offset), ...observations.slice(0, offset)];
        if (offset % 2) order.reverse();
        const onEvict = vi.fn();
        const bounded = new SearchIndex({ maxObservations: 3, onEvict });
        bounded.add(textObs("mem_1", "permanent"));
        bounded.add(textObs("lsn_1", "permanent", undefined, "lesson"));
        bounded.add(textObs("obs_lesson", "permanent", undefined, "lesson"));
        for (const obs of order) bounded.add(obs);
        expect([...bounded.keys()].sort()).toEqual([
          "lsn_1", "mem_1", "obs_b", "obs_d", "obs_f", "obs_lesson",
        ]);
        expectHeap(bounded, ["obs_b", "obs_d", "obs_f"]);
        expect(onEvict.mock.calls.flat().sort()).toEqual(["obs_a", "obs_c", "obs_e"]);
        expect(bounded.documentKindCounts()).toEqual({ memories: 1, lessons: 2 });
        expect(bounded.observationCountsBySession()).toEqual(
          new Map([["ses_1", 3], ["lesson", 2]]),
        );
      }
    });

    it("orders actual instants rather than timestamp spellings", () => {
      const onEvict = vi.fn();
      const bounded = new SearchIndex({ maxObservations: 1, onEvict });
      bounded.add(textObs("obs_offset", "offset", "2026-10-01T02:00:00+02:00"));
      bounded.add(textObs("obs_utc", "utc", "2026-10-01T00:30:00Z"));
      expect([...bounded.keys()]).toEqual(["obs_utc"]);
      expect(onEvict.mock.calls).toEqual([["obs_offset"]]);
    });

    it("reorders updates and frees heap slots on explicit removes and kind changes", () => {
      const onEvict = vi.fn();
      const bounded = new SearchIndex({ maxObservations: 3, onEvict });
      const obs = (id: string, time: number) => textObs(id, id, new Date(time).toISOString());
      bounded.add(obs("obs_a", 10));
      bounded.add(obs("obs_b", 20));
      bounded.add(obs("obs_c", 30));
      bounded.add(obs("obs_a", 40));
      expect(onEvict).not.toHaveBeenCalled();
      bounded.add(obs("obs_d", 25));
      expect(bounded.has("obs_b")).toBe(false);
      bounded.add(obs("obs_c", 0));
      bounded.add(obs("obs_e", 10));
      expect(bounded.has("obs_c")).toBe(false);
      bounded.remove("obs_d");
      bounded.add(obs("obs_f", 0));
      expectHeap(bounded, ["obs_a", "obs_e", "obs_f"]);
      bounded.add({ ...obs("obs_f", 0), sessionId: "lesson" });
      expectHeap(bounded, ["obs_a", "obs_e"]);
      bounded.add(obs("obs_f", 0));
      expectHeap(bounded, ["obs_a", "obs_e", "obs_f"]);
      expect(bounded.documentKindCounts()).toEqual({ memories: 0, lessons: 0 });
      expect(onEvict.mock.calls).toEqual([["obs_b"], ["obs_c"]]);
    });

    it("keeps heap and postings bounded through repeated insert, reject, update and delete churn", () => {
      const onEvict = vi.fn();
      const bounded = new SearchIndex({ maxObservations: 7, onEvict });
      bounded.add(textObs("mem_1", "permanent"));
      bounded.add(textObs("lsn_1", "permanent", undefined, "lesson"));
      const resident = new Map<string, CompressedObservation>();
      const evicted: string[] = [];
      let seed = 12;
      const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
      for (let step = 0; step < 800; step++) {
        const id = `obs_${random() % 23}`;
        if (random() % 4 === 0) {
          resident.delete(id);
          bounded.remove(id);
        } else {
          const incoming = textObs(id, `unique_${step}`, new Date(random() % 1000).toISOString());
          resident.set(id, incoming);
          const ordered = [...resident.values()].sort((a, b) =>
            Date.parse(b.timestamp) - Date.parse(a.timestamp) || (a.id < b.id ? 1 : -1),
          );
          if (ordered.length > 7) {
            const oldest = ordered[ordered.length - 1].id;
            resident.delete(oldest);
            evicted.push(oldest);
          }
          expect(bounded.add(incoming)).toBe(resident.has(id));
        }
        expectHeap(bounded, [...resident.keys()]);
        expect([...bounded.keys()].sort()).toEqual(["mem_1", "lsn_1", ...resident.keys()].sort());
        const { entries, invertedIndex } = internals(bounded);
        expect(invertedIndex.size).toBeLessThanOrEqual(resident.size + 2);
        for (const postings of invertedIndex.values()) {
          for (const postingId of postings.keys()) expect(entries.has(postingId)).toBe(true);
        }
      }
      expect(onEvict.mock.calls.flat()).toEqual(evicted);
      bounded.clear();
      expectHeap(bounded, []);
      expect(internals(bounded).invertedIndex.size).toBe(0);
      expect(bounded.add(textObs("obs_reset", "reset", "1970-01-01T00:00:00Z"))).toBe(true);
      expectHeap(bounded, ["obs_reset"]);
      expect(onEvict.mock.calls.flat()).toEqual(evicted);
    });

    it("applies the receiver window to v3 entries using persisted timestamps", () => {
      const sourceEvictions = vi.fn();
      const source = new SearchIndex({ maxObservations: 3, onEvict: sourceEvictions });
      source.add(textObs("obs_new", "new", "2026-10-03T00:00:00Z"));
      source.add(textObs("obs_old", "old", "2026-10-01T00:00:00Z"));
      source.add(textObs("mem_1", "permanent"));
      source.add(textObs("lsn_1", "permanent", undefined, "lesson"));
      source.add(textObs("obs_mid", "middle", "2026-10-02T00:00:00Z"));
      const snapshot = source.serialize();
      for (const [, entry] of JSON.parse(snapshot).entries) {
        expect(entry).not.toHaveProperty("heapIndex");
      }
      const onEvict = vi.fn();
      const bounded = new SearchIndex({ maxObservations: 2, onEvict });
      bounded.restoreFrom(SearchIndex.deserialize(snapshot));
      expect(bounded.observationLimit).toBe(2);
      expectHeap(bounded, ["obs_mid", "obs_new"]);
      expect([...bounded.keys()].sort()).toEqual(["lsn_1", "mem_1", "obs_mid", "obs_new"]);
      expect(bounded.documentKindCounts()).toEqual({ memories: 1, lessons: 1 });
      expect(bounded.observationCountsBySession()).toEqual(
        new Map([["ses_1", 2], ["lesson", 1]]),
      );
      expect(bounded.search("old")).toEqual([]);
      expect(bounded.add(textObs("obs_rejected", "rejected", "2026-10-01T00:00:00Z"))).toBe(false);
      expect(onEvict.mock.calls).toEqual([["obs_old"], ["obs_rejected"]]);
      expect(sourceEvictions).not.toHaveBeenCalled();
      expect(source.observationCount).toBe(3);
      expect(source.has("obs_old")).toBe(true);
    });

    it("builds cap bookkeeping for timestamp-less v2 entries without source text", () => {
      const onEvict = vi.fn();
      const bounded = new SearchIndex({ maxObservations: 2, onEvict });
      bounded.restoreFrom(SearchIndex.deserialize(JSON.stringify(v2Snapshot)));
      expectHeap(bounded, ["obs_c", "obs_d"]);
      expect(bounded.search("red").map(({ obsId }) => obsId)).toEqual(["obs_d"]);
      bounded.add(textObs("obs_new", "new"));
      expectHeap(bounded, ["obs_d", "obs_new"]);
      expect(onEvict.mock.calls).toEqual([["obs_a"], ["obs_b"], ["obs_c"]]);
      bounded.remove("obs_d");
      expect(bounded.search("red")).toEqual([]);
      expectHeap(bounded, ["obs_new"]);
    });
  });

  it("starts empty", () => {
    expect(index.size).toBe(0);
  });

  it("adds and finds observations", () => {
    index.add(makeObs());
    expect(index.size).toBe(1);
    const results = index.search("auth");
    expect(results.length).toBe(1);
    expect(results[0].obsId).toBe("obs_1");
  });

  it("returns empty for no matches", () => {
    index.add(makeObs());
    expect(index.search("database")).toEqual([]);
  });

  it("scores exact matches higher than prefix matches", () => {
    index.add(
      makeObs({
        id: "obs_exact",
        title: "redis cache",
        narrative: "Set up redis caching layer",
        concepts: ["redis"],
        facts: ["Added redis"],
        files: ["src/redis.ts"],
      }),
    );
    index.add(
      makeObs({
        id: "obs_prefix",
        title: "redistool handler",
        narrative: "Set up redistool for ops",
        concepts: ["redistool"],
        facts: ["Added redistool"],
        files: ["src/redistool.ts"],
      }),
    );
    const results = index.search("redis");
    const exact = results.find((r) => r.obsId === "obs_exact");
    const prefix = results.find((r) => r.obsId === "obs_prefix");
    expect(exact).toBeDefined();
    expect(prefix).toBeDefined();
    expect(exact!.score).toBeGreaterThanOrEqual(prefix!.score);
  });

  it("respects limit", () => {
    for (let i = 0; i < 30; i++) {
      index.add(makeObs({ id: `obs_${i}`, title: `auth feature ${i}` }));
    }
    expect(index.search("auth", 5).length).toBe(5);
  });

  it("clears the index", () => {
    index.add(makeObs());
    index.clear();
    expect(index.size).toBe(0);
    expect(index.search("auth")).toEqual([]);
  });

  // Regression coverage: deleted docs must not keep occupying result
  // slots after remove(). Without remove(), a limit-capped search can
  // return fewer live results than requested because the slot is held
  // by a doc that no longer exists in storage.
  describe("remove", () => {
    it("drops a removed doc from search results", () => {
      index.add(makeObs({ id: "obs_a", title: "jose for JWT" }));
      index.add(
        makeObs({ id: "obs_b", title: "JWT tokens expire after 30 minutes" }),
      );
      expect(index.search("jose jwt", 1)[0].obsId).toBe("obs_a");

      index.remove("obs_a");

      // With limit=1, the survivor must now surface instead of getting
      // masked by the deleted doc's slot.
      const after = index.search("jose jwt", 1);
      expect(after).toHaveLength(1);
      expect(after[0].obsId).toBe("obs_b");
      expect(index.size).toBe(1);
    });

    it("is a no-op for unknown ids", () => {
      index.add(makeObs({ id: "obs_a" }));
      expect(() => index.remove("does_not_exist")).not.toThrow();
      expect(index.size).toBe(1);
      expect(index.search("auth")).toHaveLength(1);
    });

    it("cleans up empty posting lists and the prefix cache", () => {
      // unique_concept_xyz appears only in obs_a. After removing obs_a,
      // a prefix search for "unique_" must NOT surface it from the
      // sortedTerms cache.
      index.add(
        makeObs({
          id: "obs_a",
          concepts: ["unique_concept_xyz"],
        }),
      );
      index.add(makeObs({ id: "obs_b", title: "completely different" }));
      // Prime the sortedTerms cache.
      expect(index.search("unique_")).toHaveLength(1);

      index.remove("obs_a");

      expect(index.search("unique_concept_xyz")).toEqual([]);
      expect(index.search("unique_")).toEqual([]);
    });

    it("keeps scoring consistent after add/remove/add cycles", () => {
      // totalDocLength bookkeeping desync would skew BM25 normalization
      // (docLen / avgDocLen). Round-trip add → remove → re-add and
      // confirm size + retrievability hold.
      const obs = makeObs({ id: "obs_a" });
      index.add(obs);
      expect(index.size).toBe(1);
      index.remove("obs_a");
      expect(index.size).toBe(0);
      index.add(obs);
      expect(index.size).toBe(1);
      expect(index.search("auth")[0].obsId).toBe("obs_a");
    });

    it("survives serialize/deserialize after removes", () => {
      index.add(makeObs({ id: "obs_a", title: "alpha doc" }));
      index.add(makeObs({ id: "obs_b", title: "beta doc" }));
      index.remove("obs_a");

      const restored = SearchIndex.deserialize(index.serialize());
      expect(restored.size).toBe(1);
      expect(restored.search("alpha")).toEqual([]);
      expect(restored.search("beta")).toHaveLength(1);
    });
  });

  it("returns empty for empty query", () => {
    index.add(makeObs());
    expect(index.search("")).toEqual([]);
  });

  it("searches across multiple fields", () => {
    index.add(
      makeObs({ id: "obs_file", title: "something", files: ["auth.ts"] }),
    );
    expect(index.search("auth").length).toBe(1);
  });

  it("handles multiple query terms", () => {
    index.add(
      makeObs({
        id: "obs_both",
        title: "redis cache",
        narrative: "Set up redis and cache layer",
        concepts: ["redis", "cache"],
        facts: ["Added caching"],
        files: ["src/cache.ts"],
      }),
    );
    index.add(
      makeObs({
        id: "obs_one",
        title: "redis only",
        narrative: "Set up redis connection",
        concepts: ["redis"],
        facts: ["Added redis"],
        files: ["src/redis.ts"],
      }),
    );
    const results = index.search("redis cache");
    expect(results[0].obsId).toBe("obs_both");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("indexes and finds non-ASCII (Greek) text", () => {
    index.add(
      makeObs({
        id: "obs_greek",
        title: "Προβολή μνήμης",
        narrative: "Δοκιμάζουμε αναζήτηση σε ελληνικά",
        concepts: ["δοκιμή", "μνήμη"],
      }),
    );
    const results = index.search("μνήμη");
    expect(results.length).toBe(1);
    expect(results[0].obsId).toBe("obs_greek");
  });

  it("tokenizes mixed ASCII and non-ASCII (Greek) queries", () => {
    index.add(
      makeObs({
        id: "obs_mixed",
        title: "JWT middleware ρύθμιση",
        narrative: "Configured JWT with ελληνικά σχόλια",
        concepts: ["auth", "jwt", "ρύθμιση"],
      }),
    );
    const results = index.search("JWT ρύθμιση");
    expect(results.length).toBe(1);
    expect(results[0].obsId).toBe("obs_mixed");
  });

  it("segments Chinese (Han) text into words", () => {
    index.add(
      makeObs({
        id: "obs_zh",
        title: "项目记忆存储",
        narrative: "我们正在测试中文分词",
        concepts: ["项目", "记忆"],
      }),
    );
    const results = index.search("项目");
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.obsId === "obs_zh");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("segments Japanese (kana + kanji) text into words", () => {
    index.add(
      makeObs({
        id: "obs_ja",
        title: "プロジェクト記憶",
        narrative: "日本語の分かち書きをテストしています",
        concepts: ["プロジェクト", "記憶"],
      }),
    );
    const results = index.search("プロジェクト");
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.obsId === "obs_ja");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("segments Korean (Hangul) syllable blocks into words", () => {
    index.add(
      makeObs({
        id: "obs_ko",
        title: "프로젝트 메모리 저장소",
        narrative: "한국어 검색을 테스트합니다",
        concepts: ["프로젝트", "메모리"],
      }),
    );
    const results = index.search("메모리");
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((r) => r.obsId === "obs_ko");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("preserves source order across mixed CJK and non-CJK runs", () => {
    expect(segmentCjk("hello 项目 world")).toEqual(["hello", "项目", "world"]);
    expect(segmentCjk("abc 메모리 def 项目 ghi")).toEqual([
      "abc",
      "메모리",
      "def",
      "项目",
      "ghi",
    ]);
    expect(segmentCjk("leading 项目")).toEqual(["leading", "项目"]);
    expect(segmentCjk("项目 trailing")).toEqual(["项目", "trailing"]);
  });
});
