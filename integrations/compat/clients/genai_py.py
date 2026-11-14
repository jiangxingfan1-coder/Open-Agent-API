"""Official `google-genai` Python SDK against the gateway: generateContent."""

import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from harness import ACP, API_KEY, BASE_URL, FIXTURE, Lab, acp_script, check, equal, make_key, runs_created, snapshot_runs, PNG_B64  # noqa: E402

try:
    from google import genai
    from google.genai import errors, types
except ImportError as error:
    Lab("google-genai-python").skip(f"cannot import google-genai: {error}")
    Lab("google-genai-python").done()
    raise SystemExit(0)

try:
    from importlib.metadata import version as _version

    VERSION = _version("google-genai")
except Exception:  # noqa: BLE001
    VERSION = ""
lab = Lab("google-genai-python", VERSION)


def make(api_version="v1beta", headers=None, timeout=None, retry=None, key=API_KEY):
    options = types.HttpOptions(base_url=BASE_URL, api_version=api_version, headers=headers, timeout=timeout, retry_options=retry)
    return genai.Client(api_key=key, http_options=options)


client = make()
bridge = make(headers={"X-OAA-Client-Tools": "bridge"})
WEATHER = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="get_weather",
            description="Get the weather",
            parameters=types.Schema(type="OBJECT", properties={"city": types.Schema(type="STRING")}, required=["city"]),
        )
    ]
)


@lab.scenario("generate.basic")
def _():
    r = client.models.generate_content(model=FIXTURE, contents="hi")
    equal(r.text, "Hello world from the fixture.", "text")
    equal(r.candidates[0].finish_reason, types.FinishReason.STOP, "finish_reason")
    check(r.usage_metadata and r.usage_metadata.total_token_count > 0, "usage_metadata")


@lab.scenario("generate.api_version_v1")
def _():
    v1 = make("v1")  # keep a reference: a garbage-collected client closes its HTTP session
    r = v1.models.generate_content(model=FIXTURE, contents="hi")
    equal(r.text, "Hello world from the fixture.", "text")


@lab.scenario("generate.stream")
def _():
    chunks = list(client.models.generate_content_stream(model=FIXTURE, contents="LONG"))
    check(len(chunks) > 5, f"only {len(chunks)} chunks")
    text = "".join(c.text or "" for c in chunks)
    check("Paragraph 6" in text, "stream lost text")
    last = chunks[-1]
    equal(last.candidates[0].finish_reason, types.FinishReason.STOP, "last finish_reason")
    check(last.usage_metadata is not None, "usage on the last chunk")


@lab.scenario("generate.system_instruction_and_history")
def _():
    r = client.models.generate_content(
        model=FIXTURE,
        contents=[
            types.Content(role="user", parts=[types.Part(text="first question")]),
            types.Content(role="model", parts=[types.Part(text="first answer")]),
            types.Content(role="user", parts=[types.Part(text="SHOW_PROMPT")]),
        ],
        config=types.GenerateContentConfig(system_instruction="SYSTEM_MARK"),
    )
    for mark in ("SYSTEM_MARK", "first question", "first answer"):
        check(mark in r.text, f"{mark} did not reach the agent")


@lab.scenario("generate.chat_session")
def _():
    chat = client.chats.create(model=FIXTURE, config=types.GenerateContentConfig(system_instruction="sys"))
    chat.send_message("one")
    r = chat.send_message("SHOW_PROMPT")
    check("one" in r.text, "chat history did not reach the agent")
    parts = [c.text for c in chat.send_message_stream("two")]
    check("".join(p or "" for p in parts) != "", "no streamed text")


@lab.scenario("generate.config_params_tolerated")
def _():
    r = client.models.generate_content(
        model=FIXTURE,
        contents="hi",
        config=types.GenerateContentConfig(
            temperature=0.2,
            top_p=0.9,
            top_k=40,
            candidate_count=1,
            stop_sequences=["END"],
            presence_penalty=0.1,
            frequency_penalty=0.1,
            seed=1,
            safety_settings=[types.SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="BLOCK_NONE")],
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    equal(r.text, "Hello world from the fixture.", "text")


@lab.scenario("generate.json_mime_type")
def _():
    r = client.models.generate_content(model=FIXTURE, contents="JSON", config=types.GenerateContentConfig(response_mime_type="application/json"))
    equal(r.text, '{"answer":"ok","n":1}', "text")


@lab.scenario("generate.max_output_tokens_finish")
def _():
    r = client.models.generate_content(model=FIXTURE, contents="LENGTH", config=types.GenerateContentConfig(max_output_tokens=5))
    equal(r.candidates[0].finish_reason, types.FinishReason.MAX_TOKENS, "finish_reason")


@lab.scenario("generate.tools_declared_default_mode")
def _():
    r = client.models.generate_content(model=FIXTURE, contents="hi", config=types.GenerateContentConfig(tools=[WEATHER], automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True)))
    equal(r.text, "Hello world from the fixture.", "text")


