import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  VectorIndex,
  float32ToBase64,
  base64ToFloat32,
  float32ToFloat16Base64,
  float16ToBase64,
  base64ToFloat16,
  base64ToFloat16AsFloat32,
  decodePersistedEmbedding,
} from "../src/state/vector-index.js";

function referenceCosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  return normA && normB ? dot / Math.sqrt(normA) / Math.sqrt(normB) : 0;
}

function positiveHalfValue(bits: number): number {
  if (bits < 1024) return bits / 2 ** 24;
  const exponent = Math.floor(bits / 1024);
  return (1 + (bits % 1024) / 1024) * 2 ** (exponent - 15);
}

describe("VectorIndex", () => {
  let index: VectorIndex;

  beforeEach(() => {
    index = new VectorIndex();
  });

  it("starts empty", () => {
    expect(index.size).toBe(0);
  });

  it("adds and retrieves vectors", () => {
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    expect(index.size).toBe(1);
  });

  it("removes a vector", () => {
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    index.remove("obs_1");
    expect(index.size).toBe(0);
  });

  it("returns empty array when searching empty index", () => {
    const results = index.search(new Float32Array([0.1, 0.2, 0.3]));
    expect(results).toEqual([]);
  });

  it("returns results sorted by cosine similarity", () => {
    index.add("obs_close", "ses_1", new Float32Array([1, 0, 0]));
    index.add("obs_far", "ses_1", new Float32Array([0, 1, 0]));
    index.add("obs_medium", "ses_1", new Float32Array([0.7, 0.7, 0]));

    const results = index.search(new Float32Array([1, 0, 0]));
    expect(results[0].obsId).toBe("obs_close");
    expect(results[0].score).toBeCloseTo(1.0, 5);
    expect(results[1].obsId).toBe("obs_medium");
    expect(results[2].obsId).toBe("obs_far");
    expect(results[2].score).toBeCloseTo(0.0, 5);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      index.add(`obs_${i}`, "ses_1", new Float32Array([i * 0.1, 0.5, 0.5]));
    }
    const results = index.search(new Float32Array([0.9, 0.5, 0.5]), 3);
    expect(results.length).toBe(3);
  });

  it("clears all vectors", () => {
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    index.add("obs_2", "ses_1", new Float32Array([0.4, 0.5, 0.6]));
    index.clear();
    expect(index.size).toBe(0);
    expect(index.search(new Float32Array([0.1, 0.2, 0.3]))).toEqual([]);
  });

  it("serialize and deserialize round-trip preserves data", () => {
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    index.add("obs_2", "ses_2", new Float32Array([0.4, 0.5, 0.6]));

    const json = index.serialize();
    const restored = VectorIndex.deserialize(json);

    expect(restored.size).toBe(2);
    const results = restored.search(new Float32Array([0.1, 0.2, 0.3]), 2);
    expect(results.length).toBe(2);
    expect(results[0].obsId).toBe("obs_1");
    expect(results[0].sessionId).toBe("ses_1");
  });

  it("handles zero vectors without error", () => {
    index.add("obs_zero", "ses_1", new Float32Array([0, 0, 0]));
    const results = index.search(new Float32Array([1, 0, 0]));
    expect(results[0].score).toBe(0);
  });

  it("round-trip preserves dim + identity for pooled-Buffer sizes", () => {
    // 384-dim floats = 1536 bytes, comfortably inside Node's 8KB Buffer
    // pool. Without explicit byteOffset/byteLength in the base64 round-trip,
    // deserialise reads pool offset 0 and reports the entire pool as a
    // 2048-element view, which the live index then rejects with
    // "dimensions seen on disk: 2048".
    const DIM = 384;
    const vecs = Array.from({ length: 5 }, (_, n) => {
      const v = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) v[i] = n * 1000 + i;
      return v;
    });
    vecs.forEach((v, n) => index.add(`obs_${n}`, "ses_1", v));

    const restored = VectorIndex.deserialize(index.serialize());
    expect(restored.size).toBe(5);
    const { mismatches } = restored.validateDimensions(DIM);
    expect(mismatches).toEqual([]);
    for (let n = 0; n < 5; n++) {
      const results = restored.search(vecs[n], 1);
      expect(results[0].obsId).toBe(`obs_${n}`);
      expect(results[0].score).toBeCloseTo(1.0, 4);
    }
  });

  it("preserves bytes when source Float32Array is itself a sliced view", () => {
    // The encode side has the same risk: passing arr.buffer drops the
    // slice metadata if arr is a sub-view (subarray / typedArray.set).
    const backing = new Float32Array(8);
    for (let i = 0; i < 8; i++) backing[i] = i;
    const slice = backing.subarray(2, 6); // values 2, 3, 4, 5

    index.add("obs_slice", "ses_1", slice);
    const restored = VectorIndex.deserialize(index.serialize());
    const results = restored.search(new Float32Array([2, 3, 4, 5]), 1);
    expect(results[0].obsId).toBe("obs_slice");
    expect(results[0].score).toBeCloseTo(1.0, 4);
  });

  it("float16 codec round-trips dimension and cosine identity", () => {
    const src = new Float32Array([0.1, -0.2, 0.3, 1, 0, -1, 1e-5, 3.14159]);
    const decoded = base64ToFloat16AsFloat32(float32ToFloat16Base64(src));
    expect(decoded.length).toBe(src.length);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < src.length; i++) {
      dot += src[i] * decoded[i];
      na += src[i] * src[i];
      nb += decoded[i] * decoded[i];
    }
    expect(dot / (Math.sqrt(na) * Math.sqrt(nb))).toBeGreaterThan(0.999);
  });

  it("halves the stored volume of a persisted embedding", () => {
    const src = new Float32Array(1024).fill(0.25);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin(i) / 2;
    expect(float32ToFloat16Base64(src).length).toBeLessThan(float32ToBase64(src).length * 0.55);
  });

  it("decodePersistedEmbedding keeps v3 float32 bytes and reads f16 via c=f16", () => {
    const src = new Float32Array([0.25, -0.5, 0.75]);
    const f32 = decodePersistedEmbedding(float32ToBase64(src));
    expect(Array.from(f32)).toEqual(Array.from(src));
    const f16 = decodePersistedEmbedding(float32ToFloat16Base64(src), "f16");
    expect(f16.length).toBe(3);
    expect(f16[0]).toBeCloseTo(0.25, 3);
  });

  it("owns ingested vectors and returns freshly decoded Float32 entries", () => {
    const source = new Float32Array([0.1, -0.2, 0.3]);
    const quantized = base64ToFloat16AsFloat32(float32ToFloat16Base64(source));
    index.add("obs_owned", "ses_owned", source);
    source.fill(99);

    const first = index.get("obs_owned")!;
    expect(first.embedding).toBeInstanceOf(Float32Array);
    expect(first.embedding).toEqual(quantized);
    expect(first.embedding[0]).not.toBe(Math.fround(0.1));
    first.embedding.fill(42);
    first.sessionId = "changed";

    const second = index.get("obs_owned")!;
    expect(second).not.toBe(first);
    expect(second.embedding).not.toBe(first.embedding);
    expect(second).toEqual({ embedding: quantized, sessionId: "ses_owned" });
    const [[id, iterated]] = [...index.entries()];
    expect(id).toBe("obs_owned");
    expect(iterated.embedding).toEqual(quantized);
    expect(iterated.embedding).not.toBe(second.embedding);
    iterated.embedding.fill(7);
    expect(index.get("obs_owned")!.embedding).toEqual(quantized);
    expect(index.get("missing")).toBeUndefined();
    expect(index.getFloat16("missing")).toBeUndefined();
  });

  it("copies half subviews on ingest and protects resident data from accessor mutation", () => {
    const backing = new Uint16Array([0xffff, 0x8000, 0x0001, 0x3c00, 0x7d01, 0xffff]);
    const source = backing.subarray(1, 5);
    const expected = new Uint16Array(source);
    index.loadPersistedFloat16("obs_half", "ses_half", source);
    backing.fill(0);

    const first = index.getFloat16("obs_half")!;
    expect(first).toBeInstanceOf(Uint16Array);
    expect(first).toEqual(expected);
    expect(first.buffer.byteLength).toBe(8);
    first.fill(123);
    expect(index.getFloat16("obs_half")).toEqual(expected);
    expect(index.getFloat16("obs_half")).not.toBe(first);
    const decoded = index.get("obs_half")!.embedding;
    expect(Object.is(decoded[0], -0)).toBe(true);
    expect(decoded[1]).toBe(2 ** -24);
    expect(decoded[2]).toBe(1);
    expect(decoded[3]).toBeNaN();
  });

  it("reports only two resident embedding bytes per component after reads and search", () => {
    const dimensions = 1024;
    const count = 512;
    const source = new Float32Array(dimensions).fill(0.1);
    expect(index.residentByteLength).toBe(0);
    for (let i = 0; i < count; i++) index.add(`obs_${i}`, "ses_memory", source);
    expect(index.residentByteLength).toBe(count * dimensions * 2);

    index.get("obs_0");
    for (const [, entry] of index.entries()) expect(entry.embedding.length).toBe(dimensions);
    index.search(source, 5);
    const resident: Map<string, { embedding: Uint16Array }> = Reflect.get(index, "vectors");
    for (const entry of resident.values()) {
      expect(entry.embedding).toBeInstanceOf(Uint16Array);
      expect(entry.embedding.buffer.byteLength).toBe(dimensions * 2);
      expect(Object.values(entry).filter(ArrayBuffer.isView)).toEqual([entry.embedding]);
    }
    expect(index.residentByteLength).toBe(count * source.byteLength / 2);

    index.add("obs_0", "ses_replaced", new Float32Array(3));
    expect(index.residentByteLength).toBe((count - 1) * dimensions * 2 + 6);
    index.remove("obs_0");
    expect(index.residentByteLength).toBe((count - 1) * dimensions * 2);
    index.clear();
    expect(index.residentByteLength).toBe(0);
  });

  it("notifies changes with detached Float32 values and keeps persisted loads clean", () => {
    const listener = vi.fn();
    index.setChangeListener(listener);
    const legacy = new Float32Array([0.1, 0.25, -0.5]);
    index.loadPersisted("obs_legacy", "ses_legacy", legacy);
    index.loadPersistedFloat16("obs_half", "ses_half", new Uint16Array([0x3c00]));
    legacy.fill(9);
    expect(index.pendingChanges).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(index.get("obs_legacy")!.embedding).toEqual(new Float32Array([0.0999755859375, 0.25, -0.5]));

    index.add("obs_new", "ses_new", new Float32Array([0.1, 0.5]));
    const [id, notified] = listener.mock.calls[0];
    expect(id).toBe("obs_new");
    expect(notified.sessionId).toBe("ses_new");
    expect(notified.embedding).toBeInstanceOf(Float32Array);
    expect(notified.embedding).toEqual(index.get("obs_new")!.embedding);
    notified.embedding.fill(10);
    expect(index.get("obs_new")!.embedding).toEqual(new Float32Array([0.0999755859375, 0.5]));
    expect(index.takeChanges()).toEqual(new Map([["obs_new", true]]));
    index.remove("obs_new");
    expect(listener).toHaveBeenLastCalledWith("obs_new", null);
    index.clear();
    expect(listener).toHaveBeenLastCalledWith(null, null);
  });

  it("restores without duplicating resident arrays and independently tracks later changes", () => {
    const source = new VectorIndex();
    source.add("obs_keep", "ses_source", new Float32Array([0.1, 1]));
    source.markRemoved("obs_removed");
    const borrowed = source.getFloat16("obs_keep")!;
    const listener = vi.fn();
    index.setChangeListener(listener);
    index.add("obs_old", "ses_old", new Float32Array(9));
    listener.mockClear();
    index.restoreFrom(source);

    const sourceVectors = Reflect.get(source, "vectors");
    const restoredVectors = Reflect.get(index, "vectors");
    expect(restoredVectors).not.toBe(sourceVectors);
    expect(restoredVectors.get("obs_keep").embedding).toBe(sourceVectors.get("obs_keep").embedding);
    borrowed.fill(0);
    index.getFloat16("obs_keep")!.fill(0);
    expect(index.get("obs_keep")).toEqual(source.get("obs_keep"));
    expect(index.residentByteLength).toBe(4);
    expect(index.has("obs_old")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    const changes = new Map([["obs_keep", true], ["obs_removed", false]]);
    expect(index.takeChanges()).toEqual(changes);
    expect(source.takeChanges()).toEqual(changes);

    source.add("obs_keep", "ses_replaced", new Float32Array([2, 3, 4]));
    expect(index.get("obs_keep")!.embedding).toEqual(new Float32Array([0.0999755859375, 1]));
    index.remove("obs_keep");
    expect(source.has("obs_keep")).toBe(true);
    expect(index.takeChanges()).toEqual(new Map([["obs_keep", false]]));
    index.restoreFrom(index);
    expect(index.size).toBe(0);
    expect(source.size).toBe(1);
  });

  it("recovers legacy float32 JSON and preserves its public serialization format", () => {
    const original = new Float32Array([0.1, -0, 2 ** -24, 0.75]);
    const restored = VectorIndex.deserialize(JSON.stringify([
      ["obs_legacy", { embedding: float32ToBase64(original), sessionId: "ses_legacy" }],
      ["invalid", { embedding: 5, sessionId: "ses_invalid" }],
      null,
    ]));
    expect(restored.size).toBe(1);
    expect(restored.pendingChanges).toBe(0);
    expect(restored.residentByteLength).toBe(8);
    expect(restored.getFloat16("obs_legacy")).toEqual(new Uint16Array([0x2e66, 0x8000, 1, 0x3a00]));
    const [[id, serialized]] = JSON.parse(restored.serialize());
    expect(id).toBe("obs_legacy");
    expect(serialized.sessionId).toBe("ses_legacy");
    expect(Buffer.from(serialized.embedding, "base64").byteLength).toBe(original.byteLength);
    expect(base64ToFloat32(serialized.embedding)).toEqual(restored.get("obs_legacy")!.embedding);
    expect(VectorIndex.deserialize(restored.serialize()).getFloat16("obs_legacy")).toEqual(restored.getFloat16("obs_legacy"));
    expect(VectorIndex.deserialize("not JSON").size).toBe(0);
    expect(VectorIndex.deserialize("{}").size).toBe(0);
  });

  it("keeps deterministic corpus scores bounded and preserves float32-reference top-k rankings", () => {
    let seed = 0x12345678;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 31 - 1;
    };
    const corpus = Array.from({ length: 256 }, (_, i) => ({
      obsId: `obs_${i}`,
      sessionId: `ses_${i % 7}`,
      embedding: Float32Array.from({ length: 96 }, next),
    }));
    for (const entry of corpus) index.add(entry.obsId, entry.sessionId, entry.embedding);
    const get = vi.spyOn(index, "get");
    const entries = vi.spyOn(index, "entries");
    for (let q = 0; q < 8; q++) {
      const query = q % 2 === 0 ? corpus[q].embedding : Float32Array.from({ length: 96 }, next);
      const reference = corpus.map((entry) => ({
        obsId: entry.obsId,
        sessionId: entry.sessionId,
        score: referenceCosine(query, entry.embedding),
      })).sort((a, b) => b.score - a.score);
      const actual = index.search(query, corpus.length);
      const scores = new Map(reference.map((entry) => [entry.obsId, entry.score]));
      for (const result of actual) expect(Math.abs(result.score - scores.get(result.obsId)!)).toBeLessThan(0.0002);
      const top = index.search(query, 10);
      expect(top.map(({ obsId, sessionId }) => [obsId, sessionId])).toEqual(
        reference.slice(0, 10).map(({ obsId, sessionId }) => [obsId, sessionId]),
      );
    }
    expect(get).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
  });

  it("scores half values with the original float32 query and handles dimension mismatches", () => {
    const query = new Float32Array([0.123456, -0.321987, 0.777777]);
    index.loadPersistedFloat16("obs_half", "ses_half", new Uint16Array([0x2e66, 0xb555, 0x3a00]));
    const expected = referenceCosine(query, new Float32Array([0.0999755859375, -0.333251953125, 0.75]));
    expect(index.search(query)[0].score).toBeCloseTo(expected, 14);
    expect(index.search(new Float32Array(2))[0].score).toBe(0);
    expect(index.search(new Float32Array(3))[0].score).toBe(0);
  });
});

