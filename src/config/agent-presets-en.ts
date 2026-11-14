/**
 * ACP 预设说明（agent-presets.ts 的 `notes`）的英文版，按预设 id 一一对应。
 * `presetNotes` 按语言取一边；test/acp.test.ts 核对每个预设都有英文且不含汉字。
 */
import type { Locale } from '../core/locale.js';
import type { AcpPreset } from './agent-presets.js';

const NPX =
  'OAA never runs npx or downloads or installs packages; install it yourself following the vendor instructions, then point the adapter command at the installed executable.';

// prettier-ignore
export const PRESET_NOTES_EN: Readonly<Record<string, string>> = {
  qoder: 'Official Qoder qoder --acp entry point; the legacy qodercli file name is also discovered. Discovery matches file names only and does not mean signed in or handshake passed.',
  'deepseek-harness': 'ACP profile of DeepSeek Harness, alongside the built-in dsh native engine (one-shot headless); multi-turn continuation depends on ACP session support. Authentication, provider, models and quota are managed by Harness.',
  kimi: 'ACP stdio entry point of Kimi Code CLI (supports session/load, resume, fork); OAA sends text prompts only. Authentication and quota are managed by Kimi Code CLI.',
  vibe: 'ACP stdio entry point of Mistral Vibe; OAA does not fill in paths, authentication, or auto-approval flags.',
  gemini: 'Official Gemini CLI ACP entry point gemini --acp (--experimental-acp is a deprecated alias). Note: since 2026-06-18 Gemini CLI is replaced by Antigravity CLI for free-tier and Google One users. Gemini CLI also has an A2A server marked experimental (gemini-cli-a2a-server), usable with transport: "a2a". Sign in to Gemini CLI first; OAA never calls ACP authenticate for you, and a passing handshake does not mean authentication is valid.',
  'antigravity-acp': 'Google Antigravity binary entry point from the ACP Registry; OAA only discovers agy_acp_server.par already on PATH and never downloads, extracts, or authenticates it. Independent of the built-in antigravity (agy headless) engine.',
  'amp-acp': 'Unofficial: a community adapter listed in the ACP Registry; Amp has no official ACP entry point (its official programmatic interfaces are amp -x --stream-json and @ampcode/sdk). OAA only discovers an installed amp-acp and never downloads or runs archives; authentication and quota are managed by Amp.',
  'cortex-code': 'Snowflake Cortex Code entry point from the ACP Registry; the cortex file name may clash with other tools, so confirm before enabling. Enterprise sign-in, model permissions and quota are managed by Cortex Code.',
  'pi-acp': `Version-pinned pi ACP launcher from the ACP Registry. ${NPX}`,
  deepagents: `ACP Registry launcher for LangChain DeepAgents. ${NPX}`,
  junie: 'ACP entry point of JetBrains Junie CLI (documented as junie --acp true, --acp=true in the Registry); Junie CLI is still in EAP early access. Sign-in, models and enterprise licensing are managed by Junie.',
  'opencode-acp': 'Official OpenCode ACP entry point; authentication, provider and models are managed by OpenCode.',
  copilot: 'Copilot CLI ACP is still in public preview; the explicit --stdio keeps stdout to NDJSON only. The copilot file name may clash with other CLIs, so confirm before enabling.',
  goose: 'Official Goose ACP stdio subcommand; extensions and models come from the local Goose configuration. The goose file name may clash with a database migration tool, so confirm before enabling.',
  kiro: 'Official Kiro ACP entry point; OAA only auto-discovers kiro-cli (kiro may be the IDE launcher). Kiro extension methods are not bridged.',
  cursor: 'ACP stdio entry point of Cursor CLI; agent is a generic file name, so OAA treats it as Cursor only when its real path contains cursor. Cursor question/plan extension methods are not bridged and are treated as unsupported; authentication is managed by agent login.',
  qwen: 'Official Qwen Code ACP mode (qwen --acp); authentication, models and quota are managed by Qwen Code, and OAA only handles the standard ACP session and approval boundary.',
  auggie: 'Official Augment Auggie ACP entry point (auggie --acp); sign-in, codebase context and quota are managed by Augment.',
  'factory-droid': 'Factory Droid ACP entry point, using the ACP Registry form droid exec --output-format acp-daemon; the official Zed integration docs use --output-format acp, which you can try if the handshake fails. Account, models and billing are managed by Factory.',
  cline: 'Official Cline ACP mode (cline --acp; no auto-approval by default in ACP mode); sign-in, provider, models and quota are managed by Cline CLI, and tool approvals go through OAA approvals.',
  devin: 'ACP stdio entry point of Devin for Terminal; OAA presets no permission-bypass flags, uses native ACP permission requests with OAA approvals, and never signs in for you.',
  hermes: 'Hermes ACP stdio entry point (hermes acp). --accept-hooks is deliberately left out: it auto-approves every shell hook not yet confirmed; approve hooks one by one in Hermes\'s own configuration if needed. The hermes file name may clash with a JS engine, so confirm before enabling. Account, models and quota are managed by Hermes.',
  kilo: 'ACP stdio entry point of Kilo; the kilo file name may clash with a text editor, so confirm before enabling. Sign-in, provider, models and quota are managed by Kilo.',
  reasonix: 'Reasonix ACP stdio entry point; the legacy dsnix file name is also discovered. OAA injects no dedicated system prompt or key and uses only the generic ACP contract.',
  'trae-cli': 'Official Trae CLI ACP serve entry point (global flags such as --profile and --permission-mode must come before acp serve); OAA presets no --yolo permission bypass and keeps native ACP permission requests.',
  'grok-build-acp': 'ACP stdio entry point of xAI Grok Build (grok agent stdio); no automatic sign-in and --always-approve is not enabled.',
  'claude-acp': `Not from the vendor: a Claude adapter maintained by the ACP organization (formerly claude-code-acp); Anthropic has no native ACP entry point, and the vendor-supported route is the built-in claude native engine (Agent SDK). ${NPX} After a global install, OAA looks for claude-agent-acp or claude-code-acp on PATH (executable names inferred from the package names).`,
  'codex-acp': `Not from the vendor: a Codex adapter maintained by the ACP organization; OpenAI has no native ACP entry point, and the vendor-supported route is the built-in codex native engine (app-server, officially marked Experimental). ${NPX} After installing, OAA looks for codex-acp on PATH.`,
  codebuddy: `Tencent Cloud CodeBuddy Code supports ACP natively (codebuddy --acp; there is also --acp-transport streamable-http, but OAA uses stdio only). When installed globally OAA looks for codebuddy on PATH; sign-in, models and quota are managed by CodeBuddy. ${NPX}`,
  'minimax-code': `ACP Registry launcher for MiniMax Code; account, models and quota are managed by MiniMax. ${NPX}`,
  glm: `ACP Registry launcher for GLM Agent; authentication, models and quota are managed by the GLM CLI. ${NPX}`,
  grok: `ACP Registry launcher for xAI Grok Build; if grok is already installed, use the grok-build-acp preset. ${NPX}`,
};

/** 预设说明：中文取 `notes`，英文取上表（缺失时回退中文，测试保证不会缺）。 */
export const presetNotes = (preset: AcpPreset, locale: Locale): string =>
  locale === 'en' ? (PRESET_NOTES_EN[preset.id] ?? preset.notes) : preset.notes;
