# Worker memory

## Search index residency

The worker stores resident vectors as IEEE-754 binary16 arrays (two bytes per
dimension), instead of expanding persisted half vectors into Float32 on boot.
Queries stay Float32, and scoring decodes components through a shared 256 KiB
lookup table. Float32 compatibility accessors return temporary snapshots, not a
second resident index. Float16 is lossy: rankings can change for near ties. The
regression corpus measures ranking and score error; it does not prove zero recall
loss for arbitrary data.

BM25 stores frequencies in its posting lists and a compact term list per document,
rather than an extra nested frequency Map per document. The scoring formula is
unchanged. Its v3 serialized format can read legacy v2 snapshots.

### Optional newest-observation window

Set `AGENTMEMORY_MAX_INDEXED_OBSERVATIONS=50000` in the daemon environment or
`~/.agentmemory/.env`, then restart. Unset or `0` keeps the existing unlimited
behavior. A positive safe integer enables the limit; invalid values use unlimited.

- BM25 retains the newest `obs_*` observations by timestamp, breaking ties by ID.
  `mem_*` memories and lessons are outside this limit.
- A bounded keyword prepass selects the resident IDs before vector bucket loading.
  It retries an incomplete scan up to three times, then fails startup rather than
  claiming complete semantic coverage from an incomplete selection.
  Only selected embeddings are retained. A legacy monolithic-vector migration may
  still materialize the old snapshot once before the window can be applied.
- Leaving the resident window does **not** delete observations or persisted vectors.
  Expanding/disabling the window on restart restores older eligible vectors without
  embedding them again. New observations outside the window are stored but not
  newly embedded; expanding the window may require the existing explicit full
  backfill option for those records.
- Global recall intentionally excludes observations outside the window. Their
  records remain available through session/detail reads; this is not lazy global
  search across cold history. `/agentmemory/status` reports `index.observationLimit`
  and an informational `observation_index_window` notice.
- Eviction leaves unsaved embeddings in the existing pending log. Checkpointing
  can recover those payloads even after they leave RAM; metadata counts persisted
  vectors, not just the resident subset. Explicit delete/clear still removes cold
  vectors as well as resident ones.

This bounds the resident observation indexes, **not total RSS**. Permanent records,
ID/bucket bookkeeping, concurrent requests, per-session reads and migration buffers
still need memory. The state backend must continue to use iii-engine; this change
does not introduce a standalone database or bypass its state functions.

### Empty-narrative reconciliation

Live observation, duplicate restore, compression, import and keyword rebuild agree
on nonblank `title` and `narrative` before search indexing. Empty-narrative events
remain stored, including their source payload; they are not assumed to be
content-free and are not bulk-deleted. This change alone does not recover session
quota or replay existing dead letters.

A successful complete keyword rebuild queues derived vectors for deleted,
superseded or ineligible records for removal through normal bucket persistence.
It keeps a separate eligible-ID set, so records outside the resident window are
not mistaken for deleted records. Failed memory/session/observation reads disable
this cleanup. Concurrent vector writes/deletes also defer cleanup, rather than
pruning data created while the scan was in progress. A subsequent complete quiet
rebuild can retry it.

## Validation scope

Half vectors have exactly half the Float32 payload size; total RSS savings are not
the same percentage. The difference between RSS, V8 heap and external memory
does not by itself prove allocator fragmentation. Benchmark allocator changes on
the same frozen corpus and workload before attributing that residual or claiming
a production reduction. No production-store deletion is required for these tests.

An isolated Node 22.22.0 probe compared commit `0798ec9` with this implementation
in separate fresh processes using `--expose-gc`: 20,000 observations, 30 generated
terms per narrative from a 1,000-term vocabulary, and 20,000 distinct 1024-d
vectors (`sin(dimension + document) / 32`). Deltas after an explicit GC were:

| Measurement | Baseline | Compact indexes |
| --- | ---: | ---: |
| Float vector payload | 78.125 MiB | 39.0625 MiB |
| External-memory delta | 78.1 MiB | 39.5 MiB |
| Used-heap delta | 82.5 MiB | 47.7 MiB |
| RSS delta | 205.3 MiB | 154.1 MiB |
| Build time | 1512 ms | 1502 ms |

This is one synthetic allocation probe without iii-engine, Redis, production
history or a representative recall corpus. RSS and timings vary between runs;
these numbers are evidence for smaller data structures, not a production SLA.

## Launch-time allocator limit

On Linux with glibc, the worker defaults to `MALLOC_ARENA_MAX=2` to limit allocator
arenas and reduce native-memory fragmentation. This is an allocator setting, not
a cap on RSS or the V8 heap.

The CLI imports the worker into its own Node process. Setting `process.env` just
before that import is too late: glibc initializes its allocator before JavaScript
runs. The setting must be in Node's launch environment.

For the default daemon invocation (`agentmemory`, or flag-first invocations such
as `agentmemory --no-engine`), the CLI checks the launch environment before
loading `.env` or starting the engine/worker:

- On Linux, if `MALLOC_ARENA_MAX` is absent and `process.execve` is available
  (including Node 22.22), it replaces itself with the same Node executable and
  `MALLOC_ARENA_MAX=2` in the inherited environment. Node flags from
  `process.execArgv`, the CLI entry point, and all CLI arguments are preserved.
  The PID and standard input/output/error survive the replacement.
- The replacement inherits `MALLOC_ARENA_MAX=2`, so it does not re-exec again.
  Any explicitly inherited value, including an empty string, is respected.
- Named commands such as `status`, `doctor`, `mcp`, and `stop`, and all
  `--help`/`-h`/`--version`/`-V` requests skip this launcher. The current CLI has
  no `start` or `daemon` subcommand; run it without a command to start the worker.
- Other platforms skip the allocator launcher.

On Node 20, or any runtime without `process.execve`, daemon startup emits a
warning and continues without claiming that the allocator default was applied.
Set the variable in the shell or service manager's launch environment:

```sh
MALLOC_ARENA_MAX=2 agentmemory
```

Direct worker entry points also require launch-time configuration because they
bypass the CLI launcher:

```sh
MALLOC_ARENA_MAX=2 node dist/index.mjs
```

To choose a different value, export it before starting Node, for example
`MALLOC_ARENA_MAX=8 agentmemory`. Putting this variable only in
`~/.agentmemory/.env` does not configure the running Node allocator and does not
override the CLI's launch-time default. A native engine child receiving the
variable is not evidence that an already-running worker received it at launch.

Node documents `process.execve` as experimental; it replaces the process without
running exit/cleanup handlers. The CLI calls it before startup resources are
created. See the [Node 22 process documentation](https://nodejs.org/docs/latest-v22.x/api/process.html#processexecvefile-args-env).
