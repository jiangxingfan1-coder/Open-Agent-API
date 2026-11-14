#!/bin/sh
# Send a local image to an agent with plain curl (OpenAI Chat Completions, base64 data URL).
#
# What it shows: the image travels inline as a base64 `data:` URL in an `image_url` part. The gateway checks the real
# bytes: only PNG, JPEG, GIF and WebP are accepted and the declared type must match them (`image_invalid`
# otherwise). An agent that cannot use images refuses the request clearly (400 `unsupported_content`).
# The other entries take the same bytes: Responses `input_image`, Claude `image` blocks with a base64 source,
# Gemini `inlineData` (see the Python and Node examples of this folder, and docs/images.md).
# Needs:    curl, base64, and OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT). No jq needed.
# Agent:    one that takes images (`GET /v1/models` shows `image_input`). The offline sample agent accepts the
#           image but its fixed answer does not describe it.
# Run:      sh image.sh [path/to/image.png]        (default: sample.png next to this script)
# Exit:     0 = answered; 2 = the request was refused (for example an agent without image input).
set -eu
BASE="${OAA_BASE_URL:-http://127.0.0.1:8787}"
: "${OAA_API_KEY:?Set OAA_API_KEY first (see the cookbook README).}"
AGENT="${OAA_AGENT:-agent/sample}"
PROMPT="${OAA_PROMPT:-Describe this image in one sentence.}"
FILE="${1:-$(dirname "$0")/sample.png}"
P=$(printf '%s' "$PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g')
case "$FILE" in
  *.png) MIME=image/png ;; *.jpg|*.jpeg) MIME=image/jpeg ;; *.gif) MIME=image/gif ;; *.webp) MIME=image/webp ;;
  *) MIME=image/png ;;
esac
# base64 without line breaks (works with both the GNU and the BSD tool).
B64=$(base64 < "$FILE" | tr -d '\n')

# The body is large for a real photo: send it from a file on stdin instead of the command line.
out=$(printf '{"model":"%s","messages":[{"role":"user","content":[{"type":"text","text":"%s"},{"type":"image_url","image_url":{"url":"data:%s;base64,%s"}}]}]}' \
  "$AGENT" "$P" "$MIME" "$B64" |
  curl -sS -w '\nHTTP %{http_code}\n' "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $OAA_API_KEY" -H "Content-Type: application/json" --data-binary @-)
echo "$out"
status=$(printf '%s' "$out" | tail -1 | cut -d' ' -f2)
case "$status" in
  200) echo "ok" ;;
  400) echo "refused (400): see error.code and error.param above" >&2; exit 2 ;;
  *) echo "unexpected status $status" >&2; exit 1 ;;
esac
