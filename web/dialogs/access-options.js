import { $ } from '../lib/dom.js';
import { state } from '../lib/state.js';
import { catalogFor } from './model-discovery.js';
import { t } from '../lib/i18n.js';

export function supportedToolModes(agent) {
  const supported =
    agent?.tool_boundaries ??
    (agent?.engine === 'kernel' ? ['managed', 'client', 'hybrid'] : ['managed']);
  return supported.filter((mode) => !agent?.access || agent.access.modes.includes(mode));
}
export function renderKeyToolModes(ids) {
  const agents = (state.data?.agents ?? []).filter((a) => ids.includes(a.id));
  const picker = $('key-tool-boundary');
  for (const option of picker.options)
    option.disabled = !agents.length
      ? option.value !== 'managed'
      : !agents.every((a) => supportedToolModes(a).includes(option.value));
  if (picker.selectedOptions[0]?.disabled)
    picker.value = [...picker.options].find((o) => !o.disabled)?.value ?? '';
}
export function renderPublishToolModes(engine) {
  const backend = state.backends?.find((b) => b.engine === engine);
  const orchestration = ['kernel', 'antigravity', 'claude'].includes(engine);
  $('publish-orchestrate').disabled = !orchestration;
  $('publish-orchestrate').parentElement.title = orchestration
    ? ''
    : t('orchestration.unavailable');
  if (!orchestration) $('publish-orchestrate').checked = false;
  const modes =
    backend?.tool_boundaries ??
    (catalogFor(engine)?.clientTools === 'hybrid' || backend?.conversion?.client_tools === 'bridge'
      ? ['managed', 'hybrid']
      : ['managed']);
  const picker = $('publish-tool-boundary');
  for (const option of picker.options) option.disabled = !modes.includes(option.value);
  if (picker.selectedOptions[0]?.disabled) picker.value = 'managed';
  const approvals =
    backend?.conversion?.approvals === 'bridged' || catalogFor(engine)?.clientTools === 'hybrid';
  const approver = $('publish-approver');
  for (const option of approver.options)
    option.disabled = option.value === 'native' ? approvals : !approvals;
  approver.disabled = !approvals;
  if (approver.selectedOptions[0]?.disabled) approver.value = approvals ? 'owner' : 'native';
  $('publish-auto-approve').disabled = !approvals;
  if (!approvals) {
    $('publish-auto-approve').checked = false;
    $('publish-auto-approve-note').hidden = true;
  }
  return modes;
}
