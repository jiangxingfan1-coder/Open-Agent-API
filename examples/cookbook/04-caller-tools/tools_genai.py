"""Let the agent call a function in YOUR program (caller tools), with the Google GenAI Python SDK.

What it shows: you declare `function_declarations` as for Gemini. When the agent wants one, the response carries a
function call part; you run the function and answer with a function response part, and the SAME run carries on.
This script runs the loop by hand to show the messages; the SDK can also do it for you: pass a plain Python function
in `tools=[get_weather]` and leave automatic function calling on (it works against the gateway the same way).
Needs:    pip install google-genai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    one that can take your tools over: a built-in (kernel) agent, or an ACP agent that supports MCP.
          The offline sample agent (agent/sample) never calls your tools, so it cannot show this recipe.
Run:      python tools_genai.py
"""

import os
import sys

from google import genai
from google.genai import types

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "What is the weather in Paris right now? Use the get_weather tool.")

client = genai.Client(api_key=KEY, http_options=types.HttpOptions(base_url=BASE, api_version="v1beta"))

WEATHER = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="get_weather",
            description="Get the current weather of a city.",
            parameters=types.Schema(
                type="OBJECT",
                properties={"city": types.Schema(type="STRING", description="City name, e.g. Paris")},
                required=["city"],
            ),
        )
    ]
)
# Manual loop: switch the SDK's automatic function calling off so that this script sees every call.
CONFIG = types.GenerateContentConfig(
    tools=[WEATHER], automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True)
)


def get_weather(city: str) -> dict:
    """Your function. It runs in your process, with your data and your credentials."""
    return {"city": city, "temperature_c": 21, "sky": "sunny"}


FUNCTIONS = {"get_weather": get_weather}

contents = [types.Content(role="user", parts=[types.Part(text=PROMPT)])]
calls_made = 0
for turn in range(8):  # a safety bound on the loop
    response = client.models.generate_content(model=AGENT, contents=contents, config=CONFIG)
    calls = response.function_calls or []
    if not calls:
        print("answer:", response.text)
        break
    # Keep the model turn (with its function calls) in the history, then answer every call in one user turn.
    contents.append(response.candidates[0].content)
    parts = []
    for call in calls:
        result = FUNCTIONS[call.name](**call.args)
        calls_made += 1
        print(f"tool call: {call.name}({dict(call.args)}) -> {result}")
        parts.append(types.Part.from_function_response(name=call.name, response={"output": result}))
    contents.append(types.Content(role="user", parts=parts))
else:
    sys.exit("the agent kept calling tools; stopping")

if calls_made == 0:
    print("the agent did not call your tool; this recipe needs an agent that does", file=sys.stderr)
    sys.exit(3)
print("ok")
