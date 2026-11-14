"""Send a local image to an agent with the OpenAI Python SDK (Chat Completions and Responses).

What it shows: the image travels inline as a base64 `data:` URL (an https URL or an uploaded file id work too, see
docs/images.md). The gateway checks the real bytes: only PNG, JPEG, GIF and WebP are accepted, the declared type must
match the bytes (`image_invalid` otherwise), and an agent that cannot use images refuses the request clearly
(400 `unsupported_content`, `error.param` names the part) before a run exists - an image is never dropped silently.
Needs:    pip install openai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    one that takes images (`GET /v1/models` shows `image_input`). The offline sample agent accepts the
          image but its fixed answer does not describe it.
Run:      python image_openai.py [path/to/image.png]        (default: sample.png next to this script)
Exit:     0 = answered; 2 = the request was refused (for example an agent without image input).
"""

import base64
import mimetypes
import os
import sys

from openai import BadRequestError, OpenAI

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Describe this image in one sentence.")
PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample.png")

mime = mimetypes.guess_type(PATH)[0] or "image/png"
with open(PATH, "rb") as handle:
    data_url = f"data:{mime};base64,{base64.b64encode(handle.read()).decode('ascii')}"

client = OpenAI(base_url=f"{BASE}/v1", api_key=KEY, max_retries=0, timeout=300)

try:
    # Chat Completions: an `image_url` content part next to the text.
    chat = client.chat.completions.create(
        model=AGENT,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    )
    print("chat:", chat.choices[0].message.content)

    # Responses: an `input_image` part.
    response = client.responses.create(
        model=AGENT,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": PROMPT},
                    {"type": "input_image", "image_url": data_url},
                ],
            }
        ],
    )
    print("responses:", response.output_text)
except BadRequestError as error:
    print(f"refused ({error.code}, param {error.param}): {error.message}", file=sys.stderr)
    sys.exit(2)
print("ok")
