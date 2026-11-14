import { copyButton, copyText, el } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

// A code block with a copy button: the button sits on its own row above the code, at the right (styles in
// components.css, .snippet), and never covers the code. Code does not wrap; if it is too wide it scrolls
// sideways. The title only tells screen readers what is being copied.
export function snippetBlock(title, code, message) {
  const box = el('div', undefined, 'snippet');
  box.append(
    copyButton(t('dlg.snippet.copy', { title }), () => copyText(code, message)),
    el('pre', code, 'code'),
  );
  return box;
}
