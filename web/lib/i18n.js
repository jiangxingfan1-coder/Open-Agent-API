import { zh as coreZh } from './messages-core-zh.js';
import { en as coreEn } from './messages-core-en.js';
import { zh as viewsZh } from './messages-views-zh.js';
import { en as viewsEn } from './messages-views-en.js';
import { zh as platformZh } from './messages-platform-zh.js';
import { en as platformEn } from './messages-platform-en.js';
import { zh as dialogsZh } from './messages-dialogs-zh.js';
import { en as dialogsEn } from './messages-dialogs-en.js';

// Console i18n. Chinese is the default; a browser that does not prefer Chinese starts in
// English. Switching the language saves the choice and reloads the page, so any module may call
// t() at the top level and keep a plain string.
//
// A message may hold {name} placeholders and, for English counts, {name|one|other}, which picks
// the first form when the value is 1: '{n} {n|agent|agents}'.
//
// The dictionaries sit next to this file as messages-<group>-<lang>.js (groups: core, views,
// platform, dialogs): the gateway serves only flat web/lib/<name>.js files, not a subdirectory.
export const LANG_KEY = 'oaa.console.lang';
const DICT = {
  zh: { ...coreZh, ...viewsZh, ...platformZh, ...dialogsZh },
  en: { ...coreEn, ...viewsEn, ...platformEn, ...dialogsEn },
};

function initialLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // Storage blocked: fall through to the browser language.
  }
  return (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export let lang = initialLang();
const htmlLang = () => (lang === 'zh' ? 'zh-CN' : 'en');
document.documentElement.lang = htmlLang();

/** Locale tag for Intl and toLocale*String calls. */
export const locale = () => (lang === 'zh' ? 'zh-CN' : 'en-US');

/** Remember the language. The caller reloads the page so every string is rebuilt in it. */
export function setLang(next) {
  lang = next === 'en' ? 'en' : 'zh';
  document.documentElement.lang = htmlLang();
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not remembered; still applied until the page is reloaded.
  }
}

export function t(key, params) {
  const text = DICT[lang][key] ?? DICT.zh[key] ?? key;
  if (!params) return text;
  return text
    .replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (_, name, one, other) =>
      Number(params[name]) === 1 ? one : other,
    )
    .replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
}
