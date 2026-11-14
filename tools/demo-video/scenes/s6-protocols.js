/*
 * 分镜 6：三家协议。OpenAI / Claude / Gemini 三行调用依次亮起；每行只写调用方式、这次调用真实得到的
 * HTTP 状态、耗时与 token 用量（有就显示）。不显示回答正文：真实智能体的回答可能很长，还可能带它自己
 * 生成的文件链接，不适合上镜。Gemini 那一行是线上格式的直接 HTTP 请求，不是官方 SDK，画面上如实写明。
 */
(() => {
  const V = window.VIDEO;
  const D = window.DEMO;
  const DURATION = 5.6;
  const LIGHT = [0.55, 1.7, 2.85];

  /** 各家用量字段不同：OpenAI 的 total_tokens、Gemini 的 totalTokenCount、Claude 只有输入与输出两项。 */
  V.tokens = (call) => {
    const u = call?.usage;
    if (!u) return null;
    const n = (x) => (Number.isFinite(x) ? x : null);
    return (
      n(u.total_tokens) ??
      n(u.totalTokenCount) ??
      (n(u.input_tokens) !== null && n(u.output_tokens) !== null
        ? u.input_tokens + u.output_tokens
        : null)
    );
  };

  V.define({
    id: 'protocols',
    duration: DURATION,
    build(root) {
      const id = D.rec.agent.id;
      const wrap = V.el('div', 'proto');
      const rows = D.copy.protocols.rows.map((r) => {
        const call = D.rec.calls[r.key] ?? {};
        const tokens = V.tokens(call);
        const stats = [
          V.esc(r.how),
          call.ok ? `HTTP ${call.http_status}` : '',
          call.ok ? `${V.esc(D.copy.protocols.stats.elapsed)} ${V.seconds(call.elapsed_ms)} s` : '',
          tokens !== null
            ? `${V.esc(D.copy.protocols.stats.usage)} ${tokens.toLocaleString('en-US')} tokens`
            : '',
        ].filter(Boolean);
        const row = V.el('div', 'proto-row');
        row.innerHTML =
          `<div class="bar"></div><div class="label">${V.esc(r.label)}</div>` +
          `<div class="code">${V.highlight(V.fill(r.code, { id }))}</div>` +
          `<div class="stats">${stats.map((s) => `<span>${s}</span>`).join('<i></i>')}</div>`;
        wrap.append(row);
        return row;
      });
      root.append(wrap);
      const caption = V.caption(root, [{ ...D.copy.protocols, from: 0.4, to: null }]);
      const corner = V.corner(root, D.rec.agent.real ? 'real' : 'placeholder');

      return (t) => {
        root.style.opacity = String(V.envelope(t, DURATION));
        rows.forEach((row, i) => {
          const k = V.easeOut(V.prog(t, LIGHT[i], LIGHT[i] + 0.55));
          row.style.opacity = String(0.2 + 0.8 * k);
          row.querySelector('.bar').style.opacity = String(k);
          row.querySelector('.stats').style.opacity = String(k);
        });
        corner.badge.style.opacity = String(V.prog(t, 0.4, 0.9));
        caption(t);
      };
    },
  });
})();
