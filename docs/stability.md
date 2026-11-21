# Stability: long runs, crash recovery, upgrades and data retention

English · [简体中文](zh-CN/stability.md)

This page answers three operator questions with evidence from this repository:
can a gateway run for a long time without leaking, does an upgrade keep the data, and does the
database stop growing. Every number below comes from a tool you can rerun yourself.

## 1. Soak test (`npm run soak`)

```
npm run soak -- --minutes 30 --concurrency 8 --retention-minutes 5 [--dir DIR] [--keep]
```

The load generator's `--concurrency` counts clients, not execution slots. To compare local worker capacity without changing a deployment, run e.g. `npm run soak -- --minutes 30 --no-restarts --concurrency 8 --worker-slots 6`. The optional slot override applies only to the isolated test gateway; the report includes the configured capacity and sampled active jobs.

Add `--profile-prune` to separate maintenance queue time from candidate selection, write-lock acquisition, deletion, commit, file cleanup, yielding and the WAL checkpoint. The report includes P99 for operations finishing before, during and after the manual CLI call, lightweight health probes during it, and the gateway event-loop intervals that overlap it. A percentile with few samples is not a service SLO. V8 physical heap, array buffers and best-effort OS memory summaries help distinguish steady heap from growing resident memory; their sizes overlap and must not be added together.

For cross-owner webhook latency, run `npm run bench:webhook-isolation -- --out result.json`.
One owner starts with 32,000 queued deliveries and 32,000 recovery rows across eight endpoints.
Another submits 256 background runs with four loopback clients. A separate process measures HTTP
submission and signed notification latency with no backlog, a waiting backlog, and an actively
recovering backlog. The report also measures time to promote the entire backlog; promotion is
not delivery to the remote receiver. It uses a fixture model, not a production latency target.

To measure upload latency as a caller's file history grows, run
`npm run bench:upload-quota -- --rows 128000 --samples 512 --clients 6 --out result.json`.
The fixture compares an empty history with a large one, with and without a storage cap. A separate
process times real HTTP uploads, another owner's file reads during those uploads, and rejections
after the cap is full. Historical metadata is synthetic; no user files or model accounts are used.
With a cap enabled, the SQLite connection caches at most 256 caller totals. Eviction favors keeping
frequently checked callers over one-off callers; this does not limit how many callers may upload.
External commits invalidate those totals; a cold check rebuilds from the caller's file
records. Retention subtracts a known file size in the same transaction as deletion; an unknown
size instead forces a fresh count. In-flight reservations are always read from the database,
including on a cache hit.

For simultaneous first uploads after restart, run
`npm run bench:upload-cold-start -- --accounts 8 --rows 128000 --restarts 16 --out cold.json`.
Each gateway process serves a cold and a warm burst against the same disk database, while a
different caller reads a real file. The report includes upload and reader latency, reader
response gaps through the whole burst, and one-byte over-limit rejections. The OS disk cache is
not cleared. Add `--compare PATH_TO_PRIOR_DIST` to alternate two local builds in AB/BA order.

New catalogs created with a storage cap store the chargeable byte count in the existing
owner/subject index. Fresh uncapped catalogs keep the cheaper, scope-only write path. Quota reads on the new layout
no longer need the wider digest index; duplicate-file lookup still uses it. Existing
`scope-only` catalogs keep working and are **not rebuilt during startup**. Inspect one with
`oaa file-index --config PATH` (read-only, including on a live gateway). To upgrade, stop the
gateway normally and run `oaa file-index --config PATH --write`. A `scope-bytes` result needs
no further action. Changing a cap does not rebuild an existing index in either direction.
To return to the lighter write layout, use `oaa file-index scope-only --config PATH --write` offline.
The byte key costs space and work on inserts. This command replaces just one recognized index in a transaction; it neither deletes
files or runs nor changes their rowids. Allow disk space for building the index and its WAL.
It does not compact or shrink the whole database. If a commit cannot be confirmed, inspect
the layout without `--write` before trying again.

