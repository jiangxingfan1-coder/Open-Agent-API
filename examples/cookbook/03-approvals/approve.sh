#!/bin/sh
# Approvals with plain curl: find a task that waits for approval, then approve or deny it.
#
# What it shows: a background run that needs a person's approval stops in "requires_action"
# (metadata "oaa.status"). GET /v1/runs/{id}/actions lists the pending items; each is decided with
# POST /v1/runs/{id}/actions/{action_id} {"decision":"approve"|"deny"}.
# Needs:    curl, and OAA_API_KEY of a key with the `approve` scope (the key that `oaa quickstart` writes has it)
#           optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT. No jq needed.
# Agent:    an agent that asks for approval. The offline sample agent does when the task contains "approve":
#           it asks to write a file. An agent that never asks simply finishes ("no approval was needed").
# Run:      sh approve.sh [approve|deny]        (default: approve)
# Result:   approve -> the run completes; deny -> the run fails with permission_denied.
set -eu
BASE="${OAA_BASE_URL:-http://127.0.0.1:8787}"
: "${OAA_API_KEY:?Set OAA_API_KEY first (see the cookbook README).}"
AGENT="${OAA_AGENT:-agent/sample}"
PROMPT="${OAA_PROMPT:-Please write a short note to outputs/note.txt. This needs my approval.}"
DECISION="${1:-approve}"
case "$DECISION" in approve|deny) ;; *) echo "usage: sh approve.sh [approve|deny]" >&2; exit 2 ;; esac
P=$(printf '%s' "$PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g')

api() { # api METHOD PATH [JSON BODY]
  if [ $# -ge 3 ]; then
    curl -sS -X "$1" "$BASE$2" -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" -d "$3"
  else
    curl -sS -X "$1" "$BASE$2" -H "Authorization: Bearer $OAA_API_KEY"
  fi
}
status_of() { printf '%s' "$1" | grep -o '"status":"[a-z_]*"' | head -1 | cut -d'"' -f4; }

body=$(api POST /v1/responses "{\"model\":\"$AGENT\",\"input\":\"$P\",\"background\":true}")
RUN=$(printf '%s' "$body" | grep -o '"id":"resp_[a-z0-9]*"' | head -1 | cut -d'"' -f4)
echo "started $RUN"

# Poll until the run ends or waits for an approval.
i=0
while :; do
  body=$(api GET "/v1/responses/$RUN")
  case "$(status_of "$body")" in completed|failed|cancelled|incomplete) echo "$(status_of "$body"): no approval was needed"; exit 0 ;; esac
  printf '%s' "$body" | grep -q '"oaa.status":"requires_action"' && break
  i=$((i + 1)); [ "$i" -lt 240 ] || { echo "gave up waiting for $RUN" >&2; exit 1; }
  sleep 0.5
done

# The pending items. Each has an "id" (approval_...), a "kind" and a "detail" preview of what it asks.
actions=$(api GET "/v1/runs/$RUN/actions")
echo "pending: $(printf '%s' "$actions" | grep -o '"kind":"[a-z_]*"' | head -1)"
ID=$(printf '%s' "$actions" | grep -o '"id":"approval_[a-z0-9]*"' | head -1 | cut -d'"' -f4)
[ -n "$ID" ] || { echo "the run waits for something other than an approval" >&2; exit 1; }
echo "$DECISION $ID"
api POST "/v1/runs/$RUN/actions/$ID" "{\"decision\":\"$DECISION\"}"
echo

# Wait for the end.
i=0
while :; do
  body=$(api GET "/v1/responses/$RUN")
  s=$(status_of "$body")
  case "$s" in completed|failed|cancelled|incomplete) break ;; esac
  i=$((i + 1)); [ "$i" -lt 240 ] || { echo "gave up waiting for $RUN" >&2; exit 1; }
  sleep 0.5
done
echo "$s"
if [ "$DECISION" = approve ]; then
  [ "$s" = completed ]
else
  [ "$s" = failed ] && printf '%s' "$body" | grep -q '"code":"permission_denied"' && echo "denied: permission_denied"
fi
echo "ok"
