/*
 * 把各镜头建好，对外只暴露两样东西：
 *   window.__ready          等字体与图片全部就绪的 Promise
 *   window.__frame(id, t)   把第 id 镜在 t 秒时的样子摆好（同一个 t 永远得到同一帧）
 */
(() => {
  const V = window.VIDEO;
  const stage = document.getElementById('stage');
  const renders = {};
  for (const id of V.order) {
    const root = V.el('div', 'scene');
    root.dataset.scene = id;
    stage.append(root);
    renders[id] = V.scenes[id].build(root);
  }
  const show = (id) => {
    for (const node of stage.children) {
      if (node.dataset.scene === id) node.setAttribute('data-active', '');
      else node.removeAttribute('data-active');
    }
  };

  window.__ready = (async () => {
    // 逐镜在几个时间点摆一遍，让用到的字都进入渲染树，再把对应字体显式加载完。
    for (const id of V.order) {
      show(id);
      const d = V.scenes[id].duration;
      for (const t of [d * 0.45, d * 0.95]) renders[id](t);
    }
    // 兜底：上镜的文字里不得有本机路径、file:// 链接或密钥。命中就拒绝渲染，并指出是哪一镜、哪段文字。
    const patterns = (window.DEMO.forbidden ?? []).map(([source, flags]) => [
      new RegExp(source, flags),
      source,
    ]);
    for (const node of stage.children) {
      const text = node.textContent;
      for (const [re, source] of patterns) {
        const m = re.exec(text);
        if (m)
          throw new Error(
            `第 ${node.dataset.scene} 镜的画面文字里有不该上镜的内容：/${source}/ 附近「${text
              .slice(Math.max(0, m.index - 30), m.index + 60)
              .replace(/\s+/g, ' ')}」`,
          );
      }
    }
    for (const node of stage.children) node.setAttribute('data-active', '');
    const text = stage.textContent;
    const cjk = [...new Set(text.replace(/[\u0000-ÿ]/g, ''))].join('');
    await Promise.all([
      document.fonts.load('600 46px "Noto Serif SC"', cjk),
      document.fonts.load('600 46px "Noto Serif SC"', 'Open Agent API 0123456789'),
      document.fonts.load('italic 92px "Instrument Serif"', 'Open Agent API OpenAIClaudeGemini'),
      document.fonts.load('400 64px "Instrument Serif"', text),
      document.fonts.load('400 24px "Geist"', text),
      document.fonts.load('500 24px "Geist"', text),
      document.fonts.load('400 26px "Geist Mono"', text),
      document.fonts.load('500 26px "Geist Mono"', text),
    ]);
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
    show(V.order[0]);
    return true;
  })();

  window.__frame = async (id, t) => {
    if (!renders[id]) throw new Error(`没有这一镜：${id}`);
    show(id);
    renders[id](t);
    return true;
  };
  window.__scenes = () => V.order.map((id) => ({ id, duration: V.scenes[id].duration }));
  window.__runTimes = () => V.runTimes();
})();
