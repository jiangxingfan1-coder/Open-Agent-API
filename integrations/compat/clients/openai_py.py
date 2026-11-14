"""Official `openai` Python SDK against the gateway: Chat Completions and Responses."""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import API_KEY, BASE_URL, FIXTURE, SAMPLE, Lab, NotApplicable, check, equal, cancel_active_runs, make_key, runs_created, snapshot_runs  # noqa: E402

try:
    import openai
    from openai import OpenAI
except ImportError as error:
    Lab("openai-python").skip(f"cannot import openai: {error}")
    Lab("openai-python").done()
    raise SystemExit(0)

lab = Lab("openai-python", openai.__version__)
client = OpenAI(base_url=f"{BASE_URL}/v1", api_key=API_KEY, max_retries=0)
# Caller-defined tools need the compat mode: /v1/compat as Base URL, X-OAA-Client-Tools: bridge to hand calls back.
bridge = OpenAI(
    base_url=f"{BASE_URL}/v1/compat",
    api_key=API_KEY,
    max_retries=0,
    default_headers={"X-OAA-Client-Tools": "bridge"},
)
compat = OpenAI(base_url=f"{BASE_URL}/v1/compat", api_key=API_KEY, max_retries=0)
TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}
RTOOL = {"type": "function", "name": "get_weather", "description": "Get the weather", "parameters": TOOL["function"]["parameters"], "strict": False}


def text_of(completion) -> str:
    return completion.choices[0].message.content or ""


# ---------------------------------------------------------------- models
@lab.scenario("models.list")
def _():
    page = client.models.list()
    ids = [m.id for m in page.data]
    check(FIXTURE in ids and SAMPLE in ids, f"agents missing from /v1/models: {ids}")


@lab.scenario("models.retrieve")
def _():
    model = client.models.retrieve(FIXTURE)
    equal(model.id, FIXTURE, "model id")


# ---------------------------------------------------------------- chat
@lab.scenario("chat.basic")
def _():
    r = client.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "hi"}])
    equal(r.choices[0].finish_reason, "stop", "finish_reason")
    equal(text_of(r), "Hello world from the fixture.", "content")
    check(r.usage and r.usage.total_tokens > 0, "usage missing")
    equal(r.model, FIXTURE, "model echoes the agent name")


@lab.scenario("chat.sample_agent")
def _():
    r = client.chat.completions.create(model=SAMPLE, messages=[{"role": "user", "content": "hello"}])
    check("sample agent" in text_of(r), text_of(r)[:80])


@lab.scenario("chat.stream")
def _():
    chunks = list(client.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "LONG"}], stream=True))
    check(len(chunks) > 5, f"only {len(chunks)} chunks for a long answer")
    equal(chunks[0].choices[0].delta.role, "assistant", "first delta role")
    text = "".join(c.choices[0].delta.content or "" for c in chunks if c.choices)
    check("Paragraph 6" in text, "stream lost text")
    equal([c.choices[0].finish_reason for c in chunks if c.choices][-1], "stop", "last finish_reason")


@lab.scenario("chat.stream_include_usage")
def _():
    chunks = list(
        client.chat.completions.create(
            model=FIXTURE, messages=[{"role": "user", "content": "hi"}], stream=True, stream_options={"include_usage": True}
        )
    )
    last = chunks[-1]
    check(last.usage is not None and last.usage.total_tokens > 0, "no usage chunk")
    equal(len(last.choices), 0, "usage chunk choices")


@lab.scenario("chat.stream_helper")
def _():
    with client.chat.completions.stream(model=FIXTURE, messages=[{"role": "user", "content": "hi"}]) as stream:
        final = stream.get_final_completion()
    equal(text_of(final), "Hello world from the fixture.", "accumulated content")


@lab.scenario("chat.system_developer_history")
def _():
    r = client.chat.completions.create(
        model=FIXTURE,
        messages=[
            {"role": "system", "content": "SYSTEM_MARK"},
            {"role": "developer", "content": "DEVELOPER_MARK"},
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "first answer"},
            {"role": "user", "content": "SHOW_PROMPT"},
        ],
    )
    seen = text_of(r)
    for mark in ("SYSTEM_MARK", "DEVELOPER_MARK", "first question", "first answer"):
        check(mark in seen, f"{mark} did not reach the agent")


