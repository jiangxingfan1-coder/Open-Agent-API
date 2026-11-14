# Engineering conventions

English · [简体中文](zh-CN/engineering.md)

This document records the day-to-day engineering conventions of the Open Agent API repository. Every rule corresponds to a check that actually exists in the repository; when a rule and a check disagree, the check wins and this document should be corrected.

## 1. Common commands

Commands are defined in `scripts` of `package.json`.

| Command | What it does |
| --- | --- |
| `npm run build` | `tsc -p tsconfig.json`, output to `dist/` |
| `npm run check` | Type check only (`tsc --noEmit`) |
| `npm run format` | Format `src`, `test`, `bench`, `examples`, `scripts/*.mjs`, `web/*.js`, `web/{lib,views,dialogs,shared}/*.js`, `web/*.css`, `web/{styles,shared}/*.css`, `web/portal/*.js`, `web/portal/*.css`, `web/portal/styles/*.css` with Prettier |
| `npm run format:check` | Check formatting only, without changing files |
| `npm run test:offline` | Build first, then run the tests that do not listen on a port (see section 5) |
| `npm test` | Build first, then run all `dist/test/*.test.js` tests, which briefly listen on random ports on 127.0.0.1 |
| `npm run verify` | `check` + `format:check` + `test`, one-step verification; this is what CI runs |

CI (`.github/workflows/ci.yml`) runs `npm ci --omit=optional --ignore-scripts` and `npm run verify` on push and pull request, with Node 24 and Node 26 (the latest of each line, the two lines `engines` supports) on Ubuntu and macOS. The Windows job (also on both lines) runs only the type check, the format check and the packaging-related tests (see [releasing.md](releasing.md)).

## 2. Directory layers and dependency rules

Except for the command-line entry `src/cli.ts`, every file under `src/` sits in a layer directory, exactly one level deep (`src/<directory>/<file>.ts`). The layers are defined in `LAYERS` in `test/architecture.test.ts`:

| Directory | Layer | Contents |
| --- | --- | --- |
| `core/` | 0 | Contracts and foundations: contracts, util, schemas, builtins, suspension, version, locale, plus the error catalog errors (with its English text in errors-en), the event catalog events, the limits catalog limits, and the run-status transition table run-status |
| `config/` | 1 | Configuration and presets: config, agent-presets |
| `lang/` | 2 | The definition language and execution graph: lang, graph, bundle (and the compiler files next to them) |
| `store/` | 2 | Persistence: store, output, inspection, audit |
| `providers/` | 2 | Model access: models, http-stream, provider-state |
| `engines/` | 3 | Agent access (the inner harness): native, acp, a2a, adapter, conformance, process, sandbox, and shared, which is common to the four ways of access |
| `fabric/` | 4 | The distribution network: network, worker, placement, mcp-connections, tool-import, local-backends |
| `kernel/` | 5 | The kernel (the outer harness): kernel, run-state, routing, invocation, response-object and so on |
| `gateway/` | 6 | The gateway and protocols: server, the various `*-routes`, auth, streams, compat-stream, protocol, uap, discovery and so on |
| `client/` | 7 | The client: client, mcp |

The location of `src/cli.ts` is fixed (the packaging scripts and the desktop shell depend on `dist/src/cli.js`), and it may import from any directory.

The architecture test enforces these rules:

- **Imports only point downward**: a file may import only from the same directory or a lower layer. Different directories on the same layer (`lang` / `store` / `providers`) do not import from each other. No file may import `cli.ts`.
- **No import cycles**: files may not form a cycle, and `import type` counts too.
- **Line-count ratchet**: by default each file is at most 600 lines; files over 600 lines are registered in `LINE_BUDGETS`, with the cap being the line count at registration rounded up to a multiple of 50. Budgets may only be lowered: when a file gets shorter, lower its budget to the new line count rounded up to a multiple of 50; do not raise or add a registration just to let a file through, split the file first.
- **No `any`**: the count limit `ANY_BUDGET` for `as any` and `: any` is 0. Take external input as `unknown` first, then narrow it with zod validation, `typeof` checks, or a local narrow type.

