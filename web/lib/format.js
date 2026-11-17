import { prefs } from './state.js';
import { lang, t } from './i18n.js';
import {
  formatDateTime,
  formatDuration,
  formatPoints,
  formatSignedPoints,
  formatTokens,
  formatTokensShort,
  formatWhen as sharedWhen,
} from '../shared/format.js';

// Points, tokens, durations and times use the rules in shared/format.js, the portal's too.
export const points = (n) => formatPoints(n, lang);
export const signedPoints = (n) => formatSignedPoints(n, lang);
export const compactTokens = (n) => formatTokensShort(n, lang);

export const VIEWS = {
  projects: { title: t('project.title'), group: t('view.group.workspace'), desc: '' },
  workflows: { title: t('workflow.title'), group: t('view.group.workspace'), desc: '' },
  usage: {
    title: t('view.usage.title'),
    group: t('view.group.workspace'),
    desc: t('view.usage.desc'),
  },
  overview: {
    title: t('view.overview.title'),
    group: t('view.group.workspace'),
    desc: t('view.overview.desc'),
  },
  agents: {
    title: t('view.agents.title'),
    group: t('view.group.workspace'),
    desc: t('view.agents.desc'),
  },
  requests: {
    title: t('view.requests.title'),
    group: t('view.group.workspace'),
    desc: t('view.requests.desc'),
  },
  nodes: {
    title: t('view.nodes.title'),
    group: t('view.group.runtime'),
    desc: t('view.nodes.desc'),
  },
  access: {
    title: t('view.access.title'),
    group: t('view.group.connect'),
    desc: t('view.access.desc'),
  },
  connections: {
    title: t('view.connections.title'),
    group: t('view.group.connect'),
    desc: t('view.connections.desc'),
  },
  keys: {
    title: t('view.keys.title'),
    group: t('view.group.connect'),
    desc: t('view.keys.desc'),
  },
  platform: {
    title: t('view.platform.title'),
    group: t('view.group.connect'),
    desc: t('view.platform.desc'),
  },
  settings: {
    title: t('view.settings.title'),
    group: t('view.group.preferences'),
    desc: t('view.settings.desc'),
  },
};
export const VIEW_ICONS = {
  projects: 'folder-open',
  workflows: 'workflow',
  usage: 'chart-no-axes-combined',
  overview: 'layout-dashboard',
  agents: 'bot',
  requests: 'activity',
  nodes: 'server',
  access: 'plug',
  connections: 'cable',
  keys: 'key-round',
  platform: 'store',
  settings: 'settings',
};

export const PLACEMENT_NAMES = {
  portable: t('placement.portable'),
  'host-bound': t('placement.hostBound'),
};
export const formatPlacement = (v) => PLACEMENT_NAMES[v] ?? v ?? '';

export const MODE_NAMES = {
  auto: t('mode.auto'),
  explicit: t('mode.explicit'),
};
export const formatMode = (v) => MODE_NAMES[v] ?? v ?? '';

// O + A interlocked line (scripts/brand-icon.mjs is the geometry source).
export const MARK_VIEWBOX = '40.11 43 175.78 170';
export const MARK_PATHS = [
  'M209.89 207L150.11 49L108.57 155',
  'M94.7 190.38L88.19 207',
  'M143.36 106.65A50 50 0 1 1 119.1 78.6',
];

// Identification marks shipped in web/agents (see THIRD_PARTY_NOTICES.md).
export const AGENT_ICONS = new Set(
  'aider amp-acp antigravity antigravity-acp auggie claude claude-acp cline codebuddy codex codex-acp copilot cortex-code cursor deepagents deepseek-harness devin factory-droid gemini glm goose grok grok-build grok-build-acp hermes junie kilo kimi kiro minimax-code open-design opencode opencode-acp pi pi-acp qoder qwen reasonix trae-cli vibe workbuddy'.split(
    ' ',
  ),
);
// Marks drawn in near-black only: inverted on the dark themes so they stay visible.
export const AGENT_MONO_ICONS = new Set([
  'auggie',
  'factory-droid',
  'deepagents',
  'cursor',
  'opencode',
  'opencode-acp',
  'codex',
  'codex-acp',
  'copilot',
  'cline',
  'goose',
  'grok',
  'grok-build',
  'grok-build-acp',
  'glm',
  'kilo',
  'pi',
  'pi-acp',
  'hermes',
]);
export const ENGINE_ALIASES = { dsh: 'deepseek-harness' };
export const AGENT_NAMES = {
  kernel: t('agent.kernel'),
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
  'deepseek-harness': 'DeepSeek Harness',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  kimi: 'Kimi Code',
  opencode: 'OpenCode',
  'opencode-acp': 'OpenCode (ACP)',
  goose: 'Goose',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  kiro: 'Kiro',
  qoder: 'Qoder',
  auggie: 'Auggie',
  'factory-droid': 'Factory Droid',
  cline: 'Cline',
  vibe: 'Mistral Vibe',
  'amp-acp': 'Amp',
  'claude-acp': 'Claude Code (ACP)',
  'codex-acp': 'Codex (ACP)',
  'antigravity-acp': 'Antigravity (ACP)',
  aider: 'Aider',
  devin: 'Devin',
  junie: 'Junie',
  kilo: 'Kilo Code',
  'trae-cli': 'Trae CLI',
  codebuddy: 'CodeBuddy',
  glm: 'GLM',
  'minimax-code': 'MiniMax Code',
  grok: 'Grok',
  'grok-build': 'Grok Build',
  'grok-build-acp': 'Grok Build (ACP)',
  'cortex-code': 'Cortex Code',
  pi: 'Pi',
  'pi-acp': 'Pi (ACP)',
  deepagents: 'DeepAgents',
  hermes: 'Hermes',
  reasonix: 'Reasonix',
  workbuddy: 'WorkBuddy',
  'open-design': 'Open Design',
};
export const NATIVE_RUNTIMES = ['codex', 'claude', 'antigravity', 'dsh'];