@lab.scenario("chat.content_parts")
def _():
    r = client.chat.completions.create(
        model=FIXTURE,
        messages=[{"role": "user", "content": [{"type": "text", "text": "SHOW_PROMPT"}, {"type": "text", "text": "part two"}]}],
    )
    check("part two" in text_of(r), "second text part lost")


@lab.scenario("chat.sampling_params_tolerated")
def _():
    r = client.chat.completions.create(
        model=FIXTURE,
        messages=[{"role": "user", "content": "hi"}],
        temperature=0.3,
        top_p=0.9,
        presence_penalty=0.1,
        frequency_penalty=0.2,
        seed=7,
        stop=["a", "b", "c", "d", "e", "f"],
        user="lab-user",
        logit_bias={"50256": -100},
        n=1,
        max_completion_tokens=200,
        store=False,
        metadata={"lab": "1"},
    )
    equal(text_of(r), "Hello world from the fixture.", "content")


@lab.scenario("chat.extra_body_vendor_params")
def _():
    # What chat UIs add as "custom parameters" (Ollama / llama.cpp / vLLM sampling knobs).
    r = client.chat.completions.create(
        model=FIXTURE,
        messages=[{"role": "user", "content": "hi"}],
        extra_body={"top_k": 40, "min_p": 0.05, "repetition_penalty": 1.1, "repeat_penalty": 1.1, "num_ctx": 4096},
    )
    equal(text_of(r), "Hello world from the fixture.", "content")


@lab.scenario("chat.reasoning_effort")
def _():
    r = client.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "hi"}], reasoning_effort="low")
    equal(text_of(r), "Hello world from the fixture.", "content")


@lab.scenario("chat.max_tokens_connectivity")
def _():
    r = client.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "hi"}], max_tokens=1)
    check(r.choices[0].finish_reason in ("stop", "length"), r.choices[0].finish_reason)


@lab.scenario("chat.length_finish")
def _():
    r = client.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "LENGTH"}])
    equal(r.choices[0].finish_reason, "length", "finish_reason")
    equal(text_of(r), "partial text", "partial text kept")


@lab.scenario("chat.tools_bridge_roundtrip")
def _():
    first = bridge.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "CALLTOOL"}], tools=[TOOL])
    equal(first.choices[0].finish_reason, "tool_calls", "finish_reason")
    calls = first.choices[0].message.tool_calls
    check(calls and calls[0].function.name == "get_weather", "no tool call")
    args = json.loads(calls[0].function.arguments)
    equal(args.get("city"), "Paris", "tool arguments")
    done = bridge.chat.completions.create(
        model=FIXTURE,
        tools=[TOOL],
        messages=[
            {"role": "user", "content": "CALLTOOL"},
            {"role": "assistant", "content": None, "tool_calls": [c.model_dump() for c in calls]},
            {"role": "tool", "tool_call_id": calls[0].id, "content": "sunny"},
        ],
    )
    equal(text_of(done), "Tool result: sunny", "final answer after the tool result")


@lab.scenario("chat.tools_bridge_stream")
def _():
    chunks = list(bridge.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "CALLTOOL"}], tools=[TOOL], stream=True))
    names = [tc.function.name for c in chunks if c.choices for tc in (c.choices[0].delta.tool_calls or []) if tc.function and tc.function.name]
    equal(names, ["get_weather"], "streamed tool call names")
    equal([c.choices[0].finish_reason for c in chunks if c.choices][-1], "tool_calls", "finish_reason")


@lab.scenario("chat.tools_default_endpoint_is_explicit")
def _():
    try:
        client.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "hi"}], tools=[TOOL])
    except openai.BadRequestError as error:
        body = error.body or {}
        code = body.get("code") if isinstance(body, dict) else None
        equal(code, "unsupported_parameter", "error code")
        check("compat" in str(error).lower(), f"the error does not say where tools are accepted: {error}")
        return
    raise AssertionError("tools were silently accepted on the default endpoint")


@lab.scenario("chat.response_format_json")
def _():
    r = compat.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "JSON"}], response_format={"type": "json_object"})
    equal(json.loads(text_of(r)).get("answer"), "ok", "parsed JSON")


