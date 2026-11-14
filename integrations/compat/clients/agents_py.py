"""OpenAI Agents SDK (Python) with the gateway's agent used as the SDK agent's "model".

The community will try exactly this: `Agent(model=OpenAIResponsesModel(...))` or
`OpenAIChatCompletionsModel(...)` with a client whose base URL is the gateway. Tracing is switched
off so the SDK never uploads anything to api.openai.com.
"""

import asyncio
import os
import sys
import warnings

os.environ["OPENAI_AGENTS_DISABLE_TRACING"] = "1"
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import API_KEY, BASE_URL, FIXTURE, Lab, check, equal  # noqa: E402

try:
    from importlib.metadata import version

    VERSION = version("openai-agents")
    from agents import (
        Agent,
        ModelSettings,
        OpenAIChatCompletionsModel,
        OpenAIResponsesModel,
        Runner,
        function_tool,
        set_tracing_disabled,
    )
    from openai import AsyncOpenAI
except ImportError as error:
    Lab("openai-agents-python").skip(f"cannot import openai-agents: {error}")
    Lab("openai-agents-python").done()
    raise SystemExit(0)

set_tracing_disabled(True)
lab = Lab("openai-agents-python", VERSION)
BRIDGE = {"X-OAA-Client-Tools": "bridge"}


def aclient(base="v1", headers=None):
    return AsyncOpenAI(base_url=f"{BASE_URL}/{base}", api_key=API_KEY, max_retries=0, default_headers=headers)


def responses_model(**kw):
    return OpenAIResponsesModel(model=FIXTURE, openai_client=aclient(**kw))


def chat_model(**kw):
    return OpenAIChatCompletionsModel(model=FIXTURE, openai_client=aclient(**kw))


@function_tool
def get_weather(city: str) -> str:
    """Get the weather for a city."""
    return f"sunny in {city}"


def run(agent, prompt):
    return asyncio.run(Runner.run(agent, prompt))


async def stream_text(agent, prompt):
    result = Runner.run_streamed(agent, prompt)
    deltas = 0
    async for event in result.stream_events():
        if event.type == "raw_response_event" and getattr(event.data, "type", "") == "response.output_text.delta":
            deltas += 1
        elif event.type == "raw_response_event" and getattr(event.data, "type", "") == "response.output_text.done":
            pass
    return result.final_output, deltas


for label, build in (("responses_model", responses_model), ("chat_completions_model", chat_model)):

    def basic(build=build):
        agent = Agent(name="lab", instructions="INSTRUCTION_MARK", model=build())
        r = run(agent, "SHOW_PROMPT")
        check("INSTRUCTION_MARK" in r.final_output, f"agent instructions did not reach the gateway agent: {r.final_output[:120]}")
        equal(run(Agent(name="lab", instructions="be brief", model=build()), "hi").final_output, "Hello world from the fixture.", "final_output")

    lab.scenario(f"{label}.run")(basic)

    def streaming(build=build):
        text, deltas = asyncio.run(stream_text(Agent(name="lab", instructions="x", model=build()), "LONG"))
        check("Paragraph 6" in text, "streamed text lost")
        if label == "responses_model":
            check(deltas > 3, f"only {deltas} text deltas")

    lab.scenario(f"{label}.run_streamed")(streaming)

    def settings(build=build):
        agent = Agent(
            name="lab",
            instructions="x",
            model=build(),
            model_settings=ModelSettings(temperature=0.2, top_p=0.9, max_tokens=200, frequency_penalty=0.1, presence_penalty=0.1, parallel_tool_calls=True, tool_choice="auto"),
        )
        equal(run(agent, "hi").final_output, "Hello world from the fixture.", "final_output")

    lab.scenario(f"{label}.model_settings_tolerated")(settings)

    def tools_default(build=build):
        agent = Agent(name="lab", instructions="x", model=build(), tools=[get_weather])
        try:
            run(agent, "hi")
        except Exception as error:  # noqa: BLE001
            check("compat" in str(error), f"the error does not point to /v1/compat: {error}")
            return "tools on the default endpoint: explicit error pointing to /v1/compat"
        raise AssertionError("tools were silently accepted on the default endpoint")

    lab.scenario(f"{label}.function_tool_on_default_endpoint_is_explicit")(tools_default)

    def tools_bridge(build=build):
        agent = Agent(name="lab", instructions="x", model=build(base="v1/compat", headers=BRIDGE), tools=[get_weather])
        r = run(agent, "CALLTOOL")
        check("sunny in Paris" in r.final_output and r.final_output.startswith("Tool result:"), f"final_output: {r.final_output}")

    lab.scenario(f"{label}.function_tool_loop_via_bridge")(tools_bridge)

lab.done()
