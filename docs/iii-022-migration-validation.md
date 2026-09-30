# iii 0.22.1 Migration Validation

## Scope and promotion gate

This fork migrates the paired iii engine, `iii-sdk`, and `@iii-dev/helpers` to
0.22.1. It preserves float16 vector buckets, pipelined loads, orphan cleanup,
BM25 reconstruction from stored content, and disabled engine observability.

This is the 0.22.1 inline `workers:` configuration with `iii-` builtin names,
not the 0.23 worker-compose migration. Do not apply unversioned current iii
configuration examples to this runtime.

**Production promotion is not approved by the current restart tests.** Keep the
old engine and application tree intact until the persistence gate below passes.
A green unit suite and an HTTP 201 response do not establish filesystem durability.

## Isolated validation on 2026-09-30

Both versions were tested sequentially against copies of the same file-based
store, with a separate HOME, lifecycle metadata, config, working directory, and
REST/stream/viewer/worker-bus ports. No production service, credential, engine
binary or observation was changed by these tests.

The seed contained approximately 244 MB of stored data. Both tests loaded
41,651 vectors and rebuilt BM25 for 35,220 documents. A loopback-only deterministic
1024-dimensional embedding fixture exercised the embedding interface without
using hosted credentials; it does not measure real semantic retrieval quality.

Both versions passed:

- Reads of five historical memories with unchanged content hashes.
- Reads of two closed sessions with unchanged observation IDs and content hashes.
- Authentication rejection and malformed-observation validation.
- Creation, immediate readback and search of 100 distinct hook observations.
- Memory writes, MCP tool enumeration and MCP recall of canary evidence.
- Normal CLI worker-first stop, process exit and release of all four listeners.

Both versions failed the immediate full-restart persistence gate. Canary
observation IDs did not survive unchanged, and new canary scope files were absent.
On restart the index returned to the seed's document/vector counts. The old
0.11.2 runtime reproduces the same failure, so this is not solely a migration
regression.

### Memory observations

| Measurement | iii 0.11.2 | iii 0.22.1 |
| --- | ---: | ---: |
| Worker + engine RSS after copied-corpus boot | 1640.25 MiB | 1714.31 MiB |
| Worker + engine RSS after 100 hook writes | 1636.91 MiB | 1726.73 MiB |

These are single process-RSS samples, not cgroup totals or sustained-load results.
They do not establish a memory reduction or demonstrate that long-running RSS
accumulation is fixed. Do not compare them directly to a warm production cgroup,
which also accounts for page cache and kernel memory.

## Engine persistence gap

Exact inspected source:

- [iii 0.22.1 KV writes](https://github.com/iii-hq/iii/blob/e7de3820d1e558f3762edf95e4440552444d48d3/engine/src/builtins/kv.rs)
- [iii 0.22.1 state adapter destruction](https://github.com/iii-hq/iii/blob/e7de3820d1e558f3762edf95e4440552444d48d3/engine/src/workers/state/adapters/kv_store.rs)
- [iii 0.11.2 KV implementation](https://github.com/iii-hq/iii/blob/2b445957701f94dc5f56f900af314e9d59f3b0f7/engine/src/builtins/kv.rs)

The `file_based` KV adapter uses a directory of encoded `scope.bin` files, not
SQLite. Successful `state::set` acknowledges RAM plus a dirty marker. A periodic
background task persists dirty scopes; its default interval is 5000 ms. Immediate
get/list read the same RAM. Adapter destruction has no awaited final storage
flush, and 0.22.1 exposes no `state::flush` or `state::save` endpoint.

A clean worker/engine exit can therefore lose the last dirty batch. Reducing
`save_interval_ms` or inserting a delay only reduces the exposure window; neither
is a final-write durability barrier. Dirty-map emptiness is not a barrier either,
since the map is drained before asynchronous file writes finish.

A proper graceful-restart fix must quiesce writes, join all background savers
including superseded reconfiguration tasks, then await a final dirty flush and
propagate failures through adapter destruction. Crash/power-loss guarantees are
separate: they require appropriate write-through/journaling and fsync semantics.
No such engine patch is included in this application migration yet.

## Application migration safeguards

### Avoid trace payload copies

Set these in the Node worker environment when running without tracing:

```sh
III_DISABLE_TRACE_PAYLOADS=true
OTEL_ENABLED=false
III_TELEMETRY_ENABLED=false
```

The first variable specifically disables trace-payload redaction/copying and JSON
serialization in the SDK's registered-handler wrapper. `OTEL_ENABLED=false`
alone does not skip that work; engine observability and usage telemetry are
independent. Necessary transport serialization/input resolution still occur.
A trace byte limit truncates after full serialization, so it is not equivalent.

`test/sdk-trace-payloads.test.ts` executes the installed SDK CommonJS wrapper
with an inert transport and verifies result/error identity and traversal behavior.
The production ESM wrapper was also inspected; it uses the same opt-out predicate.

### Preserve healthy vector checkpoints

The application now allows 80 seconds for the vector checkpoint, 5 seconds for
viewer close, and 10 seconds for SDK shutdown. The worker's hard watchdog is
100 seconds; CLI worker stop grace is 101 seconds. A service stop timeout must
also leave time to reap the engine; this machine's existing 120-second deadline
covers the canonical single-worker/single-engine case.

`test/shutdown-persistence.test.ts` uses real application persistence/index
classes and delayed in-memory KV mocks. It verifies first metadata publication
and float16 reload after 4.1-4.9-second writes, explicit failure handling, and
bounded dead-engine teardown. It does not simulate the engine's disk autosave
or solve the raw-state persistence gap.

## Eventual cutover requirements

1. Keep the old engine, full application build and dependency tree unchanged.
2. Stage the new engine under a separate, versioned path. Require exact binary
   and SDK/helper versions before launch; fail closed rather than invoking the
   auto-installer on production HOME.
3. Re-run copied-store restart tests after an actual engine persistence fix.
   Verify accepted observations, memory content, vector counts and recall, not
   merely readiness or process exit. Cover state update/delete as well.
4. Record and suspend health, backup and consolidation writers during an
   authorized maintenance window. Verify old worker/engine/listeners are gone
   before taking a consistent offline data/config/unit backup.
5. Switch the complete application tree and matching SDK together with the
   side-by-side engine. Preserve the production config's intended bind policy
   and absolute state paths; a bundled config defaults to loopback instead.
6. Verify the actual engine executable and version. `/status` reports a
   compile-time pin, not an executable probe.
7. Restore previously active timers. Retain an offline recovery path; restoring
   a pre-cutover snapshot alone would discard later writes unless replayed.

Isolation requires more than `--port` or `--data-dir`: instance 0 lifecycle files
still live under HOME, and production custom YAML can contain absolute state
paths that the renderer does not rewrite. Force the bundled config and a private
HOME when running copied-store tests. Never share production pidfiles/configs or
use generic process-name kills for cleanup.
