// A small, restrained syntax colouring for the documentation site. No dependency, no script on the page:
// the colouring is done at build time and expressed as four CSS classes (comment, string, keyword, number).
// Languages it knows: bash/sh, json, python, javascript/typescript, oaa (OAA-Lang), yaml, nginx/caddyfile.
// Anything else is shown as plain text, which is always correct.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const wrap = (cls, text) => (cls ? `<span class="tk-${cls}">${esc(text)}</span>` : esc(text));

/**
 * Generic scanner. `rules` is a list of [class, regex]; the first rule whose sticky regex matches at the
 * current position wins, otherwise one character is copied through unchanged.
 */
function scan(code, rules) {
  let out = '';
  let pos = 0;
  let plain = '';
  const flush = () => {
    if (plain) out += esc(plain);
    plain = '';
  };
  while (pos < code.length) {
    let matched = false;
    for (const [cls, re] of rules) {
      re.lastIndex = pos;
      const m = re.exec(code);
      if (m && m[0].length > 0) {
        flush();
        out += wrap(cls, m[0]);
        pos += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) plain += code[pos++];
  }
  flush();
  return out;
}

const word = (list) => new RegExp(`(?:${list.join('|')})(?![\\w$-])`, 'y');

const STRING_DQ = /"(?:[^"\\\n]|\\.)*"?/y;
const STRING_SQ = /'(?:[^'\\\n]|\\.)*'?/y;
const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:ms|s|m|h)?(?![\w.])/y;

function bash(code) {
  // Line by line so that "the first word of a command" is easy to find.
  return code
    .split('\n')
    .map((line, index, all) => {
      if (/^\s*#/.test(line)) return wrap('c', line);
      const continued = index > 0 && /\\\s*$/.test(all[index - 1] ?? '');
      let first = !continued;
      const rules = [
        ['c', /(?<=^|\s)#.*/y],
        ['s', STRING_DQ],
        ['s', STRING_SQ],
        ['n', /\$(?:\{[^}\n]*\}|\([^)\n]*\)|[A-Za-z_][A-Za-z0-9_]*)/y],
        ['f', /(?<=\s)--?[A-Za-z][\w-]*/y],
      ];
      // Prompt-style lines ("$ oaa status") and output lines keep their prompt uncoloured.
      let prefix = '';
      const prompt = /^(\s*[$>]\s+)/.exec(line);
      if (prompt) {
        prefix = prompt[1];
        line = line.slice(prefix.length);
      }
      let out = '';
      if (first && !continued) {
        const cmd = /^(\s*)((?:[A-Za-z_][\w-]*=\S*\s+)*)([A-Za-z0-9_./~-]+)/.exec(line);
        if (cmd && !/^\s*[-{}[\]]/.test(line)) {
          out += esc(cmd[1]) + esc(cmd[2]) + wrap('k', cmd[3]);
          line = line.slice(cmd[0].length);
          first = false;
        }
      }
      return esc(prefix) + out + scan(line, rules);
    })
    .join('\n');
}

function json(code) {
  return scan(code, [
    ['k', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y],
    ['s', STRING_DQ],
    ['n', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])/y],
    ['n', word(['true', 'false', 'null'])],
  ]);
}

function python(code) {
  return scan(code, [
    ['c', /#.*/y],
    ['s', /(?:[rbfRBF]{0,2})(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y],
    ['s', /(?:[rbfRBF]{0,2})"(?:[^"\\\n]|\\.)*"?/y],
    ['s', /(?:[rbfRBF]{0,2})'(?:[^'\\\n]|\\.)*'?/y],
    [
      'k',
      word([
        'and',
        'as',
        'assert',
        'async',
        'await',
        'break',
        'class',
        'continue',
        'def',
        'del',
        'elif',
        'else',
        'except',
        'finally',
        'for',
        'from',
        'global',
        'if',
        'import',
        'in',
        'is',
        'lambda',
        'nonlocal',
        'not',
        'or',
        'pass',
        'raise',
        'return',
        'try',
        'while',
        'with',
        'yield',
      ]),
    ],
    ['n', word(['True', 'False', 'None'])],
    ['n', NUMBER],
  ]);
}

function javascript(code) {
  return scan(code, [
    ['c', /\/\/.*/y],
    ['c', /\/\*[\s\S]*?(?:\*\/|$)/y],
    ['s', /`(?:[^`\\]|\\.)*`?/y],
    ['s', STRING_DQ],
    ['s', STRING_SQ],
    [
      'k',
      word([
        'as',
        'async',
        'await',
        'break',
        'case',
        'catch',
        'class',
        'const',
        'continue',
        'default',
        'delete',
        'do',
        'else',
        'export',
        'extends',
        'finally',
        'for',
        'from',
        'function',
        'if',
        'import',
        'in',
        'instanceof',
        'interface',
        'let',
        'new',
        'of',
        'return',
        'switch',
        'throw',
        'try',
        'type',
        'typeof',
        'var',
        'while',
        'yield',
      ]),
    ],
    ['n', word(['true', 'false', 'null', 'undefined'])],
    ['n', NUMBER],
  ]);
}

function oaa(code) {
  return scan(code, [
    ['c', /#.*/y],
    ['c', /\/\/.*/y],
    ['c', /\/\*[\s\S]*?(?:\*\/|$)/y],
    ['s', /"""[\s\S]*?(?:"""|$)/y],
    ['s', STRING_DQ],
    ['s', STRING_SQ],
    [
      'k',
      word([
        'agent',
        'let',
        'flow',
        'step',
        'foreach',
        'import',
        'tool',
        'if',
        'else',
        'workflow',
        'route',
        'limits',
        'when',
        'input',
        'output',
        'type',
      ]),
    ],
    ['n', word(['true', 'false', 'null'])],
    ['n', NUMBER],
  ]);
}

function hashComments(code) {
  return scan(code, [
    ['c', /(?<=^|\s)#.*/my],
    ['s', STRING_DQ],
    ['s', STRING_SQ],
    ['n', NUMBER],
  ]);
}

const LANGUAGES = {
  bash,
  sh: bash,
  shell: bash,
  zsh: bash,
  json,
  jsonc: json,
  python,
  py: python,
  javascript,
  js: javascript,
  mjs: javascript,
  ts: javascript,
  typescript: javascript,
  oaa,
  yaml: hashComments,
  yml: hashComments,
  toml: hashComments,
  nginx: hashComments,
  caddyfile: hashComments,
};
/** Returns HTML (already escaped) for a code block of the given fence language. */
export function highlight(code, lang) {
  const fn = LANGUAGES[String(lang ?? '').toLowerCase()];
  if (!fn) return esc(code);
  return fn(code);
}

export const KNOWN_LANGUAGES = Object.keys(LANGUAGES);
