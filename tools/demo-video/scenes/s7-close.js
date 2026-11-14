/* 分镜 7：收尾。标志、仓库地址（在 copy.json 里集中配置）、许可证。 */
(() => {
  const V = window.VIDEO;
  const D = window.DEMO;
  const DURATION = 4.4;

  V.define({
    id: 'close',
    duration: DURATION,
    build(root) {
      const stack = V.el('div', 'close-stack');
      stack.innerHTML = V.markSvg('close-mark');
      const word = V.el('div', 'close-word', V.esc(D.copy.brand));
      word.translate = false;
      const url = V.el('div', 'close-url', V.esc(D.copy.repo_url));
      const lic = V.el('div', 'close-license');
      lic.append(...V.pairNodes(D.copy.close));
      stack.append(word, url, lic);
      root.append(stack);
      const svg = stack.querySelector('svg');
      const reveal = (node, t, from) => {
        const k = V.easeOut(V.prog(t, from, from + 0.55));
        node.style.opacity = String(k);
        node.style.transform = `translateY(${(1 - k) * 10}px)`;
      };
      return (t) => {
        V.drawMark(svg, [1, 1, 1]);
        svg.style.opacity = String(V.easeOut(V.prog(t, 0.3, 0.9)));
        reveal(word, t, 0.6);
        reveal(url, t, 1.2);
        reveal(lic, t, 1.8);
        stack.style.opacity = String(1 - V.prog(t, DURATION - 0.5, DURATION));
      };
    },
  });
})();
