export function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64",
  );
}

export function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function float32BitsToFloat16Bits(x: number): number {
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const frac = x & 0x7fffff;
  if (exp === 0xff) {
    return sign | 0x7c00 | (frac ? 0x200 : 0);
  }

  const halfExp = exp - 112;
  if (halfExp >= 31) return sign | 0x7c00;

  const shift = halfExp <= 0 ? 14 - halfExp : 13;
  if (shift > 24) return sign;
  const significand = halfExp <= 0 ? frac | 0x800000 : frac;
  const truncated = significand >>> shift;
  const remainder = significand & ((1 << shift) - 1);
  const halfway = 1 << (shift - 1);
  const roundUp = remainder > halfway || (remainder === halfway && (truncated & 1) !== 0);
  const rounded = truncated + Number(roundUp);
  return sign | ((halfExp > 0 ? halfExp << 10 : 0) + rounded);
}

const float16Values = new Float32Array(0x10000);
for (let bits = 0; bits < float16Values.length; bits++) {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exp = (bits >>> 10) & 0x1f;
  const frac = bits & 0x3ff;
  const value = exp === 0
    ? frac * 2 ** -24
    : exp === 31
      ? frac === 0 ? Infinity : NaN
      : (1024 + frac) * 2 ** (exp - 25);
  float16Values[bits] = sign * value;
}

function toFloat16(arr: Float32Array): Uint16Array {
  const bits = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  const out = new Uint16Array(arr.length);
  for (let i = 0; i < out.length; i++) out[i] = float32BitsToFloat16Bits(bits[i]);
  return out;
}

function toFloat32(arr: Uint16Array): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < out.length; i++) out[i] = float16Values[arr[i]];
  return out;
}

export function float16ToBase64(arr: Uint16Array): string {
  const out = Buffer.allocUnsafe(arr.byteLength);
  for (let i = 0; i < arr.length; i++) out.writeUInt16LE(arr[i], i * 2);
  return out.toString("base64");
}

export function base64ToFloat16(b64: string): Uint16Array {
  const buf = Buffer.from(b64, "base64");
  const out = new Uint16Array(buf.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt16LE(i * 2);
  return out;
}

export function float32ToFloat16Base64(arr: Float32Array): string {
  const bits = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  const out = Buffer.allocUnsafe(arr.length * 2);
  for (let i = 0; i < arr.length; i++) {
    out.writeUInt16LE(float32BitsToFloat16Bits(bits[i]), i * 2);
  }
  return out.toString("base64");
}

export function base64ToFloat16AsFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const n = buf.byteLength >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = float16Values[buf.readUInt16LE(i * 2)];
  }
  return out;
}

export function decodePersistedEmbedding(b64: string, codec?: string): Float32Array {
  if (codec === "f16") return base64ToFloat16AsFloat32(b64);
  return base64ToFloat32(b64);
}

