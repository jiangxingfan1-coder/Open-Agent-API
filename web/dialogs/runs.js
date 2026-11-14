import { hooks, state } from '../lib/state.js';
import { $, error, toast } from '../lib/dom.js';
import { load } from '../lib/live.js';

import { createRunInspector } from '../run-inspector.js';
import { t } from '../lib/i18n.js';

/* ── Dialogs ─────────────────────────────────────────── */
export const runInspector = createRunInspector({
  onChanged: () => {
    void load().catch((e) => error(e.message));
  },
  onClosed: () => {
    state.selectedRun = null;
  },
  onSelected: (id) => {
    state.selectedRun = id;
  },
  onContinue: ({ runId, agent }) => {
    const agents = state.data?.agents ?? [];
    const target = agents.find((a) => a.id === agent) ?? agents[0];
    if (!target) return toast(t('dlg.runs.no_agent'));
    state.continuation = { runId, agent };
    state.keepContinuation = true;
    $('run-dialog').close();
    hooks.showAgent(target);
  },
});
export async function showRun(id) {
  return runInspector.open(id);
}
