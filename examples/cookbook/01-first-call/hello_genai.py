"""First call with the official Google GenAI Python SDK: generateContent, blocking and streaming.

What it shows: the SDK's base URL is the gateway root with API version v1beta; the agent name goes into
`model` unchanged.
Needs:    pip install google-genai   and   OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT)
Agent:    any agent. The offline sample agent (agent/sample) answers with a fixed text.
Run:      python hello_genai.py
"""

import os
import sys

from google import genai
from google.genai import types

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Say hello in one sentence.")

client = genai.Client(
    api_key=KEY,
    http_options=types.HttpOptions(base_url=BASE, api_version="v1beta"),
)

# 1. Blocking
response = client.models.generate_content(model=AGENT, contents=PROMPT)
print("generateContent:", response.text)
assert response.candidates[0].finish_reason == types.FinishReason.STOP

# 2. Streaming
pieces = [chunk.text or "" for chunk in client.models.generate_content_stream(model=AGENT, contents=PROMPT)]
print("streamGenerateContent:", "".join(pieces))
assert "".join(pieces), "the stream carried no text"
print("ok")
