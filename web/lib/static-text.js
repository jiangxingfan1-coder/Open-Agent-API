import { t } from './i18n.js';

// Fills the text of index.html from the message dictionaries. The page carries no copy of its
// own, and boot.js hides the body (html[data-i18n-pending]) until this has run, so there is
// no flash of empty labels. Markers:
//   data-i18n="key"                     text content
//   data-i18n-html="key"                markup from our own dictionary (<code> only)
//   data-i18n-attr="a,b:key;c:key2"     attributes a and b from key, c from key2
export function applyStaticText(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll('[data-i18n-html]'))
    node.innerHTML = t(node.dataset.i18nHtml);
  for (const node of root.querySelectorAll('[data-i18n-attr]'))
    for (const group of node.dataset.i18nAttr.split(';')) {
      const [names, key] = group.split(':');
      for (const name of names.split(',')) node.setAttribute(name.trim(), t(key.trim()));
    }
}

applyStaticText();
document.title = t('page.title');
delete document.documentElement.dataset.i18nPending;
