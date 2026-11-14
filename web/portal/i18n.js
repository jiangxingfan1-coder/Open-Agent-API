import { zh } from './messages-zh.js';
import { en } from './messages-en.js';

// Chinese is the default; a browser that does not prefer Chinese starts in English.
const LANG_KEY = 'oaa.portal.lang';
const DICT = { zh, en };

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
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'zh';
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Not remembered; still applied for this visit.
  }
}

export function t(key, params) {
  const text = DICT[lang][key] ?? DICT.zh[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '') : text;
}

// Error copy by `error.code`; a code we have no copy for shows the server's own message.
export function errorMessage(err) {
  const key = `error.${err?.code}`;
  if (DICT[lang][key] || DICT.zh[key]) return t(key);
  // A server fault has no copy of ours: say so in the page's language, not in the server's.
  if (err?.status >= 500) return t('error.server');
  return err?.message || err?.code || t('error.unknown');
}
