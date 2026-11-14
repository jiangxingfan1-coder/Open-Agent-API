# Open Agent API 品牌标识

## 标志：O 与 A 互扣

一条细线写成的字母 O 与 A，像两枚链环扣在一起：

- **O（Open）**：一个开放协议、一个统一入口——任何调用方都从这里进入。
- **A（Agent / API）**：被发布、可被调用的智能体。
- **互扣**：A 的左腿在上方压过 O，在下方从 O 底下穿过。智能体与开放协议彼此咬合，谁也离不开谁；穿插处的断口沿用 Possibility 标志的「开放交叉」，两款产品因此属于同一家族。

## 家族规则（与 Possibility 一致）

| 项目 | 规格 |
| --- | --- |
| 网格 | 256 × 256 |
| 图标底板 | 白色圆角方块，内缩 4，圆角 56，无阴影 |
| 线条 | 纯黑 `#000000`，线宽 8，圆头、圆角连接 |
| 穿插断口 | 被压住的线在交叉点两侧各留出 19 的空隙 |
| 小尺寸 | favicon 与界面内 ≤ 32 px 时线宽加粗到 12–15，保证可读 |

界面配色沿用 Possibility 的 Möbius 设计语言：墨 `#132220`、纸 `#F5F3EE` / `#ECE9E1`、潮（蒂芙尼绿）`#81D8D0`，朱砂只用于需要人工处理的状态（审批、结果未知）。

## 文件

| 文件 | 用途 |
| --- | --- |
| `oaa-app-icon.svg` / `oaa-app-icon-1024.png` | 应用图标（白底黑线） |
| `oaa-mark.svg` | 透明底黑色标志 |
| `oaa-mark-ink.svg` | 透明底墨色标志（用于纸色背景） |
| `oaa-mark-inverse.svg` | 透明底浅色标志（用于深色背景） |
| `../../web/brand.svg` | 浏览器 favicon |

所有文件都由 `scripts/brand-icon.mjs` 中的同一份几何生成，修改标志时只改那里，然后运行：

```bash
node scripts/brand-assets.mjs
```

打包脚本（`npm run package:mac` / `package:win`）也调用同一模块生成 `.icns` 与 Windows 图标。

## 使用注意

- 不要拉伸、旋转标志，也不要给线条加描边、渐变或投影。
- 不要把断口补成连续的线——断口是标志的一部分。
- 文字组合使用斜体衬线 `Open Agent API`（Instrument Serif，缺失时回退到 Iowan Old Style / Georgia），与标志高度大致对齐。
