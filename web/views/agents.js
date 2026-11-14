import { isAdmin, state } from '../lib/state.js';
import { t } from '../lib/i18n.js';
import { engineKind, engineName } from '../lib/format.js';
import { agentGlyph, button, copyText, el, empty, icon, iconButton, status } from '../lib/dom.js';
import { activityAvailable, activityWindow } from '../lib/live.js';
import { agentHealth, filterText, setCount } from './common.js';
import { openKeyDialog } from '../dialogs/key.js';
import { openPublish } from '../dialogs/publish.js';
import { AUTO_APPROVE_HINT, conversionBadge, showAgent } from '../dialogs/agent.js';
import { WINDOW_LABEL } from './overview.js';

export function renderAgents(body) {
  const filter = filterText();
  const data = state.data.agents.filter((a) =>
    `${a.id} ${a.engine} ${engineName(a.engine)} ${a.description}`.toLowerCase().includes(filter),
  );
  setCount(t('agents.count', { n: data.length }));
  if (!data.length) {
    body.append(
      state.data.agents.length
        ? empty(t('agents.noMatch'), t('common.tryKeyword'), { icon: 'search' })
        : empty(t('agents.none'), t('agents.noneHint'), {
            icon: 'bot',
            action: isAdmin()
              ? button(t('common.publishAgent'), 'plus', openPublish, 'primary')
              : undefined,
          }),
    );
    return;
  }
  const grid = el('div', undefined, 'card-grid');
  const showActivity = activityAvailable();
  for (const a of data) {
    // A div (not a button) so the footer can hold its own button without nesting controls.
    // The whole card opens the sheet; the only separate action is creating a key, kept quiet in
    // the footer.
    const card = el('div', undefined, 'agent-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', t('agents.aria', { id: a.id }));
    card.onclick = () => showAgent(a);
    card.onkeydown = (e) => {
      if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        showAgent(a);
      }
    };
    const head = el('div', undefined, 'agent-head');
    const names = el('div', undefined, 'agent-names');
    const nameRow = el('div', undefined, 'agent-name-row');
    const name = el('span', a.id, 'agent-name');
    name.translate = false;
    name.title = a.id;
    const copyId = iconButton(t('html.agent.copyCallName'), 'copy', () =>
      copyText(a.id, t('agents.copied', { id: a.id })),
    );
    copyId.classList.add('agent-copy');
    nameRow.append(name, copyId);
    names.append(
      nameRow,
      el('span', `${engineName(a.engine)} · ${engineKind(a.engine)}`, 'agent-engine'),
    );
    head.append(agentGlyph(a.engine, '', a.preset), names);

    const desc = el(
      'p',
      a.description || t('agents.noDescription'),
      `agent-desc${a.description ? '' : ' is-empty'}`,
    );
    if (a.description) desc.title = a.description;

    // Model routes: one line of mono tags; those that do not fit fold into +N, with the full
    // list in the hover tooltip.
    const models = el('div', undefined, 'agent-models');
    a.routes.slice(0, 2).forEach((r) => models.append(el('span', r.model, 'tag')));
    if (a.routes.length > 2) {
      const more = el('span', `+${a.routes.length - 2}`, 'tag');
      more.title = a.routes.map((r) => r.model).join(t('common.listSeparator'));
      models.append(more);
    }

    // Integration level, number of tools and skills, auto-approval: text only, no colour blocks.
    const fine = el('div', undefined, 'agent-fine');
    const facts = el('div', undefined, 'agent-facts');
    const tier = conversionBadge(a.conversion);
    if (tier) {
      tier.className = 'fact';
      facts.append(tier);
    }
    // Built-in agents: which configured model provider the first route uses, and whether its key
    // resolves in the gateway process (only a missing key needs a person, so only that is marked).
    const provider =
      a.engine === 'kernel'
        ? (state.providers ?? []).find((p) => p.name === a.routes[0]?.provider)
        : undefined;
    if (provider) {
      const fact = el(
        'span',
        t(provider.key_ready ? 'agents.provider' : 'agents.providerNoKey', { name: provider.name }),
        provider.key_ready ? 'fact' : 'fact text-attention',
      );
      fact.translate = false;
      fact.title = provider.key_ready
        ? `${provider.kind} · ${provider.base_url}`
        : t('agents.providerNoKeyHint', { ref: provider.key.ref ?? '' });
      facts.append(fact);
    }
    if (a.tools.length) facts.append(el('span', t('agents.tools', { n: a.tools.length }), 'fact'));
    if (a.skills.length)
      facts.append(el('span', t('agents.skills', { n: a.skills.length }), 'fact'));
    if (a.approvals === 'auto') {
      const auto = el('span', t('agents.autoApprove'), 'fact strong');
      auto.title = AUTO_APPROVE_HINT;
      facts.append(auto);
    }
    fine.append(facts);
    if (showActivity) {
      const health = agentHealth(a.id);
      const line = el('div', undefined, 'agent-stats');
      line.append(
        icon('activity'),
        el('span', `${WINDOW_LABEL[activityWindow()]} · ${health || t('agents.noTasks')}`),
      );
      fine.append(line);
    }

    const foot = el('div', undefined, 'agent-foot');
    foot.append(status(a.status ?? (a.ready ? 'ready' : 'unavailable')));
    if (isAdmin())
      foot.append(
        button(
          t('common.generateKey'),
          'key-round',
          () => openKeyDialog({ agents: [a.id] }),
          'agent-key',
        ),
      );
    card.append(head, desc, models, fine, foot);
    grid.append(card);
  }
  body.append(grid);
}
