"""Structured output with the Anthropic Python SDK: `output_config.format`, and handling the failure.

What it shows: a successful response is a text block holding JSON that parses and fits your schema (a wrong answer
is sent back to the agent for one correction round). If the agent still cannot produce it, the call fails with HTTP
422 and the gateway code `structured_output_invalid` (in `error.body["error"]["code"]`).
Needs:    pip install anthropic   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    a built-in (kernel) agent, or an external agent whose session can be continued (for the correction
          round). The offline sample agent cannot be asked twice, so it ends in the 422 path below.
Run:      python structured_anthropic.py
Exit:     0 = valid JSON received; 3 = structured_output_invalid (handled); 2 = the request itself was refused.
Not served: structure by a forced tool call (tool_choice) — use output_config.format as here.
"""

import json
import os
import sys

from anthropic import Anthropic, BadRequestError, UnprocessableEntityError
from pydantic import BaseModel

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Who wrote Hamlet? Give the title of the play, its author and the year of its first performance.")

client = Anthropic(base_url=BASE, api_key=KEY, max_retries=0, timeout=300)

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "author": {"type": "string"},
        "year": {"type": "integer"},
    },
    "required": ["title", "author", "year"],
    "additionalProperties": False,
}
messages = [{"role": "user", "content": PROMPT}]

try:
    # 1. Plain JSON Schema in output_config.format.
    message = client.messages.create(
        model=AGENT,
        max_tokens=1024,
        messages=messages,
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
    )
    data = json.loads("".join(b.text for b in message.content if b.type == "text"))  # always parses, always fits
    print("json:", data)
    assert set(data) == {"title", "author", "year"} and isinstance(data["year"], int)

    # 2. The SDK's own helper: a pydantic model in, a parsed object out.
    class Play(BaseModel):
        title: str
        author: str
        year: int

    parsed = client.messages.parse(model=AGENT, max_tokens=1024, messages=messages, output_format=Play)
    print("parsed:", parsed.parsed_output)
    assert isinstance(parsed.parsed_output, Play)
except UnprocessableEntityError as error:
    # The run was created and finished, but its answer never fitted. Retrying the same agent will not help.
    code = (error.body or {}).get("error", {}).get("code")
    if code != "structured_output_invalid":
        raise
    print("structured_output_invalid:", error.body["error"]["message"])
    sys.exit(3)
except BadRequestError as error:
    print(f"the request was refused: {error.message}", file=sys.stderr)
    sys.exit(2)
print("ok")
