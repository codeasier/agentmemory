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
starts at the exact official 0.22.1 tag; commit `5ace0eb` contains the
durability patch and commit `6ee52b21e` the memory patch (see
"Memory growth after the cutover" below).
It retains the public package version and file encoding but reports
`0.22.1+agentmemory.1` via `iii --version`.
Its persistent state and stream adapters quiesce accepted mutations and await
KV shutdown; the KV core joins superseded saver tasks, awaits a serialized
final flush, and reports write failures. Store mutations and dirty markers
now share the same write-lock order, including the delete/recreate case.
The StreamWorker also propagates the active adapter's shutdown error.

The final release binary staged at
`/home/codeasier/.local/lib/agentmemory-iii-0.22.1-agentmemory.1/iii`
has SHA-256 `2977b506879e52785efb467b6c019c71cd41cf008d76b0d090a70e46b2432dcd`.
The durability-only binary it replaced (`0151039e…`) is kept at
`/home/codeasier/backups/engine-iii-0.22.1/` for rollback, and
`prestart_new.py` pins the staged digest, so a mismatched binary fails closed
instead of starting.
Audited Rust filters passed 42 KV-core, 9 state-adapter, 8 stream-adapter,
1 StreamWorker error, 5 heap-maintenance and 11 stream-worker tests; the
deterministic delete/recreate regression first failed on inherited behavior and
then passed with the fix. Unfiltered Rust tests are unsafe beside the live
service: an unrelated bridge-client test removes `III_URL` and connects to its
production default port.

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

## Memory growth after the cutover

The 0.22.1 pair fixed durability, not resident memory, and its isolated RSS
samples explicitly did not establish a long-running bound. On 2026-10-06 the
cgroup went from a 1503–1830 MB plateau (10-02…10-05) to 2413 MB within 1.5 h of
the hook workload resuming, while the on-disk store grew only 14 MB (223→237 MB)
and the index 10 MB. Attribution at the time: the engine's `file_based` KV holds
the whole store as `serde_json::Value` trees and deep-copied a scope's tree on
every `set`, `get`, `update`, `list` and save-loop flush, so glibc kept the freed
churn inside its per-thread arenas — the process showed five exactly 64 MiB-aligned
anonymous mappings, the arena heap shape, against a 20-core
`MALLOC_ARENA_MAX` ceiling of 160.

