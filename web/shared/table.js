// Column model for data tables, shared by the console (lib/dom.js) and the portal (portal/dom.js).
// A table is described by its columns. Column: { text, align?, width?, min?, truncate? }
//   align  'start' (default) | 'num' | 'actions'. 'num' right-aligns tabular figures in the body
//          font; 'actions' right-aligns row buttons or links and never wraps them.
//   width  fixed width in px, cell padding included. Give one to every num / actions / status /
//          date column. A column without `width` is flexible: flexible columns share what is left.
//   min    smallest px width of a flexible column (default FLEX_MIN).
//   truncate  true keeps the column's cells on one line, cut off with an ellipsis; the full text
//          goes to each cell's `title` (unless the cell already has one). For long identifiers
//          (model names, agent ids, node ids) so a row never grows taller than the others.
// A table never drops a column: narrower than the sum of the minimums, `.table-scroll` scrolls
// sideways inside its container. Rows are `<tr>`s built by the caller; buildTable() adds the
// column's align class to each cell, so callers never repeat it. The rules live in table.css.
export const FLEX_MIN = 160;
export const TRUNCATE_CLASS = 'trunc';

const make = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
};

/** Returns `<div class="table-scroll"><table class="data-table">…</table></div>`. */
export function buildTable(columns, rows) {
  const table = make('table', undefined, 'data-table');
  const cols = make('colgroup');
  const head = make('thead');
  const tr = make('tr');
  for (const c of columns) {
    const th = make('th', c.text, c.align && c.align !== 'start' ? c.align : undefined);
    if (c.truncate) th.classList.add(TRUNCATE_CLASS);
    tr.append(th);
    const col = make('col');
    if (typeof c.width === 'number') col.style.width = `${c.width}px`;
    cols.append(col);
  }
  head.append(tr);
  const body = make('tbody');
  for (const row of rows) {
    Array.from(row.children).forEach((td, i) => {
      const align = columns[i]?.align;
      if (align && align !== 'start') td.classList.add(align);
      if (columns[i]?.truncate) {
        td.classList.add(TRUNCATE_CLASS);
        if (!td.title && td.textContent) td.title = td.textContent.trim();
      }
    });
    body.append(row);
  }
  const flexible = columns.filter((c) => typeof c.width !== 'number');
  const fixed = columns.reduce((sum, c) => sum + (typeof c.width === 'number' ? c.width : 0), 0);
  const flexMin = Math.max(FLEX_MIN, ...flexible.map((c) => c.min ?? 0));
  table.style.minWidth = `${fixed + flexible.length * flexMin}px`;
  table.append(cols, head, body);
  const scroll = make('div', undefined, 'table-scroll');
  scroll.append(table);
  return scroll;
}
