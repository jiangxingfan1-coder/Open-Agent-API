#!/bin/sh
# A long task with plain curl: run in the background and poll, cancel, continue.
#
# What it shows (OpenAI Responses entry, "background": true):
#   1. start a run, poll GET /v1/responses/{id} until it ends;
#   2. cancel a run that is still working (POST /v1/responses/{id}/cancel);
#   3. continue the conversation with "previous_response_id".
# Needs:    curl, and OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT, OAA_LONG_PROMPT). No jq needed.
# Agent:    any agent. agent/sample (offline) finishes at once, so a cancel in step 2 ends "incomplete" or
#           "completed", and it cannot continue a session (step 3 reports native_resume_unsupported).
# Run:      sh long_task.sh
set -eu
BASE="${OAA_BASE_URL:-http://127.0.0.1:8787}"
: "${OAA_API_KEY:?Set OAA_API_KEY first (see the cookbook README).}"
AGENT="${OAA_AGENT:-agent/sample}"
PROMPT="${OAA_PROMPT:-Summarise what an API gateway does in two sentences.}"
LONG_PROMPT="${OAA_LONG_PROMPT:-Write a very detailed report on the history of the printing press, with sections and sources.}"
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

api() { # api METHOD PATH [JSON BODY]
  if [ $# -ge 3 ]; then
    curl -sS -X "$1" "$BASE$2" -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" -d "$3"
  else
    curl -sS -X "$1" "$BASE$2" -H "Authorization: Bearer $OAA_API_KEY"
  fi
}
# The first "status" and the "id" of a response body are the run's own (output items come later in the JSON).
status_of() { printf '%s' "$1" | grep -o '"status":"[a-z_]*"' | head -1 | cut -d'"' -f4; }
id_of() { printf '%s' "$1" | grep -o '"id":"resp_[a-z0-9]*"' | head -1 | cut -d'"' -f4; }

wait_for_end() { # wait_for_end RUN_ID -> prints the final body
  i=0
  while :; do
    body=$(api GET "/v1/responses/$1")
    case "$(status_of "$body")" in completed|failed|cancelled|incomplete) break ;; esac
    if printf '%s' "$body" | grep -q '"oaa.status":"requires_action"'; then
      echo "  the run is waiting for an approval (see recipe 03); stop polling" >&2
      break
    fi
    i=$((i + 1)); [ "$i" -lt 600 ] || { echo "gave up waiting for $1" >&2; exit 1; }
    sleep 1
  done
  printf '%s' "$body"
}

echo "== 1. start in the background, poll"
body=$(api POST /v1/responses "{\"model\":\"$AGENT\",\"input\":\"$(esc "$PROMPT")\",\"background\":true}")
FIRST=$(id_of "$body")
echo "started $FIRST $(status_of "$body")"
body=$(wait_for_end "$FIRST")
echo "poll -> $(status_of "$body")"
[ "$(status_of "$body")" = completed ]

echo "== 2. cancel (cancelled, or incomplete/effect_outcome_unknown for an external agent, or completed)"
body=$(api POST /v1/responses "{\"model\":\"$AGENT\",\"input\":\"$(esc "$LONG_PROMPT")\",\"background\":true}")
SLOW=$(id_of "$body")
api POST "/v1/responses/$SLOW/cancel" >/dev/null
body=$(wait_for_end "$SLOW")
echo "cancel -> $(status_of "$body")"
case "$(status_of "$body")" in cancelled|incomplete|completed) ;; *) exit 1 ;; esac

echo "== 3. continue with previous_response_id"
body=$(api POST /v1/responses "{\"model\":\"$AGENT\",\"input\":\"Now say it again, shorter.\",\"previous_response_id\":\"$FIRST\",\"background\":true}")
body=$(wait_for_end "$(id_of "$body")")
if printf '%s' "$body" | grep -q '"code":"native_resume_unsupported"'; then
  echo "continue -> this agent cannot continue a session (native_resume_unsupported); use another agent"
else
  echo "continue -> $(status_of "$body")"
  [ "$(status_of "$body")" = completed ]
  printf '%s' "$body" | grep -q "\"previous_response_id\":\"$FIRST\""
fi
echo "ok"
