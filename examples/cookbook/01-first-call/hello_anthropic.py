"""First call with the official Anthropic Python SDK: Messages, blocking and streaming.

What it shows: the SDK's base URL is the gateway root (it appends /v1/messages itself); the agent name
goes into `model`.
Needs:    pip install anthropic   and   OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT)
Agent:    any agent. The offline sample agent (agent/sample) answers with a fixed text.
Run:      python hello_anthropic.py
"""

import os
import sys

from anthropic import Anthropic

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Say hello in one sentence.")

# Note: no "/v1" in base_url for this SDK. max_retries=0: see 07-errors-and-retries.
client = Anthropic(base_url=BASE, api_key=KEY, max_retries=0, timeout=300)
messages = [{"role": "user", "content": PROMPT}]

# 1. Blocking. max_tokens is required by the SDK; the gateway only uses it to lower the agent's own limit.
message = client.messages.create(model=AGENT, max_tokens=1024, messages=messages)
text = "".join(block.text for block in message.content if block.type == "text")
print("messages:", text)
assert message.stop_reason == "end_turn", message.stop_reason

# 2. Streaming
with client.messages.stream(model=AGENT, max_tokens=1024, messages=messages) as stream:
    pieces = list(stream.text_stream)
    final = stream.get_final_message()
print("messages stream:", "".join(pieces))
assert pieces, "the stream carried no text"
assert final.stop_reason == "end_turn", final.stop_reason
print("ok")