@lab.scenario("chat.image_part_rejected_clearly")
def _():
    try:
        client.chat.completions.create(
            model=FIXTURE,
            messages=[{"role": "user", "content": [{"type": "text", "text": "what is this"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}],
        )
    except openai.BadRequestError as error:
        equal((error.body or {}).get("code"), "unsupported_content", "error code")
        equal((error.body or {}).get("param"), "messages.0.content.1", "error param")
        return
    raise AssertionError("an image part was accepted")


@lab.scenario("chat.concurrent_requests")
def _():
    # Chat UIs fire the answer, a title and tags/follow-ups at the same time with the same key and agent.
    from concurrent.futures import ThreadPoolExecutor

    def one(i):
        agent = SAMPLE if i % 3 == 0 else FIXTURE
        stream = i % 2 == 0
        r = client.chat.completions.create(model=agent, messages=[{"role": "user", "content": "hello"}], stream=stream)
        return "".join(c.choices[0].delta.content or "" for c in r if c.choices) if stream else text_of(r)

    with ThreadPoolExecutor(max_workers=8) as pool:
        answers = list(pool.map(one, range(8)))
    check(all(answers), f"an answer was empty: {answers}")


@lab.scenario("chat.error_authentication")
def _():
    bad = OpenAI(base_url=f"{BASE_URL}/v1", api_key="sk-oaa-wrong", max_retries=0)
    try:
        bad.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "hi"}])
    except openai.AuthenticationError as error:
        equal(error.status_code, 401, "status")
        return
    raise AssertionError("no AuthenticationError")


@lab.scenario("chat.error_unknown_model")
def _():
    try:
        client.chat.completions.create(model="agent/does-not-exist", messages=[{"role": "user", "content": "hi"}])
    except openai.NotFoundError as error:
        equal((error.body or {}).get("type") is not None, True, "error.type present")
        return
    raise AssertionError("no NotFoundError")


@lab.scenario("chat.error_bad_request")
def _():
    try:
        client.chat.completions.create(model=FIXTURE, messages=[])
    except openai.BadRequestError:
        return
    raise AssertionError("no BadRequestError for empty messages")


@lab.scenario("chat.error_run_failure_not_retried")
def _():
    retrying = OpenAI(base_url=f"{BASE_URL}/v1", api_key=API_KEY, max_retries=2)
    before = snapshot_runs()
    try:
        retrying.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "FAIL"}])
    except openai.APIStatusError as error:
        created = runs_created(before)
        equal(created, 1, f"runs created for one failed call with max_retries=2 (HTTP {error.status_code})")
        return f"HTTP {error.status_code} {type(error).__name__}, one run"
    raise AssertionError("a failed run was reported as success")


@lab.scenario("chat.error_rate_limit_429")
def _():
    limited = OpenAI(base_url=f"{BASE_URL}/v1", api_key=make_key(quota={"rpm": 1}), max_retries=0)
    limited.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "hi"}])
    try:
        limited.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "hi"}])
    except openai.RateLimitError as error:
        retry_after = error.response.headers.get("retry-after")
        check(retry_after and float(retry_after) > 0, f"429 without a usable Retry-After ({retry_after!r})")
        return f"RateLimitError, Retry-After {retry_after}s"
    raise AssertionError("no RateLimitError")


@lab.scenario("chat.error_permission_403")
def _():
    scoped = OpenAI(base_url=f"{BASE_URL}/v1", api_key=make_key(agents=[SAMPLE]), max_retries=0)
    try:
        scoped.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "hi"}])
    except openai.PermissionDeniedError:
        return
    except openai.NotFoundError:
        return "an agent outside the key's scope is reported as 404 NotFoundError (does not reveal it exists)"
    raise AssertionError("an out-of-scope agent was served")


@lab.scenario("chat.sample_agent_stream_without_usage")
def _():
    # Native / external agents report no token usage; include_usage must still produce a parseable stream.
    chunks = list(client.chat.completions.create(model=SAMPLE, messages=[{"role": "user", "content": "hello"}], stream=True, stream_options={"include_usage": True}))
    check("sample agent" in "".join(c.choices[0].delta.content or "" for c in chunks if c.choices), "stream text")


