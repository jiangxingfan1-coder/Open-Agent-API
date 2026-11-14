# 产品截图：README 与展示页用的图

`docs/assets/` 里 README 引用的截图（`hero`、`runs`、`inspector`、`api-key`、`portal`，各有 `light` 与 `dark` 两版）与
`site/assets/` 里展示页引用的截图（`hero`、`inspector`、`api-key`、`portal`），都由这里的脚本生成。
这个目录不属于产品，不随发布包分发。

## 做了什么

`shoot.mjs` 不启动网关、不监听任何端口、不联网。它用无头 Chrome（`tools/demo-video/lib/chrome.mjs`，通过管道控制）以 `file://`
打开**真实的**控制台与开发者门户前端（`web/`），在页面里于入口脚本之前注入一个离线假网关：

- `console-harness.js`：控制台。预置假的连接令牌与外观偏好、界面语言；冻结时钟（2026-11-12 08:30 UTC，时区固定为 UTC+8，画面上显示 16:30）；
  用固定的演示数据替换 `fetch`（概览、活动、任务列表与任务详情、密钥）。
- `portal-harness.js`：门户。同样的做法：假登录会话、冻结时钟、固定的智能体目录与密钥。
- `texts.mjs`：演示文字，中英两套。**同一套演示数据**（同样的智能体、同样的任务、同样的数字），只是示例文字不同；
  英文版里不出现中文任务内容。数据全是编出来的：`example.com` 域名、明显的假密钥，不含真实密钥与个人信息。

截到的是产品当前的真实界面，不是仿制品；`web/` 改了界面，重新跑一遍即可更新截图。

## 用法

需要 Chrome、PATH 里的 ffmpeg（压调色板与缩放）、`node_modules/lucide`（`npm ci` 之后就有）。

```sh
# 英文版（文件名带 -en）：README 用的尺寸出到 docs-out，展示页用的尺寸出到 site-out
node tools/screenshots/shoot.mjs --lang en --out /tmp/shots/docs --site-out /tmp/shots/site
cp /tmp/shots/docs/*-en.png docs/assets/
cp /tmp/shots/site/*-en.png site/assets/

# 中文版（文件名不带后缀）：同一套脚本，换 --lang zh
node tools/screenshots/shoot.mjs --lang zh --out /tmp/shots/docs-zh --site-out /tmp/shots/site-zh
```

参数：

- `--only hero,runs,inspector,api-key,portal`：只生成其中几张；`--themes light`：只生成浅色（默认浅深各一版）。
- `--site-out DIR`：同时输出展示页的尺寸（把同一张图缩到展示页的宽度：`hero`、`inspector`、`portal` 2240 像素，`api-key` 1120 像素；`runs` 展示页不用）。
- `--colors 160`：调色板颜色数，默认 160（与现有截图一致）。

每张图是 1440 CSS 像素宽、2 倍像素的截图，再按固定的框裁剪：`hero` 1440×985、`runs` 1440×640、`inspector` 1440×780、
`portal` 1440×728，`api-key` 取密钥结果对话框的外框。然后压成 160 色的调色板 PNG（不抖动），体积与现有截图同量级。

英文版生成时会检查画面文字里有没有汉字（演示数据本身是英文的），有就以非零退出码结束并指出是哪一张。

## 换示例数据

改 `texts.mjs`（文字）或两个 `*-harness.js`（数字与结构）。两种语言要保持是同一套数据：改了一边，另一边同步改。
