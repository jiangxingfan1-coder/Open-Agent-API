// Documentation site enhancements. The site is fully readable without this script: it adds search, copy buttons
// for code blocks and the highlight of the current section in the "on this page" list. No network access.
(() => {
  'use strict';
  const doc = document;
  const body = doc.body;
  const lang = body.dataset.lang || 'en';

  // ── Search ────────────────────────────────────────────────
  const form = doc.querySelector('.docs-search');
  const input = form && form.querySelector('input');
  const list = form && form.querySelector('.search-results');
  const status = form && form.querySelector('[role="status"]');
  let entries = null;
  let loading = null;
  let active = -1;
  let shown = [];

  const load = () => {
    if (!loading) {
      loading = new Promise((resolve) => {
        const s = doc.createElement('script');
        s.src = body.dataset.index;
        s.onload = () => {
          const raw = (window.__OAA_DOCS_INDEX__ || {})[lang] || [];
          entries = raw.map((e) => ({
            url: e[0],
            page: e[1],
            head: e[2],
            text: e[3],
            hl: e[2].toLowerCase(),
            pl: e[1].toLowerCase(),
            tl: e[3].toLowerCase(),
            kl: e[4].toLowerCase(),
          }));
          resolve();
        };
        s.onerror = () => {
          entries = [];
          resolve();
        };
        doc.head.appendChild(s);
      });
    }
    return loading;
  };

  const wordStart = (hay, i) => i === 0 || !/[a-z0-9]/.test(hay[i - 1]);

  const score = (e, terms) => {
    let total = 0;
    for (const t of terms) {
      let s = 0;
      let i = e.hl.indexOf(t);
      if (i >= 0) s += 10 + (wordStart(e.hl, i) ? 6 : 0) + (e.hl === t ? 10 : 0);
      i = e.pl.indexOf(t);
      if (i >= 0) s += 5 + (wordStart(e.pl, i) ? 3 : 0);
      // A word of the section's own text outranks one that only the keyword list (the rest of the section) holds.
      i = e.tl.indexOf(t);
      if (i >= 0) s += 6 + (wordStart(e.tl, i) ? 2 : 0);
      i = e.kl.indexOf(t);
      if (i >= 0) s += (' ' + e.kl + ' ').includes(' ' + t + ' ') ? 6 : 3;
      if (s === 0) return 0;
      total += s;
    }
    return total;
  };

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Appends `text` to `el` with every term wrapped in <mark> (DOM nodes only, no HTML parsing). */
  const highlightInto = (el, text, terms) => {
    if (!terms.length) {
      el.textContent = text;
      return;
    }
    const re = new RegExp('(' + terms.map(escapeRe).join('|') + ')', 'ig');
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) el.append(text.slice(last, m.index));
      const mark = doc.createElement('mark');
      mark.textContent = m[0];
      el.append(mark);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.append(text.slice(last));
  };

  const snippet = (text, terms) => {
    const low = text.toLowerCase();
    let at = -1;
    for (const t of terms) {
      const i = low.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0 || at < 60) return text.length > 150 ? text.slice(0, 150) + '…' : text;
    const start = Math.max(0, at - 40);
    return '…' + text.slice(start, start + 150) + (start + 150 < text.length ? '…' : '');
  };

  const setActive = (i) => {
    active = i;
    shown.forEach((li, n) => li.setAttribute('aria-selected', n === i ? 'true' : 'false'));
    if (i >= 0 && shown[i]) {
      input.setAttribute('aria-activedescendant', shown[i].id);
      shown[i].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const render = (terms, results) => {
    list.textContent = '';
    shown = [];
    if (!results.length) {
      const li = doc.createElement('li');
      li.className = 'r-empty';
      li.textContent = body.dataset.noResults || 'No results';
      list.append(li);
      status.textContent = body.dataset.noResults || 'No results';
    } else {
      results.forEach((e, n) => {
        const li = doc.createElement('li');
        li.id = 'docs-opt-' + n;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        const a = doc.createElement('a');
        a.href = e.url;
        const head = doc.createElement('span');
        head.className = 'r-head';
        highlightInto(head, e.head || e.page, terms);
        a.append(head);
        if (e.head) {
          const page = doc.createElement('span');
          page.className = 'r-page';
          page.textContent = e.page;
          a.append(page);
        }
        if (e.text) {
          const text = doc.createElement('span');
          text.className = 'r-text';
          highlightInto(text, snippet(e.text, terms), terms);
          a.append(text);
        }
        li.append(a);
        list.append(li);
        shown.push(li);
      });
      status.textContent =
        results.length +
        (lang.startsWith('zh') ? ' 条结果' : results.length === 1 ? ' result' : ' results');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  };

  const run = async () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      close();
      status.textContent = '';
      return;
    }
    await load();
    if (input.value.trim().toLowerCase() !== q) return; // the user kept typing
    const terms = q.split(/\s+/).filter(Boolean);
    const results = entries
      .map((e, i) => ({ e, i, s: score(e, terms) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, 10)
      .map((r) => r.e);
    render(terms, results);
  };

  if (form && input && list && status) {
    form.hidden = false;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const target = shown[active] || shown[0];
      const link = target && target.querySelector('a');
      if (link) location.href = link.href;
    });
    input.addEventListener('focus', load, { once: true });
    input.addEventListener('input', run);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' && shown.length) {
        ev.preventDefault();
        setActive((active + 1) % shown.length);
      } else if (ev.key === 'ArrowUp' && shown.length) {
        ev.preventDefault();
        setActive((active - 1 + shown.length) % shown.length);
      } else if (ev.key === 'Escape') {
        if (!list.hidden) close();
        else input.value = '';
      }
    });
    list.addEventListener('mousedown', (ev) => ev.preventDefault());
    doc.addEventListener('click', (ev) => {
      if (!form.contains(ev.target)) close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    doc.addEventListener('keydown', (ev) => {
      if (
        ev.key === '/' &&
        !ev.metaKey &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !/^(input|textarea|select)$/i.test(ev.target.tagName) &&
        !ev.target.isContentEditable
      ) {
        ev.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  // ── Copy buttons ──────────────────────────────────────────
  const label = body.dataset.copy || 'Copy';
  const done = body.dataset.copied || 'Copied';
  doc.querySelectorAll('.code-block').forEach((block) => {
    const pre = block.querySelector('pre');
    if (!pre || pre.classList.contains('mermaid')) return;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      const text = pre.innerText.replace(/\n$/, '');
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const area = doc.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        doc.body.append(area);
        area.select();
        try {
          doc.execCommand('copy');
        } catch {
          /* nothing else to try */
        }
        area.remove();
      }
      btn.textContent = done;
      setTimeout(() => (btn.textContent = label), 1500);
    });
    block.append(btn);
  });

  // ── Current section in "on this page" ─────────────────────
  const tocLinks = [...doc.querySelectorAll('.docs-toc a[href^="#"]')];
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map(
      tocLinks.map((a) => [decodeURIComponent(a.getAttribute('href').slice(1)), a]),
    );
    const mark = (id) => {
      for (const a of tocLinks) a.removeAttribute('aria-current');
      const a = byId.get(id);
      if (a) a.setAttribute('aria-current', 'true');
    };
    const seen = new Set();
    const observer = new IntersectionObserver(
      (items) => {
        for (const it of items)
          it.isIntersecting ? seen.add(it.target.id) : seen.delete(it.target.id);
        const first = [...byId.keys()].find((id) => seen.has(id));
        if (first) mark(first);
      },
      { rootMargin: '-80px 0px -65% 0px' },
    );
    for (const id of byId.keys()) {
      const h = doc.getElementById(id);
      if (h) observer.observe(h);
    }
  }
})();
