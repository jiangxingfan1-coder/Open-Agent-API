"""Structured output with the Google GenAI Python SDK: `response_mime_type` + `response_schema`, and the failure.

What it shows: a successful response is text holding JSON that parses and fits your schema (a wrong answer is sent
back to the agent for one correction round). If the agent still cannot produce it, the call fails with HTTP 422
(`errors.ClientError`, code 422; the gateway code `structured_output_invalid` is in `details[0].reason`).
Needs:    pip install google-genai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    a built-in (kernel) agent, or an external agent whose session can be continued (for the correction
          round). The offline sample agent cannot be asked twice, so it ends in the 422 path below.
Run:      python structured_genai.py
Exit:     0 = valid JSON received; 3 = structured_output_invalid (handled); 2 = the request itself was refused.
"""

import json
import os
import sys

from google import genai
from google.genai import errors, types
from pydantic import BaseModel

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Who wrote Hamlet? Give the title of the play, its author and the year of its first performance.")

client = genai.Client(api_key=KEY, http_options=types.HttpOptions(base_url=BASE, api_version="v1beta"))

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


class Play(BaseModel):
    title: str
    author: str
    year: int


try:
    # 1. Plain JSON Schema (response_json_schema).
    response = client.models.generate_content(
        model=AGENT,
        contents=PROMPT,
        config=types.GenerateContentConfig(response_mime_type="application/json", response_json_schema=SCHEMA),
    )
    data = json.loads(response.text)  # always parses, always fits SCHEMA
    print("json:", data)
    assert set(data) == {"title", "author", "year"} and isinstance(data["year"], int)

    # 2. A pydantic model as response_schema: the SDK hands back a parsed object.
    response = client.models.generate_content(
        model=AGENT,
        contents=PROMPT,
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=Play),
    )
    print("parsed:", response.parsed)
    assert isinstance(response.parsed, Play)
except errors.ClientError as error:
    reason = next((d.get("reason") for d in (error.details or {}).get("error", {}).get("details", []) if isinstance(d, dict)), None)
    if error.code == 422 and reason == "structured_output_invalid":
        # The run was created and finished, but its answer never fitted. Retrying the same agent will not help.
        print(f"structured_output_invalid: {error.message}")
        sys.exit(3)
    if error.code in (400, 404):
        print(f"the request was refused ({error.code}, {reason}): {error.message}", file=sys.stderr)
        sys.exit(2)
    raise
print("ok")
