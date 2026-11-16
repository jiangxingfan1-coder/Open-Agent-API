import { api } from '../lib/api.js';
import { $, withBusy } from '../lib/dom.js';
import { state } from '../lib/state.js';
import { t } from '../lib/i18n.js';

const catalogs = new Map();
let token;
export function catalogFor(engine) {
  if (token !== state.token) {
    catalogs.clear();
    token = state.token;
  }
  return catalogs.get(engine) ?? state.backends?.find((b) => b.engine === engine)?.model_catalog;
}
export async function refreshModels(engine, render, force = false) {
  const currentToken = state.token;
  const before = catalogFor(engine);
  if (!force && before && before.expiresAt > Date.now()) {
    render();
    return;
  }
  $('model-source-status').textContent = t('models.loading');
  try {
    const catalog = await api(
      'GET',
      `/v1/local/backends/${encodeURIComponent(engine)}/models${force ? '?refresh=true' : ''}`,
    );
    if (currentToken !== state.token) return;
    catalogs.set(engine, catalog);
  } catch {
    if (currentToken !== state.token) return;
    catalogs.set(engine, {
      ...before,
      status: before?.models?.length ? 'stale' : 'unavailable',
      expiresAt: 0,
    });
  }
  if ($('native-engine').value === engine) render();
}
export function renderCatalogStatus(engine) {
  const catalog = catalogFor(engine);
  const labels = {
    ready: 'models.ready',
    stale: 'models.stale',
    unavailable: 'models.unavailable',
    unsupported: 'models.unsupported',
  };
  $('model-source-status').textContent = t(labels[catalog?.status] ?? 'models.unavailable', {
    count: catalog?.models?.length ?? 0,
  });
  if (catalog?.error === 'adapter_auth_required')
    $('model-source-status').textContent += ` · ${t('models.auth_required')}`;
  if (catalog?.truncated)
    $('model-source-status').textContent +=
      ` · ${t('models.truncated', { count: catalog.models.length })}`;
}
export function bindModelRefresh(render) {
  $('model-refresh').onclick = () =>
    withBusy($('model-refresh'), t('models.loading'), () =>
      refreshModels($('native-engine').value, render, true),
    );
}
