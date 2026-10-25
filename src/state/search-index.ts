import type { CompressedObservation } from "../types.js";
import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";
import { segmentCjk, hasCjk } from "./cjk-segmenter.js";

interface IndexEntry {
  obsId: string;
  sessionId: string;
  termCount: number;
  terms: string[];
  timestamp: number;
  heapIndex?: number;
}

interface SearchIndexOptions {
  maxObservations?: number;
  onEvict?: (id: string) => void;
}

class TermPostings extends Map<string, number> {
  constructor(readonly term: string) {
    super();
  }
}

export class SearchIndex {
  private entries: Map<string, IndexEntry> = new Map();
  private invertedIndex: Map<string, TermPostings> = new Map();
  private totalDocLength = 0;
  private sortedTerms: string[] | null = null;
  private observationHeap: IndexEntry[] = [];
  private indexedObservations = 0;
  private readonly onEvict?: (id: string) => void;
  readonly observationLimit: number;

  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(options: SearchIndexOptions = {}) {
    const limit = options.maxObservations ?? Infinity;
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new RangeError(
        "maxObservations must be a non-negative safe integer or Infinity",
      );
    }
    this.observationLimit = limit;
    this.onEvict = options.onEvict;
  }

  add(obs: CompressedObservation): boolean {
    const terms = this.extractTerms(obs);
    const termFreq = new Map<string, number>();

    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }

    return this.insertEntry(
      {
        obsId: obs.id,
        sessionId: obs.sessionId,
        termCount: terms.length,
        terms: [],
        timestamp: SearchIndex.timestampOf(obs.timestamp),
      },
      termFreq,
    );
  }

  acceptsObservation(obs: Pick<CompressedObservation, "id" | "timestamp" | "sessionId">): boolean {
    if (this.entries.has(obs.id)) return true;
    if (!obs.id.startsWith("obs_") || obs.sessionId === "lesson") return true;
    if (this.indexedObservations < this.observationLimit) return true;
    const oldest = this.observationHeap[0];
    if (!oldest) return false;
    const timestamp = SearchIndex.timestampOf(obs.timestamp);
    return timestamp > oldest.timestamp || (timestamp === oldest.timestamp && obs.id > oldest.obsId);
  }

  private insertEntry(
    entry: IndexEntry,
    frequencies: Iterable<[string, number]>,
  ): boolean {
    this.remove(entry.obsId);
    const observation = this.isObservation(entry);
    let evictedId: string | undefined;
    if (observation && this.indexedObservations >= this.observationLimit) {
      const oldest = this.observationHeap[0];
      if (!oldest || this.compareObservations(entry, oldest) <= 0) {
        this.onEvict?.(entry.obsId);
        return false;
      }
      evictedId = oldest.obsId;
      this.remove(evictedId);
    }

    for (const [term, frequency] of frequencies) {
      this.addPosting(entry, term, frequency);
    }
    this.entries.set(entry.obsId, entry);
    this.totalDocLength += entry.termCount;
    if (observation) this.trackObservation(entry);
    this.sortedTerms = null;
    if (evictedId !== undefined) this.onEvict?.(evictedId);
    return true;
  }

  private addPosting(entry: IndexEntry, term: string, frequency: number): void {
    let postings = this.invertedIndex.get(term);
    if (!postings) {
      postings = new TermPostings(term);
      this.invertedIndex.set(term, postings);
    }
    if (!postings.has(entry.obsId)) entry.terms.push(postings.term);
    postings.set(entry.obsId, frequency);
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  sessionOf(id: string): string | undefined {
    return this.entries.get(id)?.sessionId;
  }

  observationCountsBySession(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (entry.obsId.startsWith("mem_")) continue;
      counts.set(entry.sessionId, (counts.get(entry.sessionId) ?? 0) + 1);
    }
    return counts;
  }

  documentKindCounts(): { memories: number; lessons: number } {
    let memories = 0;
    let lessons = 0;
    for (const entry of this.entries.values()) {
      if (entry.obsId.startsWith("mem_")) memories++;
      else if (entry.sessionId === "lesson") lessons++;
    }
    return { memories, lessons };
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    for (const term of entry.terms) {
      const postingList = this.invertedIndex.get(term);
      if (postingList) {
        postingList.delete(id);
        if (postingList.size === 0) {
          this.invertedIndex.delete(term);
        }
      }
    }

    if (this.isObservation(entry)) this.untrackObservation(entry);
    this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
    this.entries.delete(id);
    this.sortedTerms = null;
  }

  search(
    query: string,
    limit = 20,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    const rawTerms = this.tokenize(query.toLowerCase());
    if (rawTerms.length === 0) return [];

    const N = this.entries.size;
    if (N === 0) return [];
    const avgDocLen = this.totalDocLength / N;

    const queryTerms: Array<{ term: string; weight: number }> = [];
    const seen = new Set<string>();
    for (const term of rawTerms) {
      if (!seen.has(term)) {
        seen.add(term);
        queryTerms.push({ term, weight: 1.0 });
      }
      for (const syn of getSynonyms(term)) {
        if (!seen.has(syn)) {
          seen.add(syn);
          queryTerms.push({ term: syn, weight: 0.7 });
        }
      }
    }

    const scores = new Map<string, number>();
    const sorted = this.getSortedTerms();

    for (const { term, weight } of queryTerms) {
      const matchingDocs = this.invertedIndex.get(term);
      if (matchingDocs) {
        const df = matchingDocs.size;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        for (const [obsId, tf] of matchingDocs) {
          const entry = this.entries.get(obsId)!;
          const docLen = entry.termCount;

          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const bm25Score = idf * (numerator / denominator) * weight;

          scores.set(obsId, (scores.get(obsId) || 0) + bm25Score);
        }
      }

      const startIdx = this.lowerBound(sorted, term);
      for (let si = startIdx; si < sorted.length; si++) {
        const indexTerm = sorted[si];
        if (!indexTerm.startsWith(term)) break;
        if (indexTerm === term) continue;

        const obsIds = this.invertedIndex.get(indexTerm)!;
        const prefixDf = obsIds.size;
        const prefixIdf =
          Math.log((N - prefixDf + 0.5) / (prefixDf + 0.5) + 1) * 0.5;
        for (const [obsId, tf] of obsIds) {
          const entry = this.entries.get(obsId)!;
          const docLen = entry.termCount;
          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          scores.set(
            obsId,
            (scores.get(obsId) || 0) + prefixIdf * (numerator / denominator) * weight,
          );
        }
      }
    }

    return Array.from(scores.entries())
      .map(([obsId, score]) => {
        const entry = this.entries.get(obsId)!;
        return { obsId, sessionId: entry.sessionId, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  get size(): number {
    return this.entries.size;
  }

  get observationCount(): number {
    return this.indexedObservations;
  }

  clear(): void {
    this.entries.clear();
    this.invertedIndex.clear();
    this.totalDocLength = 0;
    this.sortedTerms = null;
    this.observationHeap.length = 0;
    this.indexedObservations = 0;
  }

  restoreFrom(other: SearchIndex): void {
    if (other === this) return;
    this.clear();
    for (const entry of other.entries.values()) {
      this.insertEntry(
        {
          obsId: entry.obsId,
          sessionId: entry.sessionId,
          termCount: entry.termCount,
          terms: [],
          timestamp: entry.timestamp,
        },
        other.entryFrequencies(entry),
      );
    }
  }

  private *entryFrequencies(entry: IndexEntry): IterableIterator<[string, number]> {
    for (const term of entry.terms) {
      yield [term, this.invertedIndex.get(term)!.get(entry.obsId)!];
    }
  }

  serialize(): string {
    const entries = Array.from(this.entries, ([id, entry]) => [
      id,
      {
        obsId: entry.obsId,
        sessionId: entry.sessionId,
        termCount: entry.termCount,
        terms: entry.terms,
        timestamp: entry.timestamp,
      },
    ]);
    const inverted = Array.from(this.invertedIndex.entries()).map(
      ([term, postings]) => [term, Array.from(postings)],
    );
    return JSON.stringify({
      v: 3,
      entries,
      inverted,
      totalDocLength: this.totalDocLength,
    });
  }

  static deserialize(json: string): SearchIndex {
    try {
      const idx = new SearchIndex();
      const data = JSON.parse(json);
      const legacy = data?.v === 2 || data?.v === undefined;
      if (
        (!legacy && data?.v !== 3) ||
        !Array.isArray(data?.entries) ||
        !Array.isArray(data?.inverted) ||
        (legacy && !Array.isArray(data?.docTerms))
      ) {
        return idx;
      }
      for (const [key, val] of data.entries) {
        const entry: IndexEntry = {
          obsId: key,
          sessionId: val.sessionId,
          termCount: val.termCount,
          terms: [],
          timestamp: SearchIndex.timestampOf(val.timestamp),
        };
        idx.entries.set(key, entry);
        if (idx.isObservation(entry)) idx.trackObservation(entry);
      }
      if (legacy) {
        for (const [id, counts] of data.docTerms) {
          const entry = idx.entries.get(id);
          if (!entry) continue;
          for (const [term, frequency] of counts) {
            idx.addPosting(entry, term, frequency);
          }
        }
      } else {
        for (const [term, postings] of data.inverted) {
          for (const [id, frequency] of postings) {
            const entry = idx.entries.get(id);
            if (entry) idx.addPosting(entry, term, frequency);
          }
        }
      }
      const rawLen = Number(data.totalDocLength);
      idx.totalDocLength =
        Number.isFinite(rawLen) && rawLen >= 0 ? Math.floor(rawLen) : 0;
      return idx;
    } catch {
      return new SearchIndex();
    }
  }

  private static timestampOf(value: unknown): number {
    const timestamp =
      typeof value === "number"
        ? value
        : typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private isObservation(entry: IndexEntry): boolean {
    return entry.obsId.startsWith("obs_") && entry.sessionId !== "lesson";
  }

  private compareObservations(a: IndexEntry, b: IndexEntry): number {
    return (
      a.timestamp - b.timestamp ||
      (a.obsId < b.obsId ? -1 : a.obsId > b.obsId ? 1 : 0)
    );
  }

  private trackObservation(entry: IndexEntry): void {
    this.indexedObservations++;
    if (this.observationLimit === Infinity) return;
    entry.heapIndex = this.observationHeap.length;
    this.observationHeap.push(entry);
    this.siftUp(entry.heapIndex);
  }

  private untrackObservation(entry: IndexEntry): void {
    this.indexedObservations--;
    const position = entry.heapIndex;
    if (position === undefined) return;
    const last = this.observationHeap.pop()!;
    delete entry.heapIndex;
    if (position === this.observationHeap.length) return;
    this.observationHeap[position] = last;
    last.heapIndex = position;
    this.siftDown(this.siftUp(position));
  }

  private swapObservations(a: number, b: number): void {
    const heap = this.observationHeap;
    [heap[a], heap[b]] = [heap[b], heap[a]];
    heap[a].heapIndex = a;
    heap[b].heapIndex = b;
  }

  private siftUp(position: number): number {
    const heap = this.observationHeap;
    while (position > 0) {
      const parent = (position - 1) >>> 1;
      if (this.compareObservations(heap[parent], heap[position]) <= 0) break;
      this.swapObservations(parent, position);
      position = parent;
    }
    return position;
  }

  private siftDown(position: number): void {
    const heap = this.observationHeap;
    while (position * 2 + 1 < heap.length) {
      let child = position * 2 + 1;
      if (
        child + 1 < heap.length &&
        this.compareObservations(heap[child + 1], heap[child]) < 0
      ) child++;
      if (this.compareObservations(heap[position], heap[child]) <= 0) break;
      this.swapObservations(position, child);
      position = child;
    }
  }

  private extractTerms(obs: CompressedObservation): string[] {
    const parts = [
      obs.title,
      obs.subtitle || "",
      obs.narrative,
      ...obs.facts,
      ...obs.concepts,
      ...obs.files,
      obs.type,
    ];
    return this.tokenize(parts.join(" ").toLowerCase());
  }

  private tokenize(text: string): string[] {
    const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
    const out: string[] = [];
    for (const raw of cleaned.split(/\s+/)) {
      if (raw.length < 2) continue;
      if (hasCjk(raw)) {
        for (const seg of segmentCjk(raw)) {
          if (seg.length >= 1) out.push(seg);
        }
      } else {
        out.push(stem(raw));
      }
    }
    return out;
  }

  private getSortedTerms(): string[] {
    if (!this.sortedTerms) {
      this.sortedTerms = Array.from(this.invertedIndex.keys()).sort();
    }
    return this.sortedTerms;
  }

  private lowerBound(arr: string[], target: string): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
