"""Send a local image to an agent with the Anthropic Python SDK (Messages).

What it shows: an `image` content block with a base64 source (a `url` or an uploaded `file` source work too, see
docs/images.md). The gateway checks the real bytes: only PNG, JPEG, GIF and WebP are accepted and the declared
`media_type` must match them (`image_invalid` otherwise). An agent that cannot use images refuses the request
clearly (400 `unsupported_content`) before a run exists.
Needs:    pip install anthropic   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    one that takes images (`GET /v1/models` shows `image_input`). The offline sample agent accepts the
          image but its fixed answer does not describe it.
Run:      python image_anthropic.py [path/to/image.png]        (default: sample.png next to this script)
Exit:     0 = answered; 2 = the request was refused (for example an agent without image input).
"""

import base64
import mimetypes
import os
import sys

from anthropic import Anthropic, BadRequestError

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Describe this image in one sentence.")
PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample.png")

media_type = mimetypes.guess_type(PATH)[0] or "image/png"
with open(PATH, "rb") as handle:
    encoded = base64.b64encode(handle.read()).decode("ascii")

client = Anthropic(base_url=BASE, api_key=KEY, max_retries=0, timeout=300)

try:
    message = client.messages.create(
        model=AGENT,
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": encoded}},
                    {"type": "text", "text": PROMPT},
                ],
            }
        ],
    )
except BadRequestError as error:
    print(f"refused: {error.body['error']['message']}", file=sys.stderr)
    sys.exit(2)
print("messages:", "".join(block.text for block in message.content if block.type == "text"))
print("ok")
