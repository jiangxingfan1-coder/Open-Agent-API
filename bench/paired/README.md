# Paired Runtime Benchmark

This is a **model-free engineering comparison**, not a live-model quality, cost, HTTP-service, or cross-machine benchmark. It runs the unmodified AgentScope 2.0.11 `Agent` loop and the real OAA kernel. Neither has a provider credential. No model or tool implementation is silently substituted for a missing framework.

## Setup

Python is optional for OAA itself. Use an isolated environment only for the comparison:

```sh
python3 -m venv .oaa-bench/agentscope-venv
.oaa-bench/agentscope-venv/bin/python -m pip install \
  --only-binary=:all: --require-hashes \
  -r bench/paired/requirements-macos-py313.lock
npm run bench:paired -- --samples 15 --out .oaa-bench/paired-new.json
```

The lock records the exact wheels tested on macOS arm64 with Python 3.13. On another platform, resolve `requirements.txt` into a separate environment and retain its installer report; do not claim dependency equivalence. The runner checks the AgentScope version and records its core source hashes and installed package versions. `--python /absolute/path/to/python` selects that environment. It never installs dependencies itself.

The pinned [AgentScope release](https://github.com/agentscope-ai/agentscope/tree/v2.0.11) uses its native model, toolkit, event and concurrent-tool interfaces. The PyPI wheel used for the initial verification has SHA-256 `9b602aebc76d349425193469f2c4dd413d2bff837a4d22b27cac57653349877a`. The reference paper [AgentScope 1.0](https://arxiv.org/abs/2508.16279) is background, not evidence for this later release's measurements.

## Controls

- Four profiles: OAA serial/parallel and AgentScope serial/parallel. AgentScope's parallel tool is explicitly concurrency-safe; its serial variant is only a control.
- Three fixed shapes: direct answer, three independent source reads, and a three-step dependent read chain.
- One shared scripted-model/tool oracle controls input, JSON schema, source data, artificial delays, budgets and expected results. Fresh proof markers must reach the model through actual tool results. Forged, replayed, rejected or unfinished calls invalidate the trial.
- Base instructions match. Framework-added system context does not necessarily match; hashes and byte sizes are recorded. Scripted token counts are bookkeeping only, not measured tokens or money.
- No host tools, model SDK endpoints, native agents or private skills are exposed. Child environments do not inherit provider credentials. The Python fixture also rejects socket/subprocess audit events; this is not a general-purpose OS sandbox.
- Trial order rotates to reduce order bias. Both engines get fresh sessions. Cold means the first request after a fresh process becomes ready, not a cold OS cache. Process readiness time is separate.

## Evidence And Limits

Every trial records first framework event and its type, first nonempty framework text delta, validated completion, observed concurrency, model/tool counts, declared fixture usage and the trace. Failed trials remain failures; they cannot become successes merely because a canned answer matches. The final latency includes the same controller-side validation for both engines. Reports use exclusive creation and are never overwritten.

Executed Node/Python adapter code and selected OAA source/compiled files are retained under the report's `source_snapshot`. The adapters run from that snapshot. Its `node_modules` link points to the current project's dependencies; the snapshot is read-only provenance, **not** a standalone install workspace. Do not run package installers inside it. Dependency lock changes during recording invalidate the run.

OAA performs SQLite `synchronous=FULL` checkpoint/output persistence; the AgentScope SDK baseline uses in-memory `AgentState` without persistence middleware. This is a material feature difference. Source snapshots, dependency fingerprints and explicit limitations must accompany any reported timing. The suite does not establish the 30% real-model target, general superiority, private-skill quality, or equivalent durability.

`npm test` validates the oracle and OAA transport with no Python dependency. Running `bench:paired` with all four profiles is the independent-framework check. A restricted `--profiles oaa-serial,oaa-parallel` run explicitly records `independent_framework_tested: false`.

## Opt-In Diagnostics

`--profile-oaa` adds benchmark-only method spans and SQLite statement/transaction counts to each OAA trial. Reports are marked `measurement_mode: "instrumented_oaa"`; ordinary runs remain `latency_only`. Async spans are inclusive and can overlap, so do not add their durations or compare instrumented latency with uninstrumented latency. Count explicit `sqlite.commit` and `sqlite.autocommit_write` separately when investigating transaction overhead. These hooks do not reduce SQLite durability or change tool permissions.

For a before/after latency comparison, use the retained baseline's `source_snapshot/dist/bench/paired/run.js` and the current runner with identical profiles, sample counts and measurement mode, writing separate reports. The scripts use frozen adapter sources and the recorded shared workload. Runtime load and filesystem caches can still vary; fewer commits alone are not an end-to-end speedup result. Keep the independent-framework comparison separate from this within-OAA comparison.
