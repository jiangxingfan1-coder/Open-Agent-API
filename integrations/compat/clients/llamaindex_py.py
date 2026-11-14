"""LlamaIndex's OpenAI-compatible wrappers against the gateway (`OpenAILike`, and `OpenAI` for contrast)."""

import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import API_KEY, BASE_URL, FIXTURE, Lab, NotApplicable, check, equal  # noqa: E402

try:
    from importlib.metadata import version

    VERSION = f"llama-index-core {version('llama-index-core')}, llama-index-llms-openai-like {version('llama-index-llms-openai-like')}"
    from llama_index.core.llms import ChatMessage
    from llama_index.core.tools import FunctionTool
    from llama_index.llms.openai import OpenAI
    from llama_index.llms.openai_like import OpenAILike
except ImportError as error:
    Lab("llamaindex-python").skip(f"cannot import llama-index packages: {error}")
    Lab("llamaindex-python").done()
    raise SystemExit(0)

lab = Lab("llamaindex-python", VERSION)
V1 = f"{BASE_URL}/v1"
COMPAT = f"{BASE_URL}/v1/compat"
BRIDGE = {"X-OAA-Client-Tools": "bridge"}


def like(**kwargs):
    kwargs.setdefault("api_base", V1)
    return OpenAILike(model=FIXTURE, api_key=API_KEY, is_chat_model=True, max_retries=0, context_window=32000, **kwargs)


def get_weather(city: str) -> str:
    """Get the weather for a city."""
    return f"sunny in {city}"


@lab.scenario("openai_like.complete_and_chat")
def _():
    llm = like()
    equal(llm.complete("hi").text, "Hello world from the fixture.", "complete")
    r = llm.chat([ChatMessage(role="system", content="SYSTEM_MARK"), ChatMessage(role="user", content="first question"), ChatMessage(role="assistant", content="first answer"), ChatMessage(role="user", content="SHOW_PROMPT")])
    for mark in ("SYSTEM_MARK", "first question", "first answer"):
        check(mark in r.message.content, f"{mark} lost")


@lab.scenario("openai_like.stream_chat_and_complete")
def _():
    llm = like()
    text = ""
    parts = 0
    for r in llm.stream_chat([ChatMessage(role="user", content="LONG")]):
        text = r.message.content
        parts += 1
    check(parts > 3 and "Paragraph 6" in text, f"stream_chat: {parts} parts")
    text = "".join(r.delta or "" for r in llm.stream_complete("LONG"))
    check("Paragraph 6" in text, "stream_complete lost text")


@lab.scenario("openai_like.sampling_params_tolerated")
def _():
    llm = like(temperature=0.3, max_tokens=200, additional_kwargs={"top_p": 0.9, "frequency_penalty": 0.1, "presence_penalty": 0.1, "seed": 7, "stop": ["END"], "user": "lab"})
    equal(llm.complete("hi").text, "Hello world from the fixture.", "complete")


@lab.scenario("openai_like.tools_bridge_roundtrip")
def _():
    llm = like(api_base=COMPAT, default_headers=BRIDGE, is_function_calling_model=True)
    tool = FunctionTool.from_defaults(fn=get_weather)
    first = llm.chat_with_tools([tool], user_msg="CALLTOOL")
    calls = llm.get_tool_calls_from_response(first, error_on_no_tool_call=False)
    check(calls and calls[0].tool_name == "get_weather", f"no tool call: {first.message.content!r}")
    equal(calls[0].tool_kwargs.get("city"), "Paris", "tool kwargs")


@lab.scenario("openai_like.tools_on_default_endpoint_error_says_where")
def _():
    llm = like(is_function_calling_model=True)
    tool = FunctionTool.from_defaults(fn=get_weather)
    try:
        llm.chat_with_tools([tool], user_msg="hi")
    except Exception as error:  # noqa: BLE001
        check("compat" in str(error), f"the error does not point to /v1/compat: {error}")
        return
    raise AssertionError("tools were silently accepted on the default endpoint")


@lab.scenario("openai_class.unknown_model_name")
def _():
    # The plain `OpenAI` LLM validates the model name against OpenAI's own list before any request.
    try:
        OpenAI(model=FIXTURE, api_base=V1, api_key=API_KEY).complete("hi")
    except ValueError as error:
        raise NotApplicable(f"client-side: llama_index.llms.openai.OpenAI rejects the agent name ({str(error)[:90]}); use OpenAILike")
    raise AssertionError("OpenAI accepted an unknown model name")


lab.done()
