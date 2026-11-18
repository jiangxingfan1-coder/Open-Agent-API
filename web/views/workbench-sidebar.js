import { button, el, icon, iconButton, icons, toast } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { state } from '../lib/state.js';
import { agentById } from './common.js';
import { CLIENT_TOOL_TEMPLATES } from './workbench-code.js';

export function renderToolsDrawer({ wb, session, saveSessions, rerenderSidebar, rerenderHeader }) {
  const drawer = el('details', undefined, 'wb-tools-drawer');
  drawer.open = wb.drawerOpen;
  drawer.ontoggle = () => {
    wb.drawerOpen = drawer.open;
  };
  const summary = el('summary');
  summary.append(
    icon('wrench'),
    el('span', t('wb.tools.title')),
    el('span', String(session.clientTools.length), 'wb-count-pill'),
  );
  drawer.append(summary);

  const body = el('div', undefined, 'wb-tools-body');
  body.append(el('p', t('wb.tools.hint'), 'muted wb-small-note'));

  const tplBar = el('div', undefined, 'wb-template-bar');
  for (const tpl of CLIENT_TOOL_TEMPLATES) {
    const addTpl = el('button', `+ ${tpl.name}`, 'chip-choice route');
    addTpl.type = 'button';
    addTpl.translate = false;
    addTpl.title = tpl.description;
    addTpl.onclick = () => {
      const existing = session.clientTools.findIndex((item) => item.name === tpl.name);
      const copy = {
        name: tpl.name,
        description: tpl.description,
        parameters: JSON.parse(JSON.stringify(tpl.parameters)),
      };
      if (existing >= 0) session.clientTools[existing] = copy;
      else session.clientTools.push(copy);
      if (session.toolMode === 'auto') session.toolMode = 'bridge';
      wb.drawerOpen = true;
      saveSessions();
      rerenderSidebar();
      rerenderHeader();
      toast(t('wb.tools.templateAdded', { name: tpl.name }));
    };
    tplBar.append(addTpl);
  }
  body.append(tplBar);

  if (session.clientTools.length) {
    const list = el('div', undefined, 'wb-tool-list');
    session.clientTools.forEach((tool, idx) => {
      const row = el('div', undefined, 'wb-tool-item');
      const nameNode = el('code', tool.name);
      const actions = el('div', undefined, 'wb-tool-item-actions');
      actions.append(
        iconButton(t('wb.tools.edit'), 'pencil', () => {
          wb.editingToolIndex = idx;
          wb.toolNameDraft = tool.name;
          wb.toolDescDraft = tool.description || '';
          wb.toolSchemaDraft = JSON.stringify(tool.parameters || { type: 'object' }, null, 2);
          wb.toolFormError = '';
          wb.drawerOpen = true;
          rerenderSidebar();
        }),
        iconButton(t('wb.tools.remove'), 'trash-2', () => {
          session.clientTools.splice(idx, 1);
          if (wb.editingToolIndex === idx) wb.editingToolIndex = -1;
          saveSessions();
          rerenderSidebar();
          rerenderHeader();
        }),
      );
      row.append(nameNode, actions);
      list.append(row);
    });
    body.append(list);
  }

  const form = el('div', undefined, 'wb-tool-form');
  const nameField = el('label', undefined, 'field wb-compact-field');
  nameField.append(el('span', t('wb.tools.nameLabel')));
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'read_file_symbol';
  nameInput.translate = false;
  nameInput.value = wb.toolNameDraft;
  nameInput.oninput = () => {
    wb.toolNameDraft = nameInput.value;
  };
  nameField.append(nameInput);

  const descField = el('label', undefined, 'field wb-compact-field');
  descField.append(el('span', t('wb.tools.descLabel')));
  const descInput = el('input');
  descInput.type = 'text';
  descInput.placeholder = t('wb.tools.descPlaceholder');
  descInput.value = wb.toolDescDraft;
  descInput.oninput = () => {
    wb.toolDescDraft = descInput.value;
  };
  descField.append(descInput);

  const schemaField = el('label', undefined, 'field wb-compact-field');
  schemaField.append(el('span', t('wb.tools.schemaLabel')));
  const schemaInput = el('textarea', undefined, 'wb-schema-editor');
  schemaInput.rows = 4;
  schemaInput.spellcheck = false;
  schemaInput.translate = false;
  schemaInput.value = wb.toolSchemaDraft;
  schemaInput.oninput = () => {
    wb.toolSchemaDraft = schemaInput.value;
  };
  schemaField.append(schemaInput);

  const errEl = el('div', wb.toolFormError, 'form-error');
  const btnRow = el('div', undefined, 'wb-tool-form-actions');
  const resetDraft = () => {
    wb.editingToolIndex = -1;
    wb.toolNameDraft = '';
    wb.toolDescDraft = '';
    wb.toolSchemaDraft = '{\n  "type": "object",\n  "properties": {}\n}';
    wb.toolFormError = '';
  };
  const saveBtn = button(
    wb.editingToolIndex >= 0 ? t('wb.tools.updateBtn') : t('wb.tools.addBtn'),
    'plus',
    () => {
      const name = wb.toolNameDraft.trim();
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
        wb.toolFormError = t('wb.tools.invalidName');
        errEl.textContent = wb.toolFormError;
        return;
      }
      let schema;
      try {
        schema = JSON.parse(wb.toolSchemaDraft.trim() || '{"type":"object"}');
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error('object');
      } catch {
        wb.toolFormError = t('wb.tools.invalidSchema');
        errEl.textContent = wb.toolFormError;
        return;
      }
      const entry = { name, description: wb.toolDescDraft.trim(), parameters: schema };
      if (wb.editingToolIndex >= 0 && wb.editingToolIndex < session.clientTools.length) {
        session.clientTools[wb.editingToolIndex] = entry;
      } else {
        const dup = session.clientTools.findIndex((x) => x.name === name);
        if (dup >= 0) session.clientTools[dup] = entry;
        else session.clientTools.push(entry);
      }
      if (session.toolMode === 'auto') session.toolMode = 'bridge';
      resetDraft();
      saveSessions();
      rerenderSidebar();
      rerenderHeader();
    },
    'subtle small-btn',
  );
  btnRow.append(saveBtn);
  if (wb.editingToolIndex >= 0) {
    btnRow.append(
      button(
        t('common.cancel'),
        '',
        () => {
          resetDraft();
          rerenderSidebar();
        },
        'subtle small-btn',
      ),
    );
  }
  form.append(nameField, descField, schemaField, errEl, btnRow);
  body.append(form);
  drawer.append(body);
  return drawer;
}