When adding a file, first decide which layer it belongs to; if it needs to import something from a higher layer, the responsibility is in the wrong place, and the shared part should be moved down to a lower layer.

## 3. Coding and naming conventions

- **Language and modules**: TypeScript, `"type": "module"`, with `module` and `moduleResolution` set to `NodeNext`. Relative imports always carry the `.js` suffix (for example `import { Fault } from '../core/util.js'`).
- **Compiler checks**: `tsconfig.json` turns on `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns` and `noEmitOnError`. Overriding a parent member needs `override`; a function that returns a value must `return` on every path; a non-empty `switch` branch may not fall through.
- **Formatting**: Prettier, configured in `.prettierrc.json` (single quotes, line width 100, trailing commas `all`). Run `npm run format` before committing.
- **File names**: lowercase kebab-case, such as `run-state.ts` and `compat-stream.ts`; test files are `test/<topic>.test.ts`.
- **Identifiers**: PascalCase for types and classes, camelCase for functions and variables, UPPER_SNAKE_CASE for module-level constants (such as `VALID_STRATEGIES`).
- **Protocol fields and error codes**: stay in English; error codes use snake_case (such as `run_not_found`), and metadata keys use the `oaa.` prefix (such as `oaa.routing_strategy`).
- **Text and comments**: code comments, test names, commit messages, issues and pull requests are in English by default (Chinese is welcome too). Documentation is English first, with the Chinese version under `docs/zh-CN/`; when you change one side, update the other. User-visible text must be bilingual (Chinese and English): console strings in `web/lib/messages-*-zh.js` and `web/lib/messages-*-en.js` (and `web/portal/messages-*.js` for the developer portal), error text in `src/core/errors.ts` and `src/core/errors-en.ts`, command-line and gateway messages written with `bi(zh, en)` from `src/core/locale.ts`, and the showcase pages `site/index.html` (Chinese) and `site/en/index.html` (English).
- **Dependencies**: do not add runtime dependencies casually; when one is really needed, commit it separately and explain why.

## 4. How to add an error code / event

### Error codes

