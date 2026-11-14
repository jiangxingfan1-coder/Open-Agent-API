// A data table that never needs sideways scrolling. buildTable() (web/shared/table.js) gives every
// column a minimum width; when the container is narrower than their sum the table turns into one
// stacked entry per row instead: the main cell on top, the other cells beneath with their column
// name as a small label. The layout of each kind of table is in styles/tables.css (.is-stacked).
import { buildTable } from './shared/table.js';

/** buildTable() plus the stacked form. `kind` names the layout: runs | keys | ledger | agents. */
export function stackedTable(kind, columns, rows) {
  const scroll = buildTable(columns, rows);
  const table = scroll.querySelector('table');
  table.classList.add(`stack-${kind}`);
  const labels = columns.map((c) => c.text);
  for (const tr of table.tBodies[0].rows)
    Array.from(tr.cells).forEach((td, i) => td.setAttribute('data-label', labels[i] ?? ''));
  const needed = () => Number.parseFloat(table.style.minWidth) || 0;
  const fit = () =>
    table.classList.toggle('is-stacked', scroll.clientWidth > 0 && scroll.clientWidth < needed());
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      if (!scroll.isConnected) return observer.disconnect();
      fit();
    });
    observer.observe(scroll);
  }
  // Before the first observation the table is not in the page yet: decide when it gets there.
  requestAnimationFrame(fit);
  setTimeout(fit, 0);
  setTimeout(fit, 300);
  return scroll;
}
