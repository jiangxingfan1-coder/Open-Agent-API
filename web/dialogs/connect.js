import { hooks, prefs, savePrefs, state } from '../lib/state.js';
import { VIEWS } from '../lib/format.js';
import { $, confirmAction, error, openDialog, toast, withBusy } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { load, resetWorkspace, startEvents } from '../lib/live.js';
import { runInspector } from './runs.js';
import { platform, tabId } from './platform-data.js';
import { t } from '../lib/i18n.js';

/* ── Connection ──────────────────────────────────────── */
$('live-status').onclick = () => openDialog('connection-dialog');
$('connection-form').onsubmit = async (e) => {
  e.preventDefault();
  const submit = $('connection-form').querySelector('[type=submit]');
  await withBusy(submit, t('dlg.connect.connecting'), async () => {
    const old = state.token;
    state.token = $('api-key').value.trim();
    try {
      const overview = await api('GET', '/v1/overview');
      runInspector.reset();
      resetWorkspace();
      state.data = overview;
      sessionStorage.setItem('oaa-token', state.token);
      $('api-key').value = '';
      $('connection-dialog').close();
      const landing = VIEWS[prefs.landing] ? prefs.landing : 'overview';
      if (location.hash !== `#${landing}`) location.hash = landing;
      state.view = landing;
      hooks.render();
      void startEvents();
      toast(t('dlg.connect.connected'));
    } catch (err) {
      state.token = old;
      toast(err.message);
    }
  });
};
$('token-file').onchange = async (e) => {
  if (e.target.files[0]) $('api-key').value = (await e.target.files[0].text()).trim();
};
export function disconnect() {
  runInspector.reset();
  sessionStorage.removeItem('oaa-token');
  state.token = '';
  $('api-key').value = '';
  resetWorkspace();
  if ($('connection-dialog').open) $('connection-dialog').close();
  hooks.render();
}
$('disconnect').onclick = async () => {
  if (
    await confirmAction({
      title: t('dlg.connect.disconnect_title'),
      message: t('dlg.connect.disconnect_message'),
      accept: t('dlg.connect.disconnect_accept'),
      danger: true,
    })
  )
    disconnect();
};
$('refresh').onclick = () => load().catch((e) => error(e.message));
$('collapse-sidebar').onclick = () => savePrefs({ sidebar: 'collapsed' });
$('expand-sidebar').onclick = () => savePrefs({ sidebar: 'expanded' });
window.onhashchange = () => {
  // The address looks like #view or #view/subpage (only the developer platform uses it so far: #platform/accounts).
  const [v, sub] = location.hash.slice(1).split('/');
  state.view = VIEWS[v] ? v : VIEWS[prefs.landing] ? prefs.landing : 'overview';
  if (state.view === 'platform') platform.tab = tabId(sub);
  hooks.render();
  if (state.token)
    load().catch((e) => {
      error(e.message);
      if (!state.data) openDialog('connection-dialog');
    });
};
