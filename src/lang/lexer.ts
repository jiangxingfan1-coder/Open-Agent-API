import { Fault } from '../core/util.js';

export type TokenType =
  | 'STRING'
  | 'NUMBER'
  | 'IDENT'
  | 'EXPR'
  | 'LBRACE'
  | 'RBRACE'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'LPAREN'
  | 'RPAREN'
  | 'EQ'
  | 'COLON'
  | 'COMMA'
  | 'QUESTION'
  | 'PIPE'
  | 'AT'
  | 'ARROW'
  | 'SLASH'
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

export function dedentTripleString(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n');
  if (text.startsWith('\n')) text = text.slice(1);
  const lines = text.split('\n');
  if (lines.length > 0 && lines.at(-1)!.trim() === '') {
    lines.pop();
  }
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^[ \t]*/.exec(line);
    if (match) minIndent = Math.min(minIndent, match[0].length);
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return lines.join('\n');
  return lines.map((line) => (line.trim() ? line.slice(minIndent) : '')).join('\n');
}

/** `onComment` 每遇到一条注释调用一次（格式化会丢掉注释，调用方据此提醒）。 */
export function tokenizeOaaLang(source: string, onComment?: () => void): Token[] {
  if (source.length > 512_000) {
    throw new Fault('oaa_syntax_error', 'OAA source file exceeds the 512 KiB compiler limit.');
  }
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (count = 1) => {
    for (let k = 0; k < count; k++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }

    // Line comments (# or //)
    if (ch === '#' || (ch === '/' && source[i + 1] === '/')) {
      onComment?.();
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }

    // Block comments (/* ... */)
    if (ch === '/' && source[i + 1] === '*') {
      onComment?.();
      const startLine = line;
      const startCol = col;
      advance(2);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        advance();
      }
      if (i >= source.length) {
        throw new Fault(
          'oaa_syntax_error',
          `Line ${startLine}, Col ${startCol}: Unterminated block comment.`,
        );
      }
      advance(2);
      continue;
    }

    const startLine = line;
    const startCol = col;

    // Inline OAA-VM expression block: $( ... )
    if (ch === '$' && source[i + 1] === '(') {
      advance(2);
      let depth = 1;
      let exprBuf = '';
      while (i < source.length && depth > 0) {
        const c = source[i]!;
        if (c === '"' || c === "'") {
          const q = c;
          exprBuf += c;
          advance();
          while (i < source.length && source[i] !== q) {
            if (source[i] === '\\' && i + 1 < source.length) {
              exprBuf += source[i]! + source[i + 1]!;
              advance(2);
            } else {
              exprBuf += source[i]!;
              advance();
            }
          }
          if (i < source.length) {
            exprBuf += source[i]!;
            advance();
          }
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
        exprBuf += c;
        advance();
      }
      if (depth !== 0 || source[i] !== ')') {
        throw new Fault(
          'oaa_syntax_error',
          `Line ${startLine}, Col ${startCol}: Unterminated '$(...)' expression block.`,
        );
      }
      advance(); // consume closing ')'
      tokens.push({
        type: 'EXPR',
        value: exprBuf.trim(),
        line: startLine,
        col: startCol,
      });
      continue;
    }

    // Triple-quoted multiline string """..."""
    if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
      advance(3);
      let buf = '';
      while (
        i < source.length &&
        !(source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"')
      ) {
        buf += source[i];
        advance();
      }
      if (i >= source.length) {
        throw new Fault(
          'oaa_syntax_error',
          `Line ${startLine}, Col ${startCol}: Unterminated triple-quoted string.`,
        );
      }
      advance(3);
      tokens.push({
        type: 'STRING',
        value: dedentTripleString(buf),
        line: startLine,
        col: startCol,
      });
      continue;
    }

    // Quoted string "..." or '...'
    if (ch === '"' || ch === "'") {
      const quote = ch;
      advance();
      let buf = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\n') {
          throw new Fault(
            'oaa_syntax_error',
            `Line ${startLine}, Col ${startCol}: Unterminated string literal.`,
          );
        }
        if (source[i] === '\\') {
          advance();
          if (i >= source.length) break;
          const esc = source[i]!;
          if (esc === 'n') buf += '\n';
          else if (esc === 'r') buf += '\r';
          else if (esc === 't') buf += '\t';
          else if (esc === 'b') buf += '\b';
          else if (esc === 'f') buf += '\f';
          else if (esc === 'u') {
            const hex = source.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex))
              throw new Fault(
                'oaa_syntax_error',
                `Line ${line}, Col ${col}: Invalid Unicode escape.`,
              );
            buf += String.fromCharCode(Number.parseInt(hex, 16));
            advance(4);
          } else if (esc === '"' || esc === "'" || esc === '\\' || esc === '/') buf += esc;
          else buf += esc;
          advance();
        } else {
          buf += source[i];
          advance();
        }
      }
      if (i >= source.length || source[i] !== quote) {
        throw new Fault(
          'oaa_syntax_error',
          `Line ${startLine}, Col ${startCol}: Unterminated string literal.`,
        );
      }
      advance();
      tokens.push({ type: 'STRING', value: buf, line: startLine, col: startCol });
      continue;
    }

    // Arrow ->
    if (ch === '-' && source[i + 1] === '>') {
      advance(2);
      tokens.push({ type: 'ARROW', value: '->', line: startLine, col: startCol });
      continue;
    }

    // Single-char punctuation
    const singleMap: Record<string, TokenType> = {
      '{': 'LBRACE',
      '}': 'RBRACE',
      '[': 'LBRACKET',
      ']': 'RBRACKET',
      '(': 'LPAREN',
      ')': 'RPAREN',
      '=': 'EQ',
      ':': 'COLON',
      ',': 'COMMA',
      '?': 'QUESTION',
      '|': 'PIPE',
      '@': 'AT',
      '/': 'SLASH',
    };
    if (ch in singleMap) {
      advance();
      tokens.push({ type: singleMap[ch]!, value: ch, line: startLine, col: startCol });
      continue;
    }

    // Numbers & duration literals (e.g. 500ms, 30s, 5m, 1h)
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '-' && source[i + 1]! >= '0' && source[i + 1]! <= '9')
    ) {
      let num = ch;
      advance();
      while (i < source.length && /[0-9.]/.test(source[i]!)) {
        num += source[i];
        advance();
      }
      // 科学计数法：1e3、2.5E-4
      if (
        (source[i] === 'e' || source[i] === 'E') &&
        (/[0-9]/.test(source[i + 1] ?? '') ||
          (/[+-]/.test(source[i + 1] ?? '') && /[0-9]/.test(source[i + 2] ?? '')))
      ) {
        num += source[i]! + source[i + 1]!;
        advance(2);
        while (i < source.length && /[0-9]/.test(source[i]!)) {
          num += source[i];
          advance();
        }
      }
      const numeric = Number(num);
      if (Number.isNaN(numeric)) {
        throw new Fault(
          'oaa_syntax_error',
          `Line ${startLine}, Col ${startCol}: Invalid numeric literal '${num}'.`,
        );
      }
      if (!Number.isFinite(numeric)) {
        throw new Fault(
          'oaa_syntax_error',
          `Line ${startLine}, Col ${startCol}: Numeric literal '${num}' is out of range.`,
        );
      }
      // Check optional duration unit suffix (ms, s, m, h)
      let unit = '';
      if (i < source.length && /[a-zA-Z]/.test(source[i]!)) {
        let u = '';
        let k = i;
        while (k < source.length && /[a-zA-Z0-9_]/.test(source[k]!)) {
          u += source[k];
          k++;
        }
        if (u === 'ms' || u === 's' || u === 'm' || u === 'h') {
          unit = u;
          advance(u.length);
        }
      }
      const multiplier =
        unit === 'ms'
          ? 1
          : unit === 's'
            ? 1000
            : unit === 'm'
              ? 60_000
              : unit === 'h'
                ? 3_600_000
                : 1;
      tokens.push({
        type: 'NUMBER',
        value: String(unit ? Math.round(numeric * multiplier) : numeric),
        line: startLine,
        col: startCol,
      });
      continue;
    }

    // Identifiers (including $ref paths like $input.query or $step#/field)
    if (/[A-Za-z_$]/.test(ch)) {
      let ident = ch;
      advance();
      while (
        i < source.length &&
        (/[A-Za-z0-9_.-]/.test(source[i]!) ||
          (ident.startsWith('$') && (source[i] === '#' || source[i] === '/')))
      ) {
        ident += source[i];
        advance();
      }
      tokens.push({ type: 'IDENT', value: ident, line: startLine, col: startCol });
      continue;
    }

    throw new Fault(
      'oaa_syntax_error',
      `Line ${startLine}, Col ${startCol}: Unexpected character '${ch}'.`,
    );
  }

  tokens.push({ type: 'EOF', value: '', line, col });
  return tokens;
}

/** 源码里是否有注释（格式化会丢掉注释）。源码有词法错误时，只看出错位置之前的部分。 */
export function oaaSourceHasComments(source: string): boolean {
  let found = false;
  try {
    tokenizeOaaLang(source, () => {
      found = true;
    });
  } catch {
    // 词法错误交给编译器去报。
  }
  return found;
}
