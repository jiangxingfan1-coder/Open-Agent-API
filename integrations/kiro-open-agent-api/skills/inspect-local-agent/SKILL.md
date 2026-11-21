---
name: inspect-local-agent
description: Inspect published agents and known runs on a configured Open Agent API gateway without starting tasks.
---

# Inspect the gateway

- Use `oaa_list_agents` to show agents that the configured reader may access.
- For a supplied run ID, use `oaa_get_run` to summarize its current state. If it
  requires action, tell the user that the operator still needs to decide.
- Do not start, resume, cancel, approve or upload anything in this workflow.
  Do not read the token file, print its contents, or ask for a replacement
  credential in chat. On an access error, report the missing access.
- The offline `agent/sample` is not proof of a live Codex, Claude Code, or
  other provider connection.
