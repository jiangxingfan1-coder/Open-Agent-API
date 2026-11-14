/*
 * 分镜 4：不是模型，是任务。画面是真实控制台前端的截图（render.mjs 用录制导出的接口快照离线喂给 web/ 后截下），
 * 光标是后期叠加的；点开的那一行就是分镜 3 里调用产生的任务。
 */
(() => {
  const V = window.VIDEO;
  const D = window.DEMO;
  const DURATION = 10;
  const CLICK = 3.25;
  const SWAP = [3.4, 3.9];

  V.define({
    id: 'tasks',
    duration: DURATION,
    build(root) {
      const stage = V.shotStage(root, ['tasks-list', 'tasks-inspector']);
      const row = stage.px('tasks-list', 'row');
      const target = { x: row.x + row.w * 0.42, y: row.y + row.h * 0.5 };
      const caption = V.caption(root, [{ ...D.copy.tasks, from: 0.5, to: null }]);
      const corner = V.corner(root, D.rec.agent.real ? 'real' : 'placeholder');

      return (t) => {
        root.style.opacity = String(V.envelope(t, DURATION));
        const swap = V.easeInOut(V.prog(t, SWAP[0], SWAP[1]));
        stage.imgs['tasks-list'].style.opacity = String(1 - swap);
        stage.imgs['tasks-inspector'].style.opacity = String(swap);

        // 镜头：列表阶段几乎不动；检查器阶段缓慢推向时间线与输出。
        const push = V.easeInOut(V.prog(t, 4.2, 9.6));
        const drift = V.prog(t, 0, SWAP[1]) * 0.03;
        stage.camera(1 + drift + push * 0.13, V.lerp(704, 1408, swap), 60 + 240 * (1 - swap));

        const cur = V.path(t, [
          [0.8, 1290, 700],
          [2.5, target.x, target.y],
        ]);
        const curOpacity = V.prog(t, 0.8, 1.2) * (1 - V.prog(t, CLICK + 0.45, CLICK + 0.85));
        stage.placeCursor(cur.x, cur.y, curOpacity);
        stage.placeRing(row, V.prog(t, 2.4, 2.7) * (1 - V.prog(t, SWAP[0], SWAP[1])), 2);
        stage.placeRipple(target.x, target.y, V.prog(t, CLICK, CLICK + 0.5));
        corner.badge.style.opacity = String(V.prog(t, 0.5, 1.0));
        caption(t);
      };
    },
  });
})();
