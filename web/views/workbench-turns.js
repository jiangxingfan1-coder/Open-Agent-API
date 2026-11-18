import { authHeaders } from '../lib/api.js';
import {
  agentGlyph,
  button,
  confirmAction,
  el,
  icon,
  iconButton,
  status,
  toast,
  withBusy,
} from '../lib/dom.js';
import { num } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { state } from '../lib/state.js';
import { previewArtifact, previewable } from '../dialogs/media-preview.js';
import { showRun } from '../dialogs/runs.js';
import { agentById } from './common.js';
import { targetModelName } from './workbench-code.js';
import {
  defaultToolResultFor,
  executeStreamingTurn,
  submitOwnerDecision,
} from './workbench-stream.js';

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** Render assistant text safely with fenced code blocks and paragraphs (never innerHTML). */
export function renderSafeText(container, rawText) {
  container.replaceChildren();
  const text = String(rawText || '');
  if (!text) return;
  const segments = text.split(/```/);
  segments.forEach((seg, idx) => {
    if (idx % 2 === 1) {
      const newline = seg.indexOf('\n');
      const codeBody = newline >= 0 ? seg.slice(newline + 1) : seg;
      container.append(el('pre', codeBody.replace(/\n$/, ''), 'code wb-inline-code'));
    } else {
      for (const block of seg.split(/\n{2,}/)) {
        const trimmed = block.trim();
        if (trimmed) container.append(el('p', trimmed, 'wb-para'));
      }
    }
  });
}

async function downloadArtifact(artifact) {
  try {
    const res = await fetch(`/v1/files/${encodeURIComponent(artifact.id)}/content`, {
      headers: authHeaders(state.token),
    });
    if (!res.ok) throw Error(t('wb.artifact.downloadFailed', { status: res.status }));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = artifact.filename || 'artifact';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    toast(err.message);
  }
}

function renderOwnerApprovalCard(session, turn, onUpdate) {
  const card = el('div', undefined, 'wb-action-card owner');
  const head = el('div', undefined, 'wb-action-head');
  head.append(
    icon('shield-alert'),
    el('strong', t('wb.approval.title')),
    el('span', t('wb.approval.hint'), 'muted'),
  );
  card.append(head);

  const actions = turn.ownerActions || [];
  if (!actions.length) {
    card.append(el('p', t('wb.approval.loading'), 'muted'));
    return card;
  }

  for (const action of actions) {
    const item = el('div', undefined, 'wb-action-item');
    const titleRow = el('div', undefined, 'wb-action-item-head');
    titleRow.append(
      el(
        'span',
        action.kind === 'native' ? t('wb.approval.native') : t('wb.approval.tool'),
        'wb-action-kind',
      ),
      el('code', action.id),
    );
    const detailPre = el('pre', action.detail?.preview || '{}', 'code small');
    item.append(titleRow, detailPre);

    let replyInput = null;
    if (action.kind === 'native') {
      const replyLabel = el('label', undefined, 'field wb-compact-field');
      replyLabel.append(el('span', t('wb.approval.replyLabel')));
      replyInput = el('textarea');
      replyInput.rows = 2;
      replyInput.value = turn.draftReplies?.[action.id] ?? '{}';
      replyInput.oninput = () => {
        turn.draftReplies ??= {};
        turn.draftReplies[action.id] = replyInput.value;
      };
      replyLabel.append(replyInput);
      item.append(replyLabel);
    }

    const errNode = el('div', '', 'form-error');
    const controls = el('div', undefined, 'wb-action-controls');
    const approveBtn = button(
      t('wb.approval.approve'),
      'check',
      async () => {
        errNode.textContent = '';
        await withBusy(approveBtn, t('wb.approval.submitting'), async () => {
          try {
            await submitOwnerDecision({
              session,
              turn,
              actionId: action.id,
              decision: 'approve',
              replyJson: replyInput?.value,
              onUpdate,
            });
          } catch (err) {
            errNode.textContent = err.message;
          }
        });
      },
      'primary small-btn',
    );
    const denyBtn = button(
      t('wb.approval.deny'),
      'x',
      async () => {
        const confirmed = await confirmAction({
          title: t('wb.approval.denyConfirmTitle'),
          message: t('wb.approval.denyConfirmMsg'),
          accept: t('wb.approval.deny'),
          danger: true,
        });
        if (!confirmed) return;
        errNode.textContent = '';
        await withBusy(denyBtn, t('wb.approval.submitting'), async () => {
          try {
            await submitOwnerDecision({
              session,
              turn,
              actionId: action.id,
              decision: 'deny',
              replyJson: '',
              onUpdate,
            });
          } catch (err) {
            errNode.textContent = err.message;
          }
        });
      },
      'subtle small-btn',
    );
    controls.append(approveBtn, denyBtn);
    item.append(errNode, controls);
    card.append(item);
  }
  return card;
}

function formatCallArgs(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return String(raw || '{}');
  }
}

function renderCallerBridgeCard(session, turn, onUpdate) {
  const card = el('div', undefined, 'wb-action-card caller');
  const head = el('div', undefined, 'wb-action-head');
  head.append(
    icon('plug'),
    el('strong', t('wb.bridge.cardTitle')),
    el('span', t('wb.bridge.cardHint'), 'muted'),
  );
  card.append(head);

  turn.draftOutputs ??= {};
  const calls = turn.callerCalls || [];
  for (const call of calls) {
    if (!(call.call_id in turn.draftOutputs)) {
      turn.draftOutputs[call.call_id] = defaultToolResultFor(call.name);
    }
    const item = el('div', undefined, 'wb-action-item');
    const titleRow = el('div', undefined, 'wb-action-item-head');
    titleRow.append(el('code', call.name), el('span', call.call_id, 'tag'));
    const argsPre = el('pre', formatCallArgs(call.arguments), 'code small');
    const outLabel = el('label', undefined, 'field wb-compact-field');
    outLabel.append(el('span', t('wb.bridge.outputLabel', { name: call.name })));
    const outInput = el('textarea');
    outInput.rows = 3;
    outInput.spellcheck = false;
    outInput.value = turn.draftOutputs[call.call_id];
    outInput.oninput = () => {
      turn.draftOutputs[call.call_id] = outInput.value;
    };
    outLabel.append(outInput);
    item.append(titleRow, argsPre, outLabel);
    card.append(item);
  }

  const controls = el('div', undefined, 'wb-action-controls');
  const sendBtn = button(
    t('wb.bridge.sendContinue'),
    'send-horizontal',
    async () => {
      const toolOutputs = calls.map((call) => ({
        call_id: call.call_id,
        output: turn.draftOutputs[call.call_id] ?? '',
      }));
      await executeStreamingTurn({ session, turn, toolOutputs, onUpdate });
    },
    'primary small-btn',
  );
  controls.append(sendBtn);
  card.append(controls);
  return card;
}

export function renderTurnNode(session, turn, onUpdate) {
  if (turn.role === 'user') {
    const row = el('article', undefined, 'wb-turn wb-turn-user');
    const bubble = el('div', undefined, 'wb-user-bubble');
    if (turn.images?.length) {
      const gallery = el('div', undefined, 'wb-turn-images');
      for (const img of turn.images) {
        if (img.dataUrl) {
          const thumb = el('img', undefined, 'wb-turn-thumb');
          thumb.src = img.dataUrl;
          thumb.alt = img.name || 'image';
          gallery.append(thumb);
        } else {
          gallery.append(el('span', img.name || 'image', 'tag'));
        }
      }
      bubble.append(gallery);
    }
    if (turn.text) bubble.append(el('p', turn.text, 'wb-para'));
    row.append(bubble);
    return row;
  }

  const row = el('article', undefined, 'wb-turn wb-turn-assistant');
  const agent = agentById(turn.agentId);
  const head = el('div', undefined, 'wb-turn-head');
  const targetLabel = el('strong', targetModelName(turn.agentId, turn.route));
  targetLabel.translate = false;
  head.append(agentGlyph(agent?.engine || turn.agentId, 'small', agent?.preset), targetLabel);
  if (turn.resolvedModel) {
    head.append(el('code', turn.resolvedModel, 'wb-resolved-model'));
  }
  const stKey = turn.waitingOn === 'caller' ? 'awaiting_caller' : turn.status || 'completed';
  head.append(status(stKey, turn.waitingOn === 'owner'));
  if (turn.usage?.total_tokens) {
    head.append(
      el('span', t('wb.turn.tokens', { n: num(turn.usage.total_tokens) }), 'muted wb-turn-tokens'),
    );
  }
  if (turn.runId) {
    const inspectBtn = iconButton(t('wb.turn.inspectRun', { id: turn.runId }), 'activity', () =>
      showRun(turn.runId),
    );
    inspectBtn.classList.add('wb-inspect-btn');
    head.append(inspectBtn);
  }
  row.append(head);

  if (turn.reasoning || (turn.streaming && !turn.text)) {
    const details = el('details', undefined, 'wb-reasoning');
    details.open = turn.reasoningOpen ?? (turn.streaming && !turn.text);
    details.ontoggle = () => {
      turn.reasoningOpen = details.open;
    };
    const summary = el('summary');
    summary.append(
      icon('sparkles'),
      el('span', turn.streaming ? t('wb.turn.thinkingLive') : t('wb.turn.thinkingDone')),
    );
    details.append(
      summary,
      el('pre', turn.reasoning || t('wb.turn.waitingStream'), 'wb-reasoning-body'),
    );
    row.append(details);
  }

  if (turn.steps?.length) {
    const stepsWrap = el('div', undefined, 'wb-steps');
    const stepIcons = {
      completed: 'check',
      running: 'refresh-cw',
      failed: 'x',
      uncertain: 'circle-alert',
    };
    for (const step of turn.steps) {
      const badge = el('span', undefined, `tag wb-step-badge ${step.status || ''}`);
      badge.append(icon(stepIcons[step.status] || 'wrench'), el('span', step.name));
      stepsWrap.append(badge);
    }
    row.append(stepsWrap);
  }

  if (turn.text) {
    const textWrap = el('div', undefined, 'wb-text');
    renderSafeText(textWrap, turn.text);
    row.append(textWrap);
  }

  if (turn.error) {
    const errBox = el('p', undefined, 'callout danger wb-turn-error');
    errBox.append(icon('circle-alert'), el('span', turn.error));
    row.append(errBox);
  }

  if (turn.artifacts?.length) {
    const artWrap = el('div', undefined, 'wb-artifacts');
    for (const art of turn.artifacts) {
      const item = el('div', undefined, 'wb-artifact-row');
      item.append(
        icon('file-text'),
        el('span', art.filename, 'wb-artifact-name'),
        el('span', formatBytes(art.bytes), 'muted'),
      );
      if (previewable(art.filename)) {
        item.append(
          iconButton(t('wb.artifact.preview'), 'eye', () =>
            previewArtifact({ token: state.token, controller: new AbortController() }, art),
          ),
        );
      }
      item.append(iconButton(t('wb.artifact.download'), 'download', () => downloadArtifact(art)));
      artWrap.append(item);
    }
    row.append(artWrap);
  }

  if (turn.status === 'requires_action' && turn.waitingOn === 'owner') {
    row.append(renderOwnerApprovalCard(session, turn, onUpdate));
  } else if (turn.status === 'requires_action' && turn.waitingOn === 'caller') {
    row.append(renderCallerBridgeCard(session, turn, onUpdate));
  }

  return row;
}
