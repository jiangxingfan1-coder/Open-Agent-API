"""Send a local image to an agent with the Google GenAI Python SDK (generateContent).

What it shows: an image part built from the file's bytes (the SDK sends `inline_data` with URL-safe base64; a
`file_data` part with an https URL or an uploaded `oaa://files/<id>` works too, see docs/images.md). The gateway
checks the real bytes: only PNG, JPEG, GIF and WebP are accepted and the declared mime type must match them. An
agent that cannot use images refuses the request clearly (400) before a run exists.
Needs:    pip install google-genai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
Agent:    one that takes images (`GET /v1/models` shows `image_input`). The offline sample agent accepts the
          image but its fixed answer does not describe it.
Run:      python image_genai.py [path/to/image.png]        (default: sample.png next to this script)
Exit:     0 = answered; 2 = the request was refused (for example an agent without image input).
"""

import mimetypes
import os
import sys

from google import genai
from google.genai import errors, types

BASE = os.environ.get("OAA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
KEY = os.environ.get("OAA_API_KEY") or sys.exit("Set OAA_API_KEY first (see the cookbook README).")
AGENT = os.environ.get("OAA_AGENT", "agent/sample")
PROMPT = os.environ.get("OAA_PROMPT", "Describe this image in one sentence.")
PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample.png")

mime = mimetypes.guess_type(PATH)[0] or "image/png"
with open(PATH, "rb") as handle:
    image = types.Part.from_bytes(data=handle.read(), mime_type=mime)

client = genai.Client(api_key=KEY, http_options=types.HttpOptions(base_url=BASE, api_version="v1beta"))

try:
    response = client.models.generate_content(
        model=AGENT,
        contents=[types.Content(role="user", parts=[types.Part(text=PROMPT), image])],
    )
except errors.ClientError as error:
    print(f"refused ({error.code}): {error.message}", file=sys.stderr)
    sys.exit(2)
print("generateContent:", response.text)
print("ok")
