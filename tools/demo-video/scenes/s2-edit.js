/*
 * 分镜 2：改一行。一段已有的 OpenAI SDK 代码；光标把 baseURL 与 model 两处改掉，改过的两行亮起。
 * 代码文本取自 recording.json（record.mjs 里实际执行的那一段），不是画上去的另一份。
 */
(() => {
  const V = window.VIDEO;
  const D = window.DEMO;
  const DURATION = 11;
  const CPS = { baseURL: 14, model: 12 };
  const TIMES = {
    baseURL: { caret: 1.2, selFrom: 1.7, selTo: 2.2, del: 2.4, type: 2.7 },
    model: { caret: 5.0, selFrom: 5.3, selTo: 5.7, del: 5.9, type: 6.2 },
  };

  V.define({
    id: 'edit',
    duration: DURATION,
    build(root) {
      const code = D.rec.code;
      const lines = code.snippet_before.split('\n');
      const edits = [
        { key: 'baseURL', old: code.before.baseURL, neu: code.after.baseURL },
        { key: 'model', old: code.before.model, neu: code.after.model },
      ].map((e) => {
        const index = lines.findIndex((l) => l.includes(`${e.key}: '${e.old}'`));
        if (index < 0) throw new Error(`示例代码里找不到 ${e.key} 那一行。`);
        const [prefix, suffix] = lines[index].split(`'${e.old}'`);
        const t = TIMES[e.key];
        const typeEnd = t.type + e.neu.length / CPS[e.key];
        return { ...e, index, prefix, suffix, t, typeEnd, cps: CPS[e.key] };
      });

      const win = V.el('div', 'window');
      // 窗口高度 = 标题栏 56 + 上下留白 52 + 每行 44；行数多了（英文提示词折行）就整体上移，底边留在 880 以内，不压到字幕。
      const top = Math.min(86, 880 - (56 + 52 + lines.length * 44));
      win.style.cssText = `left:180px;top:${top}px;width:1560px;`;
      const bar = V.el(
        'div',
        'window-bar',
        '<span class="dots"><i></i><i></i><i></i></span>todo.mjs',
      );
      const body = V.el('div', 'code');
      const rows = lines.map((_l, i) => {
        const row = V.el('div', 'ln');
        const wash = V.el('div', 'wash');
        const num = V.el('span', 'num', String(i + 1));
        const txt = V.el('span', 'txt');
        const tag = V.el('span', 'tag');
        row.append(wash, num, txt, tag);
        body.append(row);
        return { row, wash, txt, tag };
      });
      for (const e of edits) rows[e.index].tag.textContent = D.copy.edit_labels[e.key];
      win.append(bar, body);
      root.append(win);
      const caption = V.caption(root, [{ ...D.copy.edit, from: 0.5, to: null }]);

      return (t) => {
        root.style.opacity = String(V.envelope(t, DURATION));
        const blink = Math.floor(t * 2.4) % 2 === 0;
        // 两处都改完之后，其余的行退到背景里，视线留在改过的两行上。
        const dim = 1 - 0.5 * V.easeInOut(V.prog(t, 8.0, 8.8));
        lines.forEach((text, i) => {
          rows[i].txt.innerHTML = V.highlight(text);
          const han = V.hanLang(text);
          if (han) rows[i].txt.lang = han;
          rows[i].txt.style.opacity = edits.some((e) => e.index === i) ? '1' : String(dim);
          rows[i].wash.style.opacity = '0';
          rows[i].tag.style.opacity = '0';
        });
        // 两次编辑各自决定自己那一行的内容；光标只出现在「正在编辑」的那一行。
        for (const e of edits) {
          const { caret, selFrom, selTo, del, type } = e.t;
          let value = e.old;
          let mark = '';
          if (t >= caret && t < selFrom) {
            mark = V.CARET;
          } else if (t >= selFrom && t < del) {
            const n = Math.ceil(V.easeInOut(V.prog(t, selFrom, selTo)) * e.old.length);
            value = `${e.old.slice(0, e.old.length - n)}${V.SEL_ON}${e.old.slice(e.old.length - n)}${V.SEL_OFF}`;
            mark = V.CARET;
          } else if (t >= del && t < type) {
            value = '';
            mark = V.CARET;
          } else if (t >= type) {
            const n = Math.min(e.neu.length, Math.floor((t - type) * e.cps));
            value = e.neu.slice(0, n);
            const typing = n < e.neu.length;
            // 打完之后光标再闪一小会儿，然后离开这一行。
            const lingering = !typing && t < e.typeEnd + 0.45;
            if (typing || lingering) mark = blink || typing ? V.CARET : '';
          }
          const line = `${e.prefix}'${value}${mark}'${e.suffix}`;
          rows[e.index].txt.innerHTML = V.highlight(line);
          const han = V.hanLang(line);
          if (han) rows[e.index].txt.lang = han;
          // 改过的行：打字时淡淡地亮，打完后亮足；旁边浮出说明。
          const typedShare = V.prog(t, e.t.type, e.typeEnd);
          const wash = Math.max(
            0.35 * typedShare,
            V.easeOut(V.prog(t, e.typeEnd, e.typeEnd + 0.6)),
          );
          rows[e.index].wash.style.opacity = String(wash);
          rows[e.index].tag.style.opacity = String(
            V.easeOut(V.prog(t, e.typeEnd + 0.15, e.typeEnd + 0.455)),
          );
        }
        caption(t);
      };
    },
  });
})();
