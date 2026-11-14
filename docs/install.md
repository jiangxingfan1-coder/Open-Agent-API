# Install Open Agent API

English · [简体中文](zh-CN/install.md)

Every route below ends the same way: `oaa quickstart` initializes a data directory, starts the gateway in the
background on `127.0.0.1`, publishes an **offline sample agent** (`agent/sample`: no model, no network, no cost),
creates a caller key file, makes one real call, and prints the Base URL, the model name and a `curl` you can paste.
Running it again changes nothing. `oaa stop` stops the gateway.

Release files live on the project's GitHub Releases page
(`https://github.com/jiangxingfan1-coder/Open-Agent-API/releases`). In the examples `<version>` stands for the version you downloaded. The Linux packages, `install.sh`, the npm tarball and the
Docker image are attached to releases published after 0.0.64; 0.0.64 itself has only the macOS and Windows installers. Each release has a `SHA256SUMS` file: check a download with `sha256sum -c SHA256SUMS --ignore-missing`
(Linux), `shasum -a 256 -c SHA256SUMS --ignore-missing` (macOS) or `Get-FileHash` (Windows).

| Route | Needs | Pick it when | Not for |
| --- | --- | --- | --- |
| [macOS app](#macos) | macOS 13+ | you want the desktop app and the console in one window | servers |
| [Windows zip](#windows) | Windows 10+, x64 | you want the desktop launcher | servers |
| [Linux tar.gz / `install.sh`](#linux) | glibc 2.28+ (x64 or arm64) | a Linux workstation or server, no root, no Docker | Alpine / musl |
| [Docker](#docker) | Docker with Compose v2 | a server, an isolated gateway, built-in or remote agents | using the Codex / Claude Code CLIs of the host |
| [npm tarball](#npm) | Node.js 24.18+ (24 or 26 line) | you already live in Node and want `oaa` on your PATH | machines without Node |
| [Source](#source) | Node.js 24.18+ (24 or 26 line), git | developing Open Agent API itself | everyone else |

The macOS, Windows and Linux packages ship their own Node.js runtime. The npm and source routes use the Node.js on
your machine (`engines` in `package.json`: `>=24.18.0 <27`).

**The Claude native engine** needs Anthropic's `@anthropic-ai/claude-agent-sdk`, which is under Anthropic's own terms
and is therefore not part of any package or image. Without it that one engine answers `adapter_unavailable` with the
install command (`oaa doctor` prints it too): `npm install --prefix ~/.oaa/vendor @anthropic-ai/claude-agent-sdk@<pinned version>`,
then restart the gateway. Everything else works without it.

## macOS

**Install.** Open `Open-Agent-API-<version>-macOS-arm64.dmg` (Apple silicon) or `…-macOS-x64.dmg` (Intel) and drag the
app to Applications. The app is ad-hoc signed and **not notarized** unless the maintainer configured a certificate, so the
first launch is blocked: Control-click the app, choose Open, then Open again (macOS 15: System Settings → Privacy &
Security → "Open Anyway"). Only the first launch needs this.

**Quickstart.**

```bash
"/Applications/Open Agent API.app/Contents/Resources/oaa" quickstart
```

If the desktop app is already open it is using port 8787; add `--port 18787`. The data directory is `.oaa` in the
current directory; the desktop app keeps its own data in `~/Library/Application Support/OpenAgentAPI`.

**First launch.** To work out of the box, the app publishes the offline sample agent `agent/sample` (it calls no model and
uses no network; the Antigravity example `agent/antigravity` too when `agy` is installed) and switches on the agent engines
it finds on the Mac (Codex, Claude Code, Antigravity, DeepSeek Harness). Switching on only makes an engine available: it runs
once you publish an agent that uses it and call that agent with a key. A dialog says once what was done and where to turn
an engine off (the console's "Execution machines" page; the app detects and enables installed engines again at each start).

**Port.** The desktop app takes the port from `port` in its own `config.json` (8787 unless you changed it; the menu bar
icon has "Open Data Folder"). To change it, edit that file and choose "Restart Gateway". If the port is taken the app
says which port it is, that it may be another Open Agent API instance, and how to change it; it never connects to
whatever answers there. A gateway it finds already running on the port is used only when it was started for the same
`config.json` (for example one that outlived a crashed app).

**Isolated run (testing, a second copy).** Setting `OAA_DESKTOP_HOME` (a data folder; `--home <dir>` does the same) runs
the app entirely inside that folder, and `OAA_DESKTOP_PORT` (`--port <n>`, only valid together with the folder) sets the
port. Copy and paste:

```bash
OAA_DESKTOP_HOME="$(mktemp -d)" OAA_DESKTOP_PORT=18787 "/Applications/Open Agent API.app/Contents/MacOS/OpenAgentAPI"
```

It runs next to an installed copy without touching it: its data folder `~/Library/Application Support/OpenAgentAPI`, its
port, `/Applications`, `~/Applications` and `~/.local/bin` stay as they are, and the isolated run installs and links
nothing. Config, admin key, logs, the sample agents and the port setting go into the given folder; the console's web
storage (preferences, language) is kept in memory only; the window position and appearance are not saved. The window
title says "isolated run". Quit with ⌘Q, then delete the folder. What isolation does not cover: macOS notification
permission belongs to the app and is shared; files you download from the console still go to `~/Downloads`; and agents you
run are still your own programs with your real home folder.

**Uninstall.** Quit the app (`oaa stop` for a gateway started from the terminal), drag the app to the Trash, and delete
`~/Library/Application Support/OpenAgentAPI` and any `.oaa` directories if you no longer want the data.

## Windows

**Install.** Download `Open-Agent-API-<version>-win-x64.zip` and extract it (right-click → Properties → Unblock first
avoids a prompt per file). Double-click `Install-OAA-Windows.cmd`: it copies the files to
`%LOCALAPPDATA%\Programs\OpenAgentAPI`, creates Desktop and Start Menu shortcuts, adds the folder to your user `PATH`
and starts the app. The package is not code-signed, so SmartScreen may say "Windows protected your PC": check the
`SHA256SUMS` first, then More info → Run anyway. The scripts run PowerShell with `-ExecutionPolicy Bypass` for that one
process only; your execution policy is not changed. The messages of the PowerShell scripts (installer, launcher, stop
script) follow the Windows display language: Chinese when it starts with `zh`, English otherwise. The launcher takes the
port from `port` in `%LOCALAPPDATA%\OpenAgentAPI\config.json` (8787 before that file exists).

**Quickstart.** In a new terminal: `oaa quickstart` (or `oaa.cmd quickstart` inside the extracted folder if you did not
install). The shortcut does the same thing and writes the output to `%LOCALAPPDATA%\OpenAgentAPI\quickstart.log`.

**Uninstall.** There is no uninstaller yet. Run `Stop-OpenAgentAPI.cmd` (or `oaa stop`), delete
`%LOCALAPPDATA%\Programs\OpenAgentAPI`, the two shortcuts, and the `PATH` entry (Settings → System → About → Advanced
system settings → Environment Variables). Delete `%LOCALAPPDATA%\OpenAgentAPI` to remove the data.

## Linux

Packages exist for x64 and arm64 (`Open-Agent-API-<version>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz`). They bundle the
official Node.js runtime and have no desktop shell. They need glibc 2.28 or newer (Debian 10+, Ubuntu 20.04+, RHEL 8+);
Alpine (musl) is not supported, use Docker there.

**Install with the script** (no root, nothing outside `~/.local` is touched, no shell profile is edited):

```bash
curl -fsSL https://github.com/jiangxingfan1-coder/Open-Agent-API/releases/latest/download/install.sh | sh
```

The script downloads the `.tar.gz` for your CPU, verifies it against the release's `SHA256SUMS` (it refuses to install on a
mismatch), unpacks it to `~/.local/share/open-agent-api` and links `~/.local/bin/oaa` to the launcher. It tells you if
`~/.local/bin` is not on your `PATH`. Options: `--version X.Y.Z`, `--prefix DIR` (installs under `DIR/share` and `DIR/bin`),
`--uninstall`, `--help`. The copy attached to a release installs that release; to read it before running it, download it
and run `sh install.sh`. Running it again upgrades in place.

**Install by hand.**

```bash
tar -xzf Open-Agent-API-<version>-linux-x64.tar.gz
./Open-Agent-API-linux-x64/oaa quickstart        # or: sh Open-Agent-API-linux-x64/install.sh
```

**Quickstart.** `oaa quickstart` in the directory where you want the `.oaa` data directory.

**Uninstall.** `oaa stop`, then `sh install.sh --uninstall` (removes the install directory and the link, never your
`.oaa` data directories), or just delete the extracted folder.

## Docker

The image runs the gateway as the non-root `node` user, keeps all state in the `/data` volume and listens on
`0.0.0.0` **inside** the container. `docker-compose.yml` publishes it on the host's loopback address only
(`127.0.0.1:8787`), so it is not reachable from other machines; to expose it put a TLS reverse proxy in front
(see [deploy-public.md](deploy-public.md)) and set `OAA_PUBLIC_BASE_URL` / `OAA_ALLOWED_HOSTS`.

> **Status: the Dockerfile cannot be built on a developer machine (there is no Docker there); CI is where it is built.**
> `.github/workflows/docker.yml` builds the amd64 image on every push and pull request and runs a container smoke test
> (first start, key files, an API call, restart, `docker stop`); that passed on GitHub's Ubuntu runner on 2026-11-14.
> The arm64 image and the push to ghcr only happen when a release is published and have not run yet. If a build fails,
> the log of that workflow is the place to look; the troubleshooting list is in [releasing.md](releasing.md).

**Install and quickstart.** From a checkout of this repository (this works before an image has been published):

```bash
docker compose up --build -d
docker compose logs oaa          # prints where the key files are, never the keys; then a curl you can paste
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $(docker compose exec -T oaa cat /data/.oaa/keys/quickstart.key)" \
  -H 'Content-Type: application/json' \
  -d '{"model":"agent/sample","messages":[{"role":"user","content":"Hello"}]}'
```

The first start initializes `/data/.oaa`, publishes the offline sample agent and writes the caller key file
`/data/.oaa/keys/quickstart.key` (admin key: `/data/.oaa/admin.token`, used for the console at
`http://127.0.0.1:8787`). Later starts reuse everything. Once a release is published the image is
`ghcr.io/jiangxingfan1-coder/open-agent-api:<version>` (and `:latest`) for `linux/amd64` and `linux/arm64`; without a
checkout use `docker run`:

```bash
docker run -d --init --name oaa -p 127.0.0.1:8787:8787 -v oaa-data:/data \
  ghcr.io/jiangxingfan1-coder/open-agent-api:latest
```

Other commands run inside the container with `docker compose exec oaa oaa <command>` (the working directory is
`/data`, so `.oaa` is the gateway's data directory): `oaa doctor`, `oaa key create --name ci --token-file /data/.oaa/admin.token`, `oaa publish my.oaa --token-file /data/.oaa/admin.token`. Model keys
for built-in agents are environment variables (`OPENAI_API_KEY`, see the commented placeholders in
`docker-compose.yml`). A bind mount instead of the named volume must be writable by uid 1000
(`sudo chown 1000:1000 ./data`).

**What this route can and cannot run.** The container has none of the command-line agents installed on your host: no
Codex, no Claude Code, no Antigravity, and `oaa connect codex` finds nothing. It fits:

- **built-in agents** that call a model API with your own key (default provider: OpenAI Responses);
- **ACP and A2A remote agents** the gateway reaches over the network;
- **execution nodes**: run `oaa node join --config worker.json` on the developer machine that has Codex / Claude Code,
  pointed at the container's gateway (see [operations.md](operations.md)), so the container is the API surface and your
  machine does the agent work.

It does not make the agents installed on the Docker host usable from inside the container.

**Uninstall.** `docker compose down` (add `-v` to delete the `oaa-data` volume and with it every key and run).

## npm

The release carries `open-agent-api-<version>.tgz`. The package is marked `private` in `package.json` so that it cannot be
published to the npm registry by accident; it installs fine from the file or from the release URL.

```bash
npm install -g https://github.com/jiangxingfan1-coder/Open-Agent-API/releases/download/v<version>/open-agent-api-<version>.tgz
oaa quickstart
```

Without installing anything: `npx --package <url or path of the .tgz> oaa quickstart`. Installing downloads the
runtime dependencies from the npm registry (about 270 MB on disk, most of it the optional Windows sandbox SDK that
`@anthropic-ai/sandbox-runtime` pulls in). The Claude Agent SDK is not among them, see above. To build the tarball
yourself, run `npm pack` in a checkout (it rebuilds `dist/` first).

**Uninstall.** `oaa stop`, then `npm uninstall -g open-agent-api` (your `.oaa` data directories stay).

## Source

```bash
git clone https://github.com/jiangxingfan1-coder/Open-Agent-API.git
cd Open-Agent-API
npm ci
npm run build
npm run oaa -- quickstart
```

`npm run verify` runs the type check, the format check and every test. **Uninstall:** `npm run oaa -- stop`, then delete
the checkout.
