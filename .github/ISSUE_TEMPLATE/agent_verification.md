---
name: Agent verification report
about: Share the result of `oaa verify` for an agent you have installed (Codex, Claude Code, an ACP agent, ...)
title: 'Agent verification: <agent name and version>'
labels: verification
assignees: ''
---

> Only Antigravity has been verified with real calls so far (see `docs/evidence.md`). A report from you for
> Codex, Claude Code or any other agent helps everyone know what really works.
>
> **Please paste the generated Markdown report as it is.** `oaa verify` already removes keys, your user name,
> host name and local paths. Read it once before posting; if anything private is left, remove it and say so.
> Never paste keys, tokens or the content of `.oaa/admin.token`.

## How I ran it

```bash
oaa verify <agent> --confirm-live-cost
```

<!-- Add any other options you used (--model, --scenarios, --timeout-ms). Running without --confirm-live-cost only prints the plan. -->

## Report

<!-- Paste the whole content of report.md here (written to the --out directory, `oaa-verify-<agent>-<time>/` by default). -->

## Anything unusual

<!-- For example: the agent asked for a login during the run, you cancelled it with Ctrl+C, a scenario failed because of your own setup, or a result surprised you. -->

## Checklist

- [ ] I ran the command myself on the machine named in the report, with the agent's own sign-in.
- [ ] I read the report and removed anything private that was left in it.
- [ ] I know the run made real agent calls that may count against my quota or cost money.
