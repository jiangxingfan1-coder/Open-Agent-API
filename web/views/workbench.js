import { api } from '../lib/api.js';
import { agentGlyph, button, confirmAction, el, empty, icon, icons, toast } from '../lib/dom.js';
import { MOD } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { hooks, state } from '../lib/state.js';
import { agentById } from './common.js';
import { openWorkbenchCodeDialog, targetModelName } from './workbench-code.js';
import { renderWorkbenchSidebar } from './workbench-sidebar.js';
import { executeStreamingTurn } from './workbench-stream.js';
import { renderTurnNode } from './workbench-turns.js';

const STORAGE_KEY = 'oaa.workbench.v1';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function loadStoredSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(parsed?.sessions) && parsed.sessions.length) return parsed;
  } catch {
    // Ignore malformed or blocked storage.
  }
  return null;
}

export function makeSession(agentId = '') {
  return {
    id: `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title: '',
    agentId,
    route: 'auto',
    project: '',
    toolMode: 'auto',
    recommend: false,
    clientTools: [],
    lastResponseId: null,
    lastAgentId: null,
    lastRoute: null,
    turns: [],
    updatedAt: Date.now(),
  };
}

export const wb = (() => {
  const saved = loadStoredSessions();
  const initial = saved?.sessions?.length ? saved.sessions : [makeSession()];
  return {
    sessions: initial,
    activeId:
      saved?.activeId && initial.some((s) => s.id === saved.activeId)
        ? saved.activeId
        : initial[0].id,
    draftText: '',
    draftImages: [],
    projects: [],
    projectsToken: '',
    drawerOpen: false,
    editingToolIndex: -1,
    toolNameDraft: '',
    toolDescDraft: '',
    toolSchemaDraft: '{\n  "type": "object",\n  "properties": {}\n}',
    toolFormError: '',
  };
})();

function saveSessions() {
  try {
    const compact = wb.sessions.slice(0, 24).map((s) => ({
      id: s.id,
      title: s.title,
      agentId: s.agentId,
      route: s.route,
      project: s.project,
      toolMode: s.toolMode,
      recommend: !!s.recommend,
      clientTools: s.clientTools || [],
      lastResponseId: s.lastResponseId || null,
      lastAgentId: s.lastAgentId || null,
      lastRoute: s.lastRoute || null,
      updatedAt: s.updatedAt || Date.now(),
      turns: (s.turns || []).slice(-30).map((turn) => ({
        id: turn.id,
        role: turn.role,
        text: turn.text || '',
        images: (turn.images || []).map((img) => ({ name: img.name, bytes: img.bytes })),
        agentId: turn.agentId,
        route: turn.route,
        resolvedModel: turn.resolvedModel || '',
        runId: turn.runId || '',
        status: turn.streaming ? 'interrupted' : turn.status || 'completed',
        waitingOn: turn.waitingOn || null,
        reasoning: turn.reasoning || '',
        steps: turn.steps || [],
        artifacts: turn.artifacts || [],
        callerCalls: turn.callerCalls || [],
        ownerActions: turn.ownerActions || [],
        usage: turn.usage || null,
        error: turn.error || '',
      })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId: wb.activeId, sessions: compact }));
  } catch {
    // Session persistence is optional when storage quota is full.
  }
}

export function activeSession() {
  let found = wb.sessions.find((s) => s.id === wb.activeId);
  if (!found) {
    if (!wb.sessions.length) wb.sessions.push(makeSession(state.data?.agents?.[0]?.id || ''));
    found = wb.sessions[0];
    wb.activeId = found.id;
  }
  const agents = state.data?.agents || [];
  if (agents.length && (!found.agentId || !agents.some((a) => a.id === found.agentId))) {
    found.agentId = agents[0].id;
  }
  return found;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(Error(t('wb.err.imageTooLarge')));
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        name: file.name || 'image.png',
        mime: file.type || 'image/png',
        bytes: file.size,
        dataUrl: String(reader.result || ''),
      });
    reader.onerror = () => reject(Error(t('wb.err.imageRead')));
    reader.readAsDataURL(file);
  });
}

async function ensureProjectsLoaded(onLoaded) {
  if (!state.token || wb.projectsToken === state.token) return;
  const token = state.token;
  wb.projectsToken = token;
  try {
    const res = await api('GET', '/v1/projects', undefined, { token });
    if (token !== state.token) return;
    wb.projects = Array.isArray(res?.data) ? res.data : [];
    onLoaded();
  } catch {
    wb.projects = [];
  }
}

function activeStreamingTurn(session) {
  return (session.turns || []).find((turn) => turn.role === 'assistant' && turn.streaming);
}

export function renderWorkbench(parent) {
  const agents = state.data?.agents || [];
  if (!agents.length) {
    parent.replaceChildren(
      empty(t('wb.emptyAgents.title'), t('wb.emptyAgents.desc'), {
        icon: 'bot',
        page: true,
        action: button(t('common.publishAgent'), 'plus', () => hooks.openPublish?.(), 'primary'),
      }),
    );
    icons();
    return;
  }

  const root = el('div', undefined, 'workbench');
  const sidebar = el('aside', undefined, 'surface wb-sidebar');
  const main = el('section', undefined, 'surface wb-main');
  const header = el('header', undefined, 'wb-header');
  const messagesBox = el('div', undefined, 'wb-messages');
  const composer = el('form', undefined, 'wb-composer');
  main.append(header, messagesBox, composer);
  root.append(sidebar, main);
  parent.replaceChildren(root);

  const turnNodes = new Map();
  let lastHeaderKey = '';

  const renderSidebar = () =>
    renderWorkbenchSidebar({
      sidebar,
      wb,
      activeSession,
      makeSession,
      activeStreamingTurn,
      saveSessions,
      turnNodes,
      renderSidebar,
      renderHeader,
      syncMessages,
    });

  function syncMessages(scrollBottom = false) {
    const session = activeSession();
    const nearBottom =
      scrollBottom ||
      messagesBox.scrollTop + messagesBox.clientHeight >= messagesBox.scrollHeight - 60;
    if (!session.turns.length) {
      turnNodes.clear();
      const agent = agentById(session.agentId) || agents[0];
      const guide = el('div', undefined, 'wb-guide');
      guide.append(
        agentGlyph(agent.engine, 'large', agent.preset),
        el('strong', targetModelName(session.agentId, session.route)),
        el('p', t('wb.guide.desc', { mod: MOD }), 'muted'),
      );
      messagesBox.replaceChildren(guide);
      icons();
      return;
    }
    if (messagesBox.querySelector('.wb-guide')) messagesBox.replaceChildren();
    const validIds = new Set(session.turns.map((x) => x.id));
    for (const [id, node] of turnNodes) {
      if (!validIds.has(id)) {
        node.remove();
        turnNodes.delete(id);
      }
    }
    for (const turn of session.turns) {
      const existing = turnNodes.get(turn.id);
      if (
        existing &&
        existing.contains(document.activeElement) &&
        document.activeElement?.matches('textarea, input')
      ) {
        continue;
      }
      const fresh = renderTurnNode(session, turn, onTurnUpdated);
      if (existing && existing.parentElement === messagesBox) existing.replaceWith(fresh);
      else messagesBox.append(fresh);
      turnNodes.set(turn.id, fresh);
    }
    if (nearBottom) messagesBox.scrollTop = messagesBox.scrollHeight;
    icons();
  }

  function renderHeader() {
    const session = activeSession();
    const agent = agentById(session.agentId) || agents[0];
    const runningTurn = activeStreamingTurn(session);
    header.replaceChildren();

    const left = el('div', undefined, 'wb-header-title');
    left.append(
      agentGlyph(agent.engine, 'small', agent.preset),
      el('code', targetModelName(session.agentId, session.route), 'wb-call-target'),
      el('span', `tools: ${session.toolMode}`, 'tag'),
    );
    if (session.lastResponseId) {
      const contBadge = el('span', undefined, 'tag tide wb-cont-tag');
      contBadge.append(
        icon('corner-down-right'),
        el('span', t('wb.session.continuing', { id: session.lastResponseId.slice(0, 14) })),
      );
      const resetCont = el('button', '×', 'wb-tag-close');
      resetCont.type = 'button';
      resetCont.title = t('wb.session.resetChain');
      resetCont.setAttribute('aria-label', t('wb.session.resetChain'));
      resetCont.onclick = () => {
        session.lastResponseId = null;
        session.lastAgentId = null;
        session.lastRoute = null;
        saveSessions();
        renderHeader();
      };
      contBadge.append(resetCont);
      left.append(contBadge);
    }

    const actions = el('div', undefined, 'wb-header-actions');
    if (runningTurn) {
      actions.append(
        button(
          t('wb.action.stop'),
          'square',
          async () => {
            runningTurn.controller?.abort();
            if (runningTurn.runId) {
              await api(
                'POST',
                `/v1/responses/${encodeURIComponent(runningTurn.runId)}/cancel`,
                {},
              ).catch(() => {});
            }
          },
          'subtle small-btn',
        ),
      );
    }
    actions.append(
      button(
        t('wb.code.openBtn'),
        'code-2',
        () =>
          openWorkbenchCodeDialog({
            agentId: session.agentId,
            route: session.route,
            prompt:
              wb.draftText.trim() ||
              [...session.turns].reverse().find((x) => x.role === 'user')?.text ||
              '',
            images: wb.draftImages,
            toolMode: session.toolMode,
            clientTools: session.clientTools,
            project: session.project,
            recommend: session.recommend,
            previousResponseId: session.lastResponseId,
          }),
        'subtle small-btn',
      ),
      button(
        t('wb.session.clear'),
        'rotate-ccw',
        async () => {
          if (!session.turns.length && !session.lastResponseId) return;
          const ok = await confirmAction({
            title: t('wb.session.clearTitle'),
            message: t('wb.session.clearMsg'),
            accept: t('wb.session.clear'),
            danger: true,
          });
          if (!ok) return;
          activeStreamingTurn(session)?.controller?.abort();
          session.turns = [];
          session.title = '';
          session.lastResponseId = null;
          session.lastAgentId = null;
          session.lastRoute = null;
          turnNodes.clear();
          saveSessions();
          renderSidebar();
          renderHeader();
          syncMessages(true);
        },
        'subtle small-btn',
      ),
    );
    header.append(left, actions);
    icons();
  }

  const attachmentsBar = el('div', undefined, 'wb-attachments');
  const renderAttachments = () => {
    attachmentsBar.replaceChildren();
    attachmentsBar.hidden = !wb.draftImages.length;
    wb.draftImages.forEach((img, idx) => {
      const chip = el('div', undefined, 'wb-attachment-chip');
      const thumb = el('img', undefined, 'wb-attachment-thumb');
      thumb.src = img.dataUrl;
      thumb.alt = img.name;
      const removeBtn = el('button', '×', 'wb-tag-close');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', t('wb.composer.removeImage'));
      removeBtn.onclick = () => {
        wb.draftImages.splice(idx, 1);
        renderAttachments();
      };
      chip.append(thumb, el('span', img.name, 'wb-attachment-name'), removeBtn);
      attachmentsBar.append(chip);
    });
  };

  const textarea = el('textarea', undefined, 'wb-input');
  textarea.rows = 3;
  textarea.placeholder = t('wb.composer.placeholder');
  textarea.value = wb.draftText;
  textarea.oninput = () => {
    wb.draftText = textarea.value;
  };
  textarea.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      composer.requestSubmit();
    }
  };
  textarea.onpaste = async (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
    if (!items.length) return;
    e.preventDefault();
    for (const item of items) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        wb.draftImages.push(await readFileAsDataUrl(file));
      } catch (err) {
        toast(err.message);
      }
    }
    renderAttachments();
  };

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.onchange = async () => {
    for (const file of [...(fileInput.files || [])]) {
      try {
        wb.draftImages.push(await readFileAsDataUrl(file));
      } catch (err) {
        toast(err.message);
      }
    }
    fileInput.value = '';
    renderAttachments();
  };

  const composerFoot = el('div', undefined, 'wb-composer-foot');
  const leftTools = el('div', undefined, 'wb-composer-tools');
  leftTools.append(
    button(t('wb.composer.addImage'), 'image-plus', () => fileInput.click(), 'subtle small-btn'),
    el('span', t('wb.composer.shortcutHint', { mod: MOD }), 'muted wb-shortcut-hint'),
  );
  const sendBtn = button(t('wb.composer.send'), 'send-horizontal', () => {}, 'primary small-btn');
  sendBtn.type = 'submit';
  composerFoot.append(leftTools, sendBtn);
  composer.append(attachmentsBar, textarea, fileInput, composerFoot);

  function onTurnUpdated() {
    const session = activeSession();
    const running = activeStreamingTurn(session);
    sendBtn.disabled = !!running;
    const headerKey = `${running?.runId || ''}:${running?.status || ''}:${session.lastResponseId || ''}`;
    if (headerKey !== lastHeaderKey) {
      lastHeaderKey = headerKey;
      saveSessions();
      renderHeader();
      if (!sidebar.contains(document.activeElement)) renderSidebar();
    }
    syncMessages(false);
  }

  composer.onsubmit = async (e) => {
    e.preventDefault();
    const session = activeSession();
    if (activeStreamingTurn(session)) return;
    const promptText = wb.draftText.trim();
    const images = [...wb.draftImages];
    if (!promptText && !images.length) return;

    if (!session.title) session.title = (promptText || images[0]?.name || '').slice(0, 30);
    session.updatedAt = Date.now();
    wb.draftText = '';
    wb.draftImages = [];
    textarea.value = '';
    renderAttachments();

    const userTurn = {
      id: `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      role: 'user',
      text: promptText,
      images,
    };
    const assistantTurn = {
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      role: 'assistant',
      agentId: session.agentId,
      route: session.route,
      toolMode: session.toolMode,
      clientTools: JSON.parse(JSON.stringify(session.clientTools || [])),
      project: session.project,
      recommend: session.recommend,
      runId: '',
      status: 'in_progress',
      waitingOn: null,
      reasoning: '',
      text: '',
      steps: [],
      artifacts: [],
      callerCalls: [],
      ownerActions: [],
      usage: null,
      error: '',
      streaming: true,
    };
    session.turns.push(userTurn, assistantTurn);
    saveSessions();
    sendBtn.disabled = true;
    renderSidebar();
    renderHeader();
    syncMessages(true);

    await executeStreamingTurn({
      session,
      turn: assistantTurn,
      input: promptText,
      images,
      onUpdate: onTurnUpdated,
    });
  };

  renderAttachments();
  renderSidebar();
  renderHeader();
  syncMessages(true);
  void ensureProjectsLoaded(() => renderSidebar());
}
