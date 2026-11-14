"""Exercise the unmodified AgentScope Agent with credential-free fixture I/O."""
import asyncio
import importlib.metadata
import json
import platform
import sys

PROTOCOL = sys.stdout
sys.stdout = sys.stderr


def no_external_io(event, _args):
    if event in ("socket.connect", "socket.getaddrinfo", "subprocess.Popen", "os.system"):
        raise RuntimeError("External I/O is disabled in the paired fixture adapter")


sys.addaudithook(no_external_io)

import agentscope
from agentscope.agent import Agent, InjectionConfig, ModelConfig, ReActConfig
from agentscope.event import TextBlockDeltaEvent
from agentscope.formatter import OpenAIChatFormatter
from agentscope.message import UserMsg, Msg, TextBlock, ToolCallBlock, ToolResultBlock, ToolResultState
from agentscope.model import ChatModelBase, ChatResponse, ChatUsage
from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.tool import Toolkit, ToolBase, ToolChunk


def send(frame):
    PROTOCOL.write(json.dumps(frame, ensure_ascii=True, separators=(",", ":")) + "\n")
    PROTOCOL.flush()


class Rpc:
    def __init__(self):
        self.pending = {}
        self.next_id = 0

    async def call(self, run, operation, payload):
        self.next_id += 1
        key = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        send({"type": "call", "id": key, "run": run, "operation": operation, "payload": payload})
        try:
            return await future
        finally:
            self.pending.pop(key, None)

    def resolve(self, frame):
        future = self.pending.get(frame["id"])
        if future is None or future.done():
            raise RuntimeError("Unexpected benchmark reply")
        if "error" in frame:
            future.set_exception(RuntimeError(frame["error"]))
        else:
            future.set_result(frame["result"])


class ScriptedModel(ChatModelBase):
    def __init__(self, rpc, run, config):
        super().__init__(credential=None, model=config["model"], parameters=self.Parameters(),
                         max_retries=0, stream=True, context_size=1_000_000)
        self.rpc, self.run, self.config = rpc, run, config
        self.formatter = OpenAIChatFormatter()

    async def _call_api(self, model_name, messages, tools=None, tool_choice=None, **_kwargs):
        observations = []
        for message in messages:
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    value = block.output if isinstance(block.output, str) else "".join(
                        item.text for item in block.output if isinstance(item, TextBlock)
                    )
                    observations.append({"id": block.id, "value": json.loads(value)})
        answer = await self.rpc.call(self.run, "model", {
            "input": next(message.get_text_content() for message in messages if message.role == "user"),
            "system": "\n".join(message.get_text_content() or "" for message in messages if message.role == "system"),
            "observations": observations,
            "tools": [{"name": item["function"]["name"], "description": item["function"]["description"],
                       "parameters": item["function"]["parameters"]} for item in (tools or [])],
        })

        async def chunks():
            if answer["calls"]:
                yield ChatResponse(content=[ToolCallBlock(id=call["id"], name=call["name"],
                    input=json.dumps(call["arguments"], separators=(",", ":"))) for call in answer["calls"]], is_last=False)
            text = answer["text"]
            size = self.config["chunk_characters"]
            for offset in range(0, len(text), size):
                yield ChatResponse(content=[TextBlock(id="fixture-text", text=text[offset:offset + size])], is_last=False)
            yield ChatResponse(content=[], is_last=False, usage=ChatUsage(
                input_tokens=answer["usage"]["input_tokens"], output_tokens=answer["usage"]["output_tokens"], time=0,
            ))

        return chunks()


class Lookup(ToolBase):
    is_read_only = True

    def __init__(self, rpc, run, config, concurrency):
        super().__init__()
        self.rpc, self.run = rpc, run
        self.name = config["tool"]["name"]
        self.description = config["tool"]["description"]
        self.input_schema = config["tool"]["parameters"]
        self.is_concurrency_safe = concurrency > 1

    async def check_permissions(self, tool_input, context):
        return PermissionDecision(behavior=PermissionBehavior.ALLOW, message="Controlled read-only benchmark corpus only.")

    async def call(self, **kwargs):
        result = await self.rpc.call(self.run, "tool", kwargs)
        return ToolChunk(content=[TextBlock(text=json.dumps(result, separators=(",", ":")))],
                         state=ToolResultState.SUCCESS, is_last=True)


async def run_trial(rpc, frame, config, concurrency):
    run = frame["id"]
    try:
        agent = Agent(name="paired", system_prompt=config["base_prompt"],
            model=ScriptedModel(rpc, run, config), toolkit=Toolkit(tools=[Lookup(rpc, run, config, concurrency)]),
            model_config=ModelConfig(max_retries=0), injection_config=InjectionConfig(inject_runtime_state=False),
            react_config=ReActConfig(max_iters=16))
        final = None
        async for event in agent.reply_stream(UserMsg(name="user", content=config["tasks"][frame["shape"]]), yield_final_msg=True):
            if isinstance(event, Msg):
                final = event
                continue
            record = {"type": "event", "run": run, "event": type(event).__name__}
            if isinstance(event, TextBlockDeltaEvent):
                record["delta"] = event.delta
            send(record)
        if final is None:
            raise RuntimeError("AgentScope did not return its final message")
        usage = final.usage
        send({"type": "done", "run": run, "status": final.finished_reason.value,
              "output": final.get_text_content() or "", "error": str(final.error) if final.error else None,
              "usage": {"input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
                        "total_tokens": usage.input_tokens + usage.output_tokens} if usage else None})
    except Exception as error:
        send({"type": "done", "run": run, "status": "failed", "error": str(error), "output": "", "usage": None})


async def main():
    if importlib.metadata.version("agentscope") != "2.0.11":
        raise RuntimeError("This adapter requires the pinned AgentScope 2.0.11 release")
    rpc, config, active = Rpc(), None, None
    concurrency = 1
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        if len(line.encode("utf8")) > 1024 * 1024:
            raise RuntimeError("Benchmark frame too large")
        frame = json.loads(line)
        if frame["type"] == "result":
            rpc.resolve(frame)
        elif frame["type"] == "configure" and config is None:
            config, concurrency = frame["workload"], frame["concurrency"]
            if concurrency not in (1, 4):
                raise RuntimeError("Unsupported fixture concurrency")
            send({"type": "ready", "engine": "agentscope", "version": "2.0.11",
                  "runtime": platform.python_version(), "package_file": agentscope.__file__,
                  "dependencies": {dist.metadata["Name"].lower().replace("_", "-"): dist.version
                                   for dist in importlib.metadata.distributions()},
                  "durability": "SDK in-memory AgentState; no persistence middleware"})
        elif frame["type"] == "run" and config and (active is None or active.done()):
            active = asyncio.create_task(run_trial(rpc, frame, config, concurrency))
        elif frame["type"] == "shutdown" and (active is None or active.done()):
            send({"type": "bye"})
            return
        else:
            raise RuntimeError("Unexpected benchmark command")
    if active and not active.done():
        active.cancel()
        await asyncio.gather(active, return_exceptions=True)


try:
    asyncio.run(main())
except Exception as error:
    send({"type": "fatal", "message": str(error)})
    sys.exit(1)
