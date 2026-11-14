/* 分镜 1：开场。标志的单线描绘，随后是名称与一句话。 */
(() => {
  const V = window.VIDEO;
  const D = window.DEMO;
  const DURATION = 3.4;
  // 与 docs/brand/oaa-mark-ink.svg 同一份几何：O 的弧、A 的主笔画、A 左腿下端的短线。
  const PATHS = [
    'M143.36 106.65A50 50 0 1 1 119.1 78.6',
    'M209.89 207L150.11 49L108.57 155',
    'M94.7 190.38L88.19 207',
  ];
  V.markSvg = (cls) =>
    `<svg class="${cls}" viewBox="40.11 43 175.78 170" aria-hidden="true">${PATHS.map(
      (d) => `<path d="${d}" pathLength="1" stroke-dasharray="1 1.02" />`,
    ).join('')}</svg>`;
  /** 三笔依次描出；draw[i] 是第 i 笔的进度 0–1。 */
  V.drawMark = (svg, draw) => {
    svg.querySelectorAll('path').forEach((p, i) => {
      const k = draw[i];
      p.style.strokeDashoffset = String(1 - k);
      p.style.opacity = k <= 0.001 ? '0' : '1';
    });
  };

  V.define({
    id: 'open',
    duration: DURATION,
    build(root) {
      const stack = V.el('div', 'open-stack');
      stack.innerHTML = V.markSvg('open-mark');
      const word = V.el('div', 'open-word', V.esc(D.copy.brand));
      word.translate = false;
      const tag = V.el('div', 'open-tag');
      tag.append(...V.pairNodes(D.copy.open));
      stack.append(word, tag);
      root.append(stack);
      const svg = stack.querySelector('svg');
      return (t) => {
        V.drawMark(svg, [
          V.easeInOut(V.prog(t, 0.2, 1.05)),
          V.easeInOut(V.prog(t, 0.8, 1.55)),
          V.easeInOut(V.prog(t, 1.4, 1.7)),
        ]);
        const w = V.easeOut(V.prog(t, 1.35, 1.95));
        word.style.opacity = String(w);
        word.style.transform = `translateY(${(1 - w) * 10}px)`;
        const g = V.easeOut(V.prog(t, 1.95, 2.55));
        tag.style.opacity = String(g);
        tag.style.transform = `translateY(${(1 - g) * 10}px)`;
        stack.style.opacity = String(1 - V.prog(t, DURATION - 0.4, DURATION));
      };
    },
  });
})();