describe("embedding codecs", () => {
  it("preserves raw float32 helper bytes including subviews and NaN payloads", () => {
    const bits = new Uint32Array([0xffffffff, 0x80000000, 0x3dcccccd, 0x7f800001, 0x7f800000, 0xffffffff]);
    const source = new Float32Array(bits.buffer).subarray(1, 5);
    const b64 = float32ToBase64(source);
    const expected = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    expect(Buffer.from(b64, "base64")).toEqual(expected);
    const recovered = base64ToFloat32(b64);
    expect(recovered.length).toBe(4);
    expect(new Uint32Array(recovered.buffer, recovered.byteOffset, recovered.length)).toEqual(bits.subarray(1, 5));
    expect(base64ToFloat32(float32ToBase64(new Float32Array()))).toHaveLength(0);
  });

  it("encodes and decodes little-endian half subviews without retaining a larger backing buffer", () => {
    const backing = new Uint16Array([0xffff, 0x3c00, 0xc000, 0x0001, 0x8000, 0x7d01, 0xffff]);
    const source = backing.subarray(1, 6);
    const expectedBytes = Buffer.from([0x00, 0x3c, 0x00, 0xc0, 0x01, 0x00, 0x00, 0x80, 0x01, 0x7d]);
    const b64 = float16ToBase64(source);
    expect(Buffer.from(b64, "base64")).toEqual(expectedBytes);
    const decoded = base64ToFloat16(expectedBytes.toString("base64"));
    expect(decoded).toEqual(source);
    expect(decoded.buffer.byteLength).toBe(source.byteLength);
    backing.fill(0);
    expect(decoded).toEqual(new Uint16Array([0x3c00, 0xc000, 1, 0x8000, 0x7d01]));
    expect(float16ToBase64(new Uint16Array())).toBe("");
    expect(base64ToFloat16("")).toHaveLength(0);
    expect(base64ToFloat16AsFloat32("")).toHaveLength(0);
  });

  it("preserves all half bit patterns in raw persistence helpers and decodes their IEEE values", () => {
    const bits = Uint16Array.from({ length: 65536 }, (_, i) => i);
    const b64 = float16ToBase64(bits);
    expect(base64ToFloat16(b64)).toEqual(bits);
    const decoded = base64ToFloat16AsFloat32(b64);
    for (let h = 0; h < bits.length; h++) {
      const magnitude = h & 0x7fff;
      const sign = h < 0x8000 ? 1 : -1;
      const expected = magnitude > 0x7c00 ? NaN
        : magnitude === 0x7c00 ? sign * Infinity
          : sign * positiveHalfValue(magnitude);
      expect(Object.is(decoded[h], expected)).toBe(true);
    }
  });

  it.each([
    [0, 0x0000],
    [-0, 0x8000],
    [2 ** -149, 0x0000],
    [-(2 ** -149), 0x8000],
    [2 ** -25, 0x0000],
    [-(2 ** -25), 0x8000],
    [2 ** -24, 0x0001],
    [1.5 * 2 ** -24, 0x0002],
    [2.5 * 2 ** -24, 0x0002],
    [1022.5 * 2 ** -24, 0x03fe],
    [1023.5 * 2 ** -24, 0x0400],
    [2 ** -14, 0x0400],
    [1 + 2 ** -11, 0x3c00],
    [1 + 3 * 2 ** -11, 0x3c02],
    [2 - 2 ** -11, 0x4000],
    [65504, 0x7bff],
    [65519, 0x7bff],
    [65520, 0x7c00],
    [-65520, 0xfc00],
    [Infinity, 0x7c00],
    [-Infinity, 0xfc00],
  ])("rounds %s to IEEE binary16 bits %s using nearest-even", (value, expected) => {
    const decoded = base64ToFloat16(float32ToFloat16Base64(new Float32Array([value])));
    expect(decoded[0]).toBe(expected);
  });

  it("rounds below, at, and above every finite half midpoint, including negative values", () => {
    const inputs = new Float32Array(0x7c00 * 6);
    const expected = new Uint16Array(inputs.length);
    const midpoint = new Float32Array(1);
    const midpointBits = new Uint32Array(midpoint.buffer);
    for (let h = 0; h < 0x7c00; h++) {
      const lower = positiveHalfValue(h);
      const upper = h === 0x7bff ? 65536 : positiveHalfValue(h + 1);
      midpoint[0] = (lower + upper) / 2;
      const raw = midpointBits[0];
      for (let direction = -1; direction <= 1; direction++) {
        midpointBits[0] = raw + direction;
        const offset = h * 6 + (direction + 1) * 2;
        inputs[offset] = midpoint[0];
        inputs[offset + 1] = -midpoint[0];
        const rounded = direction < 0 ? h : direction > 0 ? h + 1 : h + (h & 1);
        expected[offset] = rounded;
        expected[offset + 1] = rounded | 0x8000;
      }
    }
    expect(base64ToFloat16(float32ToFloat16Base64(inputs))).toEqual(expected);
  });

  it("converts signed quiet and signaling float32 NaNs to half NaNs", () => {
    const bits = new Uint32Array([0x7f800001, 0x7fc12345, 0xff800001, 0xffc12345]);
    const encoded = float32ToFloat16Base64(new Float32Array(bits.buffer));
    expect(base64ToFloat16(encoded)).toEqual(new Uint16Array([0x7e00, 0x7e00, 0xfe00, 0xfe00]));
    for (const value of base64ToFloat16AsFloat32(encoded)) expect(value).toBeNaN();
  });

  it("honors float32 subview offsets when quantizing to little-endian half bytes", () => {
    const source = new Float32Array([99, 1, -2, 2 ** -24, -0, 99]).subarray(1, 5);
    expect(Buffer.from(float32ToFloat16Base64(source), "base64")).toEqual(
      Buffer.from([0x00, 0x3c, 0x00, 0xc0, 0x01, 0x00, 0x00, 0x80]),
    );
    expect(float32ToFloat16Base64(new Float32Array())).toBe("");
  });
});
