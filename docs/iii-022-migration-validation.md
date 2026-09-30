# iii 0.22.1 Migration Validation

## Scope and promotion gate

This fork migrates the paired iii engine, `iii-sdk`, and `@iii-dev/helpers` to
0.22.1. It preserves float16 vector buckets, pipelined loads, orphan cleanup,
BM25 reconstruction from stored content, and disabled engine observability.

This is the 0.22.1 inline `workers:` configuration with `iii-` builtin names,
not the 0.23 worker-compose migration. Do not apply unversioned current iii
configuration examples to this runtime.

**Do not promote the unpatched iii 0.22.1 binary.** The copied-store restart
gate fails on both old iii 0.11.2 and official iii 0.22.1. Use only the separately
built `0.22.1+agentmemory.1` engine after its exact release artifact passes the
same gate; keep the old engine and application tree intact. A green unit suite
and an HTTP 201 response do not establish filesystem durability.

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
get/list read the same RAM. In **unpatched upstream 0.22.1**, adapter
destruction has no awaited final storage flush, and there is no `state::flush`
or `state::save` endpoint.

A clean worker/engine exit can therefore lose the last dirty batch. Reducing
`save_interval_ms` or inserting a delay only reduces the exposure window; neither
is a final-write durability barrier. Dirty-map emptiness is not a barrier either,
since the map is drained before asynchronous file writes finish.

A proper graceful-restart fix must quiesce writes, join all background savers
including superseded reconfiguration tasks, then await a final dirty flush and
propagate failures through adapter destruction. Crash/power-loss guarantees are
separate: they require appropriate write-through/journaling and fsync semantics.

### Locally patched engine

The separate source tree at `/home/codeasier/Projects/iii-agentmemory-0.22.1`
starts at the exact official 0.22.1 tag; commit `5ace0eb` contains the patch.
It retains the public package version and file encoding but reports
`0.22.1+agentmemory.1` via `iii --version`.
Its persistent state and stream adapters quiesce accepted mutations and await
KV shutdown; the KV core joins superseded saver tasks, awaits a serialized
final flush, and reports write failures. Store mutations and dirty markers
now share the same write-lock order, including the delete/recreate case.
The StreamWorker also propagates the active adapter's shutdown error.

The final release binary staged at
`/home/codeasier/.local/lib/agentmemory-iii-0.22.1-agentmemory.1/iii`
has SHA-256 `0151039e971abe30dec5268f866c47cb33012e778d0def8453eae52dd565cfff`.
Audited Rust filters passed 42 KV-core, 9 state-adapter, 8 stream-adapter,
and 1 StreamWorker error test; the deterministic delete/recreate regression
first failed on inherited behavior and then passed with the fix. Unfiltered
Rust tests are unsafe beside the live service: an unrelated bridge-client test
removes `III_URL` and connects to its production default port.

The **exact final engine plus rebuilt application** passed historical reads,
100 distinct accepted observations, a persisted memory and deletion, REST
search/MCP recall, normal CLI stop and full engine restart. All 100 IDs and
the memory survived unchanged, the deletion remained effective, and the
41,753-vector count and shortfall status were unchanged. A separate isolated
read-only rollback probe booted the old 0.11.2 pair against a *copy* of this
new-engine-written store and recovered its new canary IDs, memory and historical
samples. This is not permission to boot old production directly on modified
new-version data; the offline backup is the primary rollback path.

Retired stream adapters from live hot swaps are still outside the final
shutdown barrier: do not hot-reconfigure a file-backed stream adapter while
migrating. The guarantee is for quiesced, **successful graceful shutdown**, not
per-write acknowledgement, abrupt kill, kernel crash, power loss, or fsync.
Native CLI exit code 0 only proves the engine PID disappeared: it cannot read
the detached engine's exit status and must not be treated as final-flush proof.
For this manual migration, compare a cold-booted *current offline snapshot*
with pre-stop read-only witnesses before production promotion; keep rollback
ready if it differs.

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
100 seconds; CLI worker stop grace is 101 seconds and native engine grace is
15 seconds. The new CLI's native stop no longer force-kills a process after
a graceful-stop timeout or clears lifecycle state on failure. The worker writes
an instance-scoped running record with PID/run ID/OS start token and atomically
publishes success or failure at shutdown; native CLI stop must observe the
matching success before stopping the engine. A watchdog exit or failed index
flush leaves no success proof. This does **not** attest the engine's later
final flush. Docker's own `stop --time` still has a separate force-kill
boundary and is not the tested production path. A service stop timeout must
leave room for both processes and orchestration overhead. The old service's 120-second
deadline does **not** cover a 12-15-second dwell for the unpatched engine in
the worst case; a cutover-specific stop supervisor and timeout override are
required before stopping the old service.

`test/shutdown-persistence.test.ts` uses real application persistence/index
classes and delayed in-memory KV mocks. It verifies first metadata publication
and float16 reload after 4.1-4.9-second writes, explicit failure handling, and
bounded dead-engine teardown. It does not simulate the engine's disk autosave
or solve the raw-state persistence gap. `test/worker-shutdown-proof.test.ts`
covers accepted success, failed flush, stale/missing identity, hard-exit absence,
and atomic-write failure. After these changes, `npm test` passed 1,944 tests
with one skip, and `npm run build` passed. TypeScript's existing baseline
diagnostics remain; the migration added no normalized diagnostics.

## Eventual cutover requirements

1. Keep the old engine, full application build and dependency tree unchanged.
2. Stage the new engine under a separate, versioned path. Require exact binary
   and SDK/helper versions before launch; fail closed rather than invoking the
   auto-installer on production HOME.
3. Re-run copied-store restart tests after an actual engine persistence fix.
   Verify accepted observations, memory content, vector counts and recall, not
   merely readiness or process exit. Cover state update/delete as well.
4. Record and suspend health, backup and consolidation timers; confirm their
   service jobs are inactive. The old `agentmemory stop` kills the worker after
   5 seconds and signals the engine immediately, while plain systemd stop
   does not gracefully terminate its engine child. Use an audited worker-first
   stop supervisor: verify PIDs, let the worker finish, keep the old engine
   alone for at least two complete 5-second saver periods, then stop it and
   verify all listeners released. Fail closed on forced kill, save error, or
   timeout; budget more than 120 seconds for the old worst case. Take a
   consistent offline data/config/unit backup only after both processes exit.
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
