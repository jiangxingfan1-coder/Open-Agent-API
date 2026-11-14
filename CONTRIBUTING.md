# Contributing

English · [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for helping improve Open Agent API. This guide explains how to set up the environment, how to verify a change, which conventions the code follows, and how to file issues and pull requests. More detailed engineering rules are in [docs/engineering.md](docs/engineering.md); when a rule and a check in the repository disagree, the check wins.

By taking part in this project you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please do not file security vulnerabilities as public issues; report them privately as described in [SECURITY.md](SECURITY.md).

## Language

The project serves readers in English and in Chinese, so the repository is bilingual. The conventions are:

- **Code comments, test names, commit messages, issues and pull requests**: English is preferred; Chinese is also welcome, and nobody will turn a contribution away because of its language. A lot of existing code still has Chinese comments and test names; you do not need to translate code you are not changing, and new code should use English.
- **Documentation**: English first. Each document `docs/X.md` has a Chinese counterpart `docs/zh-CN/X.md`, and the root files have `*.zh-CN.md` counterparts (`README.zh-CN.md`, `CONTRIBUTING.zh-CN.md`, `SECURITY.zh-CN.md`, `CODE_OF_CONDUCT.zh-CN.md`, `CHANGELOG.zh-CN.md`, `ROADMAP.zh-CN.md`). When you change one side, update the other in the same pull request. If you can only write one language, say so in the pull request description and a maintainer will help with the other.
- **User-visible text must be bilingual (Chinese and English)**. In particular:
  - console strings in `web/lib/messages-*-zh.js` and `web/lib/messages-*-en.js` (the developer portal uses `web/portal/messages-zh.js` and `web/portal/messages-en.js`); the two languages must have exactly the same keys;
  - error text: `zh` / `next` in `src/core/errors.ts` and `en` / `nextEn` in `src/core/errors-en.ts`;
  - command-line and gateway messages, written with `bi(zh, en)` from `src/core/locale.ts`;
  - the showcase pages `site/index.html` (Chinese) and `site/en/index.html` (English).
- Protocol fields, JSON field names, error codes, commands and file paths always stay in English.

## License

This project uses the [Apache License 2.0](LICENSE). Under section 5 of that license, a contribution you intentionally submit to this project is licensed under the same license unless you explicitly state otherwise. Do not submit code, icons or documentation that you have no right to license under it; when you bring in third-party material, also update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and add the license text (in `licenses/`).

## Requirements

- Node.js 24.18 or later within 24.x (`engines` in `package.json` is `>=24.18.0 <25`; CI uses Node 24, the latest 24.x).
- No Docker, Redis or globally installed packages are needed.

```sh
npm ci --omit=optional --ignore-scripts
npm run build
```

CI (`.github/workflows/ci.yml`) uses exactly the install flags above and then runs `npm run verify`.

## Build and test

| Command | What it does |
| --- | --- |
| `npm run check` | Type check only |
| `npm run format` / `npm run format:check` | Format with Prettier / only check formatting (single quotes, line width 100, trailing commas) |
| `npm run test:offline` | Build first, then run the tests that **do not listen on a port** |
| `npm test` | Build first, then run all tests |
| `npm run verify` | `check` + `format:check` + `test`; make sure it passes before you open a pull request |

Tests use Node's built-in `node:test`, with sources in `test/*.test.ts`. Some of them (the files containing `.listen(`, `WebSocketServer(` or `createServer(`; 17 at the moment) briefly listen on a random port on `127.0.0.1` and use local stand-ins instead of real models, without reaching the outside network; the rest listen on no port and can be run on their own with `npm run test:offline`. While you work, run `npm run check` and `npm run test:offline` often, and run the full `npm run verify` before you commit. The external agents and model providers used in the tests are all local fixtures, so no real account or key is needed.

## Code conventions

Each point below has a basis in the repository (`docs/engineering.md` or `test/architecture.test.ts`).

- **Layers and import direction**: every file under `src/` except `src/cli.ts` sits in a layer directory (`core`, `config`, `lang`, `store`, `providers`, `engines`, `fabric`, `kernel`, `gateway`, `client`) and may import only from the same directory or a lower layer, with no import cycles (`import type` counts too). Think about which layer a new file belongs to before adding it.
- **File length**: each file is at most 600 lines by default; the few that exceed it are registered in `LINE_BUDGETS` in `test/architecture.test.ts`. Those limits may only be lowered, never raised or newly registered; split a file that has grown too long.
- **No `any`**: the count of `as any` and `: any` is capped at 0. Take external input as `unknown` first, then validate with zod or narrow with `typeof`.
- **Error codes go through the error catalog**: a new error code is registered in `ROWS` in `src/core/errors.ts` (with its English text in `src/core/errors-en.ts`), thrown with `new Fault(code, message, status)`, and added as a row to the error-code table in both `docs/protocol.md` and `docs/zh-CN/protocol.md`; `test/error-catalog.test.ts` checks this. Published error codes and event fields are stable interfaces: do not rename them or reuse an old code for a new meaning. The same goes for run events, see section 4 of `docs/engineering.md`.
- **TypeScript and naming**: ES modules, with the `.js` suffix on relative imports; lowercase kebab-case file names; PascalCase for types and classes, camelCase for functions and variables, UPPER_SNAKE_CASE for module-level constants; protocol fields and error codes stay in English, and error codes use snake_case.
- **Text**: user-visible text must be bilingual (see [Language](#language)); comments in English.
- **Dependencies**: do not add runtime dependencies casually; when one is really needed, commit it separately and explain why.
- **Compatibility red lines**: the wire output of an existing request under existing conditions must not change by a single byte, and neither may the SQLite schema, the existing fields of the node wire protocol, or published error codes and events (see section 7 of `docs/engineering.md`).
- **Attribution**: the Apache-2.0 attribution in the header of `src/config/agent-presets.ts` and in `THIRD_PARTY_NOTICES.md` must be kept.
- **Tests**: for a functional change, write the failing test first and then implement; a pure refactor does not change test assertions, only import paths may change.

## Commit messages

- English is preferred; Chinese is also welcome. The format is `scope: what changed`, for example `engineering: add the offline test entry test:offline and one-step verify`, `types: remove every any in src`. Common scopes: `engineering`, `structure`, `types`, `tests`, `formatting`, `deps`, `planning`, `OAA-Lang`, `docs`. The Chinese form is `范围：做了什么`.
- One commit does one thing; `git add` only the files you changed, and do not use `git add -A`.
- For a user-visible change, add a line under `## Unreleased` at the top of `CHANGELOG.md` (and in `CHANGELOG.zh-CN.md`, under `## 未发布`).

## Filing an issue

The issue and pull request templates are in English, and you are welcome to fill them in Chinese.

- Bugs: please use the bug report template and state the version (`version` in `package.json`), the Node version, the operating system, the steps to reproduce, and the expected and actual results. **Do not paste keys, tokens, the contents of `.oaa/admin.token`, or unredacted logs.**
- Feature requests: please use the feature request template, and describe the problem you want to solve before the approach you want.
- Security issues: do not file a public issue; see [SECURITY.md](SECURITY.md).

## Opening a pull request

1. Say in an issue what you would like to do, especially for larger changes, so that no work is wasted.
2. Branch from `main` and keep the change small and focused.
3. Make `npm run verify` pass locally; run `npm run format` first if you touched files that are formatted.
4. Fill in the pull request description following the template: what changed, why, how it was verified, and whether there is any compatibility impact.
5. Maintainers will leave comments during review; please update the same pull request rather than opening a new one.
