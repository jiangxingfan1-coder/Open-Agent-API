import { sessionApi } from '../lib/api.js';
import { state } from '../lib/state.js';
import { el, button, iconButton, icons, toast, withBusy, agentGlyph } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

export async function editWorkflow(record, saved) {
  let draft = structuredClone(
    record?.definition ?? {
      id: '',
      name: '',
      graph: { steps: [] },
      concurrency: 2,
      enabled: false,
      trigger: { kind: 'manual' },
    },
  );
  let selected = draft.graph.steps[0]?.id,
    plan = null,
    sequence = 0,
    timer;
  const argumentDrafts = new Map(),
    argumentErrors = new Map();
  const token = state.token,
    opener = document.activeElement;
  const api = sessionApi(token);
  const dialog = el('dialog', undefined, 'modal workflow-editor');
  const header = el('header', undefined, 'dialog-heading');
  header.append(
    el('h2', t('workflow.editor')),
    iconButton(t('common.close'), 'x', () => dialog.close()),
  );
  const body = el('div', undefined, 'workflow-body'),
    settings = el('div', undefined, 'workflow-settings');
  const field = (parent, label, value, type = 'text') => {
    const wrap = el('label', undefined, 'field'),
      input = el('input');
    input.type = type;
    input.value = value;
    wrap.append(el('span', label), input);
    parent.append(wrap);
    return input;
  };
  const id = field(settings, t('workflow.id'), draft.id),
    name = field(settings, t('project.name'), draft.name);
  id.disabled = !!record;
  id.maxLength = 120;
  name.maxLength = 200;
  const concurrency = field(settings, t('workflow.parallel'), draft.concurrency, 'number');
  concurrency.min = '1';
  concurrency.max = '4';
  const projectLabel = el('label', undefined, 'field'),
    project = el('select');
  project.add(new Option(t('project.none'), ''));
  projectLabel.append(el('span', t('project.selected')), project);
  settings.append(projectLabel);
  try {
    const list = await api('GET', '/v1/projects');
    for (const p of list.data) project.add(new Option(p.name, p.id));
    project.value = draft.project ?? '';
  } catch {
    /* Private workflows remain available. */
  }
  const triggerLabel = el('label', undefined, 'field'),
    trigger = el('select');
  const triggerNames = {
    manual: t('workflow.manual'),
    interval: t('workflow.interval'),
    event: t('workflow.event'),
  };
  for (const kind of Object.keys(triggerNames)) trigger.add(new Option(triggerNames[kind], kind));
  trigger.value = draft.trigger.kind;
  triggerLabel.append(el('span', t('workflow.trigger')), trigger);
  settings.append(triggerLabel);
  const minutes = field(settings, t('workflow.minutes'), draft.trigger.minutes ?? 60, 'number');
  minutes.min = '1';
  minutes.max = '10080';
  const sourceLabel = el('label', undefined, 'field'),
    source = el('select');
  for (const agent of state.data.agents) source.add(new Option(agent.id, agent.id));
  source.value = draft.trigger.agent ?? state.data.agents[0]?.id ?? '';
  sourceLabel.append(el('span', t('workflow.source')), source);
  settings.append(sourceLabel);
  const enabledLabel = el('label', undefined, 'inline-check'),
    enabled = el('input');
  enabled.type = 'checkbox';
  enabled.checked = draft.enabled;
  enabledLabel.append(enabled, el('span', t('workflow.enabled')));
  settings.append(enabledLabel);
  const updateTrigger = () => {
    minutes.closest('label').hidden = trigger.value !== 'interval';
    sourceLabel.hidden = trigger.value !== 'event';
    enabledLabel.hidden = trigger.value === 'manual';
  };
  trigger.onchange = updateTrigger;
  updateTrigger();
  const toolbar = el('div', undefined, 'view-toolbar');
  const diagram = el('div', undefined, 'workflow-diagram'),
    properties = el('div', undefined, 'workflow-properties'),
    workspace = el('div', undefined, 'workflow-workspace');
  workspace.append(diagram, properties);
  const error = el('p', undefined, 'form-error');
  error.setAttribute('role', 'alert');
  const collect = () => {
    draft.id = id.value;
    draft.name = name.value;
    draft.concurrency = Number(concurrency.value);
    if (project.value) draft.project = project.value;
    else delete draft.project;
    draft.enabled = trigger.value !== 'manual' && enabled.checked;
    draft.trigger =
      trigger.value === 'interval'
        ? { kind: 'interval', minutes: Number(minutes.value), input: draft.trigger.input ?? {} }
        : trigger.value === 'event'
          ? {
              kind: 'event',
              agent: source.value,
              ...(draft.trigger.subject ? { subject: draft.trigger.subject } : {}),
            }
          : { kind: 'manual' };
    return structuredClone(draft);
  };
  const validate = () => {
    clearTimeout(timer);
    const current = ++sequence;
    if (argumentErrors.size) return;
    timer = setTimeout(async () => {
      try {
        const value = await api('POST', '/v1/workflows/validate', { definition: collect() });
        if (current !== sequence || !dialog.open) return;
        plan = value.plan;
        error.textContent = '';
        draw();
      } catch (e) {
        if (current === sequence && dialog.open) error.textContent = e.message;
      }
    }, 250);
  };
  const draw = () => {
    diagram.replaceChildren();
    const layers = plan?.layers ?? draft.graph.steps.map((s) => [s.id]);
    const canvas = el('div', undefined, 'workflow-canvas'),
      nodes = new Map();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('workflow-edges');
    svg.setAttribute('aria-hidden', 'true');
    const defs = document.createElementNS(svg.namespaceURI, 'defs'),
      marker = document.createElementNS(svg.namespaceURI, 'marker'),
      arrow = document.createElementNS(svg.namespaceURI, 'path');
    marker.id = 'workflow-arrowhead';
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto');
    arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 Z');
    marker.append(arrow);
    defs.append(marker);
    svg.append(defs);
    const row = el('div', undefined, 'workflow-layers');
    for (const layer of layers) {
      const column = el('div', undefined, 'workflow-layer');
      for (const key of layer) {
        const step = draft.graph.steps.find((s) => s.id === key);
        if (!step) continue;
        const node = el('button', undefined, `workflow-node${selected === key ? ' selected' : ''}`);
        node.type = 'button';
        const agent = state.data.agents.find((a) => a.id === step.tool);
        node.append(
          agentGlyph(agent?.engine ?? '', 'small'),
          el('strong', key),
          el('small', step.tool),
          el('small', (step.depends_on ?? []).join(' + ')),
        );
        node.onclick = () => {
          selected = key;
          draw();
          editNode();
        };
        nodes.set(key, node);
        column.append(node);
      }
      row.append(column);
    }
    canvas.append(svg, row);
    diagram.append(canvas);
    requestAnimationFrame(() => {
      if (!canvas.isConnected) return;
      svg.setAttribute('width', String(canvas.scrollWidth));
      svg.setAttribute('height', String(canvas.scrollHeight));
      const origin = canvas.getBoundingClientRect();
      for (const step of plan?.steps ?? draft.graph.steps)
        for (const dependency of step.depends_on ?? []) {
          const from = nodes.get(dependency)?.getBoundingClientRect(),
            to = nodes.get(step.id)?.getBoundingClientRect();
          if (!from || !to) continue;
          const x1 = from.right - origin.left,
            y1 = from.top + from.height / 2 - origin.top,
            x2 = to.left - origin.left - 3,
            y2 = to.top + to.height / 2 - origin.top;
          const edge = document.createElementNS(svg.namespaceURI, 'path');
          edge.setAttribute('d', `M ${x1} ${y1} C ${x1 + 16} ${y1}, ${x2 - 16} ${y2}, ${x2} ${y2}`);
          edge.classList.add('workflow-edge');
          edge.setAttribute('marker-end', 'url(#workflow-arrowhead)');
          svg.append(edge);
        }
    });
    icons();
  };
  const editNode = () => {
    properties.replaceChildren();
    const step = draft.graph.steps.find((s) => s.id === selected);
    if (!step) return;
    properties.append(el('h3', step.id));
    const agentLabel = el('label', undefined, 'field'),
      agentSelect = el('select');
    for (const agent of state.data.agents) agentSelect.add(new Option(agent.id, agent.id));
    agentSelect.value = step.tool;
    agentLabel.append(el('span', t('workflow.agent')), agentSelect);
    properties.append(agentLabel);
    const modelLabel = el('label', undefined, 'field'),
      model = el('select');
    modelLabel.append(el('span', t('evaluation.model')), model);
    properties.append(modelLabel);
    const models = () => {
      model.replaceChildren(new Option(t('dlg.agent.model.auto'), 'auto'));
      for (const route of state.data.agents.find((a) => a.id === step.tool)?.routes ?? [])
        model.add(new Option(route.model, route.id));
      model.value = step.arguments.model ?? 'auto';
    };
    models();
    agentSelect.onchange = () => {
      step.tool = agentSelect.value;
      step.arguments.model = 'auto';
      models();
      args.value = JSON.stringify(step.arguments, null, 2);
      args.oninput();
      validate();
      draw();
    };
    model.onchange = () => {
      step.arguments.model = model.value;
      args.value = JSON.stringify(step.arguments, null, 2);
      args.oninput();
      validate();
    };
    const argsLabel = el('label', undefined, 'field'),
      args = el('textarea');
    args.rows = 8;
    args.value = argumentDrafts.get(step.id) ?? JSON.stringify(step.arguments, null, 2);
    args.spellcheck = false;
    argsLabel.append(el('span', t('workflow.arguments')), args);
    properties.append(argsLabel);
    args.oninput = () => {
      argumentDrafts.set(step.id, args.value);
      try {
        const value = JSON.parse(args.value);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw Error(t('workflow.arguments_object'));
        step.arguments = value;
        argumentErrors.delete(step.id);
        save.disabled = argumentErrors.size > 0;
        validate();
      } catch (e) {
        argumentErrors.set(step.id, e.message);
        save.disabled = true;
        error.textContent = e.message;
        validate();
      }
    };
    const dependencies = el('fieldset');
    dependencies.append(el('legend', t('workflow.dependencies')));
    for (const other of draft.graph.steps.filter((s) => s.id !== step.id)) {
      const label = el('label', undefined, 'inline-check'),
        input = el('input');
      input.type = 'checkbox';
      input.checked = (step.depends_on ?? []).includes(other.id);
      label.append(input, el('span', other.id));
      input.onchange = () => {
        step.depends_on = input.checked
          ? [...new Set([...(step.depends_on ?? []), other.id])]
          : (step.depends_on ?? []).filter((id) => id !== other.id);
        validate();
      };
      dependencies.append(label);
    }
    properties.append(
      dependencies,
      button(t('workflow.remove_node'), 'trash-2', () => {
        argumentDrafts.delete(selected);
        argumentErrors.delete(selected);
        save.disabled = argumentErrors.size > 0;
        draft.graph.steps = draft.graph.steps.filter((s) => s.id !== selected);
        for (const s of draft.graph.steps)
          s.depends_on = (s.depends_on ?? []).filter((x) => x !== selected);
        selected = draft.graph.steps[0]?.id;
        plan = null;
        draw();
        editNode();
        validate();
      }),
    );
    icons();
  };
  toolbar.append(
    button(t('workflow.add_node'), 'plus', () => {
      let n = 1;
      while (draft.graph.steps.some((s) => s.id === `step_${n}`)) n++;
      const previous = draft.graph.steps.at(-1);
      const step = {
        id: `step_${n}`,
        tool: state.data.agents[0]?.id ?? '',
        arguments: {
          input: previous
            ? { $ref: `${previous.id}#/output` }
            : { $ref: 'input#/task', $default: '' },
        },
        depends_on: previous ? [previous.id] : [],
      };
      draft.graph.steps.push(step);
      selected = step.id;
      plan = null;
      draw();
      editNode();
      validate();
    }),
  );
  const jsonButton = button(t('workflow.json'), 'braces', () => {
    const raw = el('textarea');
    raw.rows = 18;
    raw.value = JSON.stringify(collect(), null, 2);
    raw.spellcheck = false;
    const apply = button(t('workflow.apply'), 'check', () => {
      try {
        draft = JSON.parse(raw.value);
        argumentDrafts.clear();
        argumentErrors.clear();
        if (record) draft.id = record.definition.id;
        id.value = draft.id;
        name.value = draft.name;
        concurrency.value = draft.concurrency ?? 2;
        trigger.value = draft.trigger?.kind ?? 'manual';
        enabled.checked = !!draft.enabled;
        project.value = draft.project ?? '';
        minutes.value = draft.trigger?.minutes ?? 60;
        source.value = draft.trigger?.agent ?? source.value;
        updateTrigger();
        selected = draft.graph.steps[0]?.id;
        plan = null;
        draw();
        editNode();
        raw.remove();
        apply.remove();
        workspace.hidden = false;
        toolbar.inert = false;
        save.disabled = false;
        validate();
      } catch (e) {
        error.textContent = e.message;
      }
    });
    workspace.hidden = true;
    toolbar.inert = true;
    save.disabled = true;
    body.append(raw, apply);
    icons();
  });
  toolbar.append(jsonButton);
  toolbar.append(
    button(t('workflow.natural'), 'wand-sparkles', () => {
      const prompt = el('textarea');
      prompt.rows = 3;
      const planner = el('select');
      for (const a of state.data.agents) planner.add(new Option(a.id, a.id));
      const generate = button(t('workflow.generate'), 'wand-sparkles', async () => {
        save.disabled = true;
        toolbar.inert = true;
        settings.inert = true;
        try {
          await withBusy(generate, '', async () => {
            const result = await api('POST', '/v1/workflows/draft', {
              agent: planner.value,
              request: prompt.value,
            });
            if (!dialog.open || token !== state.token) return;
            draft = result.definition;
            argumentDrafts.clear();
            argumentErrors.clear();
            if (record) draft.id = record.definition.id;
            id.value = draft.id;
            name.value = draft.name;
            concurrency.value = draft.concurrency;
            project.value = draft.project ?? '';
            selected = draft.graph.steps[0]?.id;
            plan = result.plan;
            trigger.value = 'manual';
            enabled.checked = false;
            updateTrigger();
            draw();
            editNode();
            prompt.remove();
            planner.remove();
            generate.remove();
          });
        } catch (e) {
          error.textContent = e.message;
        } finally {
          save.disabled = argumentErrors.size > 0;
          toolbar.inert = false;
          settings.inert = false;
        }
      });
      body.prepend(prompt, planner, generate);
      icons();
    }),
  );
  const save = button(
    t('evaluation.save'),
    'check',
    async () => {
      if (argumentErrors.size) {
        error.textContent = [...argumentErrors.values()][0];
        return;
      }
      try {
        await withBusy(save, '', async () => {
          const result = await api('POST', '/v1/workflows', {
            definition: collect(),
            revision: record?.revision ?? 'new',
          });
          if (token !== state.token) return;
          dialog.close();
          await saved(result);
        });
      } catch (e) {
        error.textContent = e.message;
      }
    },
    'primary',
  );
  const footer = el('footer', undefined, 'dialog-actions');
  footer.append(error, save);
  body.append(settings, toolbar, workspace);
  dialog.append(header, body, footer);
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener(
    'close',
    () => {
      clearTimeout(timer);
      dialog.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  for (const input of [id, name, concurrency, project, trigger, minutes, source, enabled])
    input.addEventListener('change', validate);
  draw();
  editNode();
  if (draft.graph.steps.length) validate();
  icons();
}