Add `--profile-reader` to the capped cold-start benchmark to record the first successful request
per account: preflight, initial wait, indexed SQL, time between queries (including service of
other accounts), handing the result back, and writing. These spans are measured inside the
fixture; the HTTP clock stays in the separate client. `--mixed-history` includes varied sizes,
duplicate digests and restricted inputs. With `--compare`, `--seed-layout legacy` keeps the old
layout and `--seed-layout upgraded` applies the offline operation to the **private fixture only**.

A capped gateway can prepare one read-only helper when the catalog has at least 4,096 files;
it does not rebuild every caller's total at startup. Only a cold caller with at least that many
files is sent to it. Concurrent requests for the same owner and subject share the count, not
their authorization or reservation. A changed or unavailable snapshot is never used as proof
of room: the serving connection can count again, and still checks outstanding reservations inside
the write transaction. Uncapped gateways start no helper. The thread retires when idle.

After five seconds without a completed page, the gateway asks the helper to relinquish that
caller's scan. Advancing row counts can keep it running up to a 15-second handoff deadline;
timer ticks and other callers' progress do not extend it. A released, complete-page prefix
can be resumed on the serving connection only under the original, still-current scan ticket.
The last reported checkpoint can also be used after a confirmed thread exit, but never while
the old read is still running or under a later upload's ticket.
If a native read cannot acknowledge release and its thread has not actually exited, affected
uploads get `503 upload_busy` and `Retry-After`, not a competing scan. No file is accepted on
this response. Other scopes may still use their own totals or the paged fallback.
Graceful shutdown retains the data-directory lease until the helper actually exits.

On fallback, different callers take turns scanning the existing index; no writer lock or cursor
is held between pages. If the last waiter disconnects the gateway asks the helper to stop, and no
further local pages are read for that request. An edit
that invalidates a partial count restarts that count. If even the reservation's final check
goes stale, the gateway releases the writer before recounting. Continued changes can return
`503 upload_busy` with `Retry-After`; no new file is accepted on that response. A single
slow disk read may still stall a page, and finishing a batch can take longer than one blocking scan.

To reproduce the degraded path, add `--helper-timeout` to the cold-start benchmark. This withholds
fixture worker messages and waits for the real timeout; it does not slow the device artificially.
The `fallback` section measures other-owner reads and upload completion **after** that timeout.
On a filesystem supporting clones, `--fresh-copy` puts the closed fixture catalog on a new inode
before each start. To measure rather than assume whether its OS pages are cold on macOS/Linux,
compile `bench/file-residency.c` with `cc -O2` and pass the executable via `--page-probe PATH`.
The probe reads page-residency metadata only. Neither option flushes host or device caches.

To exercise an active reader rather than a lost message, run
`npm run bench:upload-reader-handoff -- --scenario progress`. Use `blocked` to hold a native SQLite
operation on a separate disposable database, or `ceiling` to observe a cooperative deadline
handoff. Use `exit` to stop the private fixture worker after its first completed-page report.
The fixture records rows visited, overlap with a local recount, and accepted bytes.
The pacing and lock are injected; these results are not measurements of a failing physical drive.

`bench/soak.ts` is not part of `npm test`. It:

- starts a **real gateway process** (`node dist/src/cli.js serve`) with a temporary `HOME` and data
  directory on a random `127.0.0.1` port. A small preload (`bench/soak-probe.ts`) records the
  process's own RSS, heap and active handles; nothing else in the process changes;
- serves a deterministic, OpenAI-compatible fake model on another loopback port, so the built-in
  agent `agent/fixture` exercises the real provider path without any network or account; the
  offline ACP sample agent (`examples/sample-agent.mjs`, a private copy per run) covers external
  agents and approvals; a loopback webhook receiver has one healthy endpoint and one that answers
  500 to 30% and times out on 10% of deliveries, so the retry queue is exercised;