@lab.scenario("responses.sample_agent_without_usage")
def _():
    r = client.responses.create(model=SAMPLE, input="hello")
    equal(r.status, "completed", "status")
    check("sample agent" in r.output_text, "output_text")


@lab.scenario("chat.timeout_with_default_retries")
def _():
    # The SDK retries a timed-out request (max_retries=2 by default), but the gateway does not cancel an
    # accepted run when the client disconnects: every retry starts another run of the agent.
    retrying = OpenAI(base_url=f"{BASE_URL}/v1", api_key=API_KEY, max_retries=2, timeout=0.6)
    before = snapshot_runs()
    try:
        retrying.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "SLOW"}])
    except openai.APITimeoutError:
        time.sleep(0.3)
        created = runs_created(before)
        cancel_active_runs()
        return f"APITimeoutError; runs started by 1 call with max_retries=2: {created} (the abandoned runs keep executing)"
    raise AssertionError("no timeout")


@lab.scenario("chat.timeout")
def _():
    short = OpenAI(base_url=f"{BASE_URL}/v1", api_key=API_KEY, max_retries=0, timeout=1.0)
    before = snapshot_runs()
    try:
        short.chat.completions.create(model=FIXTURE, messages=[{"role": "user", "content": "SLOW"}])
    except openai.APITimeoutError:
        time.sleep(0.5)
        created = runs_created(before)
        cancel_active_runs()
        return f"APITimeoutError after 1s; runs created: {created}"
    raise AssertionError("no timeout")


# ---------------------------------------------------------------- responses
@lab.scenario("responses.basic")
def _():
    r = client.responses.create(model=FIXTURE, input="hi")
    equal(r.status, "completed", "status")
    equal(r.output_text, "Hello world from the fixture.", "output_text")
    check(r.usage and r.usage.total_tokens > 0, "usage missing")


@lab.scenario("responses.stream")
def _():
    events = []
    with client.responses.stream(model=FIXTURE, input="LONG") as stream:
        for event in stream:
            events.append(event.type)
        final = stream.get_final_response()
    check("response.output_text.delta" in events, f"no text deltas: {sorted(set(events))}")
    check("Paragraph 6" in final.output_text, "stream lost text")


@lab.scenario("responses.instructions_and_message_items")
def _():
    r = client.responses.create(
        model=FIXTURE,
        instructions="INSTRUCTION_MARK",
        input=[
            {"role": "developer", "content": "DEVELOPER_MARK"},
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "first answer"},
            {"role": "user", "content": [{"type": "input_text", "text": "SHOW_PROMPT"}]},
        ],
    )
    for mark in ("INSTRUCTION_MARK", "DEVELOPER_MARK", "first question", "first answer"):
        check(mark in r.output_text, f"{mark} did not reach the agent")


@lab.scenario("responses.typed_message_items")
def _():
    # The shape the Agents SDK / LangChain send: explicit type "message" and output_text history.
    r = client.responses.create(
        model=FIXTURE,
        input=[
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "q1"}]},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "a1"}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "SHOW_PROMPT"}]},
        ],
    )
    check("q1" in r.output_text and "a1" in r.output_text, "typed history lost")


@lab.scenario("responses.sampling_params_tolerated")
def _():
    r = client.responses.create(
        model=FIXTURE,
        input="hi",
        temperature=0.2,
        top_p=0.9,
        max_output_tokens=300,
        user="lab",
        store=False,
        parallel_tool_calls=True,
        tool_choice="auto",
        reasoning={"effort": "low"},
        text={"format": {"type": "text"}},
        metadata={"lab": "1"},
    )
    equal(r.output_text, "Hello world from the fixture.", "output_text")


@lab.scenario("responses.previous_response_id")
def _():
    first = client.responses.create(model=FIXTURE, input="first question")
    second = client.responses.create(model=FIXTURE, input="SHOW_PROMPT", previous_response_id=first.id)
    check("first question" in second.output_text, f"the continuation did not see the earlier turn: {second.output_text[:120]}")


@lab.scenario("responses.retrieve")
def _():
    first = client.responses.create(model=FIXTURE, input="hi")
    again = client.responses.retrieve(first.id)
    equal(again.id, first.id, "id")
    equal(again.output_text, first.output_text, "output_text")


