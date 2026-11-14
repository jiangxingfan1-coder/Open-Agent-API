<!-- 欢迎用中文填写 / You are welcome to fill this in Chinese. -->

## What changed, and why

<!-- A short description of the change and its motivation. Link the related issue with `Closes #number`. -->

## How it was verified

- [ ] `npm run verify` passes locally (type check, format check, all tests)
- [ ] A functional change has a matching test; a pure refactor did not change test assertions

## Checklist

- [ ] Follows the code conventions in CONTRIBUTING.md (layers, file length, no `any`, error code registration)
- [ ] Does not change the wire output of existing requests, or published error codes and event fields; if it does, explained below
- [ ] User-visible text is bilingual (Chinese and English), and a documentation change is made in both `docs/` and `docs/zh-CN/` (or explained below)
- [ ] A user-visible change is recorded under `## Unreleased` in `CHANGELOG.md`
- [ ] Third-party material or a new dependency is added to `THIRD_PARTY_NOTICES.md`
- [ ] Commit messages follow `scope: what changed`
- [ ] No keys, tokens or personal information are committed

## Compatibility and risk

<!-- Write "none" if there is none -->
