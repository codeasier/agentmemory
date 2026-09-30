// Pass byteOffset + byteLength explicitly so the round-trip survives
// Node's Buffer pool. Buffer.from(b64, "base64") returns a slice of a
// shared 8KB pool (poolSize), and `new Float32Array(buf.buffer)` ignores
// the slice metadata — it would mint a 2048-element view over the whole
// pool. Same risk on the encode side if the input Float32Array is itself
// a sliced view. Reported as a phantom "2048 dimensions on disk" crash
// in #455 / #469 / #584 / #587.
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

// Node 22 has no DataView.setFloat16. IEEE-754 binary16, little-endian,
// matching the evidence script (numpy float16) well enough that a 1024-d
// cosine round-trip stays at 1.0 on real embeddings.
function float32ToFloat16Bits(value: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const frac = x & 0x7fffff;
  if (exp === 0xff) {
    return sign | 0x7c00 | (frac ? 0x200 : 0);
  }
  if (exp === 0) {
    if (frac === 0) return sign;
    let m = frac;
    let e = -14;
    while ((m & 0x800000) === 0) {
      m <<= 1;
      e -= 1;
    }
    m &= 0x7fffff;
    if (e < -24) return sign;
    if (e < -14) {
      const shift = -14 - e;
      return sign | (m >> (13 + shift));
    }
    return sign | (((e + 15) << 10) + (m >> 13));
  }
  const unb = exp - 127;
  if (unb > 15) return sign | 0x7c00;
  if (unb < -14) {
    if (unb < -24) return sign;
    const shift = -14 - unb;
    return sign | (((frac | 0x800000) >> (13 + shift)) & 0x3ff);
  }
  return sign | (((unb + 15) << 10) + (frac >> 13) + ((frac >> 12) & 1));
}

function float16BitsToFloat32(h: number): number {
  const sign = (h & 0x8000) << 16;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  let bits: number;
  if (exp === 0) {
    if (frac === 0) {
      bits = sign;
    } else {
      let m = frac;
      let e = -14;
      while ((m & 0x400) === 0) {
        m <<= 1;
        e -= 1;
      }
      m &= 0x3ff;
      bits = sign | ((e + 127) << 23) | (m << 13);
    }
  } else if (exp === 0x1f) {
    bits = sign | 0x7f800000 | (frac << 13);
  } else {
    bits = sign | ((exp - 15 + 127) << 23) | (frac << 13);
  }
  const u32 = new Uint32Array(1);
  u32[0] = bits;
  return new Float32Array(u32.buffer)[0];
}

export function float32ToFloat16Base64(arr: Float32Array): string {
  const out = Buffer.allocUnsafe(arr.length * 2);
  for (let i = 0; i < arr.length; i++) {
    out.writeUInt16LE(float32ToFloat16Bits(arr[i]), i * 2);
  }
  return out.toString("base64");
}

export function base64ToFloat16AsFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const n = buf.byteLength >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = float16BitsToFloat32(buf.readUInt16LE(i * 2));
  }
  return out;
}

export function decodePersistedEmbedding(b64: string, codec?: string): Float32Array {
  if (codec === "f16") return base64ToFloat16AsFloat32(b64);
  return base64ToFloat32(b64);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export type VectorEntry = { embedding: Float32Array; sessionId: string };

export class VectorIndex {
  private vectors: Map<string, VectorEntry> = new Map();
  private changes: Map<string, boolean> = new Map();

  add(obsId: string, sessionId: string, embedding: Float32Array): void {
    this.vectors.set(obsId, { embedding, sessionId });
    this.changes.set(obsId, true);
  }

  remove(obsId: string): void {
    if (this.vectors.delete(obsId)) this.changes.set(obsId, false);
  }

  has(obsId: string): boolean {
    return this.vectors.has(obsId);
  }

  get(obsId: string): VectorEntry | undefined {
    return this.vectors.get(obsId);
  }

  entries(): IterableIterator<[string, VectorEntry]> {
    return this.vectors.entries();
  }

  loadPersisted(obsId: string, sessionId: string, embedding: Float32Array): void {
    this.vectors.set(obsId, { embedding, sessionId });
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
    for (const obsId of this.vectors.keys()) this.changes.set(obsId, false);
    this.vectors.clear();
  }

  restoreFrom(other: VectorIndex): void {
    const src = (other as any).vectors as Map<
      string,
      { embedding: Float32Array; sessionId: string }
    >;
    this.vectors = new Map();
    for (const [obsId, entry] of src) {
      this.vectors.set(obsId, {
        embedding: new Float32Array(entry.embedding),
        sessionId: entry.sessionId,
      });
    }
    this.changes = new Map(other.changes);
  }

  serialize(): string {
    const data: Array<[string, { embedding: string; sessionId: string }]> = [];
    for (const [obsId, entry] of this.vectors) {
      data.push([
        obsId,
        {
          embedding: float32ToBase64(entry.embedding),
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
          embedding: base64ToFloat32(entry.embedding),
          sessionId: entry.sessionId,
        });
      } catch {
        continue;
      }
    }
    return idx;
  }
}
