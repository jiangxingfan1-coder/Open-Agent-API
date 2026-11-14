/*
 * 分镜 5：人在回路。概览里出现「1 个任务等待你审批」→ 打开任务 → 点「批准」→ 同一个任务接着做完。
 * 三张画面是同一次录制在三个时刻导出的快照（待审批、完成），用真实控制台前端截下。
 * 这一段的智能体永远是本地替身（当前的真实智能体引擎不支持审批桥接），所以整镜都带着标注。
 */
(() => {
  const V = window.VIDEO;
  const D = window.DEMO;
  const DURATION = 12;
  const GO_CLICK = 2.7;
  const GO_SWAP = [2.85, 3.3];
  const OK_CLICK = 6.5;
  const OK_SWAP = [6.7, 7.2];

  V.define({
    id: 'approval',
    duration: DURATION,
    build(root) {
      const stage = V.shotStage(root, ['ap-overview', 'ap-inspector', 'ap-done']);
      const go = stage.px('ap-overview', 'go');
      const approve = stage.px('ap-inspector', 'approve');
      const goPoint = { x: go.x + go.w * 0.5, y: go.y + go.h * 0.5 };
      const okPoint = { x: approve.x + approve.w * 0.7, y: approve.y + approve.h * 0.62 };
      const caption = V.caption(root, [
        { ...D.copy.approval.wait, from: 0.5, to: 7.1 },
        { ...D.copy.approval.done, from: 6.9, to: null },
      ]);
      const corner = V.corner(root, 'approval');

      return (t) => {
        root.style.opacity = String(V.envelope(t, DURATION));
        const toInspector = V.easeInOut(V.prog(t, GO_SWAP[0], GO_SWAP[1]));
        const toDone = V.easeInOut(V.prog(t, OK_SWAP[0], OK_SWAP[1]));
        stage.imgs['ap-overview'].style.opacity = String(1 - toInspector);
        stage.imgs['ap-inspector'].style.opacity = String(toInspector * (1 - toDone));
        stage.imgs['ap-done'].style.opacity = String(toDone);

        // 镜头：先轻轻推向待审批的卡片，批准后推向时间线上「等待审批」的那一段。
        const a = V.easeInOut(V.prog(t, GO_SWAP[1], OK_CLICK));
        const b = V.easeInOut(V.prog(t, OK_SWAP[1], 11.4));
        const z = 1 + 0.02 * V.prog(t, 0, GO_SWAP[1]) + 0.07 * a + 0.05 * b;
        stage.camera(z, V.lerp(704, 1408, toInspector), V.lerp(330, 60, toInspector));

        const cur = V.path(t, [
          [0.8, 1290, 640],
          [2.3, goPoint.x, goPoint.y],
          [3.6, goPoint.x, goPoint.y],
          [5.9, okPoint.x, okPoint.y],
        ]);
        stage.placeCursor(cur.x, cur.y, V.prog(t, 0.8, 1.2) * (1 - V.prog(t, 7.0, 7.5)));
        const ringGo = V.prog(t, 2.2, 2.5) * (1 - V.prog(t, GO_SWAP[0], GO_SWAP[1]));
        const ringOk = V.prog(t, 5.6, 5.9) * (1 - V.prog(t, OK_SWAP[0], OK_SWAP[1]));
        stage.placeRing(t < 4.5 ? go : approve, t < 4.5 ? ringGo : ringOk, 4);
        if (t < 4.5) stage.placeRipple(goPoint.x, goPoint.y, V.prog(t, GO_CLICK, GO_CLICK + 0.5));
        else stage.placeRipple(okPoint.x, okPoint.y, V.prog(t, OK_CLICK, OK_CLICK + 0.5));
        corner.badge.style.opacity = String(V.prog(t, 0.5, 1.0));
        caption(t);
      };
    },
  });
})();
