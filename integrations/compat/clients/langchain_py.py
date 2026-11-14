"""LangChain (langchain-openai, langchain-anthropic) against the gateway."""

import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import API_KEY, BASE_URL, FIXTURE, NATIVE, Lab, check, equal  # noqa: E402

try:
    from importlib.metadata import version

    VERSION = f"langchain-openai {version('langchain-openai')}, langchain-anthropic {version('langchain-anthropic')}"
    from langchain_anthropic import ChatAnthropic
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI
    from pydantic import BaseModel
except ImportError as error:
    Lab("langchain-python").skip(f"cannot import langchain packages: {error}")
    Lab("langchain-python").done()
    raise SystemExit(0)

lab = Lab("langchain-python", VERSION)
V1 = f"{BASE_URL}/v1"
COMPAT = f"{BASE_URL}/v1/compat"
BRIDGE = {"X-OAA-Client-Tools": "bridge"}


@tool
def get_weather(city: str) -> str:
    """Get the weather for a city."""
    return f"sunny in {city}"


def openai_model(**kwargs):
    kwargs.setdefault("base_url", V1)
    return ChatOpenAI(model=FIXTURE, api_key=API_KEY, max_retries=0, **kwargs)


def anthropic_model(**kwargs):
    return ChatAnthropic(model=FIXTURE, anthropic_api_url=BASE_URL, api_key=API_KEY, max_retries=0, max_tokens=256, **kwargs)


class Answer(BaseModel):
    answer: str
    n: int


# ------------------------------------------------------------ langchain-openai
@lab.scenario("openai.invoke")
def _():
    r = openai_model().invoke("hi")
    equal(r.content, "Hello world from the fixture.", "content")
    check(r.usage_metadata and r.usage_metadata["total_tokens"] > 0, "usage_metadata")
    equal(r.response_metadata.get("finish_reason"), "stop", "finish_reason")


@lab.scenario("openai.stream")
def _():
    # With a custom base_url LangChain does not ask for stream usage on its own: stream_usage=True does.
    chunks = list(openai_model(stream_usage=True).stream("LONG"))
    check(len(chunks) > 5, f"only {len(chunks)} chunks")
    text = "".join(c.content for c in chunks)
    check("Paragraph 6" in text, "stream lost text")
    total = None
    for c in chunks:
        if c.usage_metadata:
            total = c.usage_metadata["total_tokens"]
    check(total and total > 0, "stream usage_metadata with stream_usage=True")


@lab.scenario("openai.messages_history")
def _():
    r = openai_model().invoke(
        [SystemMessage("SYSTEM_MARK"), HumanMessage("first question"), AIMessage("first answer"), HumanMessage("SHOW_PROMPT")]
    )
    for mark in ("SYSTEM_MARK", "first question", "first answer"):
        check(mark in r.content, f"{mark} lost")


@lab.scenario("openai.sampling_params_tolerated")
def _():
    m = openai_model(
        temperature=0.3,
        top_p=0.9,
        frequency_penalty=0.1,
        presence_penalty=0.1,
        seed=7,
        n=1,
        max_tokens=200,
        stop=["END"],
        extra_body={"top_k": 40, "min_p": 0.05},
    )
    equal(m.invoke("hi").content, "Hello world from the fixture.", "content")


@lab.scenario("openai.tools_bridge_roundtrip")
def _():
    m = openai_model().bind_tools([get_weather])
    first = m.invoke("CALLTOOL")
    check(first.tool_calls and first.tool_calls[0]["name"] == "get_weather", f"no tool call: {first}")
    equal(first.tool_calls[0]["args"].get("city"), "Paris", "args")
    done = m.invoke(["CALLTOOL", first, ToolMessage(content="sunny", tool_call_id=first.tool_calls[0]["id"])])
    equal(done.content, "Tool result: sunny", "final")


@lab.scenario("openai.tools_bridge_stream")
def _():
    m = openai_model().bind_tools([get_weather])
    merged = None
    for chunk in m.stream("CALLTOOL"):
        merged = chunk if merged is None else merged + chunk
    check(merged.tool_calls and merged.tool_calls[0]["args"].get("city") == "Paris", f"streamed tool call: {merged.tool_calls}")


@lab.scenario("openai.tools_on_an_agent_that_cannot_bridge_is_explicit")
def _():
    m = ChatOpenAI(model=NATIVE, base_url=V1, api_key=API_KEY, max_retries=0).bind_tools([get_weather])
    try:
        m.invoke("hi")
    except Exception as error:  # noqa: BLE001
        check("compat" in str(error) and "managed" in str(error), f"the error does not name the way out: {error}")
        return
    raise AssertionError("tools were silently accepted for an agent that cannot take them over")


@lab.scenario("openai.structured_output_json_schema")
def _():
    m = openai_model().with_structured_output(Answer, method="json_schema")
    r = m.invoke("who?")
    equal((r.answer, r.n), ("x", 1), "parsed")


@lab.scenario("openai.responses_api_invoke_and_stream")
def _():
    m = openai_model(use_responses_api=True)
    r = m.invoke("hi")
    equal(r.text, "Hello world from the fixture.", "text")
    text = "".join(c.text for c in m.stream("LONG"))
    check("Paragraph 6" in text, "responses stream lost text")


@lab.scenario("openai.responses_api_with_system_and_history")
def _():
    m = openai_model(use_responses_api=True)
    r = m.invoke([SystemMessage("SYSTEM_MARK"), HumanMessage("first question"), AIMessage("first answer"), HumanMessage("SHOW_PROMPT")])
    for mark in ("SYSTEM_MARK", "first question", "first answer"):
        check(mark in r.text, f"{mark} lost: {r.text[:100]}")


# ---------------------------------------------------------- langchain-anthropic
@lab.scenario("anthropic.invoke_and_stream")
def _():
    m = anthropic_model()
    r = m.invoke("hi")
    equal(r.text, "Hello world from the fixture.", "text")
    text = "".join(c.text for c in m.stream("LONG"))
    check("Paragraph 6" in text, "stream lost text")


@lab.scenario("anthropic.system_and_history")
def _():
    r = anthropic_model().invoke([SystemMessage("SYSTEM_MARK"), HumanMessage("first question"), AIMessage("first answer"), HumanMessage("SHOW_PROMPT")])
    for mark in ("SYSTEM_MARK", "first question", "first answer"):
        check(mark in r.text, f"{mark} lost")


@lab.scenario("anthropic.tools_bridge_roundtrip")
def _():
    m = anthropic_model().bind_tools([get_weather])
    first = m.invoke("CALLTOOL")
    check(first.tool_calls and first.tool_calls[0]["name"] == "get_weather", f"no tool call: {first.content}")
    done = m.invoke(["CALLTOOL", first, ToolMessage(content="sunny", tool_call_id=first.tool_calls[0]["id"])])
    equal(done.text, "Tool result: sunny", "final")



@lab.scenario("structured.with_structured_output_json_schema_and_correction")
def _():
    m = openai_model().with_structured_output(Answer, method="json_schema")
    r = m.invoke("BADJSON who?")
    equal((r.answer, r.n), ("x", 1), "parsed")


@lab.scenario("structured.with_structured_output_json_mode")
def _():
    m = openai_model().with_structured_output(Answer, method="json_mode")
    r = m.invoke("Reply with a JSON object with the keys answer (a string) and n (an integer).")
    check(r.answer is not None, "parsed")


lab.done()
