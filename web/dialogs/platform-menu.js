import { el, icon, icons } from '../lib/dom.js';

/* ── Inline "More" menu ───────────────────────────────────
   Each table row has one main action as a text button; the rest go into this menu, whose items carry
   an icon and text instead of a row of cryptic icon-only buttons.
   The menu is placed beside the button with position: fixed, so the table's horizontal scroll
   container cannot clip it; clicking elsewhere, pressing Esc or scrolling closes it, and focus then
   returns to the button that opened it.
   While the menu is open, the page's automatic refresh does not redraw the table (see renderView in views/shell.js). */
let current = null;
const closeCurrent = (refocus = false) => current?.close(refocus);
document.addEventListener('pointerdown', (e) => {
  if (current && !current.wrap.contains(e.target)) current.close();
});
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && current) {
      e.stopPropagation();
      current.close(true);
    }
  },
  true,
);
document.addEventListener('scroll', () => closeCurrent(), true);

// items: [{ label, icon, run, danger? }]
export function rowMenu(label, items) {
  const wrap = el('span', undefined, 'row-menu');
  const trigger = el('button', undefined, 'icon-button');
  trigger.type = 'button';
  trigger.title = label;
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.append(icon('ellipsis'));
  const list = el('div', undefined, 'row-menu-list');
  list.setAttribute('role', 'menu');
  list.hidden = true;
  const entries = items.map((item) => {
    const b = el('button', undefined, `row-menu-item${item.danger ? ' danger' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(icon(item.icon), el('span', item.label));
    b.onclick = (e) => {
      e.stopPropagation();
      handle.close(true);
      item.run();
    };
    list.append(b);
    return b;
  });
  const handle = {
    wrap,
    close(refocus = false) {
      if (list.hidden) return;
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (current === handle) current = null;
      if (refocus) trigger.focus();
    },
    open() {
      closeCurrent();
      list.hidden = false;
      const rect = trigger.getBoundingClientRect();
      const height = list.offsetHeight;
      const below = rect.bottom + height + 8 <= window.innerHeight;
      list.style.top = `${below ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
      list.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
      trigger.setAttribute('aria-expanded', 'true');
      current = handle;
      entries[0]?.focus({ preventScroll: true });
    },
  };
  trigger.onclick = (e) => {
    e.stopPropagation();
    if (list.hidden) {
      handle.open();
      icons();
    } else handle.close();
  };
  // Arrow-down on the button opens the menu; inside it the arrow keys cycle, Home / End jump to the ends, and Tab closes it.
  trigger.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' || !list.hidden) return;
    e.preventDefault();
    handle.open();
    icons();
  });
  list.addEventListener('keydown', (e) => {
    const at = entries.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      entries[(at + step + entries.length) % entries.length].focus({ preventScroll: true });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      entries[e.key === 'Home' ? 0 : entries.length - 1].focus({ preventScroll: true });
    } else if (e.key === 'Tab') handle.close();
  });
  wrap.append(trigger, list);
  return wrap;
}