1. In `ROWS` of `src/core/errors.ts`, add a row under its category: `[code, status or statuses, category, retryable, zh, next?]`.
   - `code`: snake_case English; once published it is a stable interface.
   - `status`: the most common HTTP status; when the same code uses different statuses in different situations, write an array (the first is the primary status); when it never appears as an HTTP response (it is only a run error code, or is produced locally by a worker or client), write `null`.
   - `category`: a stable English identifier from `ERROR_CATEGORIES` (`request` `agent` `publish` `run` `approval` `file` `tool` `provider` `engine` `node` `client` `platform`), corresponding one to one to the subsections of the "Error codes" chapter of [protocol.md](protocol.md#error-codes-errorcode).
   - `retryable`: write `R` if the caller retrying as is may succeed (rate limits, timeouts, capacity, a node temporarily unavailable, the gateway shutting down), otherwise `_`; when unsure, write `_`.
   - `zh`: one sentence for users, accurate and not colloquial, at most 40 Han characters; `next`: an actionable next step, optional.
   - Add the English text in `src/core/errors-en.ts`: one row per code, `[en, nextEn?]`, matching `zh` / `next` one to one (`next` and `nextEn` are either both present or both absent), with no Han characters.
   - Scheduling flags: when the code needs "the first model call may be retried on another route if it fails", "does not trigger switching to a fallback agent", or "is treated as an unknown outcome once external execution has started", also add it to the `ROUTE_RETRYABLE`, `FALLBACK_EXEMPT` and `UNCERTAIN_WHEN_STARTED` sets at the end of the file (one code per line). A code in a set must already be registered in `ROWS`, otherwise loading the module fails; `GET /v1/errors` carries the `routeRetryable`, `fallbackExempt` and `uncertainWhenStarted` flags.
2. In the source, throw it as before with `new Fault(code, message, status)` (`Fault` is in `src/core/util.ts`), writing `code` as a string literal where possible. If a code is built by concatenation or assigned outside `Fault`, register it in `DYNAMIC_ERROR_CODES` in `test/error-catalog.test.ts`. A run error code that only ends a run and does not decide the HTTP status (such as `turn_limit`, `token_budget`, `max_output_tokens`, which run-state records as incomplete) is thrown with `new RunErrorFault(code, message)`, carries no status, and has `status` of `null` in the catalog; do not use `new Fault` with a placeholder status or a named constant. Such codes also need classifying: if the cause is the call's own limit or quota, add it to `CALLER_LIMIT` in `errors.ts` (the compatibility-endpoint error body treats it as a 422: Claude `invalid_request_error`, Gemini `FAILED_PRECONDITION`); for service-side causes, register it in `SERVICE_SIDE_RUN_CODES` in `test/error-catalog.test.ts` (treated as a 500: `api_error`, `INTERNAL`). The HTTP status and retry headers are not affected by the classification.
3. In the table of the matching subsection of the "Error codes (`error.code`)" chapter of `docs/protocol.md`, add a row (HTTP status and meaning), and do the same in `docs/zh-CN/protocol.md`.
4. `test/error-catalog.test.ts` (offline) checks that: every `Fault` literal code and dynamic code in the source is in the catalog; the catalog has no duplicate codes; every code appears in both `docs/protocol.md` and `docs/zh-CN/protocol.md`; `zh` is non-empty and at most 40 Han characters; `en` is non-empty and has no Han characters; every HTTP status the code is used with in the code is included in `status` / `statuses`. A code thrown by `RunErrorFault` must be `null` in the catalog, and a code with a `null` status in the `run` category must not be thrown with `new Fault`. `test/overview.test.ts` additionally checks that the codes in the source are all written into the documentation.
5. The catalog is served through `GET /v1/errors` (requires `read` permission, carries an ETag, and a matching `If-None-Match` returns 304), and `features` in `/health` contains `error-catalog-v1`. `revision` is the first 16 hex characters of the sha256 of the catalog content, so it changes whenever the catalog changes.
6. Clients branch on `code`; never rename a code or reuse an old one for a new meaning; `message` may change.

### Run events

1. The shape of a run event is `RunEvent` in `src/core/contracts.ts` (`id`, `runId`, `type`, `time`, `data`). All event types are registered in `RUN_EVENT_TYPES` in `src/core/events.ts`, with a one-line comment for each saying what it means and the key fields of `data`; the type `RunEventType` is exported from it. Names are dotted: `response.*` for external output, `run.*` for the lifecycle, and `tool.*`, `subagent.*`, `approval.*`, `step.*`, `route.*`, `workflow.*` for the rest.
2. To add an event: first add a row (with its comment) to `RUN_EVENT_TYPES`, then write it in the source. The write entry `store.emit(runId, type, data)` and the parameter type of `EventInput.type` are `RunEventType`, so an unregistered name does not compile; the `RunEvent.type` that is read back is still a string.
3. To decide whether a run has ended, use `isTerminalEvent(type)` (`TERMINAL_EVENT_TYPES`: the four terminal `response.*` plus `run.interrupted`); do not write another list in each place. `OUTPUT_EVENT_TYPES` (the output projection) and `TIMELINE_EVENT_TYPES` (timeline reads) are also in the event catalog.
4. Events are written by `src/store/store.ts` in the same transaction as the checkpoint; the kernel commits through the storage layer, and must not bypass storage to assemble event sequence numbers directly.
5. In the matching chapter of `docs/protocol.md` (and `docs/zh-CN/protocol.md`), write down the shape of `type` and `data`. The names, fields and order of existing events can never change; fields can only be added.
6. `test/event-catalog.test.ts` (offline) checks that the literals used as event names in `core/`, `store/`, `kernel/`, `gateway/` and `fabric/` are all in the catalog. The event streams the compatibility endpoints (OpenAI / Claude / Gemini / UAP) expose must not change because of this (see section 7).

### Run status

The legal transitions of `Run.status` are registered in `RUN_TRANSITIONS` in `src/core/run-status.ts` (re-exported by `kernel/run-state.ts`); the storage layer checks against the table before persisting, and an illegal transition throws `invalid_run_transition` without writing. To add a state transition, first register it in the table (one comment per edge stating its trigger) and then change the kernel; the rules are in [architecture.md](architecture.md#32-run-state-machine) ("3.2 Run state machine"), and the test is `test/run-transitions.test.ts`.

## 5. Test categories and which to run when

Tests use Node's built-in `node:test`; the source is in `test/*.test.ts`, compiled to `dist/test/*.test.js` and run with the concurrency fixed to 1.

| Category | How it is decided | How to run |
| --- | --- | --- |
| Offline tests | The file contains none of `.listen(`, `WebSocketServer(`, `createServer(` | `npm run test:offline` |
| Tests that listen on a port | The file contains any of the above | Only with the full `npm test` |

- `scripts/test-offline.mjs` picks the offline files automatically by the rule above and hands them to `node --test --test-concurrency=1 --test-timeout=120000` (plus an overall limit of 20 minutes, after which it ends the process tree and reports an error; it does not use `--test-force-exit`, which would let some tests go unexecuted) (any single item that hangs is reported as a failure by test name within 2 minutes), and returns the exit code unchanged; it exits non-zero when it picks no file or the build output is missing. With `--isolate` (used by `.github/workflows/windows.yml`) every test file runs in its own `node --test` process with its own limit (3 minutes, `OAA_TEST_FILE_TIMEOUT_MS`); a file that times out has its process tree ended (`taskkill /T /F` on Windows), is recorded as a timeout, and the next file still runs; a summary lists failed and timed-out files and the exit code is non-zero if any did not pass. It preloads `dist/test/setup-locale.js`, which fixes the language to Chinese so that results do not depend on the system locale of the development machine or CI; a test that needs English passes `OAA_LOCALE=en` or `Accept-Language` itself.
- Tests that listen on a port always use `port: 0`, listen briefly on a random port on 127.0.0.1 only, use test stand-ins instead of real models, do not reach the outside network, and never take the desktop app's port 8787. `test/sandbox-srt.test.ts` starts srt's local proxy, and deliberately contains `createServer(` so that it falls into the port-listening category.
- **When to run**: run `npm run check` and `npm run test:offline` often while working; run `npm run verify` (which includes the full tests) before committing and before merging. Before running tests that listen on ports on your own machine, confirm according to your personal convention whether that is allowed.
- `test/architecture.test.ts` is an offline test that reads only `src/` statically; run it first after changing structure.
- A pure refactor does not change test assertions (only import paths may change); for a functional change, write the failing test first and then implement.

## 6. Commit message format

- English is preferred and Chinese is also welcome. The format is `scope: what changed`, for example `engineering: add the offline test entry test:offline and one-step verify`, `types: remove every any in src`, `structure: put src into layer directories`. Common scopes: `engineering`, `structure`, `types`, `tests`, `formatting`, `deps`, `planning`, `OAA-Lang` (in Chinese: `工程`, `结构`, `类型`, `测试`, `排版`, `依赖`, `规划`; the Chinese form is `范围：做了什么`).
- One commit does one thing; `git add` only the files you changed, and do not use `git add -A`.
- A commit produced in collaboration with an agent ends with a `Co-Authored-By:` line.

## 7. Compatibility red lines

The following are commitments to the outside, and no change may break them:

- **Wire bytes**: for an existing request under existing conditions, not one byte of the wire output may change. The compatibility streams have byte-for-byte tests (`test/observability.test.ts`, with the same workload as `bench/protocol-speed.ts`: UAP NDJSON 10,238 bytes, OpenAI Chat SSE 55,219 bytes), and those assertions may not be changed. When refactoring request parsing, only types may change, not runtime logic.
- **Storage schema**: do not change the SQLite schema (currently schema v4, that is, `SCHEMA_VERSION` in `src/store/store.ts`). When a migration is truly needed, it must be designed and reviewed separately, and must guarantee that old databases can be upgraded.
- **Node wire protocol**: the messages between the gateway and execution nodes (see "Node wire protocol" in [protocol.md](protocol.md#node-wire-protocol)) must keep existing fields: no renaming, no deletion, no change of meaning; only optional fields may be added.
- **Error codes and events**: published error codes and event fields are stable interfaces too (see section 4).
- **Attribution**: the Apache-2.0 attribution in the header of `src/config/agent-presets.ts` and in `THIRD_PARTY_NOTICES.md` must be kept.
