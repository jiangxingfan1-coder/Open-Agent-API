"""First call with the official OpenAI Python SDK: Chat Completions and Responses, blocking and streaming.

What it shows: the agent name goes into `model`; nothing else about your code changes.
Needs:    pip install openai   and   OAA_API_KEY (optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT)
Agent:    any agent. The offline sample agent (agent/sample) answers with a fixed text.
Run:      python hello_openai.py
"""

import os
import sys

from openai import OpenAI

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Say hello in one sentence.")

# max_retries=0: an agent run is not free to repeat, and a retried request would start a second run
# (see 07-errors-and-retries). timeout is generous because an agent may work for a while.
client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY, max_retries=0, timeout=300)
messages = [{"role": "user", "content": PROMPT}]

# 1. Chat Completions, blocking
chat = client.chat.completions.create(model=AGENT, messages=messages)
print("chat:", chat.choices[0].message.content)
assert chat.choices[0].finish_reason == "stop"

# 2. Chat Completions, streaming
pieces = []
for chunk in client.chat.completions.create(model=AGENT, messages=messages, stream=True):
    if chunk.choices and chunk.choices[0].delta.content:
        pieces.append(chunk.choices[0].delta.content)
print("chat stream:", "".join(pieces))
assert pieces, "the stream carried no text"

# 3. Responses, blocking. The response id is also the run id: keep it to look the run up later.
response = client.responses.create(model=AGENT, input=PROMPT)
print("responses:", response.output_text, f"(run {response.id})")

# 4. Responses, streaming
deltas = []
with client.responses.stream(model=AGENT, input=PROMPT) as stream:
    for event in stream:
        if event.type == "response.output_text.delta":
            deltas.append(event.delta)
print("responses stream:", "".join(deltas))
assert deltas, "the stream carried no text"
print("ok")
