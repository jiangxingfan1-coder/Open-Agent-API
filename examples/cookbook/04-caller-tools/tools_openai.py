"""Let the agent call a function in YOUR program (caller tools), with the OpenAI Python SDK, Chat Completions.

What it shows: you declare `tools` exactly as you would for a model. When the agent wants one, the response
ends with finish_reason "tool_calls"; you run the function and send the result back as a `tool` message, and the
SAME run carries on (same run id, no replay). The loop ends when the agent answers without a tool call.
Needs:    pip install openai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    one that can take your tools over: a built-in (kernel) agent, or an ACP agent that supports MCP.
          The response header X-OAA-Client-Tools says what happened: "bridge" = handed to the agent,
          "ignored" = this agent has its own tools and does not use yours (the script stops with a message).
          The offline sample agent (agent/sample) never calls your tools, so it cannot show this recipe.
Run:      python tools_openai.py
"""

import json
import os
import sys

from openai import BadRequestError, OpenAI

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "What is the weather in Paris right now? Use the get_weather tool.")

client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY, max_retries=0, timeout=300)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather of a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "City name, e.g. Paris"}},
                "required": ["city"],
            },
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
        raw = client.chat.completions.with_raw_response.create(model=AGENT, messages=messages, tools=TOOLS)
    except BadRequestError as error:
        # A native engine (Codex, Claude Code, ...) runs its own tool loop and cannot take yours: the gateway
        # refuses clearly (400 unsupported_parameter) and names the ways out.
        sys.exit(f"this agent cannot take caller tools over: {error.message}")
    if turn == 0:
        mode = raw.headers.get("x-oaa-client-tools")
        print("X-OAA-Client-Tools:", mode)
        if mode != "bridge":
            sys.exit(f"this agent did not take the tools over ({mode}); use a built-in agent for this recipe")
    completion = raw.parse()
    choice = completion.choices[0]
    if choice.finish_reason != "tool_calls":
        print("answer:", choice.message.content)
        if not calls_made:
            print("the agent did not call your tool; this recipe needs an agent that does", file=sys.stderr)
        break
    # Keep the assistant turn in the history, then answer every call it made (parallel calls arrive together).
    messages.append(choice.message.model_dump(exclude_none=True))
    for call in choice.message.tool_calls:
        arguments = json.loads(call.function.arguments)
        result = FUNCTIONS[call.function.name](**arguments)
        calls_made += 1
        print(f"tool call: {call.function.name}({arguments}) -> {result}")
        messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)})
else:
    sys.exit("the agent kept calling tools; stopping")

if calls_made == 0:
    sys.exit(3)  # the agent answered without using your tool: nothing was shown (the sample agent never does)
print("ok")
