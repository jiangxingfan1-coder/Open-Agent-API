"""Let the agent call a function in YOUR program (caller tools), with the Anthropic Python SDK, Messages.

What it shows: you declare `tools` as for Claude. When the agent wants one, the response ends with
stop_reason "tool_use"; you run the function and answer with a `tool_result` block, and the SAME run carries on.
Needs:    pip install anthropic   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    one that can take your tools over: a built-in (kernel) agent, or an ACP agent that supports MCP.
          The offline sample agent (agent/sample) never calls your tools, so it cannot show this recipe.
Run:      python tools_anthropic.py
Note:     the tool_use id looks like "call_..." (not "toolu_..."); treat it as an opaque string.
"""

import json
import os
import sys

from anthropic import Anthropic, BadRequestError

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "What is the weather in Paris right now? Use the get_weather tool.")

client = Anthropic(base_url=BASE, api_key=KEY, max_retries=0, timeout=300)

TOOLS = [
    {
        "name": "get_weather",
        "description": "Get the current weather of a city.",
        "input_schema": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "City name, e.g. Paris"}},
            "required": ["city"],
        },
    }
]


def get_weather(city: str) -> dict:
    """Your function. It runs in your process, with your data and your credentials."""
    return {"city": city, "temperature_c": 21, "sky": "sunny"}


FUNCTIONS = {"get_weather": get_weather}

messages = [{"role": "user", "content": PROMPT}]
calls_made = 0
for turn in range(8):  # a safety bound on the loop
    try:
        raw = client.messages.with_raw_response.create(model=AGENT, max_tokens=1024, tools=TOOLS, messages=messages)
    except BadRequestError as error:
        # A native engine (Codex, Claude Code, ...) cannot take caller tools over; on this entry the gateway lets it
        # finish with its own tools instead (header "ignored"), so a 400 here means something else is wrong.
        sys.exit(f"the request was refused: {error.message}")
    if turn == 0:
        mode = raw.headers.get("x-oaa-client-tools")
        print("X-OAA-Client-Tools:", mode)
        if mode != "bridge":
            sys.exit(f"this agent did not take the tools over ({mode}); use a built-in agent for this recipe")
    message = raw.parse()
    if message.stop_reason != "tool_use":
        print("answer:", "".join(b.text for b in message.content if b.type == "text"))
        break
    # Keep the assistant turn (text and tool_use blocks), then answer every tool_use in ONE user message.
    messages.append({"role": "assistant", "content": [b.model_dump() for b in message.content]})
    results = []
    for block in message.content:
        if block.type != "tool_use":
            continue
        result = FUNCTIONS[block.name](**block.input)
        calls_made += 1
        print(f"tool call: {block.name}({block.input}) -> {result}")
        results.append({"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(result)})
    messages.append({"role": "user", "content": results})
else:
    sys.exit("the agent kept calling tools; stopping")

if calls_made == 0:
    print("the agent did not call your tool; this recipe needs an agent that does", file=sys.stderr)
    sys.exit(3)
print("ok")
