#!/usr/bin/env python3
"""P0 evidence: float16 / int8 round-trip on real persisted vectors.

Reads iii-engine per-scope `.bin` files (JSON object + 12-byte trailer)
from a snapshot of `state_store.db`. Does not connect to the live worker
and does not write the store.

Usage:
  python3 scripts/p0-quantization-evidence.py --store /tmp/p0-vec-snap --sample 2000
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import sys
import time
from urllib.parse import unquote

import numpy as np

TOP_K = 10
FLOAT16_THRESHOLD = 0.98


def read_scope(path: str) -> dict:
    raw = open(path, "rb").read()
    if not raw.startswith(b"{"):
        raise ValueError(f"not a JSON object: {path}")
    # Engine scopes are JSON + a short binary trailer. Walk back from the
    # end until the UTF-8 prefix parses as one JSON value.
    decoder = json.JSONDecoder()
    for cut in range(len(raw), max(len(raw) - 64, 0), -1):
        try:
            text = raw[:cut].decode("utf-8")
        except UnicodeDecodeError:
            continue
        try:
            obj, _end = decoder.raw_decode(text)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    raise ValueError(f"no JSON object in {path}")


def decode_f32(b64: str) -> np.ndarray:
    buf = base64.b64decode(b64)
    if len(buf) % 4:
        raise ValueError(f"embedding bytes {len(buf)} not multiple of 4")
    return np.frombuffer(buf, dtype="<f4").copy()


def load_vectors(store: str) -> tuple[list[str], np.ndarray]:
    names = sorted(
        n
        for n in os.listdir(store)
        if n.startswith("mem%3Aindex%3Abm25%3Avec%3A") and n.endswith(".bin")
    )
    ids: list[str] = []
    rows: list[np.ndarray] = []
    skipped = 0
    for name in names:
        path = os.path.join(store, name)
        try:
            blob = read_scope(path)
        except Exception as err:
            print(f"skip {unquote(name)}: {err}", file=sys.stderr)
            skipped += 1
            continue
        for key, row in blob.items():
            if not isinstance(row, dict) or not isinstance(row.get("e"), str):
                skipped += 1
                continue
            try:
                vec = decode_f32(row["e"])
            except Exception:
                skipped += 1
                continue
            ids.append(key)
            rows.append(vec)
    seen: dict[str, int] = {}
    uniq_ids: list[str] = []
    uniq_rows: list[np.ndarray] = []
    dup = 0
    for key, vec in zip(ids, rows):
        if key in seen:
            dup += 1
            continue
        seen[key] = 1
        uniq_ids.append(key)
        uniq_rows.append(vec)
    ids, rows = uniq_ids, uniq_rows
    if dup:
        print(f"dropped {dup} duplicate ids", flush=True)
    if not rows:
        raise SystemExit("no vectors loaded")
    dim = rows[0].shape[0]
    bad = [i for i, v in enumerate(rows) if v.shape[0] != dim]
    if bad:
        raise SystemExit(f"{len(bad)} vectors have dim != {dim}")
    matrix = np.stack(rows, axis=0)
    print(
        f"loaded {len(ids)} vectors dim={dim} from {len(names)} buckets "
        f"(skipped={skipped})",
        flush=True,
    )
    return ids, matrix


def l2_normalize(x: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-12)
    return x / norms


def quantize_f16(x: np.ndarray) -> np.ndarray:
    return x.astype(np.float16).astype(np.float32, copy=False)


def quantize_int8(x: np.ndarray) -> np.ndarray:
    scale = np.max(np.abs(x), axis=1, keepdims=True)
    scale = np.maximum(scale, 1e-12)
    q = np.clip(np.round(x / scale * 127.0), -127, 127).astype(np.int8)
    return q.astype(np.float32) * (scale / 127.0)


def encoded_bytes(kind: str, n: int, dim: int) -> int:
    if kind == "f32":
        raw = n * dim * 4
    elif kind == "f16":
        raw = n * dim * 2
    elif kind == "i8":
        raw = n * dim * 1 + n * 4
    else:
        raise ValueError(kind)
    return raw


def b64_chars(raw_bytes: int) -> int:
    return (raw_bytes + 2) // 3 * 4


def topk_ids(scores: np.ndarray, k: int) -> np.ndarray:
    k = min(k, scores.shape[1])
    part = np.argpartition(scores, -k, axis=1)[:, -k:]
    gathered = np.take_along_axis(scores, part, axis=1)
    order = np.argsort(-gathered, axis=1)
    return np.take_along_axis(part, order, axis=1)


def overlap_at_k(orig: np.ndarray, quant: np.ndarray, k: int) -> np.ndarray:
    hits = np.empty(orig.shape[0], dtype=np.float64)
    for i in range(orig.shape[0]):
        hits[i] = len(set(orig[i].tolist()) & set(quant[i].tolist())) / k
    return hits


def recall_at_k(orig: np.ndarray, quant_scores: np.ndarray, k: int) -> np.ndarray:
    """Fraction of original top-k that still score in the quantized top-k.

    Unlike set-overlap of argpartition ids, this is stable under exact
    score ties (common when many embeddings sit in a tight cluster).
    """
    hits = np.empty(orig.shape[0], dtype=np.float64)
    for i in range(orig.shape[0]):
        thresh = np.partition(quant_scores[i], -k)[-k]
        kept = 0
        for j in orig[i]:
            if quant_scores[i, j] >= thresh:
                kept += 1
        hits[i] = kept / k
    return hits


def percentile(x: np.ndarray, p: float) -> float:
    return float(np.percentile(x, p))


def eval_scheme(
    name: str,
    corpus: np.ndarray,
    queries: np.ndarray,
    query_idx: np.ndarray,
    orig_neighbors: np.ndarray,
) -> dict:
    t0 = time.time()
    if name == "float16":
        q_corpus = quantize_f16(corpus)
        q_queries = q_corpus[query_idx]
    elif name == "int8":
        q_corpus = quantize_int8(corpus)
        q_queries = q_corpus[query_idx]
    else:
        raise ValueError(name)
    qn = l2_normalize(q_queries)
    cn = l2_normalize(q_corpus)
    scores = qn @ cn.T
    scores[np.arange(scores.shape[0]), query_idx] = -np.inf
    neighbors = topk_ids(scores, TOP_K)
    overlap = overlap_at_k(orig_neighbors, neighbors, TOP_K)
    recall = recall_at_k(orig_neighbors, scores, TOP_K)
    self_cos = np.sum(
        l2_normalize(queries) * l2_normalize(q_queries), axis=1
    )
    elapsed = time.time() - t0
    hist = {
        f"{v:.1f}": int((np.abs(overlap - v) < 1e-9).sum())
        for v in (0.0, 0.5, 0.8, 0.9, 1.0)
    }
    return {
        "name": name,
        "mean_overlap": float(overlap.mean()),
        "p50_overlap": percentile(overlap, 50),
        "p05_overlap": percentile(overlap, 5),
        "min_overlap": float(overlap.min()),
        "mean_recall": float(recall.mean()),
        "p50_recall": percentile(recall, 50),
        "p05_recall": percentile(recall, 5),
        "min_recall": float(recall.min()),
        "mean_self_cosine": float(self_cos.mean()),
        "min_self_cosine": float(self_cos.min()),
        "seconds": elapsed,
        "overlap_hist": hist,
        "overlap": overlap,
        "recall": recall,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--store", required=True, help="snapshot of state_store.db")
    parser.add_argument("--sample", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=20260930)
    args = parser.parse_args()

    meta_path = os.path.join(args.store, "mem%3Aindex%3Abm25.bin")
    if os.path.exists(meta_path):
        meta = read_scope(meta_path)
        print("meta:", json.dumps(meta.get("vectors:meta", meta), sort_keys=True))

    ids, corpus = load_vectors(args.store)
    n, dim = corpus.shape
    sample = min(args.sample, n)
    rng = random.Random(args.seed)
    query_idx = np.array(rng.sample(range(n), sample), dtype=np.int64)
    queries = corpus[query_idx]

    orig = l2_normalize(queries)
    corp = l2_normalize(corpus)
    t0 = time.time()
    scores = orig @ corp.T
    scores[np.arange(sample), query_idx] = -np.inf
    orig_neighbors = topk_ids(scores, TOP_K)
    top1 = scores[np.arange(sample), orig_neighbors[:, 0]]
    topk = scores[np.arange(sample), orig_neighbors[:, TOP_K - 1]]
    margin = top1 - topk
    # Exact-duplicate clusters (cosine ~1 across many ids) make set-overlap
    # of a 10-wide slice undefined: any 10 of hundreds of identical vectors
    # are equally correct. Gate on queries with a real ranking margin.
    distinctive = margin > 1e-4
    n_dist = int(distinctive.sum())
    print(
        f"original top-{TOP_K} for {sample} queries vs {n} corpus in {time.time()-t0:.1f}s "
        f"(top1 mean={float(top1.mean()):.4f} top{TOP_K} mean={float(topk.mean()):.4f} "
        f"margin mean={float(margin.mean()):.4f}; distinctive={n_dist}/{sample})"
    )
    if n_dist < 50:
        raise SystemExit(
            f"only {n_dist} distinctive queries; cannot gate quantization"
        )

    results = [
        eval_scheme("float16", corpus, queries, query_idx, orig_neighbors),
        eval_scheme("int8", corpus, queries, query_idx, orig_neighbors),
    ]
    for r in results:
        r["distinctive_mean_overlap"] = float(r["overlap"][distinctive].mean()) if "overlap" in r else None

    f32_raw = encoded_bytes("f32", n, dim)
    f16_raw = encoded_bytes("f16", n, dim)
    i8_raw = encoded_bytes("i8", n, dim)
    print()
    print(f"volume for full index n={n} dim={dim}")
    print(
        f"  float32 raw={f32_raw/1e6:.1f}MB  base64-chars~{b64_chars(f32_raw)/1e6:.1f}M"
    )
    print(
        f"  float16 raw={f16_raw/1e6:.1f}MB  base64-chars~{b64_chars(f16_raw)/1e6:.1f}M  "
        f"ratio={f16_raw/f32_raw:.2f}"
    )
    print(
        f"  int8+scale raw={i8_raw/1e6:.1f}MB  base64-chars~{b64_chars(i8_raw)/1e6:.1f}M  "
        f"ratio={i8_raw/f32_raw:.2f}"
    )
    print()
    print(f"top-{TOP_K} neighbor overlap vs float32 (sample={sample}, seed={args.seed})")
    gate = None
    for r in results:
        d_overlap = float(r["overlap"][distinctive].mean())
        d_recall = float(r["recall"][distinctive].mean())
        d_p05 = percentile(r["overlap"][distinctive], 5)
        passed = d_overlap >= FLOAT16_THRESHOLD
        tag = "PASS" if passed else "FAIL"
        print(
            f"  {r['name']:8} ALL id-overlap mean={r['mean_overlap']:.4f} "
            f"score-recall mean={r['mean_recall']:.4f} "
            f"| DISTINCTIVE n={n_dist} id-overlap mean={d_overlap:.4f} p05={d_p05:.4f} "
            f"score-recall mean={d_recall:.4f} "
            f"self-cos mean={r['mean_self_cosine']:.6f} min={r['min_self_cosine']:.6f} "
            f"hist={r['overlap_hist']} "
            f"[{tag} vs {FLOAT16_THRESHOLD:.0%} distinctive id-overlap] {r['seconds']:.1f}s"
        )
        if r["name"] == "float16":
            gate = passed

    print()
    if gate:
        print(
            f"VERDICT: float16 mean top-{TOP_K} overlap >= {FLOAT16_THRESHOLD:.0%} — "
            "P0 implementation is justified."
        )
        return 0
    print(
        f"VERDICT: float16 mean top-{TOP_K} overlap < {FLOAT16_THRESHOLD:.0%} — "
        "do not implement P0 yet."
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