@lab.scenario("generate.tools_bridge_manual_roundtrip")
def _():
    config = types.GenerateContentConfig(tools=[WEATHER], automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True))
    first = client.models.generate_content(model=FIXTURE, contents="CALLTOOL", config=config)
    calls = first.function_calls
    check(calls and calls[0].name == "get_weather", "no function call")
    equal(calls[0].args.get("city"), "Paris", "args")
    done = client.models.generate_content(
        model=FIXTURE,
        config=config,
        contents=[
            types.Content(role="user", parts=[types.Part(text="CALLTOOL")]),
            first.candidates[0].content,
            types.Content(role="user", parts=[types.Part.from_function_response(name=calls[0].name, response={"output": "sunny"})]),
        ],
    )
    check("sunny" in done.text and done.text.startswith("Tool result:"), f"final text: {done.text}")


@lab.scenario("generate.tools_bridge_automatic_function_calling")
def _():
    seen = []

    def get_weather(city: str) -> str:
        """Get the weather for a city."""
        seen.append(city)
        return "sunny"

    r = client.models.generate_content(model=FIXTURE, contents="CALLTOOL", config=types.GenerateContentConfig(tools=[get_weather]))
    equal(seen, ["Paris"], "the SDK did not run the Python function")
    check("sunny" in r.text, f"final text: {r.text}")


@lab.scenario("generate.tools_explicit_bridge_mode")
def _():
    config = types.GenerateContentConfig(tools=[WEATHER], automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True))
    first = bridge.models.generate_content(model=FIXTURE, contents="CALLTOOL", config=config)
    check(first.function_calls and first.function_calls[0].name == "get_weather", "no function call")


@lab.scenario("generate.tools_acp_agent_roundtrip")
def _():
    config = types.GenerateContentConfig(tools=[WEATHER], automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True))
    prompt = acp_script([{"name": "get_weather", "arguments": {"city": "Paris"}}])
    first = client.models.generate_content(model=ACP, contents=prompt, config=config)
    calls = first.function_calls
    check(calls and calls[0].name == "get_weather", "no function call from the ACP agent")
    done = client.models.generate_content(
        model=ACP,
        config=config,
        contents=[
            types.Content(role="user", parts=[types.Part(text=prompt)]),
            first.candidates[0].content,
            types.Content(role="user", parts=[types.Part.from_function_response(name=calls[0].name, response={"output": "sunny"})]),
        ],
    )
    check("sunny" in done.text, f"the ACP agent did not see the tool result: {done.text[:120]}")


@lab.scenario("generate.inline_data_image")
def _():
    import base64

    png = base64.b64decode(PNG_B64)
    r = client.models.generate_content(
        model=FIXTURE,
        contents=[types.Content(role="user", parts=[types.Part(text="SHOW_IMAGES"), types.Part.from_bytes(data=png, mime_type="image/png")])],
    )
    check((r.text or "").startswith("Images: 1 [image/png:"), f"reply: {r.text}")


@lab.scenario("generate.inline_data_not_an_image_rejected_clearly")
def _():
    try:
        client.models.generate_content(
            model=FIXTURE,
            contents=[types.Content(role="user", parts=[types.Part(text="what"), types.Part.from_bytes(data=b"\x89PNG", mime_type="image/png")])],
        )
    except errors.ClientError as error:
        equal(error.code, 400, "status")
        return
    raise AssertionError("a truncated image was accepted")


@lab.scenario("errors.authentication")
def _():
    wrong = make(key="sk-oaa-wrong")
    try:
        wrong.models.generate_content(model=FIXTURE, contents="hi")
    except errors.ClientError as error:
        equal(error.code, 401, "status")
        return
    raise AssertionError("no ClientError")


@lab.scenario("errors.unknown_model_404")
def _():
    try:
        client.models.generate_content(model="agent/does-not-exist", contents="hi")
    except errors.ClientError as error:
        equal(error.code, 404, "status")
        return
    raise AssertionError("no ClientError")


