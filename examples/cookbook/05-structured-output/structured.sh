#!/bin/sh
# Structured output with plain curl: ask for JSON that fits a schema, and see what a failure looks like.
#
# What it shows: with "response_format" a successful response IS JSON that parses and fits your schema. If the agent
# cannot produce it (after one correction round) the call fails with HTTP 422 and the code
# "structured_output_invalid"; the response header x-should-retry is false, so SDKs do not retry it either.
# Needs:    curl, and OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT). No jq needed.
# Agent:    a built-in (kernel) agent, or an external agent whose session can be continued (for the correction
#           round). The offline sample agent cannot be asked twice, so it ends in the 422 path below.
# Run:      sh structured.sh
# Exit:     0 = valid JSON received; 3 = structured_output_invalid (handled); anything else = something else went wrong.
set -eu
BASE="${OAA_BASE_URL:-http://127.0.0.1:8787}"
: "${OAA_API_KEY:?Set OAA_API_KEY first (see the cookbook README).}"
AGENT="${OAA_AGENT:-agent/sample}"
PROMPT="${OAA_PROMPT:-Who wrote Hamlet? Give the title of the play, its author and the year of its first performance.}"
P=$(printf '%s' "$PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g')

# -i prints the headers too; the body is the last line.
out=$(curl -sS -i "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$AGENT\",
    \"messages\": [{\"role\": \"user\", \"content\": \"$P\"}],
    \"response_format\": {\"type\": \"json_schema\", \"json_schema\": {
      \"name\": \"play\", \"strict\": true,
      \"schema\": {
        \"type\": \"object\",
        \"properties\": {\"title\": {\"type\": \"string\"}, \"author\": {\"type\": \"string\"}, \"year\": {\"type\": \"integer\"}},
        \"required\": [\"title\", \"author\", \"year\"],
        \"additionalProperties\": false
      }}}
  }")
status=$(printf '%s' "$out" | head -1 | cut -d' ' -f2)
echo "HTTP $status"
body=$(printf '%s' "$out" | tail -1)
echo "$body"

case "$status" in
  200)
    # message.content is the JSON text, already validated against the schema (escaped inside the JSON envelope).
    printf '%s' "$body" | grep -q '\\"title\\"' && printf '%s' "$body" | grep -q '\\"year\\"'
    echo "ok"
    ;;
  422)
    printf '%s' "$body" | grep -q '"code":"structured_output_invalid"'
    printf '%s' "$out" | grep -qi '^x-should-retry: false'
    echo "structured_output_invalid (handled): do not retry the same request blindly"
    exit 3
    ;;
  *)
    echo "unexpected status $status" >&2
    exit 1
    ;;
esac
