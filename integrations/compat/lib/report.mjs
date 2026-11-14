// Turns the collected results into the machine-readable matrix and a Markdown summary.

const ORDER = { fail: 0, skip: 1, na: 2, pass: 3 };

export function summarize(clients) {
  const total = { pass: 0, fail: 0, na: 0, skip: 0 };
  for (const c of clients) for (const s of Object.values(c.scenarios)) total[s.status] += 1;
  return total;
}

export function buildMatrix(clients, meta) {
  const scenarios = [...new Set(clients.flatMap((c) => Object.keys(c.scenarios)))];
  return { schema: 'oaa.compat-matrix.v1', ...meta, summary: summarize(clients), scenarios, clients };
}

const count = (client, status) => Object.values(client.scenarios).filter((s) => s.status === status).length;

export function renderMarkdown(matrix) {
  const lines = [];
  const s = matrix.summary;
  lines.push('# Compatibility matrix', '');
  lines.push(
    `Gateway ${matrix.gateway.version}, Node ${matrix.node}, generated ${matrix.generatedAt}.`,
    `Total: **${s.pass} pass**, **${s.fail} fail**, ${s.na} n/a, ${s.skip} skipped.`,
    '',
  );
  for (const kind of ['live', 'replay']) {
    const rows = matrix.clients.filter((c) => c.kind === kind);
    if (!rows.length) continue;
    lines.push(
      kind === 'live'
        ? '## Live clients (the real package ran against the gateway)'
        : '## Request-shape replays (the recorded request of a client that cannot run here)',
      '',
      '| Client | Version | Pass | Fail | N/A | Skip | Note |',
      '|---|---|---:|---:|---:|---:|---|',
    );
    for (const c of rows)
      lines.push(
        `| ${c.label} | ${c.version || ''} | ${count(c, 'pass')} | ${count(c, 'fail')} | ${count(c, 'na')} | ${count(c, 'skip')} | ${c.note ?? ''} |`,
      );
    lines.push('');
  }
  const failures = matrix.clients.flatMap((c) =>
    Object.entries(c.scenarios)
      .filter(([, v]) => v.status === 'fail')
      .map(([id, v]) => `- **${c.label}** / \`${id}\`: ${v.detail}`),
  );
  lines.push('## Failures', '', ...(failures.length ? failures : ['None.']), '');
  lines.push('## All scenarios', '');
  for (const c of matrix.clients) {
    lines.push(`<details><summary>${c.label} (${count(c, 'pass')}/${Object.keys(c.scenarios).length} pass)</summary>`, '');
    lines.push('| Scenario | Result | Detail |', '|---|---|---|');
    const entries = Object.entries(c.scenarios).sort((a, b) => ORDER[a[1].status] - ORDER[b[1].status] || a[0].localeCompare(b[0]));
    for (const [id, v] of entries)
      lines.push(`| \`${id}\` | ${v.status}${v.evidence ? ` (${v.evidence})` : ''} | ${String(v.detail).replace(/\|/g, '\\|').slice(0, 300)} |`);
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}