export function renderWorkbenchSidebar({
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
}) {
  const agents = state.data?.agents || [];
  const session = activeSession();
  sidebar.replaceChildren();

  const sessHead = el('div', undefined, 'wb-section-head');
  sessHead.append(
    el('strong', t('wb.session.listTitle')),
    button(
      t('wb.session.new'),
      'plus',
      () => {
        const created = makeSession(session.agentId);
        wb.sessions.unshift(created);
        wb.activeId = created.id;
        turnNodes.clear();
        saveSessions();
        renderSidebar();
        renderHeader();
        syncMessages(true);
      },
      'subtle small-btn',
    ),
  );
  sidebar.append(sessHead);

  const sessList = el('div', undefined, 'wb-sessions');
  for (const item of wb.sessions) {
    const row = el('div', undefined, `wb-session-row${item.id === session.id ? ' active' : ''}`);
    const pickBtn = el('button', undefined, 'wb-session-pick');
    pickBtn.type = 'button';
    const titleText = item.title || t('wb.session.untitled');
    const userCount = (item.turns || []).filter((x) => x.role === 'user').length;
    pickBtn.append(
      el('span', titleText, 'wb-session-title'),
      el('small', `${item.agentId || agents[0].id} · ${t('wb.session.turns', { n: userCount })}`),
    );
    pickBtn.onclick = () => {
      if (wb.activeId === item.id) return;
      wb.activeId = item.id;
      turnNodes.clear();
      saveSessions();
      renderSidebar();
      renderHeader();
      syncMessages(true);
    };
    row.append(pickBtn);
    if (wb.sessions.length > 1) {
      row.append(
        iconButton(t('wb.session.delete'), 'x', () => {
          activeStreamingTurn(item)?.controller?.abort();
          wb.sessions = wb.sessions.filter((x) => x.id !== item.id);
          if (wb.activeId === item.id) wb.activeId = wb.sessions[0].id;
          turnNodes.clear();
          saveSessions();
          renderSidebar();
          renderHeader();
          syncMessages(true);
        }),
      );
    }
    sessList.append(row);
  }
  sidebar.append(sessList);

  const controls = el('div', undefined, 'wb-controls');
  const agentField = el('label', undefined, 'field wb-compact-field');
  agentField.append(el('span', t('wb.ctrl.agent')));
  const agentSelect = el('select');
  agentSelect.translate = false;
  for (const a of agents) agentSelect.add(new Option(a.id, a.id));
  agentSelect.value = session.agentId;
  agentSelect.onchange = () => {
    session.agentId = agentSelect.value;
    session.route = 'auto';
    saveSessions();
    renderSidebar();
    renderHeader();
    if (!session.turns.length) syncMessages();
  };
  agentField.append(agentSelect);

  const currentAgent = agentById(session.agentId) || agents[0];
  const routeField = el('label', undefined, 'field wb-compact-field');
  routeField.append(el('span', t('wb.ctrl.route')));
  const routeSelect = el('select');
  for (const [val, label] of [
    ['auto', t('wb.route.auto')],
    ['@fast', t('wb.route.fast')],
    ['@best', t('wb.route.best')],
    ['@eco', t('wb.route.eco')],
  ]) {
    routeSelect.add(new Option(label, val));
  }
  for (const r of currentAgent.routes || []) {
    routeSelect.add(new Option(`${r.id} / ${r.model}`, r.id));
  }
  if (![...routeSelect.options].some((o) => o.value === session.route)) session.route = 'auto';
  routeSelect.value = session.route;
  routeSelect.onchange = () => {
    session.route = routeSelect.value;
    saveSessions();
    renderHeader();
    if (!session.turns.length) syncMessages();
  };
  routeField.append(routeSelect);

  const recLabel = el('label', undefined, 'inline-check wb-check-row');
  const recCheck = el('input');
  recCheck.type = 'checkbox';
  recCheck.checked = !!session.recommend;
  recCheck.onchange = () => {
    session.recommend = recCheck.checked;
    saveSessions();
  };
  recLabel.append(recCheck, el('span', t('wb.ctrl.recommend')));

  const projField = el('label', undefined, 'field wb-compact-field');
  projField.append(el('span', t('wb.ctrl.project')));
  const projSelect = el('select');
  projSelect.add(new Option(t('project.none'), ''));
  for (const p of wb.projects) projSelect.add(new Option(p.name, p.id));
  projSelect.value = session.project || '';
  projSelect.onchange = () => {
    session.project = projSelect.value;
    saveSessions();
  };
  projField.append(projSelect);

  const modeField = el('label', undefined, 'field wb-compact-field');
  modeField.append(el('span', t('wb.ctrl.toolMode')));
  const modeSelect = el('select');
  for (const [val, label] of [
    ['auto', t('wb.toolMode.auto')],
    ['managed', t('wb.toolMode.managed')],
    ['bridge', t('wb.toolMode.bridge')],
    ['reject', t('wb.toolMode.reject')],
  ]) {
    modeSelect.add(new Option(label, val));
  }
  modeSelect.value = session.toolMode || 'auto';
  modeSelect.onchange = () => {
    session.toolMode = modeSelect.value;
    saveSessions();
    renderHeader();
  };
  modeField.append(modeSelect);

  controls.append(agentField, routeField, recLabel, projField, modeField);
  sidebar.append(
    controls,
    renderToolsDrawer({
      wb,
      session,
      saveSessions,
      rerenderSidebar: renderSidebar,
      rerenderHeader: renderHeader,
    }),
  );
  icons();
}
