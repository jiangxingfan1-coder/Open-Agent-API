# Releasing a version

English · [简体中文](zh-CN/releasing.md)

This document explains how to release a version, how local development packaging differs from release packaging, what the installers contain, and what to do when someone opens the un-notarized app for the first time.

## Cut a release

1. **Bump the version** (4 places, all set to the same new version):
   - `version` in `package.json`
   - `version` at the top of `package-lock.json` and `packages[""].version` (2 places)
   - `PRODUCT_VERSION` in `src/core/version.ts`: the single source for the gateway (`/health`, OpenAPI, `GATEWAY_VERSION`), the ACP handshake `clientInfo.version`, and the MCP client and server `version`. `test/architecture.test.ts` checks that it equals `package.json` and that no other source file, and nothing under `desktop/` or `scripts/`, hard-codes the version.

   The macOS app needs no edit: `scripts/package-all.mjs` writes `package.json`'s version into the app's `Info.plist` (`CFBundleShortVersionString`), and the About dialog reads it from there.

   Check: `grep -rn --exclude-dir=node_modules --exclude-dir=dist -F "<old version>" .`. Apart from the places in `CHANGELOG.md` that narrate history, the old version number should no longer appear. (The packaging script used to fall back to a hard-coded version when `package.json` had none; that has been removed.)

2. **Update the changelog**: in `CHANGELOG.md`, rename the `## Unreleased` heading at the top to `## <version> (<date>)` and add a fresh empty `## Unreleased` above it. The release workflow takes this section as the body of the draft Release, and fails outright if the section is not found. Keep `CHANGELOG.zh-CN.md` in step (its heading is `## 未发布`); the workflow does not read that file.

3. **Verify locally**: `npm run verify`.

4. **Commit and tag**:

   ```bash
   git tag v<version>
   git push origin main v<version>
   ```

   You can also run the Release workflow manually from the Actions page on GitHub and enter the version (it must match `package.json`); in that case the draft Release's tag is created only when it is published, and points to the commit it was triggered on.

5. **Wait for CI**: the Release workflow (`.github/workflows/release.yml`) checks, packages and smoke-tests on macOS arm64, macOS x64, Windows x64, Linux x64 and Linux arm64; a separate `npm-package` job builds the npm package and test-installs it; finally the workflow gathers the artifacts and creates a **draft** Release.

6. **Check the draft Release**: open the draft on the GitHub Releases page and confirm these files are there: three desktop installers (`Open-Agent-API-<version>-macOS-arm64.dmg`, `…-macOS-x64.dmg`, `…-win-x64.zip`), two Linux packages (`…-linux-x64.tar.gz`, `…-linux-arm64.tar.gz`), the npm package `open-agent-api-<version>.tgz`, `install.sh` (stamped with the version), and one `SHA256SUMS` (covering every file except itself); and that the body is the matching section of the changelog. You can download them and try installing on real machines (the shortest steps for every install route are in [install.md](install.md)).

7. **Publish**: once everything is confirmed, click "Publish release" on the draft page. The workflow never publishes automatically. Publishing triggers `.github/workflows/docker.yml`: it builds the `linux/amd64` and `linux/arm64` images and pushes them to `ghcr.io/<lower-case owner>/open-agent-api:<version>` and `:latest` (pre-releases and versions such as `1.2.3-rc.1` do not get `latest`). If this step fails, the published Release is not affected; after fixing, run the Docker workflow manually from the Actions page with the same version (the `package.json` version at that commit must equal it).

   After the first push the package on ghcr is private by default: on the repository's Packages page set `open-agent-api` to Public and check that it is linked to this repository (the image carries the `org.opencontainers.image.source` label, which usually links it automatically).

## Manual checks before publishing

The macOS window cannot be tested offline: the offline tests run the shell's pure logic (language, port and data-folder
handling, whose gateway is on the port, the page script that signs the console in) and compile it, nothing more. So look
at the built app once on a real Mac before publishing. Run it **isolated**: it does not touch an installed copy, its data
folder `~/Library/Application Support/OpenAgentAPI`, its port 8787, `/Applications` or `~/Applications`. From the
repository, after `npm run package:release:mac -- --arch <arm64|x64> --node-dir <dir>`:

```bash
OAA_DESKTOP_HOME="$(mktemp -d)" OAA_DESKTOP_PORT=18787 "release/macos/Open Agent API.app/Contents/MacOS/OpenAgentAPI"
```