function cosineSimilarity(a: Float32Array, b: Uint16Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = float16Values[b[i]];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export type VectorEntry = { embedding: Float32Array; sessionId: string };

type ResidentVectorEntry = { embedding: Uint16Array; sessionId: string };

export type VectorChangeListener = (obsId: string | null, entry: VectorEntry | null) => void;

export class VectorIndex {
  private vectors: Map<string, ResidentVectorEntry> = new Map();
  private changes: Map<string, boolean> = new Map();
  private listener: VectorChangeListener | null = null;
  private mutationEpoch = 0;

  get revision(): number {
    return this.mutationEpoch;
  }

  setChangeListener(listener: VectorChangeListener | null): void {
    this.listener = listener;
  }

  add(obsId: string, sessionId: string, embedding: Float32Array): void {
    this.mutationEpoch++;
    const entry = { embedding: toFloat16(embedding), sessionId };
    this.vectors.set(obsId, entry);
    this.changes.set(obsId, true);
    this.listener?.(obsId, { embedding: toFloat32(entry.embedding), sessionId });
  }

  remove(obsId: string): void {
    this.mutationEpoch++;
    this.vectors.delete(obsId);
    this.changes.set(obsId, false);
    this.listener?.(obsId, null);
  }

  evictResident(obsId: string): void {
    this.vectors.delete(obsId);
  }

  keys(): IterableIterator<string> {
    return this.vectors.keys();
  }

  prune(keep: (id: string) => boolean): number {
    let removed = 0;
    for (const id of this.vectors.keys()) {
      if (keep(id)) continue;
      this.vectors.delete(id);
      this.changes.set(id, false);
      removed++;
    }
    return removed;
  }

  has(obsId: string): boolean {
    return this.vectors.has(obsId);
  }

  get(obsId: string): VectorEntry | undefined {
    const entry = this.vectors.get(obsId);
    return entry && { embedding: toFloat32(entry.embedding), sessionId: entry.sessionId };
  }

  getFloat16(obsId: string): Uint16Array | undefined {
    return this.vectors.get(obsId)?.embedding.slice();
  }

  *entries(): IterableIterator<[string, VectorEntry]> {
    for (const [obsId, entry] of this.vectors) {
      yield [obsId, { embedding: toFloat32(entry.embedding), sessionId: entry.sessionId }];
    }
  }

  loadPersisted(obsId: string, sessionId: string, embedding: Float32Array): void {
    this.vectors.set(obsId, { embedding: toFloat16(embedding), sessionId });
  }

  loadPersistedFloat16(obsId: string, sessionId: string, embedding: Uint16Array): void {
    this.vectors.set(obsId, { embedding: new Uint16Array(embedding), sessionId });
  }

  get residentByteLength(): number {
    let bytes = 0;
    for (const entry of this.vectors.values()) bytes += entry.embedding.byteLength;
    return bytes;
  }

  get pendingChanges(): number {
    return this.changes.size;
  }

  takeChanges(): Map<string, boolean> {
    const taken = this.changes;
    this.changes = new Map();
    return taken;
  }

  returnChanges(changes: Map<string, boolean>): void {
    for (const [obsId, present] of changes) {
      if (!this.changes.has(obsId)) this.changes.set(obsId, present);
    }
  }

  markRemoved(obsId: string): void {
    if (!this.vectors.has(obsId)) this.changes.set(obsId, false);
  }

  markAllChanged(): void {
    for (const obsId of this.vectors.keys()) this.changes.set(obsId, true);
  }

  search(
    query: Float32Array,
    limit = 20,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    const results: Array<{
      obsId: string;
      sessionId: string;
      score: number;
    }> = [];
    let minScore = -Infinity;

    for (const [obsId, entry] of this.vectors) {
      const score = cosineSimilarity(query, entry.embedding);
      if (results.length < limit) {
        results.push({ obsId, sessionId: entry.sessionId, score });
        if (results.length === limit) {
          results.sort((a, b) => a.score - b.score);
          minScore = results[0].score;
        }
      } else if (score > minScore) {
        results[0] = { obsId, sessionId: entry.sessionId, score };
        results.sort((a, b) => a.score - b.score);
        minScore = results[0].score;
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  get size(): number {
    return this.vectors.size;
  }

  // Walks every stored vector and returns the obsIds whose dimension
  // doesn't match `expected`, plus the set of distinct dimensions seen.
  // Used by the persistence-restore guard in src/index.ts to refuse
  // loading any index containing wrong-dimension vectors — including
  // legacy on-disk indexes written before the live-API dimension guard
  // existed (where a mid-session provider swap could mix dimensions
  // inside a single index). Empty `mismatches` plus a single-entry
  // `seenDimensions` matching `expected` is the only clean state.
  validateDimensions(
    expected: number,
  ): { mismatches: Array<{ obsId: string; dim: number }>; seenDimensions: Set<number> } {
    const mismatches: Array<{ obsId: string; dim: number }> = [];
    const seenDimensions = new Set<number>();
    for (const [obsId, entry] of this.vectors) {
      const dim = entry.embedding.length;
      seenDimensions.add(dim);
      if (dim !== expected) {
        mismatches.push({ obsId, dim });
      }
    }
    return { mismatches, seenDimensions };
  }

  clear(): void {
    this.mutationEpoch++;
    for (const obsId of this.changes.keys()) this.changes.set(obsId, false);
    for (const obsId of this.vectors.keys()) this.changes.set(obsId, false);
    this.vectors.clear();
    this.listener?.(null, null);
  }

  restoreFrom(other: VectorIndex): void {
    // Ingest and accessors copy, so these immutable resident arrays have no mutable aliases.
    this.vectors = new Map(other.vectors);
    this.changes = new Map(other.changes);
  }

  serialize(): string {
    const data: Array<[string, { embedding: string; sessionId: string }]> = [];
    for (const [obsId, entry] of this.vectors) {
      data.push([
        obsId,
        {
          embedding: float32ToBase64(toFloat32(entry.embedding)),
          sessionId: entry.sessionId,
        },
      ]);
    }
    return JSON.stringify(data);
  }

  static deserialize(json: string): VectorIndex {
    const idx = new VectorIndex();
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return idx;
    }
    if (!Array.isArray(data)) return idx;
    for (const row of data) {
      try {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [obsId, entry] = row;
        if (
          typeof obsId !== "string" ||
          typeof entry?.embedding !== "string" ||
          typeof entry?.sessionId !== "string"
        )
          continue;
        idx.vectors.set(obsId, {
          embedding: toFloat16(base64ToFloat32(entry.embedding)),
          sessionId: entry.sessionId,
        });
      } catch {
        continue;
      }
    }
    return idx;
  }
}
