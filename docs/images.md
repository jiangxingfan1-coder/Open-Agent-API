# Image input

English · [简体中文](zh-CN/images.md)

Sending a screenshot to an agent is one of the most common requests. Open Agent API accepts images
on all three compatible protocols and on its own entries, checks them, stores them as input files
of the caller, and hands them to the agent in the form that agent can actually use. An agent that
cannot use images refuses the request clearly before a run is created; an image is never dropped
silently.

The capability is advertised as `image-input-v1` in `GET /health` `features`.

## What you can send

| Entry | Image part | Inline bytes | https URL | Uploaded file |
| --- | --- | --- | --- | --- |
| OpenAI Chat Completions (`/v1/chat/completions`, `/v1/compat/...`) | `{"type":"image_url","image_url":{"url":…,"detail":…}}` | `data:image/png;base64,…` | `https://…` | (use Responses or a `file` part) |
| OpenAI Responses (`/v1/responses`, `/v1/compat/responses`) | `{"type":"input_image","image_url":…}` or `{"type":"input_image","file_id":…}` | `data:` URL in `image_url` | `image_url: "https://…"` | `file_id` |
| Claude Messages (`/v1/messages`) | `{"type":"image","source":…}` | `source.type: "base64"` with `media_type` and `data` | `source.type: "url"` | `source.type: "file"` with `file_id` |
| Gemini `generateContent` | `inlineData` / `fileData` | `{"inlineData":{"mimeType":"image/png","data":…}}` | `fileData` with an `https://` `fileUri` and an `image/*` `mimeType` | `fileData` with `fileUri: "oaa://files/<id>"` and an `image/*` `mimeType` |
| UAP (`/v1/uap`) | `{"type":"image",…}` (or `input_image`) in `content` | `data` + `media_type` | `url` | `file_id` |
| OAA native body (`agent` + `input`) | top-level `images: [...]` | `{"data":…,"media_type":…}` | `{"url":…}` | `{"file_id":…}` |

`detail` is accepted and ignored. Upload an image once with `POST /v1/files` (or `oaa upload`) and
reference it by file ID in as many requests as you like. Gemini `inlineData` with a type other than
an image (audio, PDF) is still refused with `unsupported_content`.

The text the agent sees keeps a marker such as `[Image #1]` where the image was; no image bytes are
ever placed in the prompt text, the run events, the timeline or the logs.

## Checks and limits

Every inline image is decoded once, before the run is created:

- Standard and URL-safe base64 are accepted, with or without padding (`google-genai` sends URL-safe).
- The length of the base64 string is compared with the limit **before** decoding, so an oversized
  `data:` URL costs nothing to refuse.
- The real format is detected from the bytes. Only PNG, JPEG, GIF and WebP are accepted. A declared
  type (`media_type`, the `data:` header, `mimeType`) must match the bytes (`image/jpg` counts as
  `image/jpeg`); a mismatch is `image_invalid`.
- An uploaded file referenced as an image must be visible to the caller and must be one of those
  formats.

| Setting (`images.*` in the gateway configuration) | Default | Range | Error |
| --- | --- | --- | --- |
| `maxImageBytes` (one image, decoded) | 5 MiB | 1 KiB – 8 MiB | `image_too_large` (413) |
| `maxImagesPerRequest` | 10 | 1 – 20 | `too_many_images` (400) |
| `maxTotalBytes` (all images of one request) | 8 MiB | 1 KiB – 8 MiB | `image_too_large` (413) |
| `fetchRemote` (gateway fetches https image URLs) | `false` | | |
| `fetchTimeoutMs` | 10 000 | 500 – 60 000 | `image_fetch_failed` (400) |

The whole request body is still limited to 24 MiB, and a run's input files together to 8 MiB.
Errors name the offending part in `error.param` (OpenAI entries), for example
`messages.0.content.1`; the error body keeps each protocol's own shape.

## Storage and privacy

An inline image becomes an input file of the caller: the same file store, access control and
per-caller quota (`maxStoredBytesPerSubject`, `storage_quota_exceeded`) as `POST /v1/files`. Other
callers cannot read it or reference it. If the caller already stored exactly the same bytes, that
file is reused, so a chat client that resends its whole history does not store the same image again,
and an idempotent retry produces the same request. When the request is refused before its run
exists (for example the agent does not accept images), the files this request newly stored are
removed again, so the caller's storage use does not grow; an earlier copy that was reused stays.

For new implicit uploads, SQLite records the file ID, caller and exclusive file identity before
payload bytes are written. A committed run or stored workflow reference releases the cleanup
right in the same transaction. On restart, unclaimed inputs are reclaimed in bounded batches,
including a partial write or a file whose catalog row was removed before its blob. A locked
writer defers cleanup. Explicit uploads and pre-upgrade files without proof are never inferred
to be temporary, even if their name or contents match. An unexpected replacement is left alone.

With a per-caller storage cap, JSON uploads, multipart uploads and new inline images reserve
their bytes under the same SQLite writer before storing the payload. Pending writes count
once, then transfer to the file row on publication. Ordinary uploads become permanent at
their own metadata commit; they need no run to claim them. Concurrent inline copies of the
same bytes can share materialization only within the same owner and caller subject. Each
request still needs its own valid grant and run admission. Artifact output is counted but is
not refused on account of this limit. Unreadable usage is not treated as empty.