For a downloaded `.dmg`, mount it and use `/Volumes/Open Agent API/Open Agent API.app/Contents/MacOS/OpenAgentAPI`
instead. Quit with ⌘Q and delete the temporary folder afterwards. What the isolation covers is described in
[install.md](install.md#macos). Then, in order:

1. **Window and port**: the window title (Window menu) ends with "isolated run", and the console opens on `127.0.0.1:18787` already connected, with no connection dialog.
2. **Port in use**: with the first copy still running, start the same command a second time (a new folder each time). The second copy must show "Another Open Agent API gateway is already on port 18787", name the configuration file and offer "Open Data Folder", and must not open the first copy's console.
3. **Signed in by the app**: after ⌘R ("Reload Console") the console is still connected; after "Disconnect" in Settings › Connection, ⌘R connects it again; after quitting (⌘Q) and starting the same command with the same `OAA_DESKTOP_HOME` folder, it is connected from the first screen. The app hands the admin key to the page on every load (see [security-model.md](security-model.md#default-exposure)); if any of these needs the connection dialog, the key hand-over broke.
4. **First-launch dialog**: on the very first start of a new `OAA_DESKTOP_HOME` folder a sheet titled "First launch: set up for you" must appear once. It lists `agent/sample`, the engines found on this Mac (or says none was found) and where to turn one off; "Show Execution Machines" opens that page. After ⌘Q and a second start with the same folder it must not appear again.
5. **Language**: switch System Settings › Language & Region so Chinese is first, restart the app: menus, About, the status menu and the dialogs are Chinese; with English first, they are English. The console's own language (Settings) is unaffected by the app. About shows the version of `package.json`.

**What has been done.** On 2026-11-14 the project owner ran this once, by hand, on an Apple silicon Mac, as an isolated run of a release-mode package, and confirmed: the console opens already connected with no connection dialog (part of 1); the first-launch sheet appears (the first half of 4); the console is still connected after ⌘R (the first part of 3); About shows the right version; and the menus and dialogs follow the system language (5, but only the owner's current system language was seen). **Not yet checked**: the three messages for a port that is in use (2); that Disconnect then ⌘R, and a quit and restart with the same folder, connect again (the rest of 3); that the first-launch sheet does not appear a second time (the rest of 4); the language switch in both directions (the rest of 5); recognizing and reusing a gateway that a crashed app left behind; the Intel package; the normal, non-isolated installation (default data folder, port 8787) of the version being released; and the bilingual messages of the Windows launcher (no Windows machine is available; CI only checks the PowerShell syntax). Repeat the checks that were not done, and any that the release changes, before publishing.

## Local development packaging vs release packaging

| | Local development packaging | Release packaging |
| --- | --- | --- |
| Command | `npm run package:mac` / `package:win` / `package:all` (`all` = mac + win; the Linux package exists only in release mode) | `npm run package:release:mac -- --arch <arm64\|x64> --node-dir <dir> [--node-version <v>]`, `npm run package:release:win -- --node-dir <dir> --node-version <v>`, `npm run package:release:linux -- --arch <x64\|arm64> --node-dir <dir> [--node-version <v>]` |
| Build | Runs `npm run build` first | Does not build; requires `dist/` to exist (CI produces it in the check step) |
| Install on this machine | **Yes**: installs over `~/Applications` and `/Applications`, and links `~/.local/bin/oaa` to the CLI inside the app | **No**: does not install, does not link, does not write to the user's home directory |
| Where it writes | `release/` and the install locations above | Only the repository's `release/`; the script's side-effect layer rejects any write outside it |
| Node runtime | Not bundled; uses this machine's Node | Bundles the official Node (`--node-dir` is required, and the version must satisfy `engines.node`) |
| Dependencies | The whole `node_modules` (minus `.bin`, `typescript`, `prettier`, `@types`) | Selected from `package-lock.json`, see the next section |
| macOS artifacts | `.dmg` and `.pkg` | `.dmg` |
| Checksums | `release/<platform>/SHA256SUMS` | Same |

Both modes accept `--dry-run`: it only prints the paths each step would write and the external commands it would run (`swiftc`, `sips`, `iconutil`, `codesign`, `ditto`, `hdiutil`, `zip`, and so on), and does nothing; the only thing it actually runs is the read-only `node --version` (to check the Node in `--node-dir`). It also prints the list of top-level dependencies that go into the package, with their sizes.

`--node-dir` is the official distribution directory downloaded from `https://nodejs.org/dist/v<version>/` and extracted (for macOS use `node-v<version>-darwin-<arm64|x64>.tar.gz`, for Windows use `node-v<version>-win-x64.zip`, for Linux use `node-v<version>-linux-<x64|arm64>.tar.gz`); after downloading, verify it with the `SHASUMS256.txt` in the same directory. When building the Windows or Linux package on macOS, the target's node cannot be run, so state the version with `--node-version` so it can be checked. The Node version CI uses is defined in one place only, `NODE_RUNTIME_VERSION` at the top of `release.yml`, and a test checks that it satisfies `engines.node`.

## What the installer contains and does not contain

Contains:

- The compiled gateway and CLI (`dist/`, without tests and benchmarks), the console (`web/`), the examples, `package.json`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` and `licenses/`.
- **The official Node runtime** (only the executable and its `LICENSE`, without npm): on macOS in `Open Agent API.app/Contents/Resources/node/`, on Windows in `runtime\`, on Linux in `runtime/bin/node`. Users do not need to install Node separately.
- Runtime dependencies: the packages reachable from `dependencies` in `package.json` according to `package-lock.json`.

Does not contain:

- **`@anthropic-ai/claude-agent-sdk` and its per-platform packages**: it has a proprietary Anthropic license ("SEE LICENSE IN README.md"), and shipping it in the installer would be redistribution, so it is not packaged into the public release installers. Only the Claude native engine uses it; when it is missing, that engine returns the error code `adapter_unavailable` with the installation instructions:

  ```bash
  npm install --prefix ~/.oaa/vendor @anthropic-ai/claude-agent-sdk@<version pinned in package.json>
  ```

  The gateway looks for it in `~/.oaa/vendor/node_modules` (or in `node_modules` under the directory given by the environment variable `OAA_CLAUDE_SDK_DIR`); restart the gateway after installing. Installing it means accepting Anthropic's terms. `oaa doctor` and the console's local backend information mark the Claude engine as `requires_separate_install` and give the install command. In `package.json` it is a **development dependency** (`devDependencies`), so running from source (`npm ci`) still installs it with the development dependencies and behavior is unchanged, while the npm package (`npm install -g` of a tgz installs only `dependencies`) and the Docker image (`npm ci --omit=dev`) naturally do not contain it and need no manual exclusion. Each of its platform binaries is about 340 MB; as a regular dependency it would add one more download to every `npm install -g` and every cold `npx` start.
- Development dependencies (packages marked `dev` in `package-lock.json`, such as `typescript`, `prettier`, `openai`, `@types/*`).
- Packages referenced only by the excluded packages above (such as `@anthropic-ai/sdk` and its dependencies: in the lockfile it is only a peer dependency of the proprietary SDK, and it is now marked `dev` together with the SDK).
- Optional native packages that do not match the target platform or architecture (packages with `os` / `cpu` in the lockfile, such as `@koromix/koffi-<platform>`), and the prebuilt directories of other platforms under `node-pty/prebuilds/` and `koffi/build/koffi/`.
- Files in third-party packages that nothing reads at run time (`isThirdPartyDeadWeight` in `scripts/release-plan.mjs`, covered by tests): every `*.map`; the `test(s)`, `__tests__`, `example(s)`, `doc(s)`, `benchmark(s)` and `.github` directories directly under a package root; lucide's `dist/esm` and `dist/cjs` (this project reads only `dist/umd/lucide.js`); sandbox-runtime's `vendor/srt-win` (kept only in the Windows package) and `vendor/seccomp` (kept only in the Linux package). The compiled `dist/examples` is not packaged either. `.d.ts` files, licenses and READMEs are kept. How this was checked: no selected package's `main` / `module` / `bin` / `exports` points into these directories (lucide's `main` is the exception, but no code imports it), and the smoke test imports every module under `dist/src` one by one with the bundled Node (`--app-dir`) and then runs the whole first-call chain. Measured on macOS arm64: node_modules 64.2 MB → 27.2 MB, `.dmg` 123.0 MB → 86.0 MB.

## Signing, notarization and first launch

### macOS

Without an Apple developer certificate, the app is only ad-hoc signed and **not notarized**. When someone opens it for the first time, macOS shows "cannot verify the developer" or "Apple cannot check it for malicious software". To open it (either way):

- After dragging the app into Applications, **Control-click** (or right-click) the app in Finder, choose "Open", and click "Open" again in the dialog that appears. You only need to do this the first time.
- On macOS 15 and later: double-click it once (it will be blocked), then open System Settings, go to "Privacy & Security", find the blocked Open Agent API near the bottom of the page, click "Open Anyway" and confirm.

Please verify the checksum of the downloaded file first: `shasum -a 256 -c SHA256SUMS` (to check only the file you downloaded, `grep` out its line and verify that).

With a certificate, configure the following in the repository's Actions secrets, and the Release workflow automatically switches to signing with the developer certificate (hardened runtime, with entitlements in `desktop/macos/entitlements.plist`), notarizes and staples; when any item is missing, the corresponding step is simply skipped and does not fail:

| secret | Content |
| --- | --- |
| `MACOS_CERT_P12` | The .p12 exported from the "Developer ID Application" certificate and private key, base64 encoded |
| `MACOS_CERT_PASSWORD` | The password of the .p12 |
| `MACOS_SIGN_IDENTITY` | The signing identity, such as `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | The Apple ID, team ID and app-specific password used for notarization (all three are needed for notarization) |

To package locally with a certificate: set the environment variable `OAA_MACOS_SIGN_IDENTITY` and run the packaging script.

### Windows

The Windows package is not code signed. When you double-click the script inside it, SmartScreen may show "Windows protected your PC": after checking the source and `SHA256SUMS`, click "More info" and then "Run anyway". A zip downloaded from a browser carries the "from the internet" mark; before extracting, you can also tick "Unblock" in the zip's "Properties", so the extracted files no longer prompt one by one.

The launch script runs the `.ps1` in the package with `powershell -ExecutionPolicy Bypass -File …`: this applies only to that one launched PowerShell process and does not change the system's or the user's execution policy.

The Windows package's data and logs are in `%LOCALAPPDATA%\OpenAgentAPI` (the counterpart of `~/Library/Application Support/OpenAgentAPI` on macOS); `Stop-OpenAgentAPI.cmd` quits the gateway the desktop launcher started in the background.

## Platform-specific tests

CI (`.github/workflows/ci.yml`) runs the full `npm run verify` on Ubuntu and macOS (the `release-plan` test also checks all the workflows under `.github/workflows/` offline: whether actions are pinned by hash, whether timeouts are set, whether runner labels are retired, and whether the matrix fields and artifact directories agree). The `windows` job of `ci.yml` runs only the type check, the format check and the packaging-related tests (`release-plan`, `claude-sdk`), on Node 24 and Node 26. The whole suite runs on `windows-latest` in its own workflow, `.github/workflows/windows.yml` (Node 24): `node scripts/test-offline.mjs --all --isolate` starts one process per test file (3 minutes each, so a hang cannot hide later files) and prints a summary. Many tests used POSIX-only constructs: generating fake executables with a shebang using `chmod`, `/bin/sh`, file permission bits, `SIGTERM`/`SIGKILL`, and hard-coded `/tmp` and `/usr/bin` paths. They were rewritten to work on both systems, or skip on Windows with a stated reason in the test file (a few cases such as running `.cmd` launchers, and Ctrl+C, are the other way round: they only run, or only make sense, on one side). What Windows behavior is covered, and what is not, is in [windows.md](windows.md).

**Node version matrix.** `engines` is `>=24.18.0 <27`: Node.js 24.18 or newer on the 24 or 26 line. In `ci.yml` the `verify` job (Ubuntu and macOS) and the Windows packaging job run on Node 24 and on Node 26, and every entry must pass. Background: the old upper bound `<25` came from the first baseline snapshot, and neither the repository, nor any dependency (in `package-lock.json` only the root package carried a bound), nor `git log` or the docs recorded a real incompatibility; the only experimental interface the kernel uses is `node:sqlite`. A first non-blocking CI run on Node 26.13.1 passed the whole suite except the Linux launcher test, which was failing only because the launcher itself refused a Node 26 on `PATH`; that check now follows `engines`. Node 25 is an odd-numbered release whose support period has ended and it is not tested, although the range technically admits it. The Node runtime bundled into the installers (`NODE_RUNTIME_VERSION` in `release.yml`) stays 24.18.0. To change the range again, update in one go: `engines` in `package.json`, the version hint generated by `scripts/package-windows.mjs` (the Windows and Linux launchers read `engines`, no separate edit), the matrix in `ci.yml`, the badges and statements in both READMEs and both CONTRIBUTING files, `docs/install.md`, `docs/operations.md`, `docs/deploy-public.md` and `docs/engineering.md` (each in English and Chinese); `test/release-plan.test.ts` asserts the range.

## Workflow runners and action versions

- **Runners**: Linux x64 uses `ubuntu-latest` and Linux arm64 uses `ubuntu-24.04-arm` (GitHub's documentation and the runner-images README list it among the standard runners for public repositories, which are free and unlimited; if the repository goes private again, Linux arm64 runners are billed per minute, so check before releasing). macOS arm64 uses `macos-26`, macOS x64 uses `macos-26-intel`, and Windows uses `windows-latest` (Windows Server 2025). The labels follow the [actions/runner-images README](https://github.com/actions/runner-images#available-images); `macos-14` was retired from GitHub Actions on 2026-11-02, and using it leaves jobs unable to get scheduled or failing outright. Every so often, look at the README again for new "deprecated" marks.
- **Actions are pinned to a commit hash**: `uses:` is always written as `owner/repo@<40-character hash> # vX.Y.Z`, to guard against upstream tags being rewritten; `test/release-plan.test.ts` checks that every place has this format. To upgrade, pick the new version on the action's Releases page, find the commit hash with `git ls-remote --tags https://github.com/<owner>/<repo>` or the GitHub API (`/repos/<owner>/<repo>/git/ref/tags/<tag>`; for an annotated tag, fetch once more the commit that the `tag` object points to), and change both the hash and the version in the comment.
- **Timeouts**: every job has `timeout-minutes` (a test checks this), so a hung job costs at most that many minutes of quota.
- **Conventions on Windows**: the bash used for packaging is Git Bash; the Windows zip uses the system `System32\tar.exe` (bsdtar), not the GNU tar that comes with Git and sits earlier in PATH (it does not produce zips); the check of the downloaded Node uses node itself to compute SHA-256; the step scripts of `shell: powershell` may contain only ASCII.

## The Linux package, the npm package and the Docker image

- **Linux package** (`scripts/package-all.mjs linux`, templates in `scripts/package-linux.mjs`): `Open-Agent-API-<version>-linux-<x64|arm64>.tar.gz`, which unpacks to `Open-Agent-API-linux-<arch>/`: `oaa` (a POSIX sh launcher that follows symlinks and prefers `runtime/bin/node`), `app/`, `runtime/` (the official Node), `install.sh` and `README-LINUX.txt`. There is no desktop shell. `scripts/install.sh` is the installer meant for `curl | sh` (download, verify `SHA256SUMS`, unpack to `~/.local/share/open-agent-api`, put a symlink at `~/.local/bin/oaa`; `--version`, `--prefix`, `--uninstall`). Its body is entirely inside functions and its last line is `{ main "$@"; }`, so when a download is cut short the shell refuses the incomplete syntax and runs nothing (a test truncates it at every line boundary and every prefix of the last line). The copy inside the package and the one on the release page are stamped with the version by `scripts/stamp-install.mjs` and install only their own version; an unstamped copy from the source tree resolves the latest published tag instead.
- **npm package**: `npm pack` produces `open-agent-api-<version>.tgz` (`package.json` stays `private: true`, so it cannot be published to the official npm registry by accident; whether to publish is the owner's decision), and `prepack` first removes `dist/` and rebuilds it. The `npm-package` job in `release.yml` packs, installs it with `npm install -g --prefix` into a temporary directory, runs the same smoke test, and then runs `npx --package <tgz> oaa --help` to check that it also starts when its dependencies are hoisted next to the package; the tgz is uploaded as a release artifact and written into `SHA256SUMS`. Users install with `npm install -g <URL of the tgz on the release page>`.
- **Docker image**: `Dockerfile` (multi-stage, `node:24-slim`, the non-root `node` user, the `/data` volume, a `HEALTHCHECK` on `/healthz`, no proprietary SDK among the production dependencies), `.dockerignore`, `docker-compose.yml` (the port is published only on the host's loopback `127.0.0.1:8787`), and `scripts/docker-entrypoint.mjs` (inside the container the gateway listens on `0.0.0.0`, which the port mapping needs; the default `allowedHosts` holds only the loopback names, so the Host check passes for `http://127.0.0.1:8787` from the host, and exposure to the outside is limited only by compose's loopback mapping; the first start initializes the data directory, publishes the offline sample agent, writes the caller key file and prints only where the files are). `.github/workflows/docker.yml`: on `release: published` or a manual run it pushes `linux/amd64` + `linux/arm64`; on `push` and `pull_request` it builds amd64 only and runs a container smoke test (first start, key files, API call, no key in the log, Host check, idempotent restart, exit code 0 on `docker stop`); the push happens only after the smoke test passes.

## What to watch the first time Release runs on GitHub

The Release workflow has run on GitHub for v0.0.64 only: macOS arm64, macOS x64 and Windows x64 (the Windows zip was extracted to a path with spaces and Chinese characters and run through `oaa.cmd`), and it created the draft Release. It has **not** run yet with the Linux x64 and arm64 jobs, the `npm-package` job, or the step that stamps `install.sh` and adds the new files to `SHA256SUMS`; the first release that includes them is the first run. The Linux package and `install.sh` have had an equivalent dry run on a developer machine (on macOS the Linux package was unpacked with a stub node and smoke-tested), and the offline tests cover `install.sh` and the package layout. After pushing a tag, read the logs in the order below, and fix whichever step goes red:

| Step | What the log looks like on failure | Cause and fix |
| --- | --- | --- |
| The job stays Queued | `Waiting for a runner to pick up this job…` for more than a few minutes | The runner label does not exist or is retired: compare with the runner-images README and change `matrix.runner` |
| Download the official Node | `curl: (22) The requested URL returned error: 404`; or `SHA-256 不符` (a SHA-256 mismatch; the script's messages are in Chinese) | The Node version is wrong or the network hiccuped; do not let a mismatch through, download again |
| Extract Node (Windows) | `unzip: command not found` and `7z: command not found` appear together, or `tar.exe: ... Unrecognized archive format` | All three fallbacks are unusable; switch to PowerShell's `Expand-Archive` |
| Package (Windows) | `[失败] Command failed: …System32\tar.exe` (`[失败]` means "failed") | Read tar's error; when paths are too long, put `--node-dir` and the repository at shallower paths |
| Smoke test (Windows) | `网关没有就绪（进程已退出，码 N）` ("the gateway did not become ready (process exited, code N)"), with the tail of serve.log attached | A dependency is missing from the package, or it crashes on start on Windows: fix it from the stack in serve.log; `MODULE_NOT_FOUND` means the release package was trimmed too far |
| Smoke test (Windows) | Exit code 1 and garbled Chinese text in the output | Non-ASCII text got into the `.cmd`, or a path-encoding problem (a test already limits `.cmd` to ASCII) |
| PowerShell 5.1 syntax check | `missing UTF-8 BOM` or the position of a ParseError | The corresponding `.ps1` template (`scripts/package-windows.mjs`) has a syntax error |
| Smoke test (macOS) | `hdiutil: attach failed` / `create failed - Resource busy` | Occasional: the script already retries 3 times automatically; if it still fails, re-run the job |
| Gather (release job) | `test "$(ls -1 *.dmg \| wc -l)" -eq 2` fails (or the `*.tar.gz` count should be 2, the `*.tgz` count 1) | One platform's artifact was not uploaded; look at the `upload-artifact` step of each build job and of `npm-package` |
| The job stays Queued (Linux arm64) | `ubuntu-24.04-arm` never gets a runner | The repository is private, or the label changed: compare with the runner-images README; if it is unavailable, first delete the Linux arm64 entry from the matrix and ship x64 only |
| Package (Linux) | `tar: ... Cannot change ownership` or `unrecognized option '--owner=0'` | The runner's `tar` is not GNU tar: change the linux branch of `tarCommand` in `scripts/release-plan.mjs` |
| Smoke test (Linux) | `网关没有就绪` (the gateway did not become ready) and serve.log shows `GLIBC_2.xx not found` or `cannot execute binary file` | The official Node's architecture or glibc does not match the runner: check `matrix.node_dist` and `matrix.arch` |
| Smoke test (Linux / npm) | `有模块无法 import` (some modules cannot be imported) followed by module names | Trimming removed a file read at run time: see which path of which package is missing and add an exception to `isThirdPartyDeadWeight` |
| Smoke test (all) | `等待超时` (wait timed out) on `任务停在 requires_action` (the task parks at requires_action), `oaa approvals 列出待批准项` (oaa approvals lists the pending item) or `stop 之后仍有进程使用 …` (processes still use the directory after stop) | The sample agent subprocess did not start (on Linux look at `ps` and serve.log), or the gateway did not exit cleanly: fix from the logs; leftover processes mean SIGTERM was not handled |
| `install.sh` trial (Linux) | `SHA-256 mismatch` or `download failed: file://…` | The trial points `OAA_DOWNLOAD_BASE` at `release/linux`: check the version in the file name against `SHA256SUMS` |
| `npm-package` job | `npm error code E404` while installing dependencies, or an `EBADENGINE` warning | The first is an occasional npm registry problem: re-run; the second is only a warning (`engines` is `>=24.18.0 <27`; the job uses `NODE_RUNTIME_VERSION`) |
| `npm-package` job | `npx … oaa --help` prints nothing or fails with `ERR_MODULE_NOT_FOUND` | The `dist/src/cli.js` that `bin` points to is not in the package, or a hard-coded path breaks once dependencies are hoisted: check the file list of `npm pack` (`test/npm-package.test.ts` checks it) |

### Docker first-run checklist

The Docker route cannot be built on the developer machine (there is no Docker there); `docker.yml` builds the amd64 image and runs the container smoke test on every push and pull request, and that passed on GitHub's Ubuntu runner on 2026-11-14. The steps that only run when a release is published (the arm64 build under QEMU, the push to ghcr) have not run yet. If the `Docker` workflow fails, read its log in this order:

| Step | What the log looks like on failure | Cause and fix |
| --- | --- | --- |
| Build linux/amd64 (build stage) | `npm error ... EUSAGE` / `npm ci can only install packages when your package.json and package-lock.json are in sync` | `package.json` was changed without updating the lockfile: run `npm install --package-lock-only` locally and commit |
| Build (build stage) | `tsc` reports `Cannot find module` / `TS6059 rootDir` / cannot find `test/...` | The build stage copies only `src test examples bench tsconfig.json`: when `include` in `tsconfig.json` gains a directory, add a matching `COPY` to the Dockerfile |
| Build (deps stage) | `test ! -e node_modules/@anthropic-ai/claude-agent-sdk` fails with exit code 1 | The proprietary SDK was moved back to regular `dependencies` in `package.json`: move it back to `devDependencies` (`test/claude-sdk.test.ts` catches this) |
| Build (runtime stage) | `COPY failed: file not found in build context` | `.dockerignore` excludes a path that is copied, or a path was renamed (`test/docker-config.test.ts` catches this): compare with the path in the error |
| Smoke test | `The gateway did not answer /healthz` with the container log attached | Read the log: `Cannot find module` means the runtime stage missed a file (`package.json` must be there, with its `"type": "module"`), `EACCES` means `/data` is not owned by the `node` user (`VOLUME` must come after the `chown`); `invalid_host` means the Host check did not let loopback through |
| Smoke test | `No caller key file appeared`, with `Preparing the sample agent or key failed` in the log | Read the error after it: `adapter_unavailable` or a sample agent subprocess that does not start (in the container `process.execPath` is `/usr/local/bin/node`; the path is written in `adapters.oaa-sample` of `config.json`) |
| Smoke test | `A key was printed in the container log` | The entrypoint or the gateway printed a key to the log: the entrypoint may print only the location of key files |
| Smoke test | After the restart `healthy` never arrives | `--start-period` and `--interval` of `HEALTHCHECK` (30 seconds each): raise `--start-period` for slow runners |
| Smoke test | The exit code after `docker stop` is not 0 (143 / 137) | The signal did not reach the gateway: `--init` (`init: true` in compose) forwards it and the entrypoint passes SIGTERM to its child; 137 means it was killed after 10 seconds, so see why `app.close()` did not finish |
| Build and push (arm64) | `npm ci` under QEMU is very slow (over 30 minutes) or `Illegal instruction` | Occasional under emulation: re-run; the long-term fix is to build on the arm64 runner (`ubuntu-24.04-arm`) separately and merge the manifests |
| Log in / push | `denied: permission_denied: write_package` | The job needs `packages: write` (it has it), and Settings → Actions → General → Workflow permissions must not limit `GITHUB_TOKEN` to read-only; if the package already exists under another repository, grant this repository write access in the package settings |
| pull (user side) | `manifest unknown` / `denied` | A package is private by default after the first push: set it to Public in the package settings |
| `docker compose up -d` (user side, no checkout) | Complains that the `build` path does not exist | Compose has both `image` and `build`: without a checkout use `docker run` (see install.md) or delete the `build:` line |
