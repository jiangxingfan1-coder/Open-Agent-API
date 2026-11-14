"""Check that the environment variables the official SDKs read are enough to reach an agent.

What it shows: the OpenAI and Anthropic SDKs build their client from OPENAI_BASE_URL / OPENAI_API_KEY and
ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY when you pass nothing. Any tool or framework that creates its client that
way (and many do) needs no code change: point those variables at the gateway. Note the two Base URLs differ:
the OpenAI one ends in /v1, the Anthropic one does not.
Needs:    pip install openai anthropic, and the variables below (the README of this folder shows the exports)
          OPENAI_BASE_URL=http://127.0.0.1:8787/v1     OPENAI_API_KEY=<your key>
          ANTHROPIC_BASE_URL=http://127.0.0.1:8787     ANTHROPIC_API_KEY=<your key>
          optional: OAA_AGENT (default agent/sample), OAA_PROMPT
Agent:    any agent.
Run:      python env_check.py
"""

import os
import sys

from anthropic import Anthropic
from openai import OpenAI

missing = [n for n in ("OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY") if not os.environ.get(n)]
if missing:
    sys.exit("Set these first: " + ", ".join(missing) + " (see the README of this folder).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Say hello in one sentence.")

# No arguments: base URL and key come from the environment.
chat = OpenAI(max_retries=0).chat.completions.create(model=AGENT, messages=[{"role": "user", "content": PROMPT}])
print("openai:", chat.choices[0].message.content)

message = Anthropic(max_retries=0).messages.create(
    model=AGENT, max_tokens=1024, messages=[{"role": "user", "content": PROMPT}]
)
print("anthropic:", "".join(b.text for b in message.content if b.type == "text"))
print("ok")
