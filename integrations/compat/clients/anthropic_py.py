"""Official `anthropic` Python SDK against the gateway: the Messages API."""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import ACP, API_KEY, BASE_URL, FIXTURE, Lab, acp_script, check, equal, make_key, runs_created, snapshot_runs  # noqa: E402

try:
    import anthropic
    from anthropic import Anthropic
except ImportError as error:
    Lab("anthropic-python").skip(f"cannot import anthropic: {error}")
    Lab("anthropic-python").done()
    raise SystemExit(0)

lab = Lab("anthropic-python", anthropic.__version__)
client = Anthropic(base_url=BASE_URL, api_key=API_KEY, max_retries=0)
bridge = Anthropic(base_url=BASE_URL, api_key=API_KEY, max_retries=0, default_headers={"X-OAA-Client-Tools": "bridge"})
TOOL = {
    "name": "get_weather",
    "description": "Get the weather",
    "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
}
MODEL = FIXTURE


def ask(content, **kwargs):
    return client.messages.create(model=MODEL, max_tokens=256, messages=[{"role": "user", "content": content}], **kwargs)


def text_of(message) -> str:
    return "".join(b.text for b in message.content if b.type == "text")


@lab.scenario("messages.basic")
def _():
    m = ask("hi")
    equal(m.type, "message", "type")
    equal(m.role, "assistant", "role")
    equal(m.stop_reason, "end_turn", "stop_reason")
    equal(text_of(m), "Hello world from the fixture.", "text")
    check(m.usage.input_tokens > 0 and m.usage.output_tokens > 0, "usage")
    equal(m.model, MODEL, "model")


@lab.scenario("messages.stream_event_sequence")
def _():
    events = [e.type for e in client.messages.create(model=MODEL, max_tokens=256, messages=[{"role": "user", "content": "LONG"}], stream=True)]
    equal(events[0], "message_start", "first event")
    equal(events[-1], "message_stop", "last event")
    for needed in ("content_block_start", "content_block_delta", "content_block_stop", "message_delta"):
        check(needed in events, f"missing {needed}")
    check(events.index("content_block_start") < events.index("content_block_delta") < events.index("content_block_stop") < events.index("message_delta"), "event order")


@lab.scenario("messages.stream_helper")
def _():
    with client.messages.stream(model=MODEL, max_tokens=256, messages=[{"role": "user", "content": "LONG"}]) as stream:
        pieces = list(stream.text_stream)
        final = stream.get_final_message()
    check(len(pieces) > 5, f"only {len(pieces)} text pieces")
    check("Paragraph 6" in text_of(final), "final text lost")
    equal(final.stop_reason, "end_turn", "stop_reason")
    check(final.usage.output_tokens > 0, "usage in final message")


@lab.scenario("messages.system_string")
def _():
    m = ask("SHOW_PROMPT", system="SYSTEM_MARK")
    check("SYSTEM_MARK" in text_of(m), "system string did not reach the agent")


@lab.scenario("messages.system_blocks")
def _():
    m = ask(
        "SHOW_PROMPT",
        system=[
            {"type": "text", "text": "SYSTEM_ONE", "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": "SYSTEM_TWO"},
        ],
    )
    seen = text_of(m)
    check("SYSTEM_ONE" in seen and "SYSTEM_TWO" in seen, "system blocks did not reach the agent")


@lab.scenario("messages.multiturn_and_content_blocks")
def _():
    m = client.messages.create(
        model=MODEL,
        max_tokens=256,
        messages=[
            {"role": "user", "content": [{"type": "text", "text": "first question"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "first answer"}]},
            {"role": "user", "content": [{"type": "text", "text": "SHOW_PROMPT"}, {"type": "text", "text": "second block"}]},
        ],
    )
    seen = text_of(m)
    for mark in ("first question", "first answer", "second block"):
        check(mark in seen, f"{mark} did not reach the agent")


@lab.scenario("messages.sampling_params_tolerated")
def _():
    # SDK 2.x dropped temperature / top_p / top_k from the typed signature; they still go through extra_body.
    m = ask(
        "hi",
        stop_sequences=["END"],
        metadata={"user_id": "lab"},
        thinking={"type": "disabled"},
        service_tier="auto",
        extra_body={"temperature": 0.2, "top_p": 0.9, "top_k": 40},
    )
    equal(text_of(m), "Hello world from the fixture.", "text")