`GET /v1/runs/{id}/state` and `GET /v1/runs/{id}/timeline` list the images of a run
(`images: [{kind:"file", file_id, name, mime, bytes}]`; for a URL image only its host). The console's
task inspector shows "This task came with N image(s)" with names, sizes and thumbnails; the
thumbnails come from the authenticated file download (`GET /v1/files/{id}/content`), shown through a
`blob:` URL. Webhook payloads carry no image content.

## URLs: the gateway does not fetch for you by default

Fetching an arbitrary URL would let any caller make the gateway connect anywhere. So by default:

- An `https` image URL is passed **unchanged** to the model provider, and only when the agent is a
  built-in kernel agent whose chosen route accepts image URLs (see the provider table below). The
  provider fetches it, not the gateway.
- Everywhere else (external agents need the bytes; Gemini routes take no URLs) the request is
  refused with `unsupported_content` and the message says to send the image inline or upload it.
- Plain `http`, URLs with credentials and anything other than `https` / `data:` are `image_invalid`.

With `images.fetchRemote: true` the gateway fetches every image URL itself and treats the result
like an inline image. It then uses `https` only, follows no redirects, enforces
`fetchTimeoutMs` and `maxImageBytes` while reading, requires an image `Content-Type` that matches
the sniffed format, and — under `security.profile: "public"` — refuses private, loopback,
link-local and cloud metadata addresses. That address rule is the webhook rule, checked on the
address that is actually connected to (resolved once, inside the connection's own lookup).

## How each agent receives images

Whether a worker can take images is declared under `image-input-v1`, per kernel provider and per
external engine; the conversion profile (`conversion.image_input`) and `GET /v1/models`
(`image_input: true|false`) show it, so a caller can check before sending.

| Agent | How images arrive | `conversion.image_input` | Verified |
| --- | --- | --- | --- |
| Built-in kernel agent | In the user message, in the route provider's own shape: OpenAI Responses `input_image`, Chat Completions `image_url` (data URL or https URL), Anthropic `image` (`base64` or `url` source), Gemini `inlineData` | `route` | Fixture model in tests (echoes the images it received) |
| ACP agent declaring `promptCapabilities.image` | ACP `image` content block (`mimeType`, base64 `data`) after the text, plus the workspace file | `agent-declared` (`native` after a handshake check) | ACP test fixture |
| ACP agent without image support | Workspace file (below); `imageFiles: false` on the adapter refuses images instead | `agent-declared` / `workspace-file` | ACP test fixture |
| Claude Code (Agent SDK) | The prompt becomes one streamed user message with Anthropic `image` blocks (base64) | `native` | Documented interface only, not run against the real agent |
| Codex (app-server) | `turn/start` input items `{"type":"localImage","path":…}` after the text | `native` | Documented interface only, not run against the real agent |
| Antigravity, DSH, stdio `oaa/1` adapters | Workspace file | `workspace-file` | Antigravity and DSH: documented behaviour only |
| A2A remote agents, HTTP `oaa/1` adapters | Refused (`unsupported_content`): they receive text only | `none` | Tests |

**Workspace file fallback.** Image files are written into the task workspace as
`inputs/<file id>/image-<n>.<ext>` (names are generated by the gateway; a path that would leave the
workspace is refused), and the agent's input ends with a list such as
`[Image #1] inputs/file_…/image-1.png (image/png)`. The agent opens them with its own tools.

### Kernel routes and the provider capability

A model provider declares `imageInput`: `none`, `inline` (bytes) or `url` (bytes and https URLs).
Unset, a conservative default by kind applies:

| Provider `kind` | Default `imageInput` |
| --- | --- |
| `openai-responses` | `url` |
| `anthropic-messages` | `url` |
| `gemini-generate` | `inline` |
| `openai-chat` | `none` (many compatible servers are text-only; set `inline` or `url` for a vision model) |

Routes whose provider cannot take the request's images are left out of route selection for that
request; when no route of the agent can, the request is refused with `unsupported_content`.

## Continuations

- `previous_response_id`: a kernel agent's history keeps image **references**; because models are
  stateless, history images are sent to the model again on every later turn, without being stored
  again. An external agent's own session already saw the image, so only the new turn's images are
  attached.
- Multi-turn `messages` / `contents` with images in earlier turns: every image of the request is part
  of this request and is sent; identical bytes reuse the stored file (no second copy).

## Remote execution nodes

Images travel to a remote node as the run's input files, like any other input file. A node must
announce `image-input-v1` (it includes its image declaration in its advertisement only after the
gateway offers that feature); older nodes are never chosen for a run with images, so the refusal
happens before dispatch, not at execution time.

## Verification status

| Path | Status |
| --- | --- |
| Kernel routes (all four provider shapes), ACP image blocks and the workspace-file fallback, remote nodes, caller tools (auto bridge) and structured-output repair turns | Run in the offline tests with deterministic fixtures |
| Official SDKs and chat-client replays | Run in the compatibility lab against the fixture agent |
| Claude Code (Agent SDK image blocks) | **Implemented from the documentation only, not run against the real agent.** Open risk: with an image the prompt is a streamed input of one user message; that the SDK ends the session normally after that single message has not been verified |
| Codex (`turn/start` `localImage` items) | **Implemented from the documentation only, not run against the real agent** |
| Antigravity, DSH | Workspace-file fallback; not run against the real agents |

When a turn of Claude Code or Codex fails and that turn carried images, the error keeps its code and
its message adds that the turn carried N image(s), how they were sent, and that this image path is
implemented from documentation only, so an image problem can be told apart. A missing image file in
the workspace is `image_delivery_failed`.
