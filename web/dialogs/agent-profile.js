import { engineName } from '../lib/format.js';
import { $, el } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

// Placement reason codes (docs/protocol.md, "reasons[].code"): why an execution machine cannot take a step.
// The gateway's original message stays in the title; a code without copy shows the message as is.
export const PLACEMENT_REASON = {
  agent_scope: t('dlg.agent.reason.agent_scope'),
  agent_node_restriction: t('dlg.agent.reason.agent_node_restriction'),
  session_node_affinity: t('dlg.agent.reason.session_node_affinity'),
  file_node_restriction: t('dlg.agent.reason.file_node_restriction'),
  provider_unavailable: t('dlg.agent.reason.provider_unavailable'),
  tool_selection_unreported: t('dlg.agent.reason.tool_selection_unreported'),
  capability_scope: t('dlg.agent.reason.capability_scope'),
  native_disabled: t('dlg.agent.reason.native_disabled'),
  native_model_unsupported: t('dlg.agent.reason.native_model_unsupported'),
  native_model_unreported: t('dlg.agent.reason.native_model_unreported'),
  host_binding: t('dlg.agent.reason.host_binding'),
  result_export_denied: t('dlg.agent.reason.result_export_denied'),
  builtin_unreported: t('dlg.agent.reason.builtin_unreported'),
  script_runtime_disabled: t('dlg.agent.reason.script_runtime_disabled'),
  capability_unavailable: t('dlg.agent.reason.capability_unavailable'),
  capability_mismatch: t('dlg.agent.reason.capability_mismatch'),
  byok_unsupported: t('dlg.agent.reason.byok_unsupported'),
  provider_state_unsupported: t('dlg.agent.reason.provider_state_unsupported'),
  sandbox_unavailable: t('dlg.agent.reason.sandbox_unavailable'),
  no_online_nodes: t('dlg.agent.reason.no_online_nodes'),
  node_busy: t('dlg.agent.reason.node_busy'),
  node_draining: t('dlg.agent.reason.node_draining'),
  node_revoked: t('dlg.agent.reason.node_revoked'),
  target_cooling_down: t('dlg.agent.reason.target_cooling_down'),
  required_tool_unavailable: t('dlg.agent.reason.required_tool_unavailable'),
};
/* ── AgentAPI conversion profile (conversion-profile-v1) ── */
// How faithfully an agent's own protocol converts into AgentAPI: derived by the gateway from
// static local configuration, never from a model call.
export const CONVERSION = {
  tier: {
    interactive: t('dlg.agent.tier.interactive'),
    streaming: t('dlg.agent.tier.streaming'),
    basic: t('dlg.agent.tier.basic'),
  },
  access: {
    kernel: t('dlg.agent.access.kernel'),
    native: t('dlg.agent.access.native'),
    acp: t('dlg.agent.access.acp'),
    'oaa-adapter': t('dlg.agent.access.oaa_adapter'),
    a2a: t('dlg.agent.access.a2a'),
    unknown: t('dlg.agent.access.unknown'),
  },
  streaming: {
    token: t('dlg.agent.streaming.token'),
    message: t('dlg.agent.streaming.message'),
    final: t('dlg.agent.streaming.final'),
  },
  approvals: {
    bridged: t('dlg.agent.approvals.bridged'),
    denied: t('dlg.agent.approvals.denied'),
    none: t('dlg.agent.approvals.none'),
  },
  cancel: {
    cooperative: t('dlg.agent.cancel.cooperative'),
    terminate: t('dlg.agent.cancel.terminate'),
    'request-abort': t('dlg.agent.cancel.request_abort'),
  },
  resume: {
    native: t('dlg.agent.resume.native'),
    'agent-declared': t('dlg.agent.resume.agent_declared'),
    'adapter-state': t('dlg.agent.resume.adapter_state'),
    none: t('dlg.agent.resume.none'),
  },
  tool_events: {
    tool: t('dlg.agent.tool_events.tool'),
    status: t('dlg.agent.tool_events.status'),
    none: t('dlg.agent.tool_events.none'),
  },
  usage: {
    reported: t('dlg.agent.usage.reported'),
    'agent-reported': t('dlg.agent.usage.agent_reported'),
    partial: t('dlg.agent.usage.partial'),
    none: t('dlg.agent.usage.none'),
  },
  model_selection: {
    route: t('dlg.agent.model_selection.route'),
    declared: t('dlg.agent.model_selection.declared'),
    'agent-confirmed': t('dlg.agent.model_selection.agent_confirmed'),
    allowlist: t('dlg.agent.model_selection.allowlist'),
  },
};
export const conversionText = (group, value) => CONVERSION[group]?.[value] ?? value ?? '—';
export const TIER_HINT = {
  interactive: t('dlg.agent.tier_hint.interactive'),
  streaming: t('dlg.agent.tier_hint.streaming'),
  basic: t('dlg.agent.tier_hint.basic'),
};
export function conversionBadge(c) {
  if (!c?.tier) return null;
  const badge = el('span', conversionText('tier', c.tier), `tag conv ${c.tier}`);
  badge.title = [
    TIER_HINT[c.tier],
    t('dlg.agent.badge.access', { v: conversionText('access', c.access) }),
    conversionText('streaming', c.streaming),
    t('dlg.agent.badge.approvals', { v: conversionText('approvals', c.approvals) }),
    t('dlg.agent.badge.cancel', { v: conversionText('cancel', c.cancel) }),
    conversionText('resume', c.resume),
  ]
    .filter(Boolean)
    .join(' · ');
  return badge;
}
export const AUTO_APPROVE_HINT = t('dlg.agent.auto_approve_hint');
export function renderConversion(c, approvals) {
  const section = $('agent-conversion-section');
  section.hidden = !c?.tier;
  if (!c?.tier) return;
  $('agent-conversion-tier').replaceChildren(conversionBadge(c));
  const list = $('agent-conversion');
  list.replaceChildren();
  const row = (label, text) => list.append(el('dt', label), el('dd', text));
  row(
    t('dlg.agent.conv.access'),
    `${conversionText('access', c.access)}${c.transport ? ` · ${c.transport}` : ''}`,
  );
  row(t('dlg.agent.conv.streaming'), conversionText('streaming', c.streaming));
  row(
    t('dlg.agent.conv.approvals'),
    approvals === 'auto'
      ? t('dlg.agent.conv.approvals_auto')
      : conversionText('approvals', c.approvals),
  );
  row(t('dlg.agent.conv.cancel'), conversionText('cancel', c.cancel));
  row(t('dlg.agent.conv.resume'), conversionText('resume', c.resume));
  row(t('dlg.agent.conv.tool_events'), conversionText('tool_events', c.tool_events));
  row(t('dlg.agent.conv.usage'), conversionText('usage', c.usage));
  row(
    t('dlg.agent.conv.artifacts'),
    c.artifacts ? t('dlg.agent.conv.supported') : t('dlg.agent.conv.unsupported'),
  );
  if (c.model_selection)
    row(t('dlg.agent.conv.model_selection'), conversionText('model_selection', c.model_selection));
  const note = $('agent-conversion-note');
  note.hidden = c.approvals !== 'denied';
  note.textContent = t('dlg.agent.conv.denied_note');
}
// "Tools and models": whose tools, where they run, how caller-supplied tools are handled, and what
// the model routes are. When `conversion.client_tools` is missing it is inferred from the engine:
// the built-in kernel can bridge, everything else is managed by the agent itself.
export function toolsNote(agent) {
  const kernel = agent.engine === 'kernel';
  const clientTools = agent.conversion?.client_tools ?? (kernel ? 'bridge' : 'managed');
  const runner = kernel
    ? t('dlg.agent.tools.runner_kernel')
    : t('dlg.agent.tools.runner_external', { engine: engineName(agent.engine) });
  const caller =
    clientTools === 'bridge'
      ? t('dlg.agent.tools.caller_bridge')
      : t('dlg.agent.tools.caller_managed');
  return t('dlg.agent.tools.note', { runner, caller });
}
