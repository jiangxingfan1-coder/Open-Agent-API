/*
 * 渲染页的公共部件：场景注册、时间函数、字幕与角标的构件、代码着色。
 * 每个场景是一个纯函数 render(t)：给定「本镜内的时间（秒）」，把 DOM 摆成那一刻该有的样子。
 * 不读真实时钟，不用 CSS 动画，所以同一个 t 永远得到同一帧。
 */
(() => {
  const V = (window.VIDEO = { scenes: {}, order: [], FPS: 30 });
  const D = window.DEMO;
  /** 成片语言：zh（默认）或 en。 */
  V.lang = D.lang === 'en' ? 'en' : 'zh';

  /* ── 时间函数 ─────────────────────────────────────────── */
  V.clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  V.prog = (t, a, b) => V.clamp((t - a) / (b - a));
  V.lerp = (a, b, k) => a + (b - a) * k;
  V.easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  V.easeOut = (k) => 1 - Math.pow(1 - k, 3);
  /** 镜头的淡入淡出包络：开头与结尾各一小段，中间为 1。 */
  V.envelope = (t, duration, fin = 0.4, fout = 0.4) =>
    Math.min(
      fin > 0 ? V.prog(t, 0, fin) : 1,
      fout > 0 ? 1 - V.prog(t, duration - fout, duration) : 1,
    );

  /* ── DOM 小工具 ───────────────────────────────────────── */
  V.el = (tag, cls, html) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  };
  V.esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  V.fill = (template, values) => template.replace(/\{(\w+)\}/g, (_m, k) => values[k] ?? `{${k}}`);

  /**
   * 一段文案 → 两个节点。中文版：大号中文（.zh）加小号英文（.en）；英文版：一行主文案（.main），
   * 有 sub 时再加一行小号副文案（.sub）。copy 里的条目形如 {zh, en, sub?}。
   */
  V.pairNodes = (item) =>
    V.lang === 'en'
      ? [
          V.el('div', 'main', V.esc(item.en)),
          ...(item.sub ? [V.el('div', 'sub', V.esc(item.sub))] : []),
        ]
      : [V.el('div', 'zh', V.esc(item.zh)), V.el('div', 'en', V.esc(item.en))];
  /** 文字里有汉字时返回 'zh-CN'，否则 null：英文版里原样保留的中文录制内容要带上语言标记，字形才不会被英文环境换掉。 */
  V.hanLang = (text) => (/[\u3400-\u9fff]/.test(text) ? 'zh-CN' : null);

  /* ── 场景注册 ─────────────────────────────────────────── */
  V.define = (def) => {
    V.scenes[def.id] = def;
    V.order.push(def.id);
  };

  /* ── 字幕：按时间段切换，交叉淡入 ─────────────────────── */
  V.caption = (root, items) => {
    const stack = V.el('div', 'caption');
    const nodes = items.map((item) => {
      const line = V.el('div', 'line');
      line.append(...V.pairNodes(item));
      stack.append(line);
      return line;
    });
    root.append(stack);
    return (t) => {
      items.forEach((item, i) => {
        const fin = V.prog(t, item.from, item.from + 0.45);
        const fout = item.to == null ? 0 : V.prog(t, item.to - 0.35, item.to);
        const o = Math.max(0, fin - fout);
        nodes[i].style.opacity = String(o);
        nodes[i].style.transform = `translateY(${(1 - fin) * 10}px)`;
      });
    };
  };

  /* ── 右下角：标注与真实耗时 ───────────────────────────── */
  V.badgeEl = (kind) => {
    const b = D.copy.badges[kind];
    const node = V.el('div', `badge ${kind === 'real' ? '' : 'stand-in'}`);
    const [main, ...rest] = V.pairNodes(b);
    main.innerHTML = `<i class="dot"></i><span>${main.innerHTML}</span>`;
    node.append(main, ...rest);
    return node;
  };
  /** 返回 {box, badge, note}：badge 与 note 的显隐由场景自己按时间控制。 */
  V.corner = (root, kind) => {
    const box = V.el('div', 'corner');
    const badge = kind ? V.badgeEl(kind) : null;
    const note = V.el('div', 'note');
    if (badge) box.append(badge);
    box.append(note);
    root.append(box);
    return { box, badge, note };
  };

  /* ── 代码着色（克制：字符串用潮深色，关键字用暮蓝，其余是墨色）── */
  const CARET = '\u0001';
  const SEL_ON = '\u0002';
  const SEL_OFF = '\u0003';
  V.CARET = CARET;
  V.SEL_ON = SEL_ON;
  V.SEL_OFF = SEL_OFF;
  V.highlight = (line) => {
    const re = /('(?:[^'\\]|\\.)*'?)|\b(import|from|const|await|new)\b/g;
    let out = '';
    let last = 0;
    for (let m; (m = re.exec(line));) {
      out += V.esc(line.slice(last, m.index));
      out += m[1]
        ? `<span class="tok-str">${V.esc(m[1])}</span>`
        : `<span class="tok-kw">${m[2]}</span>`;
      last = m.index + m[0].length;
    }
    out += V.esc(line.slice(last));
    return out
      .replaceAll(CARET, '<span class="caret"></span>')
      .replaceAll(SEL_ON, '<span class="sel">')
      .replaceAll(SEL_OFF, '</span>');
  };

  /* ── 控制台截图图层 ───────────────────────────────────── */
  const CURSOR_SVG =
    '<svg viewBox="0 0 30 36" width="30" height="36"><path d="M3 2 L3 28 L10 21.5 L15 33 L20 31 L15 19.5 L25 19.5 Z" fill="#132220" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>';
  /** 在 frame 里建一个可推移的容器与若干张截图；返回操作函数。比例：1280 css 像素 → 1408 画面像素。 */
  V.shotStage = (root, names) => {
    const frame = V.el('div', 'shot-frame');
    const zoom = V.el('div', 'shot-zoom');
    const imgs = {};
    for (const name of names) {
      const img = V.el('img');
      img.src = D.shots[name].url;
      img.alt = '';
      img.style.opacity = '0';
      zoom.append(img);
      imgs[name] = img;
    }
    const ring = V.el('div', 'ring');
    const ripple = V.el('div', 'ripple');
    const cursor = V.el('div', 'cursor', CURSOR_SVG);
    zoom.append(ring, ripple, cursor);
    frame.append(zoom);
    root.append(frame);
    const S = 1408 / 1280;
    const px = (shot, key) => {
      const r = D.shots[shot].rects[key];
      if (!r) throw new Error(`控制台截图 ${shot} 里没有量到 ${key} 的位置。`);
      return { x: r.x * S, y: r.y * S, w: r.width * S, h: r.height * S };
    };
    return {
      frame,
      zoom,
      imgs,
      px,
      /** 以 (fx, fy)（画面像素）为中心缩放到 z 倍。 */
      camera(z, fx, fy) {
        zoom.style.transformOrigin = `${fx}px ${fy}px`;
        zoom.style.transform = `scale(${z})`;
      },
      placeCursor(x, y, o) {
        cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
        cursor.style.opacity = String(o);
      },
      placeRing(rect, o, pad = 4) {
        ring.style.left = `${rect.x - pad}px`;
        ring.style.top = `${rect.y - pad}px`;
        ring.style.width = `${rect.w + pad * 2}px`;
        ring.style.height = `${rect.h + pad * 2}px`;
        ring.style.opacity = String(o);
      },
      placeRipple(x, y, k) {
        ripple.style.left = `${x}px`;
        ripple.style.top = `${y}px`;
        ripple.style.opacity = k > 0 && k < 1 ? String(1 - k) : '0';
        ripple.style.transform = `scale(${0.5 + k * 1.1})`;
      },
    };
  };
  /** 光标沿折线路径移动：points = [[t0, x0, y0], [t1, x1, y1], ...]，段内缓动。 */
  V.path = (t, points) => {
    if (t <= points[0][0]) return { x: points[0][1], y: points[0][2] };
    for (let i = 1; i < points.length; i++) {
      if (t <= points[i][0]) {
        const k = V.easeInOut(V.prog(t, points[i - 1][0], points[i][0]));
        return {
          x: V.lerp(points[i - 1][1], points[i][1], k),
          y: V.lerp(points[i - 1][2], points[i][2], k),
        };
      }
    }
    const last = points[points.length - 1];
    return { x: last[1], y: last[2] };
  };

  /* ── 数字与文本的格式 ────────────────────────────────── */
  V.seconds = (ms) => (ms / 1000).toFixed(1);
  V.truncate = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
  V.firstLine = (text) => text.trim().split('\n')[0] ?? '';
})();