- drives a weighted mix over HTTP: Responses / Chat Completions / Claude Messages / Gemini
  non-streaming calls; streaming calls (30% of clients disconnect after the first frames);
  background runs with polling; continuations (`previous_response_id`); cancellations at
  different moments; approvals (approve, deny, or leave until the 10 s approval timeout expires);
  idempotent replays; invalid requests (bad key, bad parameters, a 25 MiB body); event-stream
  subscriptions that disconnect; the console's overview, activity, run list, timeline and state;
  caller tools through the `auto` bridge (tool call out, result back); structured output
  (`json_schema`, 30% needing a correction round); inline image input; billed calls with a
  developer-platform account key (per-run price, one in five cancelled); and one `oaa prune`
  (through the running gateway) half-way through;
- samples every 10 s: RSS, V8 heap used after a forced GC and heap committed, off-heap
  (`external`) memory, handles, open file descriptors (`lsof`), child processes
  (`pgrep -P`), database and WAL size, data directory size, run count, unfinished runs, request
  latency percentiles and unexpected errors;
- restarts the gateway three times during the run (SIGTERM at 20%, **SIGKILL** at 40%, SIGTERM at
  60%) and after each restart checks: the gateway is healthy again, every run that completed in
  the minute before the stop is still `completed`, no run is left `in_progress` by the old
  process, no agent process outlived it; it then resumes a few interrupted runs as an operator
  would;
- drains at the end and checks that no run is left `queued`, `in_progress` or `requires_action`,
  that the final SIGTERM stops within 30 s, that no agent process is left, and that
  `PRAGMA integrity_check` is `ok`;
- `--no-restarts` runs one long segment; `SOAK_SNAPSHOT_DIR` with `SOAK_SNAPSHOT_MINUTES=10,30,55`
  writes heap snapshots of the gateway (forced GC first) for leak hunting;
- writes `report.json` (all samples, trends with least-squares slopes, failures) and
  `summary.txt` into `--dir`, and deletes the run's data unless `--keep` is given. It stops early
  if the data directory exceeds 2 GB. The tool runs on macOS and Linux (it uses `lsof`, `pgrep`,
  `du` and POSIX signals); it is not supported on Windows.

### Pass criteria (in the tool)

| Criterion | Threshold |
| --- | --- |
| Unexpected error rate | < 0.5% of requests. Requests that fail because of a deliberate restart (refused connections, runs interrupted by it) are counted separately as `restart_window`. |
| RSS of the last segment (first 2 min excluded) | at least 20 minutes: slope < 1 MB/min. Shorter (the last segment of a run with restarts): its peak at most 1.25 × the first segment's peak, because RSS moves by ±25 MB within minutes and a slope fitted over 10 minutes mostly measures that. Not judged in a run that wrote heap snapshots: writing one makes the process allocate about its heap size again, and the allocator keeps much of it for tens of minutes (observed +100 to +150 MB, returned about 30 minutes later). |
| Heap growth after the last restart (first 2 min excluded) | slope < 0.5 MB/min |
| Open file descriptors after the last restart | slope < 1 per min |
| Child processes | never more than concurrency + 4 |
| Database + WAL with retention on (run ≥ 3× retention) | second-half slope < 1% of its mean per minute |
| Restart and recovery checks | all pass |

### Latest result

Measured on 2026-11-14 on macOS (Apple Silicon), Node 24, concurrency 8, retention 5 minutes, on
the code of this release.

