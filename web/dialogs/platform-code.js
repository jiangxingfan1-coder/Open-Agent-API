import { el, icon, toast } from '../lib/dom.js';
import { snippetBlock } from './snippet.js';
import { api } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { creditsText, encode, parsePoints, refreshPlatform } from './platform-data.js';
import {
  KEEP_OPEN,
  field,
  formDialog,
  numberInput,
  segmented,
  selectInput,
  textInput,
} from './platform-dialog.js';

/* ── Redeem codes: generate (plaintext shown only once) and revoke ── */
export const CODE_KIND = { credit: t('dlg.code.kind.credit'), invite: t('dlg.code.kind.invite') };
const EXPIRY = [
  [0, t('dlg.code.exp.never')],
  [7, t('dlg.code.exp.7')],
  [30, t('dlg.code.exp.30')],
  [90, t('dlg.code.exp.90')],
  [365, t('dlg.code.exp.365')],
];
const integer = (text, label, min, max) => {
  const n = Number(String(text).trim());
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error(t('dlg.code.err.integer', { label, min, max }));
  return n;
};

export function openCodeDialog() {
  const kind = segmented(
    t('dlg.code.type_label'),
    [
      ['credit', t('dlg.code.kind.credit')],
      ['invite', t('dlg.code.kind.invite')],
    ],
    'credit',
    () => sync(),
  );
  const credits = numberInput({ value: 10, min: 0 });
  const creditsField = field(t('dlg.code.credits_per'), credits, t('dlg.code.credits_per_hint'));
  const uses = numberInput({ value: 1, min: 1, step: 1 });
  const count = numberInput({ value: 1, min: 1, step: 1 });
  const expiry = selectInput(EXPIRY, 0);
  const note = textInput({ max: 200, placeholder: t('dlg.code.note_ph') });
  const kindHint = el('small', undefined, 'muted');
  function sync() {
    const invite = kind.get() === 'invite';
    creditsField.hidden = invite;
    kindHint.textContent = invite ? t('dlg.code.hint_invite') : t('dlg.code.hint_credit');
  }
  const { ctx, open } = formDialog({
    title: t('dlg.code.title'),
    desc: t('dlg.code.desc'),
    wide: true,
    submit: t('dlg.code.submit'),
    symbol: 'ticket',
    busy: t('dlg.code.busy'),
    async onSubmit(dialog) {
      const invite = kind.get() === 'invite';
      const body = {
        kind: kind.get(),
        max_uses: integer(uses.value, t('dlg.code.uses'), 1, 1_000_000),
        count: integer(count.value, t('dlg.code.count'), 1, 100),
      };
      if (!invite) {
        const value = parsePoints(credits.value, t('dlg.code.credits'));
        if (!value) throw Error(t('dlg.code.err.no_credits'));
        body.credits = value;
      }
      const days = Number(expiry.value);
      if (days > 0) body.expires_at = Date.now() + days * 86_400_000;
      if (note.value.trim()) body.note = note.value.trim();
      const { data = [] } = await api('POST', '/v1/platform/codes', body);
      const codes = data.map((c) => c.code).filter(Boolean);
      showResult(dialog, codes, body);
      toast(t('dlg.code.generated_toast'));
      await refreshPlatform();
      return KEEP_OPEN;
    },
  });
  const grid = el('div', undefined, 'form-grid');
  grid.append(
    field(t('dlg.code.uses'), uses, t('dlg.code.uses_hint')),
    field(t('dlg.code.count'), count, t('dlg.code.count_hint')),
  );
  const second = el('div', undefined, 'form-grid');
  second.append(
    field(t('dlg.code.expiry'), expiry),
    field(t('dlg.code.note'), note, t('dlg.code.note_hint')),
  );
  const type = el('div', undefined, 'field');
  const pick = el('div');
  pick.append(kind.box);
  type.append(el('span', t('dlg.code.type')), pick, kindHint);
  ctx.body.append(type, creditsField, grid, second);
  sync();
  open();
  credits.focus();
}

function showResult(ctx, codes, request) {
  const text = codes.join('\n');
  const head = el('div', undefined, 'key-success');
  const mark = el('span', undefined, 'key-success-icon');
  mark.append(icon('circle-check'));
  const words = el('div');
  const one = codes.length === 1;
  const what =
    request.kind === 'invite'
      ? t(one ? 'dlg.code.made_invite_one' : 'dlg.code.made_invite', { n: codes.length })
      : t(one ? 'dlg.code.made_credit_one' : 'dlg.code.made_credit', {
          n: codes.length,
          credits: creditsText(request.credits),
        });
  words.append(el('strong', what), el('p', t('dlg.code.shown_once')));
  head.append(mark, words);
  const snippet = snippetBlock(
    t('dlg.code.snippet_title'),
    text,
    t(codes.length === 1 ? 'dlg.code.copied_one' : 'dlg.code.copied', { n: codes.length }),
  );
  const pre = snippet.querySelector('pre');
  ctx.setBody(head, snippet);
  ctx.finish(t('dlg.code.done'));
  // The plaintext lives only in this dialog: wipe the copy on the page once it closes.
  ctx.dlg.addEventListener('close', () => {
    pre.textContent = '';
  });
}

export async function revokeCode(code) {
  await api('DELETE', `/v1/platform/codes/${encode(code.id)}`);
  toast(t('dlg.code.revoked'));
  await refreshPlatform();
}
