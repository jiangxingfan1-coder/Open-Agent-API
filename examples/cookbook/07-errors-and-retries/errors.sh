#!/bin/sh
# Errors and retries with plain curl: read the status, the headers and the error code, and look the code up.
#
# What it shows:
#   * the error body keeps the shape of the protocol you called (here OpenAI: {"error":{"code","message","type","param"}}),
#     the stable machine-readable part is `error.code`;
#   * headers decide whether to retry: `x-should-retry: false` = never, `Retry-After: N` (429/503) = wait N seconds;
#   * `GET /v1/errors` is the catalog of every code with `retryable` and an English description;
#   * a retry loop that reuses ONE Idempotency-Key, so a retry after a timeout attaches to the run that exists
#     instead of starting a second one.
# Needs:    curl, and OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT). No jq needed.
# Agent:    any agent.
# Run:      sh errors.sh
set -eu
BASE="${OAA_BASE_URL:-http://127.0.0.1:8787}"
: "${OAA_API_KEY:?Set OAA_API_KEY first (see the cookbook README).}"
AGENT="${OAA_AGENT:-agent/sample}"
PROMPT="${OAA_PROMPT:-Say hello in one sentence.}"
P=$(printf '%s' "$PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g')

echo "== 1. a wrong key: 401, never worth retrying"
curl -sS -i "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer sk-oaa-not-a-real-key" -H "Content-Type: application/json" \
  -d "{\"model\":\"$AGENT\",\"messages\":[{\"role\":\"user\",\"content\":\"$P\"}]}" | grep -E '^HTTP|"code"' | cut -c1-120

echo "== 2. an unknown agent: 404 agent_not_found"
out=$(curl -sS -i "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"agent/does-not-exist\",\"messages\":[{\"role\":\"user\",\"content\":\"$P\"}]}")
printf '%s\n' "$out" | grep -E '^HTTP|"code"' | cut -c1-120
printf '%s' "$out" | grep -q '"code":"agent_not_found"'

echo "== 3. what does the catalog say about a code? (retryable, description)"
catalog=$(curl -sS "$BASE/v1/errors" -H "Authorization: Bearer $OAA_API_KEY")
for code in agent_not_found rate_limited structured_output_invalid action_required; do
  entry=$(printf '%s' "$catalog" | grep -o "{\"code\":\"$code\"[^}]*}" | head -1)
  retryable=$(printf '%s' "$entry" | grep -o '"retryable":[a-z]*' | cut -d: -f2)
  echo "$code: retryable=$retryable"
done
printf '%s' "$catalog" | grep -o '{"code":"agent_not_found"[^}]*}' | grep -q '"retryable":false'
printf '%s' "$catalog" | grep -o '{"code":"rate_limited"[^}]*}' | grep -q '"retryable":true'

echo "== 4. a retry loop: one Idempotency-Key, honour Retry-After, stop on x-should-retry: false"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
KEY="cookbook-$(date +%s)-$$"
attempt=1
while :; do
  curl -sS -D "$TMP/headers" -o "$TMP/body" "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $KEY" \
    -d "{\"model\":\"$AGENT\",\"messages\":[{\"role\":\"user\",\"content\":\"$P\"}]}" || true
  status=$(head -1 "$TMP/headers" 2>/dev/null | cut -d' ' -f2)
  case "${status:-000}" in
    200) echo "attempt $attempt: HTTP 200"; break ;;
    429|503)
      wait=$(grep -i '^retry-after:' "$TMP/headers" | tr -d '\r' | cut -d' ' -f2)
      grep -qi '^x-should-retry: false' "$TMP/headers" && { echo "attempt $attempt: $status, the gateway says do not retry" >&2; exit 1; }
      echo "attempt $attempt: $status, waiting ${wait:-2}s" ;;
    000) echo "attempt $attempt: no answer, retrying with the same Idempotency-Key" ; wait=2 ;;
    *) echo "attempt $attempt: HTTP $status, not retryable" >&2; cat "$TMP/body" >&2; exit 1 ;;
  esac
  [ "$attempt" -lt 4 ] || { echo "giving up after $attempt attempts" >&2; exit 1; }
  sleep "${wait:-2}"
  attempt=$((attempt + 1))
done
echo "ok"