@lab.scenario("responses.retrieve_unknown_404")
def _():
    try:
        client.responses.retrieve("resp_does_not_exist")
    except openai.NotFoundError:
        return
    raise AssertionError("no NotFoundError")


@lab.scenario("responses.background_poll")
def _():
    r = client.responses.create(model=FIXTURE, input="hi", background=True)
    check(r.status in ("queued", "in_progress", "completed"), r.status)
    for _ in range(50):
        r = client.responses.retrieve(r.id)
        if r.status in ("completed", "failed", "cancelled", "incomplete"):
            break
        time.sleep(0.1)
    equal(r.status, "completed", "final status")
    equal(r.output_text, "Hello world from the fixture.", "output_text")


@lab.scenario("responses.background_cancel")
def _():
    r = client.responses.create(model=FIXTURE, input="SLOW", background=True)
    cancelled = client.responses.cancel(r.id)
    check(cancelled.status in ("cancelled", "in_progress", "queued"), cancelled.status)
    for _ in range(50):
        cancelled = client.responses.retrieve(r.id)
        if cancelled.status == "cancelled":
            return
        time.sleep(0.1)
    raise AssertionError(f"status stayed {cancelled.status}")


@lab.scenario("responses.tools_bridge_roundtrip")
def _():
    first = bridge.responses.create(model=FIXTURE, input="CALLTOOL", tools=[RTOOL])
    calls = [o for o in first.output if o.type == "function_call"]
    check(len(calls) == 1 and calls[0].name == "get_weather", "no function_call item")
    equal(json.loads(calls[0].arguments).get("city"), "Paris", "arguments")
    done = bridge.responses.create(
        model=FIXTURE,
        tools=[RTOOL],
        previous_response_id=first.id,
        input=[{"type": "function_call_output", "call_id": calls[0].call_id, "output": "sunny"}],
    )
    equal(done.output_text, "Tool result: sunny", "final answer")


@lab.scenario("responses.structured_output")
def _():
    r = compat.responses.create(
        model=FIXTURE,
        input="JSON",
        text={"format": {"type": "json_schema", "name": "a", "schema": {"type": "object", "properties": {"answer": {"type": "string"}}}, "strict": False}},
    )
    equal(json.loads(r.output_text).get("answer"), "ok", "parsed JSON")


@lab.scenario("responses.error_failed_run")
def _():
    # A failed run is HTTP 200 with status "failed" and an error object (how the Responses API reports it).
    r = client.responses.create(model=FIXTURE, input="FAIL")
    equal(r.status, "failed", "status")
    check(r.error is not None and r.error.code, "no error object on a failed response")
    return f"status failed, error.code={r.error.code}"


@lab.scenario("responses.unsupported_input_image")
def _():
    try:
        client.responses.create(
            model=FIXTURE,
            input=[{"role": "user", "content": [{"type": "input_text", "text": "look"}, {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}]}],
        )
    except openai.BadRequestError as error:
        equal((error.body or {}).get("code"), "unsupported_content", "error code")
        return
    raise AssertionError("an image part was accepted")


@lab.scenario("responses.input_items_list")
def _():
    first = client.responses.create(model=FIXTURE, input="hi")
    try:
        client.responses.input_items.list(first.id)
    except openai.NotFoundError:
        raise NotApplicable("the gateway has no /v1/responses/{id}/input_items endpoint; the SDK gets a clean 404")
    except openai.APIStatusError as error:
        raise AssertionError(f"unexpected HTTP {error.status_code}")


@lab.scenario("unsupported_endpoints_are_clean_404")
def _():
    results = []
    for name, call in (
        ("embeddings", lambda: client.embeddings.create(model=FIXTURE, input="x")),
        ("files.list", lambda: client.files.list()),
        ("moderations", lambda: client.moderations.create(input="x")),
    ):
        try:
            call()
            results.append(f"{name}: unexpectedly served")
        except openai.NotFoundError:
            results.append(f"{name}: 404")
        except openai.APIStatusError as error:
            results.append(f"{name}: HTTP {error.status_code}")
        except Exception as error:  # noqa: BLE001
            raise AssertionError(f"{name}: {type(error).__name__}: {error}")
    return "; ".join(results)


lab.done()