@lab.scenario("messages.newer_request_fields_tolerated")
def _():
    # Fields added by recent SDK releases that a text-only agent can simply ignore.
    m = ask(
        "hi",
        cache_control={"type": "ephemeral"},
        inference_geo="us",
        speed="standard",
        output_config={"effort": "low"},
    )
    equal(text_of(m), "Hello world from the fixture.", "text")


@lab.scenario("messages.max_tokens_stop_reason")
def _():
    m = ask("LENGTH")
    equal(m.stop_reason, "max_tokens", "stop_reason")
    equal(text_of(m), "partial text", "partial text kept")


@lab.scenario("messages.tools_default_mode_is_not_an_error")
def _():
    m = ask("hi", tools=[TOOL], tool_choice={"type": "auto"})
    equal(text_of(m), "Hello world from the fixture.", "text")


@lab.scenario("messages.tools_bridge_roundtrip")
def _():
    first = client.messages.create(model=MODEL, max_tokens=256, messages=[{"role": "user", "content": "CALLTOOL"}], tools=[TOOL])
    equal(first.stop_reason, "tool_use", "stop_reason")
    uses = [b for b in first.content if b.type == "tool_use"]
    check(len(uses) == 1 and uses[0].name == "get_weather", "no tool_use block")
    equal(uses[0].input.get("city"), "Paris", "tool input")
    done = client.messages.create(
        model=MODEL,
        max_tokens=256,
        tools=[TOOL],
        messages=[
            {"role": "user", "content": "CALLTOOL"},
            {"role": "assistant", "content": [b.model_dump() for b in first.content]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": uses[0].id, "content": "sunny"}]},
        ],
    )
    equal(text_of(done), "Tool result: sunny", "final text")


@lab.scenario("messages.tools_bridge_stream")
def _():
    with client.messages.stream(model=MODEL, max_tokens=256, messages=[{"role": "user", "content": "CALLTOOL"}], tools=[TOOL]) as stream:
        final = stream.get_final_message()
    uses = [b for b in final.content if b.type == "tool_use"]
    check(len(uses) == 1 and uses[0].input == {"city": "Paris"}, f"streamed tool_use input: {[u.input for u in uses]}")
    equal(final.stop_reason, "tool_use", "stop_reason")


@lab.scenario("messages.tools_explicit_bridge_mode")
def _():
    first = bridge.messages.create(model=MODEL, max_tokens=256, messages=[{"role": "user", "content": "CALLTOOL"}], tools=[TOOL])
    equal(first.stop_reason, "tool_use", "stop_reason")


@lab.scenario("messages.tools_acp_agent_roundtrip")
def _():
    prompt = acp_script([{"name": "get_weather", "arguments": {"city": "Paris"}}])
    first = client.messages.create(model=ACP, max_tokens=256, messages=[{"role": "user", "content": prompt}], tools=[TOOL])
    equal(first.stop_reason, "tool_use", "stop_reason")
    use = [b for b in first.content if b.type == "tool_use"][0]
    done = client.messages.create(
        model=ACP,
        max_tokens=256,
        tools=[TOOL],
        messages=[
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": [b.model_dump() for b in first.content]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": use.id, "content": "sunny"}]},
        ],
    )
    check("sunny" in text_of(done), f"the ACP agent did not see the tool result: {text_of(done)[:120]}")


@lab.scenario("messages.image_rejected_clearly")
def _():
    try:
        client.messages.create(
            model=MODEL,
            max_tokens=64,
            messages=[{"role": "user", "content": [{"type": "text", "text": "what"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}]}],
        )
    except anthropic.BadRequestError as error:
        body = error.body or {}
        equal(body.get("type"), "error", "error envelope")
        equal((body.get("error") or {}).get("type"), "invalid_request_error", "error.type")
        return
    raise AssertionError("an image block was accepted")


@lab.scenario("errors.authentication")
def _():
    bad = Anthropic(base_url=BASE_URL, api_key="sk-oaa-wrong", max_retries=0)
    try:
        bad.messages.create(model=MODEL, max_tokens=8, messages=[{"role": "user", "content": "hi"}])
    except anthropic.AuthenticationError as error:
        equal((error.body or {}).get("error", {}).get("type"), "authentication_error", "error.type")
        return
    raise AssertionError("no AuthenticationError")


@lab.scenario("errors.unknown_model_404")
def _():
    try:
        client.messages.create(model="agent/does-not-exist", max_tokens=8, messages=[{"role": "user", "content": "hi"}])
    except anthropic.NotFoundError as error:
        equal((error.body or {}).get("error", {}).get("type"), "not_found_error", "error.type")
        return
    raise AssertionError("no NotFoundError")


