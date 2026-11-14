/**
 * 语言选择：返回给调用方的错误说明与命令行输出用中文还是英文。
 *
 * - 进程默认语言：环境变量 `OAA_LOCALE`（zh | en）优先；否则看系统区域 `LC_ALL` → `LC_MESSAGES` →
 *   `LANG`，再不行看 `Intl.DateTimeFormat().resolvedOptions().locale`。以 zh 开头为中文，其余为英文。
 *   这样中文系统上的已有用户照旧是中文，英文系统上开箱是英文。
 * - HTTP 请求：`Accept-Language` 里权重最高的明确语言以 zh 开头为中文，其他明确语言为英文；
 *   没有这个头、或只有 `*`（undici 的 fetch 默认发送）时用进程默认语言。
 * - 双语文案用 `bi(zh, en)` 写在抛出点；`pick` 按语言取一边。
 */
export type Locale = 'zh' | 'en';

export interface LocalText {
  readonly zh: string;
  readonly en: string;
}

export const bi = (zh: string, en: string): LocalText => ({ zh, en });

const fromTag = (tag: string | undefined): Locale | undefined => {
  const t = tag?.trim().toLowerCase();
  if (!t || t === 'c' || t === 'posix' || t === '*') return undefined;
  return t.startsWith('zh') ? 'zh' : 'en';
};

/** 进程默认语言（每次按当前环境计算，测试与长驻进程都能即时生效）。 */
export function processLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const forced = env.OAA_LOCALE?.trim().toLowerCase();
  if (forced === 'zh' || forced === 'en') return forced;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const found = fromTag(env[name]);
    if (found) return found;
  }
  try {
    return fromTag(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en';
  } catch {
    return 'en';
  }
}

/** 按 `Accept-Language` 选语言；没有明确语言时用 `fallback`（默认为进程默认语言）。 */
export function requestLocale(
  acceptLanguage: string | string[] | undefined,
  fallback: Locale = processLocale(),
): Locale {
  const header = Array.isArray(acceptLanguage) ? acceptLanguage.join(',') : acceptLanguage;
  let best: { locale: Locale; q: number } | undefined;
  for (const part of (header ?? '').split(',').slice(0, 32)) {
    const [tag, ...params] = part.split(';');
    const locale = fromTag(tag);
    if (!locale) continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { locale, q };
  }
  return best?.locale ?? fallback;
}

/** 取一边的文案；普通字符串原样返回。 */
export const pick = (text: string | LocalText, locale: Locale = processLocale()): string =>
  typeof text === 'string' ? text : text[locale];