This is an engine defect, and it is not ours alone: upstream
[iii-hq/iii#2257](https://github.com/iii-hq/iii/issues/2257) (2026-09-30) reports
the same signature with the same diagnosis, and the maintainers answered that
they had located it and would include the fix in a new release. That fix,
`4318fbfb9` / PR #2261, shipped only in the `iii/v0.24.6-rc.1` pre-release — not
in `v0.24.4`, not in 0.22.1, and no stable release carries it yet. The
client-side mitigation upstream shipped in agentmemory (`b3d6cf5` / PR #1457,
`MALLOC_ARENA_MAX=2`) is likewise unreleased: npm `latest` is 0.9.29. Bumping the
engine is not a path — 0.23.0 rejects the inline `workers:` config 0.9.29 renders,
and 0.22.1 exposes no WebSocket transport for the bundled iii-sdk 0.11.2 client.

Commit `6ee52b21e` therefore ports the upstream fix onto our 0.22.1 line:

- `Scope` becomes `IndexMap<String, Arc<Value>>`, so readers, persistence and
  the save loop share one immutable tree by handle; the per-operation deep copy
  drops from two or three to at most one.
- `load_store_from_dir` reads the archive by reference, and the writer streams
  through `IoWriter<BufWriter<File>>`, removing two full-size transient buffers
  per scope.
- A new `engine/src/memory.rs` gives the engine one `HeapMaintenance` task per
  `serve()` lifetime that calls `libc::malloc_trim(0)` every 60 s, started after
  fallible setup and stopped before teardown, independently of worker
  registration, observability and reloads.
- The stream adapter stops cloning its payload, and `list` returns
  `Value::Array(values)` instead of re-serializing the whole group.

The on-disk archive format and the graceful-shutdown flush contract are
unchanged, which the full KV-core and adapter suites confirm.

### Isolated A/B, same corpus and same load

`/home/codeasier/agentmemory-engine-ab/ab.py` runs one engine at a time against
a private copy of the production store on shifted ports (3411/3412/3413/49434)
with a loopback embedding fixture. Both passes used the same seed
(265,142,540 bytes, 50,513 vectors, 44,100 BM25 documents, 1,007 sessions), 6,000
hook writes across eight sessions, then 240 scope reads and 60 searches. The
adapter cadence was published at 200 ms in both passes so a short burst exercises
hundreds of flush batches rather than a handful; this accelerates the same code
path and is not a workload change.

| Engine RSS | after boot | after writes | after reads | idle 120 s |
| --- | ---: | ---: | ---: | ---: |
| `0151039e` (durability only) | 978.4 MiB | 983.3 MiB | **1048.8 MiB** | 1048.8 MiB |
| `2977b506` (this patch) | 997.5 MiB | 991.2 MiB | **991.2 MiB** | **941.2 MiB** |

The old engine gained 70.4 MiB across the read phase and never returned it; the
new one stayed flat and the 60 s trim pulled it 50 MiB below its boot value, for
a 107.6 MiB gap at the end of the same work. Both passes read back all 6,000
canary observations after a restart with byte-identical ID and content hashes.
The new engine's ~19 MiB higher boot is the `Arc<Value>` indirection cost
(pointer plus refcount header per entry) and is the price of not copying.

### Production result, 2026-10-06 13:11

The staged binary was replaced atomically, `prestart_new.py` was repointed at
the new digest, and the service was stopped explicitly (exit 0, all four ports
released, cgroup removed) before starting. Read-only witnesses taken before the
stop matched exactly after it: 50 memory content hashes, and three sessions at
500/500/431 observations with identical ID and content hashes.

Engine RSS fell from 1547 MB — the pre-fix level at the same corpus — to a
942–1064 MB sawtooth that keeps returning to ~950 MB, and the cgroup from
2345 MB to 2066–2187 MB. The sawtooth is the trim working: memory is handed back
after each churn burst instead of ratcheting. The Node worker's own footprint
(~900 MB, dominated by the 53k-vector index in `external`) is unchanged by this
patch and remains the next ceiling.

Monitoring caveat, fixed in the same pass: `agentmemory-cgroup-watch.sh` matched
the engine with `pgrep -f 'bin/iii --config'`, which stopped matching when the
0.22.1 layout moved the binary from `<prefix>/bin/iii` to `<prefix>/iii`.
`node_agentmemory_process_rss_bytes{role="engine"}` was therefore absent from
2026-10-01 02:18 onward, leaving the growing process unwatched. It now matches
the process name with the legacy pattern as a fallback, and the installed copy
under `/usr/local/lib/codeasier-monitoring/` was refreshed from the repository.

Rollback is a file swap, not a store restore: install
`/home/codeasier/backups/engine-iii-0.22.1/iii-0.22.1+agentmemory.1-0151039e`
over the staged path, point `EXPECTED_ENGINE_SHA` in `prestart_new.py` back at
`0151039e…`, and restart the unit. The store format is unchanged in both
directions; only the resident-memory behaviour differs.

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

## Cutover requirements

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
   Suspending systemd timers alone does not quiesce hooks or the daemon's
   internal auto-forget and audit-sweep timers.
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

## Local cutover evidence, 2026-10-01

The exact old worker and iii 0.11.2 engine were stopped under a temporary
systemd `ExecStop` supervisor, rehearsed first with a separate dummy service.
It kept the old engine alive for 16 seconds after worker exit (more than two
5-second save periods), checked the shutdown journal and released listeners,
and did not use the old CLI's 5-second forced worker kill. With health, backup,
and consolidation timers suspended, a stopped-store archive preserved the
complete data root, old HOME metadata/config/engine, full old application tree,
units and helper scripts. The private recovery directory is
`/home/codeasier/backups/agentmemory-iii022-38KwQq2C`; its
`offline-complete.tar` has SHA-256
`8b4b72ee5a4f6f5de1d21d3f802e9df58670f8962b60929900658d4e5f6f45a4`.
All 1,105 archived state files were compared against the stopped source.
The original unit files and recorded timer state are preserved separately.

A second isolated smoke test started from the **current offline production
snapshot**, not an earlier live copy. The patched pair retained 10 sampled
memory hashes, three closed-session ID/content sets, all 100 accepted canary
observations, a new memory, a deleted memory, REST search, MCP recall, and an
unchanged 42,509-vector count across complete engine stop/restart. On
production, systemd's new `ExecStartPre` verified the exact application and
engine hashes, SDK/helper versions, worker trace opt-out, and the unchanged
`0.0.0.0:3111` REST bind and absolute state/stream paths. A subsequent real
systemd restart preserved **21/21 accepted new-production observation IDs and
content hashes**, historical witnesses and at least 42,429 vectors without a
vector checkpoint shortfall. The old private binary and application tree remain
untouched. The patched engine is side-by-side, not an in-place replacement.

**Unresolved older warm-index discrepancy:** Immediately before old shutdown,
the old live process reported 36,819 BM25 documents / 36,563 indexed
observations. Both old 0.11.2 and patched 0.22.1 cold-boot the same offline
snapshot at 35,928 / 35,672 (a difference of 891 observation-side *warm*
index entries; memory documents stay at 256). The pre-cutover 42,408 vectors
survived. All 2,562 `Observation captured` IDs found in the last old worker
PID's journal were individually found in the new KV, and there were no
persisted `mem:obs:` scope files without a listed session. This rules out a
new-engine-only reconstruction regression and verifies the latest old worker's
accepted writes, but **does not prove** whether the older 891 warm-only entries
were stale index ghosts or previously unflushed historical observations. Do
not synthesize entries, claim full-corpus integrity, or turn on extra eviction
to reconcile a counter. The offline archive and ID-reconciliation evidence
are retained; cold-boot counts are the comparison baseline.

A rollback must stop/reap the patched pair, quarantine post-cutover data without
deleting it, and restore the original archive and unit into verified empty
targets before booting the old engine. Writes accepted after the archive need
replay; reverting to the pre-cutover snapshot alone would lose them. The old
pair could read *a disposable copy* of new-written data, but that is not a
license to boot it directly over a modified live store. Engine exit status is
still not observable to the separate CLI; for this manual cutover, the cold
restart and read-only witnesses supplement (not replace) the graceful-shutdown
implementation. Neither this evidence nor the patch promises crash/power-loss
fsync durability.

All three previously active user timers were restored. The missed 03:00 nightly
consolidation ran once and completed successfully before the backup timer was
resumed; the next backup is due at approximately 03:35 CST and can restart the
service. At final verification the new service was active with all timer jobs
idle, and its cgroup `MemoryCurrent` was about 1.75 GiB under the unchanged
`MemoryHigh=2560M` and `MemoryMax=3G`. This single sample does not prove a
memory optimization over the old engine or a long-run leak fix.
