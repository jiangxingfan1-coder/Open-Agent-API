#!/bin/sh
# First call with plain curl: the four entries of the gateway, blocking and streaming.
#
# What it shows: every protocol is one POST. The agent name is the model; the key goes in the header
# the protocol's own SDK would use (all of them also accept "Authorization: Bearer").
# Needs:    curl, and OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT). No jq needed.
# Agent:    any agent. The offline sample agent (agent/sample) answers with a fixed text.
# Run:      sh hello.sh
set -eu
BASE="${OAA_BASE_URL:-http://127.0.0.1:8787}"
: "${OAA_API_KEY:?Set OAA_API_KEY first (see the cookbook README).}"
AGENT="${OAA_AGENT:-agent/sample}"
PROMPT="${OAA_PROMPT:-Say hello in one sentence.}"
# Escape the prompt for a JSON string (backslash and double quote are the two that matter here).
P=$(printf '%s' "$PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g')

show() { printf '%s\n\n' "$1"; }

echo "== OpenAI Chat Completions, blocking"
out=$(curl -sS "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$AGENT\",\"messages\":[{\"role\":\"user\",\"content\":\"$P\"}]}")
show "$out"
printf '%s' "$out" | grep -q '"finish_reason":"stop"'

echo "== OpenAI Chat Completions, streaming (server-sent events, ends with [DONE])"
out=$(curl -sSN "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$AGENT\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"$P\"}]}")
show "$out"
printf '%s' "$out" | grep -q '^data: \[DONE\]'

echo "== OpenAI Responses, blocking (the id is also the run id)"
out=$(curl -sS "$BASE/v1/responses" \
  -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$AGENT\",\"input\":\"$P\"}")
show "$out"
printf '%s' "$out" | grep -q '"status":"completed"'

echo "== Anthropic Messages, blocking (x-api-key works too)"
out=$(curl -sS "$BASE/v1/messages" \
  -H "x-api-key: $OAA_API_KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d "{\"model\":\"$AGENT\",\"max_tokens\":1024,\"messages\":[{\"role\":\"user\",\"content\":\"$P\"}]}")
show "$out"
printf '%s' "$out" | grep -q '"stop_reason":"end_turn"'

echo "== Anthropic Messages, streaming"
out=$(curl -sSN "$BASE/v1/messages" \
  -H "x-api-key: $OAA_API_KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d "{\"model\":\"$AGENT\",\"max_tokens\":1024,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"$P\"}]}")
show "$out"
printf '%s' "$out" | grep -q 'event: message_stop'

echo "== Gemini generateContent, blocking (the key goes in x-goog-api-key or ?key=)"
out=$(curl -sS "$BASE/v1beta/models/$AGENT:generateContent" \
  -H "x-goog-api-key: $OAA_API_KEY" -H "Content-Type: application/json" \
  -d "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"$P\"}]}]}")
show "$out"
printf '%s' "$out" | grep -q '"finishReason":"STOP"'

echo "== Gemini streamGenerateContent (alt=sse gives server-sent events)"
out=$(curl -sSN "$BASE/v1beta/models/$AGENT:streamGenerateContent?alt=sse" \
  -H "x-goog-api-key: $OAA_API_KEY" -H "Content-Type: application/json" \
  -d "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"$P\"}]}]}")
show "$out"
printf '%s' "$out" | grep -q '"finishReason":"STOP"'

echo "ok"
