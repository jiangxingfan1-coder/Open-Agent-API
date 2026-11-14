// 会上镜或会导出的文本里不允许出现的东西：本机路径（含 file:// 链接与 ~/ 开头的路径）与密钥值。
// record.mjs 导出时用 makeScrubber 遮蔽；render.mjs 与渲染页在上镜前用 SCREEN_FORBIDDEN 再兜底检查。

/** 路径被遮蔽后留下的文字（中文录制与英文录制各一份）。 */
export const PATH_PLACEHOLDER = '（本机路径已遮蔽）';
export const PATH_PLACEHOLDER_EN = '(local path hidden)';

/**
 * 画面上不得出现的模式。写成 [source, flags]，方便原样传给渲染页（页面里用 new RegExp 重建）。
 * 前置的 (?<![\w.:~-]) 避免把 agent/demo-approval、127.0.0.1:8787/v1/ 这类正常文字当成路径。
 */
export const SCREEN_FORBIDDEN = [
  ['file:\\/\\/', 'i'],
  ['(?<![\\w.:-])~\\/', ''],
  ['(?<![\\w.:~-])\\/(?:Users|Volumes|private|var|tmp|home|root|etc|opt)\\/', ''],
  ['(?<![\\w.:~-])\\/(?:demo|repo)(?![\\w-])', ''],
  ['(?<![\\w])[A-Za-z]:\\\\\\\\?[\\w.-]', ''],
];
export const SECRET_SHAPES = [['sk-oaa-(?!\\[REDACTED\\])[A-Za-z0-9_-]{8,}', '']];

/** 在 text 里找第一处违规，返回 {pattern, index, context}；没有返回 null。 */
export function findForbidden(text, patterns = [...SCREEN_FORBIDDEN, ...SECRET_SHAPES]) {
  for (const [source, flags] of patterns) {
    const m = new RegExp(source, flags).exec(text);
    if (m)
      return {
        pattern: `/${source}/${flags}`,
        index: m.index,
        context: text.slice(Math.max(0, m.index - 30), m.index + 60).replace(/\s+/g, ' '),
      };
  }
  return null;
}

// JSON 文本里的路径：以 file:// 或 ~/ 或被遮蔽后的 /demo、/repo 开头，到空白、括号、引号、转义符为止。
const PATHISH = String.raw`[^\s)\]}"'\\,;，；）」]*`;
const PATH_PATTERNS = [
  new RegExp(String.raw`file://${PATHISH}`, 'gi'),
  new RegExp(String.raw`(?<![\w.:-])~/${PATHISH}`, 'g'),
  new RegExp(String.raw`(?<![\w.:~-])/(?:demo|repo)(?:/${PATHISH})?(?![\w-])`, 'g'),
];

/**
 * @param {{ redact: (s: string) => string, masks: [string, string][], port?: () => number | null, placeholder?: string }} o
 * 返回 scrub(value)：对任意 JSON 值先遮蔽密钥、把网关地址写成展示用的默认端口、把本机路径换成占位，再还原成对象。
 */
export function makeScrubber({ redact, masks, port = () => null, placeholder = PATH_PLACEHOLDER }) {
  const scrubText = (input) => {
    let text = redact(input);
    const p = port();
    if (p) text = text.split(`127.0.0.1:${p}`).join('127.0.0.1:8787');
    for (const [from, to] of masks) if (from) text = text.split(from).join(to);
    for (const re of PATH_PATTERNS) text = text.replace(re, placeholder);
    return text;
  };
  const scrub = (value) => JSON.parse(scrubText(JSON.stringify(value)));
  scrub.text = scrubText;
  return scrub;
}
