import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The shared table layer (web/shared/table.js) has a `truncate` column option: one line, an
// ellipsis, the full text in `title`. Runs without a browser, against a tiny DOM stand-in that
// supports exactly what buildTable() touches.

class Node_ {
  children: Node_[] = [];
  className = '';
  title = '';
  textContent = '';
  style: Record<string, string> = {};
  constructor(readonly tag: string) {}
  get classList() {
    return {
      add: (c: string) => {
        if (!this.className.split(' ').includes(c))
          this.className = `${this.className} ${c}`.trim();
      },
      contains: (c: string) => this.className.split(' ').includes(c),
    };
  }
  append(...nodes: Node_[]) {
    this.children.push(...nodes);
  }
}
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new Node_(tag),
};

interface Column {
  text: string;
  align?: string;
  width?: number;
  min?: number;
  truncate?: boolean;
}
const { buildTable } = (await import(
  new URL('../../web/shared/table.js', import.meta.url).href
)) as {
  buildTable(columns: Column[], rows: Node_[]): Node_;
};

const row = (...cells: string[]) => {
  const tr = new Node_('tr');
  for (const text of cells) {
    const td = new Node_('td');
    td.textContent = text;
    tr.append(td);
  }
  return tr;
};
const find = (root: Node_, tag: string): Node_[] =>
  root.children.flatMap((c) => (c.tag === tag ? [c] : []).concat(find(c, tag)));

test('truncate columns mark header and cells, and put the full text in title', () => {
  const long = 'agent/research@fixture-model-with-a-long-name';
  const scroll = buildTable(
    [{ text: '任务' }, { text: '模型', width: 176, truncate: true }],
    [row('a', long), row('b', 'sonnet')],
  );
  const [h1, h2] = find(scroll, 'th');
  assert.equal(h1!.classList.contains('trunc'), false);
  assert.equal(h2!.classList.contains('trunc'), true);
  const rows = find(scroll, 'tr').filter((tr) => find(tr, 'td').length);
  const cells = rows.map((tr) => find(tr, 'td'));
  assert.equal(cells[0]![0]!.classList.contains('trunc'), false);
  assert.equal(cells[0]![0]!.title, '');
  assert.equal(cells[0]![1]!.classList.contains('trunc'), true);
  assert.equal(cells[0]![1]!.title, long);
  assert.equal(cells[1]![1]!.title, 'sonnet');
});

test('a cell that already has a title keeps it', () => {
  const tr = row('x', 'long value');
  tr.children[1]!.title = 'custom';
  const scroll = buildTable([{ text: 'a' }, { text: 'b', truncate: true }], [tr]);
  assert.equal(find(scroll, 'td')[1]!.title, 'custom');
});

test('table.css truncates .trunc cells on one line with an ellipsis', async () => {
  const css = await readFile(new URL('../../web/shared/table.css', import.meta.url), 'utf8');
  const rule = /\.data-table td\.trunc\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /white-space:\s*nowrap/);
  assert.match(rule, /text-overflow:\s*ellipsis/);
  assert.match(rule, /overflow:\s*hidden/);
});

test('the task list truncates its model column', async () => {
  const src = await readFile(new URL('../../web/views/runs.js', import.meta.url), 'utf8');
  assert.match(src, /text:\s*t\('runs\.col\.model'\)[^}]*truncate:\s*true/);
});
