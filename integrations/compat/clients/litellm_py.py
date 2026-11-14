"""LiteLLM used as a library against the gateway (`openai/`, `anthropic/` and `gemini/` custom endpoints)."""

import json
import os
import sys
import warnings

# LiteLLM fetches its model price list from GitHub at import time unless told to use the bundled copy.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
os.environ.setdefault("LITELLM_LOG", "ERROR")
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import API_KEY, BASE_URL, FIXTURE, Lab, check, equal  # noqa: E402

try:
    import litellm
    from importlib.metadata import version

    VERSION = version("litellm")
except ImportError as error:
    Lab("litellm-python").skip(f"cannot import litellm: {error}")
    Lab("litellm-python").done()
    raise SystemExit(0)

lab = Lab("litellm-python", VERSION)
litellm.telemetry = False
V1 = f"{BASE_URL}/v1"
COMPAT = f"{BASE_URL}/v1/compat"
BRIDGE = {"X-OAA-Client-Tools": "bridge"}
TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}
OPENAI = f"openai/{FIXTURE}"


def say(content, **kwargs):
    kwargs.setdefault("model", OPENAI)
    kwargs.setdefault("api_base", V1)
    kwargs.setdefault("api_key", API_KEY)
    return litellm.completion(messages=[{"role": "user", "content": content}], num_retries=0, **kwargs)


@lab.scenario("openai.completion")
def _():
    r = say("hi")
    equal(r.choices[0].message.content, "Hello world from the fixture.", "content")
    equal(r.choices[0].finish_reason, "stop", "finish_reason")
    check(r.usage.total_tokens > 0, "usage")


@lab.scenario("openai.stream_with_usage")
def _():
    chunks = list(say("LONG", stream=True, stream_options={"include_usage": True}))
    check(len(chunks) > 5, f"only {len(chunks)} chunks")
    text = "".join((c.choices[0].delta.content or "") for c in chunks if c.choices)
    check("Paragraph 6" in text, "stream lost text")
    check(any(getattr(c, "usage", None) for c in chunks), "no usage chunk")


@lab.scenario("openai.sampling_params_tolerated")
def _():
    r = say("hi", temperature=0.3, top_p=0.9, frequency_penalty=0.1, presence_penalty=0.1, seed=7, stop=["END"], max_tokens=200, user="lab", n=1)
    equal(r.choices[0].message.content, "Hello world from the fixture.", "content")


@lab.scenario("openai.reasoning_effort")
def _():
    r = say("hi", reasoning_effort="low")
    equal(r.choices[0].message.content, "Hello world from the fixture.", "content")


@lab.scenario("openai.tools_bridge_roundtrip")
def _():
    first = say("CALLTOOL", tools=[TOOL])
    calls = first.choices[0].message.tool_calls
    check(calls and calls[0].function.name == "get_weather", "no tool call")
    equal(json.loads(calls[0].function.arguments).get("city"), "Paris", "arguments")
    done = litellm.completion(
        model=OPENAI,
        api_base=V1,
        api_key=API_KEY,
        tools=[TOOL],
        messages=[
            {"role": "user", "content": "CALLTOOL"},
            {"role": "assistant", "content": None, "tool_calls": [c.model_dump() for c in calls]},
            {"role": "tool", "tool_call_id": calls[0].id, "content": "sunny"},
        ],
    )
    equal(done.choices[0].message.content, "Tool result: sunny", "final")


@lab.scenario("openai.responses_api")
def _():
    r = litellm.responses(model=OPENAI, api_base=V1, api_key=API_KEY, input="hi")
    text = "".join(c.text for o in r.output if getattr(o, "type", "") == "message" for c in o.content)
    equal(text, "Hello world from the fixture.", "output text")


@lab.scenario("openai.error_mapping")
def _():
    try:
        say("hi", model="openai/agent/none")
    except litellm.NotFoundError:
        pass
    else:
        raise AssertionError("unknown model did not map to NotFoundError")
    try:
        say("hi", api_key="sk-oaa-wrong")
    except litellm.AuthenticationError:
        pass
    else:
        raise AssertionError("bad key did not map to AuthenticationError")
    try:
        say("FAIL")
    except (litellm.APIError, litellm.BadRequestError, litellm.UnprocessableEntityError) as error:
        # The gateway answers a failed run with HTTP 422 + x-should-retry: false; LiteLLM surfaces it as a
        # non-retryable client error, so a Router does not re-run (and re-bill) the agent.
        return f"failed run -> {type(error).__name__}"
    raise AssertionError("failed run did not raise")


@lab.scenario("anthropic.completion_and_stream")
def _():
    kwargs = dict(model=f"anthropic/{FIXTURE}", api_base=BASE_URL, api_key=API_KEY, num_retries=0, max_tokens=256)
    r = litellm.completion(messages=[{"role": "user", "content": "hi"}], **kwargs)
    equal(r.choices[0].message.content, "Hello world from the fixture.", "content")
    chunks = list(litellm.completion(messages=[{"role": "user", "content": "LONG"}], stream=True, **kwargs))
    text = "".join((c.choices[0].delta.content or "") for c in chunks if c.choices)
    check("Paragraph 6" in text, "stream lost text")


@lab.scenario("gemini.completion_and_stream")
def _():
    kwargs = dict(model=f"gemini/{FIXTURE}", api_base=f"{BASE_URL}/v1beta", api_key=API_KEY, num_retries=0)
    r = litellm.completion(messages=[{"role": "user", "content": "hi"}], **kwargs)
    equal(r.choices[0].message.content, "Hello world from the fixture.", "content")
    chunks = list(litellm.completion(messages=[{"role": "user", "content": "LONG"}], stream=True, **kwargs))
    text = "".join((c.choices[0].delta.content or "") for c in chunks if c.choices)
    check("Paragraph 6" in text, "stream lost text")


# Stream progress (docs/progress.md): LiteLLM passes reasoning_content through; content unchanged.
@lab.scenario("openai.stream_progress")
def _():
    def read(headers):
        content, reasoning = "", ""
        for c in say("LONG", stream=True, extra_headers=headers):
            if c.choices:
                content += c.choices[0].delta.content or ""
                reasoning += getattr(c.choices[0].delta, "reasoning_content", None) or ""
        return content, reasoning

    on, off = read({"X-OAA-Progress": "reasoning", "Accept-Language": "en"}), read({"X-OAA-Progress": "off"})
    equal(on[0], off[0], "content with progress on")
    equal(off[1], "", "no reasoning when off")
    return "reasoning_content shown" if on[1] else "progress ignored"


lab.done()