@lab.scenario("errors.invalid_request_400")
def _():
    try:
        client.messages.create(model=MODEL, max_tokens=8, messages=[])
    except anthropic.BadRequestError:
        return
    raise AssertionError("no BadRequestError")


@lab.scenario("errors.run_failure_single_attempt")
def _():
    retrying = Anthropic(base_url=BASE_URL, api_key=API_KEY, max_retries=2)
    before = snapshot_runs()
    try:
        retrying.messages.create(model=MODEL, max_tokens=8, messages=[{"role": "user", "content": "FAIL"}])
    except anthropic.APIStatusError as error:
        equal(runs_created(before), 1, f"runs created for one failed call with max_retries=2 (HTTP {error.status_code})")
        return f"HTTP {error.status_code} {type(error).__name__}, one run"
    raise AssertionError("a failed run reported success")


@lab.scenario("errors.rate_limit_429")
def _():
    limited = Anthropic(base_url=BASE_URL, api_key=make_key(quota={"rpm": 1}), max_retries=0)
    limited.messages.create(model=MODEL, max_tokens=8, messages=[{"role": "user", "content": "hi"}])
    try:
        limited.messages.create(model=MODEL, max_tokens=8, messages=[{"role": "user", "content": "hi"}])
    except anthropic.RateLimitError as error:
        equal((error.body or {}).get("error", {}).get("type"), "rate_limit_error", "error.type")
        retry_after = error.response.headers.get("retry-after")
        check(retry_after and float(retry_after) > 0, f"429 without a usable Retry-After ({retry_after!r})")
        return f"RateLimitError, Retry-After {retry_after}s"
    raise AssertionError("no RateLimitError")


@lab.scenario("errors.timeout")
def _():
    short = Anthropic(base_url=BASE_URL, api_key=API_KEY, max_retries=0, timeout=1.0)
    try:
        short.messages.create(model=MODEL, max_tokens=8, messages=[{"role": "user", "content": "SLOW"}])
    except anthropic.APITimeoutError:
        time.sleep(0.3)
        return "APITimeoutError after 1s"
    raise AssertionError("no timeout")


@lab.scenario("models.list")
def _():
    page = client.models.list()
    ids = [m.id for m in page.data]
    check(FIXTURE in ids, f"{FIXTURE} not in {ids}")


@lab.scenario("models.retrieve")
def _():
    m = client.models.retrieve(FIXTURE)
    equal(m.id, FIXTURE, "id")


@lab.scenario("unsupported.count_tokens_is_clean_404")
def _():
    try:
        client.messages.count_tokens(model=MODEL, messages=[{"role": "user", "content": "hi"}])
    except anthropic.NotFoundError as error:
        equal((error.body or {}).get("error", {}).get("type"), "not_found_error", "error.type")
        return
    raise AssertionError("count_tokens did not 404")


@lab.scenario("unsupported.batches_is_clean_404")
def _():
    try:
        client.messages.batches.list()
    except anthropic.NotFoundError:
        return
    raise AssertionError("batches did not 404")



@lab.scenario("structured.output_config_format_with_a_correction_round")
def _():
    schema = {"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "integer"}}, "required": ["name", "age"], "additionalProperties": False}
    m = client.messages.create(
        model=MODEL,
        max_tokens=256,
        messages=[{"role": "user", "content": "BADJSON who?"}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    equal(json.loads(text_of(m)), {"name": "x", "age": 1}, "answer")
    equal(m.stop_reason, "end_turn", "stop_reason")


@lab.scenario("structured.parse_helper")
def _():
    from pydantic import BaseModel

    class Person(BaseModel):
        name: str
        age: int

    m = client.messages.parse(model=MODEL, max_tokens=256, messages=[{"role": "user", "content": "who?"}], output_format=Person)
    equal((m.parsed_output.name, m.parsed_output.age), ("x", 1), "parsed_output")


@lab.scenario("structured.failure_is_a_clear_error")
def _():
    try:
        client.messages.create(
            model=MODEL,
            max_tokens=64,
            messages=[{"role": "user", "content": "ALWAYSBAD who?"}],
            output_config={"format": {"type": "json_schema", "schema": {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}}},
        )
    except anthropic.UnprocessableEntityError as error:
        equal((error.body or {}).get("error", {}).get("code"), "structured_output_invalid", "error code")
        return
    raise AssertionError("an answer that does not fit was returned as a success")


lab.done()
