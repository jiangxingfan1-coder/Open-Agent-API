/*
 * 分镜 3：真实调用。命令、回答、耗时、token 用量取自 recording.json（真实录制的那一次 openai SDK 调用）。
 * 等待时间可以压缩：画面里最多等 4.5 秒，计时器照真实耗时走，并在右下角如实写明「画面已加速」。
 * recording.json 标明智能体是替身时（占位素材），字幕与角标都会改成「占位素材」。
 */
(() => {
  const V = window.VIDEO;
  const D = window.DEMO;
  const DURATION = 12;
  const COMMAND = 'OPENAI_API_KEY=sk-oaa-… node todo.mjs';
  const TYPE_FROM = 0.7;
  const TYPE_CPS = 24;
  const MAX_WAIT = 4.5;

  /** 这一镜的时间轴；其他地方（如 GIF 的取段）也要用到「回答出现的时间」，所以单独导出。 */
  V.runTimes = () => {
    const call = D.rec.calls.openai;
    const real = call.elapsed_ms / 1000;
    const enter = TYPE_FROM + COMMAND.length / TYPE_CPS + 0.4;
    const wait = Math.min(real, MAX_WAIT);
    return { real, enter, wait, answer: enter + wait + 0.1, sped: real > wait + 0.05 };
  };

  V.define({
    id: 'run',
    duration: DURATION,
    build(root) {
      const call = D.rec.calls.openai;
      const agent = D.rec.agent;
      const T = V.runTimes();

      const win = V.el('div', 'window');
      win.style.cssText = 'left:180px;top:116px;width:1560px;height:496px;';
      const bar = V.el(
        'div',
        'window-bar',
        '<span class="dots"><i></i><i></i><i></i></span>demo — zsh',
      );
      const body = V.el('div', 'term-body');
      body.style.height = '380px';
      const cmdLine = V.el('div');
      const out = V.el('div', 'term-out');
      out.textContent = call.text.trim();
      const han = V.hanLang(out.textContent);
      if (han) out.lang = han;
      body.append(cmdLine, out);
      const foot = V.el('div', 'term-foot');
      const state = V.el('div', 'state');
      const clock = V.el('div', 'clock');
      foot.append(state, clock);
      win.append(bar, body, foot);
      root.append(win);

      const chips = V.el('div', 'chips');
      chips.style.cssText = 'left:180px;top:648px;';
      const total = call.usage?.total_tokens ?? call.usage?.totalTokens;
      const chipData = [
        [D.copy.run.chips.agent, agent.id],
        [D.copy.run.chips.elapsed, `${V.seconds(call.elapsed_ms)} s`],
        ...(total ? [[D.copy.run.chips.usage, `${total.toLocaleString('en-US')} tokens`]] : []),
        [
          D.copy.run.chips.run,
          call.run_id.length > 14 ? `${call.run_id.slice(0, 11)}…` : call.run_id,
        ],
      ];
      const chipNodes = chipData.map(([k, v]) => {
        const c = V.el('div', 'chip', `${V.esc(k)}<b>${V.esc(v)}</b>`);
        chips.append(c);
        return c;
      });
      root.append(chips);

      const copy = agent.real
        ? {
            zh: V.fill(D.copy.run.real.zh ?? '', { agent: agent.display }),
            en: V.fill(D.copy.run.real.en, { agent: agent.display }),
            sub: D.copy.run.real.sub,
          }
        : D.copy.run.placeholder;
      const caption = V.caption(root, [{ ...copy, from: 0.5, to: null }]);
      const corner = V.corner(root, agent.real ? 'real' : 'placeholder');
      const noteText = V.fill(D.copy.elapsed[T.sped ? 'sped_up' : 'exact'], {
        seconds: V.seconds(call.elapsed_ms),
      });
      corner.note.textContent = noteText;

      return (t) => {
        root.style.opacity = String(V.envelope(t, DURATION));
        const typed = Math.min(COMMAND.length, Math.max(0, Math.floor((t - TYPE_FROM) * TYPE_CPS)));
        const blink = Math.floor(t * 2.4) % 2 === 0;
        const typing = t >= TYPE_FROM && typed < COMMAND.length;
        const showCaret = t >= TYPE_FROM - 0.3 && t < T.enter && (typing || blink);
        cmdLine.innerHTML =
          `<span class="prompt">$</span> ${V.esc(COMMAND.slice(0, typed))}` +
          (showCaret ? '<span class="caret"></span>' : '');
        const answered = t >= T.answer;
        out.style.opacity = answered ? String(V.prog(t, T.answer, T.answer + 0.2)) : '0';

        // 底栏：回车之后才出现；等待中显示计时（按真实耗时走），返回后定格。
        const running = t >= T.enter;
        foot.style.opacity = running ? '1' : '0';
        const k = V.clamp((t - T.enter) / T.wait);
        const shown = answered ? call.elapsed_ms / 1000 : (call.elapsed_ms / 1000) * V.easeInOut(k);
        clock.textContent = `${shown.toFixed(1)} s`;
        const pulse = 0.45 + 0.55 * Math.abs(Math.sin(t * 3.1));
        state.innerHTML = answered
          ? `<span style="color:var(--tide-deep)">✓</span><span>${V.esc(D.copy.run.returned)}</span>`
          : `<span class="pulse" style="opacity:${pulse.toFixed(3)}"></span><span>${V.esc(D.copy.run.waiting)}</span>`;

        chipNodes.forEach((node, i) => {
          const o = V.easeOut(V.prog(t, T.answer + 0.5 + i * 0.14, T.answer + 0.95 + i * 0.14));
          node.style.opacity = String(o);
          node.style.transform = `translateY(${(1 - o) * 8}px)`;
        });
        corner.note.style.opacity = running ? String(V.prog(t, T.enter, T.enter + 0.4)) : '0';
        corner.badge.style.opacity = String(V.prog(t, 0.5, 1.0));
        caption(t);
      };
    },
  });
})();
