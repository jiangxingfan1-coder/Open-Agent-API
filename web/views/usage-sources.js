import { api } from '../lib/api.js';
import { button, confirmAction, el, iconButton, toast, withBusy } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { hooks, state } from '../lib/state.js';

let draftToken;
let drafts = {};

export function renderUsageSources(body, data, refresh) {
  if (draftToken !== state.token) {
    draftToken = state.token;
    drafts = {};
  }
  const grid = el('div', undefined, 'usage-source-grid');
  for (const name of ['codexbar', 'ccusage']) {
    const title = name === 'codexbar' ? 'CodexBar' : 'ccusage',
      settings = drafts[name] ?? data.settings[name],
      source = data.sources[name];
    const card = el('section', undefined, 'usage-source-card'),
      head = el('div', undefined, 'usage-card-head');
    const link = el('a', title);
    link.href =
      name === 'codexbar'
        ? 'https://github.com/steipete/CodexBar'
        : 'https://github.com/ccusage/ccusage';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const statuses = {
      disabled: t('usage.disabled'),
      ready: t('usage.connected'),
      unavailable: t('usage.unavailable'),
      error: t('usage.collection_failed'),
    };
    head.append(
      link,
      el(
        'span',
        !data.settings[name].enabled && source.data ? t('usage.imported') : statuses[source.status],
        'muted',
      ),
    );
    card.append(head);
    const form = el('form', undefined, 'usage-source-form');
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.checked = settings.enabled;
    const toggle = el('label', undefined, 'usage-source-toggle');
    toggle.append(
      enabled,
      el('span', name === 'ccusage' ? t('usage.enable_history') : t('usage.enable_quota')),
    );
    form.append(toggle);
    const field = (label, control) => {
      const row = el('label');
      row.append(el('span', label), control);
      form.append(row);
      return control;
    };
    let mode, sourceMode, providers, cache;
    if (name === 'codexbar') {
      mode = el('select');
      for (const [value, label] of [
        ['cache', t('usage.shared_cache')],
        ['cli', t('usage.collector_cli')],
      ]) {
        const option = el('option', label);
        option.value = value;
        option.selected = value === settings.mode;
        mode.append(option);
      }
      field(t('usage.collection_mode'), mode);
      cache = el('input');
      cache.value = settings.file;
      cache.placeholder = data.quota_cache;
      field(t('usage.cache_file'), cache);
      providers = el('input');
      providers.value = settings.providers.join(', ');
      providers.placeholder = 'codex, antigravity, qoder';
      field(t('usage.providers'), providers);
      sourceMode = el('select');
      for (const value of ['cli', 'oauth', 'api']) {
        const option = el('option', value.toUpperCase());
        option.value = value;
        option.selected = value === settings.source;
        sourceMode.append(option);
      }
      field(t('usage.quota_source'), sourceMode);
    }
    const executable = el('input');
    executable.value = settings.executable;
    executable.placeholder = data.available[name] ?? t('usage.not_installed');
    field(t('usage.executable'), executable);
    const updateMode = () => {
      if (!mode) return;
      const cli = mode.value === 'cli';
      cache.closest('label').hidden = cli;
      providers.closest('label').hidden = !cli;
      sourceMode.closest('label').hidden = !cli;
      executable.closest('label').hidden = !cli;
    };
    if (mode) {
      mode.onchange = updateMode;
      updateMode();
    }
    const actions = el('div', undefined, 'usage-source-actions');
    const save = button(t('usage.save'), 'check', () => {}, 'primary');
    save.type = 'submit';
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    const upload = iconButton(t('usage.import_json'), 'upload', () => file.click());
    upload.type = 'button';
    file.onchange = async () => {
      const token = state.token;
      try {
        const selected = file.files?.[0];
        if (!selected) return;
        if (selected.size > 1_900_000) throw Error(t('usage.file_too_large'));
        const snapshot = JSON.parse(await selected.text());
        if (token !== state.token) return;
        await api('POST', '/v1/local/usage/import', { collector: name, snapshot });
        await refresh();
        toast(t('usage.imported'));
      } catch (e) {
        toast(e.message);
      } finally {
        file.value = '';
      }
    };
    const discard = iconButton(t('usage.discard'), 'undo-2', () => {
      delete drafts[name];
      hooks.renderView(true);
    });
    discard.type = 'button';
    actions.append(save, upload, discard, file);
    form.append(actions);
    const readForm = () => ({
      ...settings,
      enabled: enabled.checked,
      executable: executable.value.trim(),
      ...(name === 'codexbar'
        ? {
            mode: mode.value,
            file: cache.value.trim(),
            providers: providers.value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean),
            source: sourceMode.value,
          }
        : {}),
    });
    form.addEventListener('input', () => {
      drafts[name] = readForm();
    });
    form.addEventListener('change', () => {
      drafts[name] = readForm();
    });
    form.onsubmit = async (event) => {
      event.preventDefault();
      const token = state.token;
      const next = structuredClone(data.settings);
      next[name] = { ...settings, enabled: enabled.checked, executable: executable.value.trim() };
      if (name === 'codexbar')
        Object.assign(next.codexbar, {
          mode: mode.value,
          file: cache.value.trim(),
          providers: providers.value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          source: sourceMode.value,
        });
      if (
        next[name].enabled &&
        !(await confirmAction({
          title: t('usage.enable_title'),
          message:
            name === 'ccusage'
              ? t('usage.history_consent')
              : next.codexbar.mode === 'cli'
                ? t('usage.quota_consent')
                : t('usage.cache_consent'),
          accept: t('usage.save'),
        }))
      )
        return;
      if (token !== state.token) return;
      try {
        await withBusy(save, '', async () => {
          await api('POST', '/v1/local/usage/settings', {
            settings: next,
            revision: data.revision,
            confirmed: true,
          });
          delete drafts[name];
          await api('POST', '/v1/local/usage/refresh', {});
          await refresh();
        });
        toast(t('usage.saved'));
      } catch (e) {
        toast(e.message);
        await refresh();
        hooks.renderView(true);
      }
    };
    card.append(form, el('small', 'MIT', 'muted'));
    grid.append(card);
  }
  body.append(grid);
}