@lab.scenario("errors.run_failure_no_default_retry")
def _():
    before = snapshot_runs()
    try:
        client.models.generate_content(model=FIXTURE, contents="FAIL")
    except errors.APIError as error:
        equal(runs_created(before), 1, f"runs created (HTTP {error.code})")
        return f"HTTP {error.code} {type(error).__name__}, one run"
    raise AssertionError("a failed run reported success")


@lab.scenario("errors.run_failure_with_retry_options")
def _():
    retrying = make(retry=types.HttpRetryOptions(attempts=3, initial_delay=0.01, max_delay=0.02))
    before = snapshot_runs()
    try:
        retrying.models.generate_content(model=FIXTURE, contents="FAIL")
    except errors.APIError as error:
        equal(runs_created(before), 1, f"runs created with retry_options attempts=3 (HTTP {error.code})")
        return f"HTTP {error.code}, one run"
    raise AssertionError("a failed run reported success")


@lab.scenario("errors.rate_limit_429")
def _():
    limited = make(key=make_key(quota={"rpm": 1}))
    limited.models.generate_content(model=FIXTURE, contents="hi")
    try:
        limited.models.generate_content(model=FIXTURE, contents="hi")
    except errors.ClientError as error:
        equal(error.code, 429, "status")
        equal(error.status, "RESOURCE_EXHAUSTED", "error.status")
        return
    raise AssertionError("no ClientError")


@lab.scenario("errors.timeout")
def _():
    short = make(timeout=1000)
    try:
        short.models.generate_content(model=FIXTURE, contents="SLOW")
    except Exception as error:  # noqa: BLE001 - httpx timeout surfaces as ReadTimeout or an SDK error
        time.sleep(0.3)
        return f"{type(error).__name__} after 1s"
    raise AssertionError("no timeout")


@lab.scenario("models.get")
def _():
    m = client.models.get(model=FIXTURE)
    check(FIXTURE in (m.name or ""), f"model name {m.name}")


@lab.scenario("models.list")
def _():
    names = [m.name for m in client.models.list()]
    check(any(FIXTURE in (n or "") for n in names), f"{FIXTURE} not in {names}")


for name, call in (
    ("count_tokens", lambda: client.models.count_tokens(model=FIXTURE, contents="hi")),
    ("embed_content", lambda: client.models.embed_content(model=FIXTURE, contents="hi")),
    ("caches.list", lambda: list(client.caches.list())),
    ("files.list", lambda: list(client.files.list())),
):

    def scenario(call=call):
        try:
            call()
        except errors.APIError as error:
            check(error.code in (404, 501), f"HTTP {error.code}")
            return f"{type(error).__name__} HTTP {error.code}"
        raise AssertionError("served unexpectedly")

    lab.scenario(f"unsupported.{name}_is_a_clean_error")(scenario)


@lab.scenario("structured.response_schema_pydantic_with_a_correction_round")
def _():
    from pydantic import BaseModel

    class Person(BaseModel):
        name: str
        age: int

    r = client.models.generate_content(
        model=FIXTURE,
        contents="BADJSON who?",
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=Person),
    )
    equal((r.parsed.name, r.parsed.age), ("x", 1), "parsed")


@lab.scenario("structured.response_json_schema_and_plain_json_mime")
def _():
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
    r = client.models.generate_content(
        model=FIXTURE, contents="who?", config=types.GenerateContentConfig(response_mime_type="application/json", response_json_schema=schema)
    )
    equal(json.loads(r.text), {"ok": True}, "answer")
    plain = client.models.generate_content(model=FIXTURE, contents="who?", config=types.GenerateContentConfig(response_mime_type="application/json"))
    check(isinstance(json.loads(plain.text), dict), "plain json mime type")


@lab.scenario("structured.stream_holds_the_answer_until_it_is_checked")
def _():
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
    chunks = list(
        client.models.generate_content_stream(
            model=FIXTURE, contents="BADJSON who?", config=types.GenerateContentConfig(response_mime_type="application/json", response_json_schema=schema)
        )
    )
    text = "".join(c.text or "" for c in chunks)
    equal(json.loads(text), {"ok": True}, "streamed answer")
    equal(len([c for c in chunks if c.text]), 1, "text chunks")


@lab.scenario("structured.failure_is_a_clear_error")
def _():
    try:
        client.models.generate_content(
            model=FIXTURE,
            contents="ALWAYSBAD who?",
            config=types.GenerateContentConfig(response_mime_type="application/json", response_json_schema={"type": "object", "required": ["a"]}),
        )
    except errors.ClientError as error:
        equal(error.code, 422, "status")
        return
    raise AssertionError("an answer that does not fit was returned as a success")


lab.done()