| | 32 min, restarts (SIGTERM, SIGKILL, SIGTERM) | 62 min, one segment |
| --- | --- | --- |
| Requests | 34,010 ok, 0 unexpected, 24 inside restart windows | 67,799 ok, 0 unexpected |
| Latency p50 / p95 / p99 (all operations, approval waits included) | 206 / 784 / 1,709 ms | 204 / 763 / 1,671 ms |
| Heap after GC (settled) | 39 → 42.5 MB in the last segment, slope −0.05 MB/min | 38 → 44 MB, slope 0.008 MB/min |
| RSS (settled) | last segment 216–271 MB; peak 0.97 × the first segment's | 236–261 MB, slope −0.16 MB/min |
| Database + WAL | 64.9 MB, flat over the second half | 69.2 MB from minute 15 to the end |
| FDs / handles / child processes | flat | flat (35–49 / 16–39 / ≤ 4) |
| Recovery checks | all passed: healthy again in 0.7–0.9 s; runs completed in the minute before each stop intact; the SIGKILL left 5 `in_progress` and 3 `requires_action` runs, all `interrupted` after the restart; no orphan agent process | — |
| `oaa prune` during the load | 1.2 s for 2,604 runs and 40,924 events, while serving | — |

Both runs pass every criterion. (The RSS rule for short segments was revised after the 32-minute
run, whose 10-minute last segment had a fitted slope of 1.9 MB/min while staying inside the band
the 62-minute run shows for an hour; the ratio above is computed from that run's report.) Memory, by part (62-minute run): the V8 heap holds 38–44 MB of live
data and keeps about 185 MB committed (V8 sizes its spaces for the allocation rate and does not
shrink them while load continues); off-heap `external` memory stays at 4–8 MB; SQLite's page cache
is capped at 16 MB by `cache_size=-16000` and memory-mapped I/O is off (`mmap_size` is not set, so
0). The rest of RSS is code, the Node runtime and allocator slack; RSS stayed between 236 and 261 MB
for the last 55 minutes.

### What the soak found and fixed

1. **A 30-minute timer per execution.** Every execution armed an `AbortSignal.timeout` with the
   agent's `limits.timeoutMs` (30 minutes by default). It cannot be cleared, so every finished run's
   signal graph stayed reachable for 30 minutes: the post-GC heap grew by about 1.3 MB/min. Fixed
   with a clearable timer (`deadlineTimer`); `test/retention.test.ts` fails if a run arms a long
   uncancellable timeout again.
2. **Empty Node timer lists.** Node keeps one internal list per distinct timer duration, and
   clearing an *unref'd* timer leaves its emptied list in place until that duration has elapsed
   (measured: 3,000 such lists right after clearing, none once the durations had passed). So this
   was a backlog that scales with load and with the length of the deadlines (30 minutes by default),
   not an unbounded leak. The overview's revision
   timers, the node wake-up timer and the webhook dispatcher re-armed unref'd timers with exact
   `deadline - now` durations, so each re-arm could leave one list behind (18,292 lists after 30
   minutes; about 0.25 MB/min). Those timers now use `coarseDelay` (rounded up to two significant
   digits, at most 10% late), which reuses a few hundred lists; a test checks the Node behaviour and
   the bound in a child process.
3. **The activity window kept pruned runs.** The console's activity cache holds up to 100,000 run
   summaries per view for its 24-hour or 7-day window (that is its designed bound). It kept runs
   that a prune had deleted until they aged out, and the overview caches were not told. A prune now
   rebuilds that cache and sends the same change notification a run change sends.
4. **A failing webhook endpoint queued without bound.** An endpoint holds its serial queue while
   it retries a delivery (up to about 42 minutes), and new events keep being queued behind it: 32,704
   deliveries in 32 minutes in the soak, 14 MB and growing. At most 10,000 deliveries now wait per
   endpoint; the oldest beyond that (after the one in progress) are marked `failed` with
   `queue_overflow` and trimmed (docs/webhooks.md).
5. Smaller: pre-migration backups are capped at 3 per source version; `server.log` rotates at
   10 MB (best effort, so a file locked on Windows does not stop the start); a pruned session
   workspace is rebuilt instead of reused from the worker's cache.

Before fixes 2–4, a 65-minute run showed the post-GC heap growing by 0.29 MB/min and the database
by 0.8 MB/min; after them, by 0.008 and 0.0 MB/min.

## 2. Crash recovery semantics

What a run looks like after the gateway stops, by how it stopped:

| Run state at the stop | Graceful stop (SIGTERM, `oaa stop`) | Crash (SIGKILL, power loss) |
| --- | --- | --- |
| `completed` / `failed` / `cancelled` / `incomplete` | unchanged | unchanged (SQLite WAL, `synchronous=FULL`) |
| `queued` | stays `queued`; the next start runs it | same |
| `in_progress`, built-in agent | `interrupted` (`gateway_restarted` or `effect_outcome_unknown`) | `interrupted` at the next start (`store.recover`) |
| `in_progress`, external agent (ACP, native, adapter) | `interrupted`, `effect_outcome_unknown`: a started turn cannot rule out side effects | same |
| `requires_action` (approval) | `interrupted`; the pending approval is expired | same, at the next start |
| `requires_action` waiting for a caller-side tool result | kept; the caller can still answer | same |
| Parked kernel step whose required decisions all committed, before scheduling resumed | the scheduler consumes those decisions after restart; a denied or expired decision does not dispatch work | same |
| queued delegated child whose parent is no longer active | `cancelled`, `parent_interrupted` | same |

A queued or parked cancellation expires its pending actions in the same transaction as its terminal event. If that write fails, the run keeps its queue position or approval wait. A batch of caller tool results likewise commits all results and its output cursor together, or none.

`interrupted` is final for display and accounting, but not for the operator: `POST
/v1/runs/{id}/resume` (or `oaa resume`) continues it, and a step with an unknown external effect
must be reconciled first (`POST /v1/runs/{id}/reconcile`). Recovery is manual by default. For
[opt-in durable runs](workstation.md#durable-runs), startup selects eligible interruption records in pages of 64. An accepted automatic resume commits its attempt count and recovery marker with its queue reservation. Unknown side effects still require reconciliation. External agent processes are children of the gateway; they exit when it exits
(the soak checks that none survive SIGTERM or SIGKILL).

**If SQLite temporarily cannot write:** an active run retains its slot and does not settle usage
until its terminal checkpoint is durable. The final writer tries the lock without blocking the
event loop and retries contention with backoff. `OAA_CHECKPOINT_RETRY` means a local write is
waiting, not that the model or tool is running again. Output already saved can still complete;
output that never reached storage is not reported as successful. An unconfirmed external effect
requires reconciliation. On shutdown, recovery uses the last committed state. A responding
`/health` is not proof that new writes will succeed. These retries do not repair a corrupt database.

New HTTP run submissions (including media jobs and workflow drafts) wait for SQLite's writer
without blocking the gateway. The wait is at most the connection timeout or five seconds,
whichever is shorter. One FIFO admits at most eight waiting requests per owner and 64 in total;
pending request bodies are also budgeted at 32 MiB per owner and 64 MiB per gateway. On pressure
or expiry the caller gets `503 admission_busy` and `Retry-After: 1`, with no run or usage reservation.
An already-committed idempotent replay needs no writer. Waiting requests recheck authorization.
Disconnecting before admission abandons the wait; it does not cancel a run already committed.
This applies to creating the run, not to every database write. File-byte reservation and
publication have their own cooperative writer wait (at most five seconds). Contended writers
and followers of an identical in-flight image are separately bounded to eight waiters / 32 MiB
per owner and 64 waiters / 64 MiB overall. These are buffered byte budgets, not a limit on total
process memory or the duration of a file transfer.
If a waiting request abandons an inline image, another waiting request can still use its copy.
The input journal rolls back abandoned materialization even after restart, independently of
retention. It records deletion before unlinking and keeps the receipt until absence is confirmed.
It does not sweep unmarked files. In particular, an empty filesystem entry left before the first
journal write contains no image bytes or quota row and is left to ordinary orphan-blob retention.

## 3. Upgrades, backups and downgrades

- The storage schema version is `PRAGMA user_version` (currently 4). Every start migrates older
  databases inside one `BEGIN IMMEDIATE` transaction; a failure rolls back and leaves the database
  at its old version (tests: `streaming.test.ts`, `node-policy.test.ts`). Tests cover upgrades from
  schema 1, 2 and 3 and from a real 0.0.64 database (`test/upgrade.test.ts`,
  `test/fixtures/upgrade-0.0.64.sqlite`).
- Before migrating an existing database the gateway writes a full copy to
  `<dataDir>/backups/state-v<old>-before-subjects-<time>.sqlite` (mode 0600). A failed copy aborts
  the start. Only the newest 3 copies per source version are kept, so a supervisor restarting a
  failing gateway in a loop cannot fill the disk. A database already at the current version is
  never copied. Backups are not deleted otherwise; remove them yourself once the upgrade is
  confirmed.
- A database from a newer gateway (`user_version` above what the binary knows) is refused with
  `schema_too_new` ("This data directory requires a newer gateway.") and is not modified.
- 0.0.64 already uses schema 4, so moving between 0.0.64 and this version in either direction needs
  no migration and writes no backup.
- `npm run upgrade-check -- --old "<path to an older release>/Contents/Resources/oaa"` repeats the
  whole check with real binaries: the older release runs `quickstart`, creates a managed key, a
  portal account, a completed run, an approved run and a pending approval, and stops; the current
  build serves the same directory (runs listed, completed runs intact, the pending approval
  `interrupted`, the quickstart key, managed key and portal login still valid, console endpoints
  answering, no backup written); the older release then opens the directory again, refuses a
  future-schema database without changing it, and refuses a config with fields it does not know.
  With `--fixture-out FILE` it also writes the scrubbed fixture used by the tests.

### Configuration compatibility

The configuration schema is strict. A config written for an older version keeps working: every
new field is optional and defaults to the old behaviour (for example, `retention` is absent, so
nothing is deleted). A config containing a field the binary does not know, including a typo, is
refused at start with a validation error that names the field; nothing in the data directory is
touched. So before going back to an older version, remove fields it does not know (such as
`retention`).

## 4. Data retention and `oaa prune`

What grows with use, and what bounds it:

| Data | Where | Bounded by |
| --- | --- | --- |
| Runs, events, steps, approvals, output baselines, run summaries, per-run key usage rows, webhook approval announcements | `state.sqlite` | `retention.runsDays` / `oaa prune` |
| Artifacts (files produced by runs) | `files` table + `<dataDir>/files/` | deleted with their run |
| Uploaded files, including stored image inputs | `files` table + `<dataDir>/files/` | `oaa prune` when older than the cutoff and not listed by a kept run (image inputs are listed in their run's `fileIds`); the per-caller stored-bytes quota counts these rows, so it drops after a prune |
| Webhook deliveries and recoverable notifications | `webhook_deliveries`, `webhook_outbox` | at most 200 finished deliveries per endpoint; at most 10,000 waiting across both tables per endpoint |
| Session workspaces of the local worker | `<worker dataDir>/sessions/` | `oaa prune` when no run of the session remains and the folder is older than the cutoff |
| Audit events | `audit_events` | kept per owner up to a fixed count (existing) |
| Portal sessions | `platform_sessions` | expire after `platform.sessionTtlHours` (existing) |
| Key usage totals, platform ledger, memories, agent versions | database | not pruned: they are account and billing records, or user data. The portal's run detail shows a pruned run as no longer available; ledger and usage pages keep working from the ledger |
| `server.log` of `oaa serve --detach` / `quickstart` | `<dataDir>/server.log` | rotated to `server.log.1` at start when larger than 10 MB (one generation) |
| Pre-migration backups | `<dataDir>/backups/` | newest 3 per source version |

**Retention is off by default.** Without a `retention` block no accepted run or ordinary upload
expires automatically. Rolling back a journaled, unclaimed input is not a retention policy.

```json
"retention": { "runsDays": 30, "intervalMinutes": 60, "warnDatabaseMb": 1024 }
```

- `runsDays` (optional, may be fractional): prune finished runs whose last update is older than
  this, every `intervalMinutes` (default 60; first pass 5 s after start).
- `warnDatabaseMb` (default 1024): `oaa doctor` reports the database size (`database.bytes`) and
  adds a warning above this size, and `oaa status` prints a note. It never deletes anything.

`oaa prune [--older-than 30d] [--dry-run] [--vacuum] [--config FILE]`

- `--older-than` accepts `30d`, `12h`, `45m`, `90s` or a bare number of days (default `30d`).
- `--dry-run` reports what would be removed (runs, events, files and bytes) without deleting.
- With a gateway running at the configured address, the command calls
  `POST /v1/maintenance/prune` with the admin key (owner-wide admin only; minimum age one minute)
  and prunes that owner's runs. Otherwise it opens the data directory itself; it takes the gateway
  lease, so a gateway cannot start meanwhile, and also sweeps workspaces and orphaned blobs.
- `--vacuum` (gateway stopped only) runs `VACUUM` afterwards to give the space back to the file
  system; it needs free disk space about the size of the database and blocks while it runs.

What is never pruned: runs that are `queued`, `in_progress`, `requires_action` or `interrupted`;
runs younger than the cutoff; a run whose developer-platform ledger line is still `in_progress`
(it is settled from the run at the next reconciliation); delegated descendants of a kept ancestor; files still listed as inputs or artifacts by a
kept run. When a producer is pruned, a retained artifact keeps its original agent read requirement, owner and subject. Continuing a run that was pruned returns 404, like any
unknown response ID.

How it runs: candidate runs are deleted in batches of 200 inside short `BEGIN IMMEDIATE`
transactions, yielding to the event loop between batches, so requests keep being served. Blobs
are removed after their rows commit; a crash in between leaves orphaned blobs, which the next
prune removes. On a live gateway a contended write lock is retried between event-loop turns within the existing SQLite timeout. After deletion the gateway uses a passive WAL checkpoint rather than waiting for long-lived readers; the WAL may stay allocated for reuse. An offline prune still uses a truncating checkpoint. Without `--vacuum`, SQLite reuses the freed pages, so the file stops
growing at the size of the retained window instead of shrinking.

## 5. Known limits

- The soak uses a fake model server and the offline sample agent. Real providers and real agent
  CLIs add their own latency, memory and failure modes that it does not measure.
- Workspaces on remote worker nodes are not pruned; only the local worker's `sessions/` folder is.
- The prune route prunes one owner at a time and does not sweep workspaces; use the offline
  `oaa prune` (or `retention.runsDays`) for that. `oaa prune --vacuum` with a running gateway is
  refused with `gateway_already_running` (the gateway holds the database); stop it first.
- `interrupted` runs are kept until an operator resumes or reconciles them; they are not pruned.
- There is no automatic `VACUUM`; the database keeps its high-water size until `oaa prune --vacuum`.
- The longest measured run is 62 minutes without restarts. Caches with designed bounds (for
  example the activity window, up to 100,000 summaries per view) fill over hours at low retention,
  not minutes; a gateway with a long `runsDays` holds more of them.
- The soak tool needs macOS or Linux.
- In one 32-minute attempt the gateway restarted after the SIGKILL needed about 110 s before it
  answered `/health`, and the older harness gave up after 30 s. It did not happen again in three
  further SIGKILL restarts (0.7–1.0 s), nor when the same data directory was killed and reopened by
  hand (1 s). The cause is not known; the harness now waits up to 3 minutes, reports a start over
  30 s as a failed check, and its probe records when JavaScript starts so a repeat can be split
  into process start-up and gateway initialisation.
- Downgrades are supported only between versions with the same schema version.