// [label, tone]. One rule for tones: `warn` (cinnabar) means "waiting on a person": pending
// approval, interrupted, outcome unknown, incomplete. Expired, paused or not-configured states
// are merely not working, so they are always neutral.
export const STATUS = {
  completed: [t('status.completed'), 'good'],
  ready: [t('status.ready'), 'good'],
  online: [t('status.online'), 'good'],
  active: [t('status.active'), 'good'],
  enabled: [t('status.enabled'), 'good'],
  unavailable: [t('status.unavailable'), 'neutral'],
  degraded: [t('status.degraded'), 'neutral'],
  busy: [t('status.queued'), 'queued'],
  cooling_down: [t('status.cooling_down'), 'neutral'],
  queued: [t('status.queued'), 'queued'],
  in_progress: [t('status.running'), 'run'],
  running: [t('status.running'), 'run'],
  requires_action: [t('status.requires_action'), 'warn'],
  // Parked on a caller's tool (bridge): needs nothing from the owner, so the in-progress style.
  awaiting_caller: [t('status.awaiting_caller'), 'run'],
  interrupted: [t('status.interrupted'), 'warn'],
  failed: [t('status.failed'), 'error'],
  incomplete: [t('status.incomplete'), 'warn'],
  cancelled: [t('status.cancelled'), 'neutral'],
  pending: [t('status.pending'), 'neutral'],
  draining: [t('status.draining'), 'neutral'],
  drained: [t('status.drained'), 'neutral'],
  revoked: [t('status.revoked'), 'neutral'],
  expired: [t('status.expired'), 'neutral'],
  offline: [t('status.offline'), 'neutral'],
  uncertain: [t('status.uncertain'), 'warn'],
  disabled: [t('status.disabled'), 'neutral'],
};
// A list row's waiting_on (older gateways lack it): `caller` means it only waits for the caller to
// send tool results back, which needs no person.
export const awaitingCaller = (r) => r?.status === 'requires_action' && r?.waiting_on === 'caller';
// The status key lists and the overview display: a task waiting on its caller shows "Waiting for
// caller", the rest are unchanged.
export const runStatusKey = (r) => (awaitingCaller(r) ? 'awaiting_caller' : r.status);
// A rule receives (status, row).
export const REQUEST_FILTERS = [
  ['all', t('filter.all'), () => true],
  ['active', t('filter.active'), (s) => ['queued', 'in_progress', 'requires_action'].includes(s)],
  [
    'attention',
    t('filter.attention'),
    (s, r) =>
      (s === 'requires_action' && !awaitingCaller(r)) || ['interrupted', 'incomplete'].includes(s),
  ],
  ['completed', t('filter.completed'), (s) => s === 'completed'],
  ['failed', t('filter.failed'), (s) => ['failed', 'cancelled'].includes(s)],
];
export const STRATEGY_PROFILES = { auto: 'auto', speed: '@fast', quality: '@best', cost: '@eco' };
// Names for capabilities a gateway advertises in GET /health `features` (src/gateway/server.ts
// GATEWAY_FEATURES, plus platform-v1 when the developer platform is on).
const FEATURE_LABELS = {
  'local-usage-v1': t('feature.local-usage-v1'),
  'local-connections-v1': t('feature.local-connections-v1'),
  'local-model-runtimes-v1': t('feature.local-model-runtimes-v1'),
  'agent-orchestration-v1': t('feature.agent-orchestration-v1'),
  'agent-policy-v1': t('feature.agent-policy-v1'),
  'model-catalog-v1': t('feature.model-catalog-v1'),
  'model-evaluation-v1': t('feature.model-evaluation-v1'),
  'project-memory-v1': t('feature.project-memory-v1'),
  'durable-tasks-v1': t('feature.durable-tasks-v1'),
  'visual-workflows-v1': t('feature.visual-workflows-v1'),
  'media-jobs-v1': t('feature.media-jobs-v1'),
  'everything-acp-import-v1': t('feature.everything-acp-import-v1'),
  'a2a-adapters-v1': t('feature.a2a-adapters-v1'),
  'acp-adapters-v1': t('feature.acp-adapters-v1'),
  'adapter-stream-v1': t('feature.adapter-stream-v1'),
  'approval-policy-v1': t('feature.approval-policy-v1'),
  'catalog-events-v1': t('feature.catalog-events-v1'),
  'client-tools-policy-v1': t('feature.client-tools-policy-v1'),
  'conversion-profile-v1': t('feature.conversion-profile-v1'),
  'error-catalog-v1': t('feature.error-catalog-v1'),
  'error-codes-v1': t('feature.error-codes-v1'),
  'harness-bridge-acp-v1': t('feature.harness-bridge-acp-v1'),
  'harness-bridge-v1': t('feature.harness-bridge-v1'),
  'image-input-v1': t('feature.image-input-v1'),
  'local-backends-v1': t('feature.local-backends-v1'),
  'stream-progress-v1': t('feature.stream-progress-v1'),
  'structured-output-v1': t('feature.structured-output-v1'),
  'oaa-lang-roundtrip-v1': t('feature.oaa-lang-roundtrip-v1'),
  'overview-activity-v1': t('feature.overview-activity-v1'),
  'overview-etag-v1': t('feature.overview-etag-v1'),
  'overview-events-v1': t('feature.overview-events-v1'),
  'platform-setup-v1': t('feature.platform-setup-v1'),
  'platform-v1': t('feature.platform-v1'),
  'queue-insight-v1': t('feature.queue-insight-v1'),
  'run-timeline-v1': t('feature.run-timeline-v1'),
  'webhooks-v1': t('feature.webhooks-v1'),
  'workflow-output-v1': t('feature.workflow-output-v1'),
};
// A capability this console does not know yet (a newer gateway) reads as plain words and a
// version, "New thing · v2", never as a raw identifier.
export function featureName(id) {
  const key = String(id ?? '');
  if (FEATURE_LABELS[key]) return FEATURE_LABELS[key];
  const m = /^(.*?)(?:-v(\d+))?$/.exec(key);
  const words = (m?.[1] || key).replace(/[-_]+/g, ' ').trim();
  const label = words ? words[0].toUpperCase() + words.slice(1) : key;
  return m?.[2] ? `${label} · v${m[2]}` : label;
}
export const SCOPE_NAMES = {
  read: t('scope.read'),
  invoke: t('scope.invoke'),
  files: t('scope.files'),
  approve: t('scope.approve'),
  billing: t('scope.billing'),
  admin: t('scope.admin'),
};
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
export const num = (n) => formatTokens(n, lang);
export const formatTime = (value) => formatDuration(Number(value) || 0, lang);
// Waits read better as rounded spoken durations ("about 28 s") than as stopwatch values.
export function waitWhen(ms) {
  return ms < 60000
    ? t('wait.sec', { n: Math.round(ms / 1000) })
    : ms < 3600000
      ? t('wait.min', { n: Math.round(ms / 60000) })
      : t('wait.hour', { n: (ms / 3600000).toFixed(1) });
}
// A whole phrase ("Starts in about 28 s"); `brief` leaves out the "starts in" part, for a narrow
// table cell.
export function formatWait(ms, brief = false) {
  if (ms < 1000) return t('wait.soon');
  const when = waitWhen(ms);
  return brief ? when : t('wait.starts', { when });
}
// Rates may arrive as 0..1 or as a percentage; both render the same.
export function ratio(x) {
  if (x == null || x === '' || !Number.isFinite(Number(x))) return null;
  const n = Number(x);
  return n > 1 ? n / 100 : n;
}
export function percent(x) {
  const r = ratio(x);
  if (r == null) return '—';
  const v = r * 100;
  return `${v >= 99.95 || v < 0.05 ? v.toFixed(0) : v.toFixed(1)}%`;
}
export const duration = (ms) => (ms == null || !Number.isFinite(Number(ms)) ? '—' : formatTime(ms));
// Relative within 7 days, then the date and time (rules in shared/format.js).
export const timeAgo = (ms) => sharedWhen(ms, lang);
// Request times follow the "time display" preference (relative or exact).
export function formatWhen(ms) {
  if (!ms) return '';
  return prefs.timeFormat !== 'absolute' ? sharedWhen(ms, lang) : formatDateTime(ms, lang);
}
export function engineKey(engine) {
  const raw = String(engine || '');
  const id = raw.startsWith('adapter/') ? raw.slice('adapter/'.length) : raw;
  return ENGINE_ALIASES[id] ?? id;
}
export const engineName = (engine, fallback) =>
  fallback || AGENT_NAMES[engineKey(engine)] || String(engine || '');
export const engineKind = (engine) =>
  engine === 'kernel'
    ? t('engine.kernel')
    : String(engine).startsWith('adapter/')
      ? t('engine.remote')
      : t('engine.local');
