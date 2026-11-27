'use strict';

const { stripTypeScriptTypes } = require('node:module');

const RESERVED_NS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

const REGEX_AFTER = new Set([
  '', '(', ')ctrl', '[', '{', '${', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~', '<', '>', '+', '-',
  '*', '%', '/', '=>', '...', 'return', 'throw', 'case', 'default', 'typeof', 'void', 'delete',
  'in', 'instanceof', 'new', 'else', 'do', 'yield', 'await', 'of',
]);

function isIdentStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 128;
}

function isIdentPart(c) {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}

// Lightweight JS/TS lexer producing token spans (skipping comments and whitespace).
// Returns null on unterminated comment/string/template/regex.
function tokenize(source, isJsx = false) {
  const tokens = [];
  const braces = [];
  const parens = [];
  let prev = '';
  let i = 0;
  const n = source.length;
  if (source.startsWith('#!')) {
    while (i < n && source[i] !== '\n' && source[i] !== '\r') i++;
  }
  const skipTpl = (start) => {
    let p = start;
    while (p < n) {
      const c = source[p];
      if (c === '\\') { p += 2; continue; }
      if (c === '`') {
        tokens.push({ type: 'str', text: source.slice(start - 1, p + 1), start: start - 1, end: p + 1 });
        prev = 'lit';
        return p + 1;
      }
      if (c === '$' && source[p + 1] === '{') {
        tokens.push({ type: 'tpl', text: source.slice(start - 1, p + 2), start: start - 1, end: p + 2 });
        braces.push('tpl');
        prev = '${';
        return p + 2;
      }
      p++;
    }
    return -1;
  };
  while (i < n) {
    const ch = source.charCodeAt(i);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 11 || ch === 12 || ch === 0xa0 || ch === 0xfeff || ch === 0x2028 || ch === 0x2029) {
      i++;
      continue;
    }
    if (ch === 47 && source.charCodeAt(i + 1) === 47) {
      i += 2;
      while (i < n && source[i] !== '\n' && source[i] !== '\r' && source[i] !== '\u2028' && source[i] !== '\u2029') i++;
      continue;
    }
    if (ch === 47 && source.charCodeAt(i + 1) === 42) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (ch === 34 || ch === 39) {
      const q = source[i], start = i++;
      while (i < n && source[i] !== q) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === '\n' || source[i] === '\r') return null;
        else i++;
      }
      if (i >= n) return null;
      i++;
      tokens.push({ type: 'str', text: source.slice(start, i), start, end: i });
      prev = 'lit';
      continue;
    }
    if (ch === 96) {
      const next = skipTpl(i + 1);
      if (next < 0) return null;
      i = next;
      continue;
    }
    if (ch === 123) {
      braces.push('{');
      tokens.push({ type: 'punc', text: '{', start: i, end: i + 1 });
      prev = '{';
      i++;
      continue;
    }
    if (ch === 125) {
      if (braces.length > 0 && braces[braces.length - 1] === 'tpl') {
        braces.pop();
        const next = skipTpl(i + 1);
        if (next < 0) return null;
        i = next;
        continue;
      }
      if (braces.length > 0) braces.pop();
      tokens.push({ type: 'punc', text: '}', start: i, end: i + 1 });
      prev = '}';
      i++;
      continue;
    }
    if (ch === 47 && REGEX_AFTER.has(prev) && !(isJsx && (prev === '<' || source[i + 1] === '>'))) {
      const start = i++;
      let inClass = false, closed = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n' || c === '\r') return null;
        if (inClass) { if (c === ']') inClass = false; }
        else if (c === '[') inClass = true;
        else if (c === '/') { closed = true; i++; break; }
        i++;
      }
      if (!closed) return null;
      while (i < n && isIdentPart(source.charCodeAt(i))) i++;
      tokens.push({ type: 'regex', text: source.slice(start, i), start, end: i });
      prev = 'lit';
      continue;
    }
    if (isIdentStart(ch) || (ch === 92 && source[i + 1] === 'u')) {
      const start = i;
      while (i < n) {
        if (source.charCodeAt(i) === 92 && source[i + 1] === 'u') {
          if (source[i + 2] === '{') {
            const endB = source.indexOf('}', i + 3);
            if (endB < 0) return null;
            i = endB + 1;
          } else if (i + 6 <= n) {
            i += 6;
          } else {
            return null;
          }
          continue;
        }
        if (i === start ? isIdentStart(source.charCodeAt(i)) : isIdentPart(source.charCodeAt(i))) {
          i++;
          continue;
        }
        break;
      }
      const text = source.slice(start, i);
      tokens.push({ type: 'id', text, start, end: i });
      prev = prev === '.' ? 'prop' : text;
      continue;
    }
    if ((ch >= 48 && ch <= 57) || (ch === 46 && source.charCodeAt(i + 1) >= 48 && source.charCodeAt(i + 1) <= 57)) {
      const start = i++;
      while (i < n && (isIdentPart(source.charCodeAt(i)) || source[i] === '.')) {
        if ((source[i] === 'e' || source[i] === 'E') && (source[i + 1] === '+' || source[i + 1] === '-')) i += 2;
        else i++;
      }
      tokens.push({ type: 'num', text: source.slice(start, i), start, end: i });
      prev = 'lit';
      continue;
    }
    // Multi-char operators we care about
    if (ch === 61 && source.charCodeAt(i + 1) === 62) {
      tokens.push({ type: 'punc', text: '=>', start: i, end: i + 2 });
      prev = '=>';
      i += 2;
      continue;
    }
    if (ch === 46 && source.charCodeAt(i + 1) === 46 && source.charCodeAt(i + 2) === 46) {
      tokens.push({ type: 'punc', text: '...', start: i, end: i + 3 });
      prev = '...';
      i += 3;
      continue;
    }
    const text = source[i];
    const prevTok = tokens.length > 0 ? tokens[tokens.length - 1] : null;
    tokens.push({ type: 'punc', text, start: i, end: i + 1 });
    if (text === '(') {
      parens.push(prev === 'if' || prev === 'while' || prev === 'for' || prev === 'with');
      prev = '(';
    } else if (text === ')') {
      prev = parens.pop() ? ')ctrl' : ')';
    } else if ((text === '+' || text === '-') && prevTok && prevTok.type === 'punc' && prevTok.text === text && prevTok.end === i) {
      prev = text + text;
    } else {
      prev = text;
    }
    i++;
  }
  return tokens;
}

function findMatchingBrace(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc' && t.text === '{') depth++;
    else if (t.type === 'punc' && t.text === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingParen(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc' && t.text === '(') depth++;
    else if (t.type === 'punc' && t.text === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasNewlineBetween(source, aEnd, bStart) {
  for (let i = aEnd; i < bStart; i++) {
    const c = source.charCodeAt(i);
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// True iff the source has a top-level (brace-depth 0) `import` or `export` statement
// (excluding `export as namespace`, `import(...)`, `import.meta`, and anything inside `declare namespace/module`).
function hasTopLevelModuleSyntax(source) {
  if (!/\b(?:import|export)\b/.test(source)) return false;
  const tokens = tokenize(source);
  if (!tokens) return false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc' && t.text === '{') { depth++; continue; }
    if (t.type === 'punc' && t.text === '}') { if (depth > 0) depth--; continue; }
    if (depth !== 0 || t.type !== 'id') continue;
    const prev = i > 0 ? tokens[i - 1] : null;
    if (prev && prev.type === 'punc' && prev.text === '.') continue;
    if (t.text === 'export') {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.type === 'id' && next.text === 'as' && tokens[i + 2]?.text === 'namespace') continue;
      if (next.type === 'punc' && next.text === '=') return true;
      if (next.type === 'punc' && (next.text === '{' || next.text === '*')) return true;
      if (next.type === 'id') return true;
    } else if (t.text === 'import') {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.type === 'punc' && (next.text === '(' || next.text === '.')) continue;
      // Internal namespace alias `import [type] Ident = QualifiedName` (not `= require(...)`) is NOT a module marker.
      let k = i + 1;
      if (tokens[k]?.type === 'id' && tokens[k].text === 'type') k++;
      if (tokens[k]?.type === 'id' && tokens[k + 1]?.type === 'punc' && tokens[k + 1].text === '=') {
        if (tokens[k + 2]?.type === 'id' && tokens[k + 2].text === 'require') return true;
        continue;
      }
      if (next.type === 'str' || (next.type === 'punc' && (next.text === '{' || next.text === '*')) || next.type === 'id') return true;
    }
  }
  return false;
}

// Rewrites top-level `import x = require("...")` -> `const x = require("...")`,
// `export import x = require("...")` -> `export const x = require("...")`,
// `export = expr` -> `module.exports = expr`, and erases `export as namespace X;`
// in `module: 'preserve'` mode.
function preprocessPreserveCjs(source, isJsx = false) {
  if (!source.includes('require') && !source.includes('export')) {
    return { code: source, changed: false, hasCjsModule: false };
  }
  const tokens = tokenize(source, isJsx);
  if (!tokens) return null;
  const edits = [];
  let hasCjsModule = false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc' && t.text === '{') { depth++; continue; }
    if (t.type === 'punc' && t.text === '}') { if (depth > 0) depth--; continue; }
    if (depth !== 0 || t.type !== 'id') continue;
    const prev = i > 0 ? tokens[i - 1] : null;
    if (prev && !(prev.type === 'punc' && (prev.text === ';' || prev.text === '}' || prev.text === ':')) &&
        !hasNewlineBetween(source, prev.end, t.start)) {
      continue;
    }

    // `export as namespace Foo;` -> blank
    if (t.text === 'export' && tokens[i + 1]?.text === 'as' && tokens[i + 2]?.text === 'namespace' &&
        tokens[i + 3]?.type === 'id') {
      let endIdx = i + 3;
      if (tokens[endIdx + 1]?.type === 'punc' && tokens[endIdx + 1].text === ';') endIdx++;
      const blank = source.slice(t.start, tokens[endIdx].end).replace(/[^\r\n]/g, ' ');
      edits.push({ start: t.start, end: tokens[endIdx].end, text: blank });
      i = endIdx;
      continue;
    }

    // `[export] import ident = require(str)` -> `[export ]const ident = require(str)`
    let isExport = false;
    let impIdx = i;
    if (t.text === 'export' && tokens[i + 1]?.type === 'id' && tokens[i + 1].text === 'import') {
      isExport = true;
      impIdx = i + 1;
    }
    if (tokens[impIdx]?.type === 'id' && tokens[impIdx].text === 'import' &&
        tokens[impIdx + 1]?.type === 'id' &&
        tokens[impIdx + 2]?.type === 'punc' && tokens[impIdx + 2].text === '=' &&
        tokens[impIdx + 3]?.type === 'id' && tokens[impIdx + 3].text === 'require' &&
        tokens[impIdx + 4]?.type === 'punc' && tokens[impIdx + 4].text === '(') {
      const closeParen = findMatchingParen(tokens, impIdx + 4);
      if (closeParen < 0) return null;
      // Only simple string literal inside require("..."); skip ASI-hazardous followers `(`, `[`, `/` without `;`
      if (closeParen === impIdx + 6 && tokens[impIdx + 5].type === 'str') {
        const afterTok = tokens[closeParen + 1];
        if (afterTok && afterTok.text !== ';' && (afterTok.text === '(' || afterTok.text === '[' || afterTok.type === 'regex')) {
          return null;
        }
        edits.push({ start: tokens[impIdx].start, end: tokens[impIdx].end, text: 'const' });
        hasCjsModule = true;
        i = closeParen;
        continue;
      }
    }

    // `[declare] [export] export = expr` -> `module.exports = expr`
    if (t.text === 'declare' || t.text === 'export') {
      let ek = i;
      while (ek < tokens.length && (tokens[ek].text === 'declare' || tokens[ek].text === 'export')) ek++;
      if (ek > i && tokens[ek - 1].text === 'export' && tokens[ek]?.type === 'punc' && tokens[ek].text === '=' &&
          !(tokens[ek + 1]?.type === 'punc' && (tokens[ek + 1].text === '=' || tokens[ek + 1].text === '>'))) {
        edits.push({ start: t.start, end: tokens[ek - 1].end, text: 'module.exports' });
        hasCjsModule = true;
        i = ek;
        continue;
      }
    }
  }
  if (edits.length === 0) return { code: source, changed: false, hasCjsModule: false };
  let out = '', pos = 0;
  for (const e of edits) {
    out += source.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += source.slice(pos);
  return { code: out, changed: true, hasCjsModule };
}

// Validates and erases top-level `declare module ... { ... }` and `declare namespace ... { ... }` blocks.
// Uses Node's stripTypeScriptTypes on each block to guarantee zero false positives on syntax errors.
function eraseValidatedAmbientBlocks(source, isJsx = false) {
  if (!source.includes('declare')) return source;
  const tokens = tokenize(source, isJsx);
  if (!tokens) return null;
  const edits = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc' && t.text === '{') { depth++; continue; }
    if (t.type === 'punc' && t.text === '}') { if (depth > 0) depth--; continue; }
    if (depth !== 0 || t.type !== 'id' || t.text !== 'declare') continue;
    const kw = tokens[i + 1];
    if (!kw || kw.type !== 'id' || (kw.text !== 'module' && kw.text !== 'namespace' && kw.text !== 'global')) continue;
    if (hasNewlineBetween(source, t.end, kw.start)) continue;
    let nameIdx = i + 2;
    let isStringName = false;
    if (kw.text === 'global') {
      if (hasNewlineBetween(source, kw.end, tokens[nameIdx]?.start ?? kw.end)) continue;
    } else if (tokens[nameIdx]?.type === 'str' && kw.text === 'module') {
      if (hasNewlineBetween(source, kw.end, tokens[nameIdx].start)) continue;
      isStringName = true;
      nameIdx++;
    } else if (tokens[nameIdx]?.type === 'id') {
      if (hasNewlineBetween(source, kw.end, tokens[nameIdx].start)) continue;
      if (RESERVED_NS.has(tokens[nameIdx].text)) return null;
      nameIdx++;
      while (tokens[nameIdx]?.type === 'punc' && tokens[nameIdx].text === '.' && tokens[nameIdx + 1]?.type === 'id') {
        nameIdx += 2;
      }
    } else {
      continue;
    }
    if (tokens[nameIdx]?.type !== 'punc' || tokens[nameIdx].text !== '{') continue;
    const closeIdx = findMatchingBrace(tokens, nameIdx);
    if (closeIdx < 0) return null;
    // Validate the block syntax with Node's stripTypeScriptTypes!
    const bodyText = source.slice(tokens[nameIdx].start, tokens[closeIdx].end);
    const header = kw.text === 'global'
      ? 'declare global '
      : isStringName
        ? 'declare namespace __tmt_amb__ '
        : 'declare namespace ' + source.slice(tokens[i + 2].start, tokens[nameIdx].start);
    try {
      stripTypeScriptTypes(header + bodyText);
    } catch (err) {
      const em = String(err?.message || '');
      let relaxedBody = bodyText;
      if (em.includes('`declare` modifier not allowed') || em.includes('`module` keyword is not supported') ||
          em.includes('Import declarations in a namespace') || em.includes("Expected ';', '}' or <eof>") ||
          em.includes("Expected '{', got 'export'")) {
        relaxedBody = relaxedBody.replace(/(?<=^|[;\r\n{])[ \t]*((?:export[ \t]+|declare[ \t]+)*)module(?=[ \t]+[A-Za-z_$][\w$.]*[ \t]*\{)/g, '$1namespace');
        relaxedBody = relaxedBody.replace(/\bexport([ \t]+)export(?=[ \t]+(?:var|let|const|function|class|enum|namespace|module|interface|type|abstract|async|declare|import)\b)/g, 'export$1      ');
        relaxedBody = relaxedBody.replace(/(?<=^|[;\r\n{])[ \t]*(export[ \t]+)?declare(?=[ \t]+(?:export[ \t]+)?(?:class|function|var|let|const|enum|namespace|module|interface|type|abstract|async|import)\b)/g, '$1       ');
        relaxedBody = relaxedBody.replace(/(?<=^|[;\r\n{])[ \t]*(?:export[ \t]+)?import[ \t]+[A-Za-z_$][\w$]*[ \t]*=[ \t]*require[ \t]*\([ \t]*(?:"[^"]*"|'[^']*')[ \t]*\)[ \t]*(?:;(?=[ \t]*(?:[\r\n}]|$|\/\/|\/\*))|(?=[\r\n}]))/g, '');
        let badImportRhs = false;
        relaxedBody = relaxedBody.replace(/(?<=^|[;\r\n{])[ \t]*(?:export[ \t]+)?import[ \t]+[A-Za-z_$][\w$]*[ \t]*=[ \t]*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*(?=;|[\r\n}])/g, (m, rhs) => {
          if (rhs.split('.').some(seg => RESERVED_NS.has(seg))) { badImportRhs = true; return m; }
          return '';
        });
        if (badImportRhs) return null;
      }
      try {
        stripTypeScriptTypes(header + relaxedBody);
      } catch (err2) {
        const em2 = String(err2?.message || '');
        if (stripWithSwcRelaxations(header + relaxedBody, em2) === null) {
          // Ambient blocks like `declare module M { break; continue; return; }` allow control-flow statements
          // that SWC rejects outside a function; validate inside a dummy function body when no import/export is present.
          if (!/\b(?:import|export)\b/.test(relaxedBody) &&
              (em2.includes("A 'break' statement") || em2.includes("A 'continue' statement") || em2.includes("'return' statement"))) {
            const fnWrap = `function __tmt_amb__() ${relaxedBody}`;
            try {
              stripTypeScriptTypes(fnWrap);
            } catch (err3) {
              if (stripWithSwcRelaxations(fnWrap, String(err3?.message || '')) === null) return null;
            }
          } else {
            return null;
          }
        }
      }
    }
    const eraseStart = (i > 0 && tokens[i - 1].type === 'id' && tokens[i - 1].text === 'export' &&
      tokens[i - 2]?.text !== '.' && !hasNewlineBetween(source, tokens[i - 1].end, t.start))
      ? tokens[i - 1].start : t.start;
    const blank = source.slice(eraseStart, tokens[closeIdx].end).replace(/[^\r\n]/g, ' ');
    edits.push({ start: eraseStart, end: tokens[closeIdx].end, text: blank });
    i = closeIdx;
  }
  if (edits.length === 0) return source;
  let out = '', pos = 0;
  for (const e of edits) {
    out += source.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += source.slice(pos);
  return out;
}

// Linear-time check for `for (... [ ... in ... ] ...)` on a single line (avoids quadratic regex backtracking).
function hasForBracketIn(source) {
  let pos = 0;
  const n = source.length;
  while (pos < n) {
    const idx = source.indexOf('for', pos);
    if (idx < 0) return false;
    const before = idx > 0 ? source.charCodeAt(idx - 1) : 0;
    const after = idx + 3 < n ? source.charCodeAt(idx + 3) : 0;
    if (isIdentPart(before) || isIdentPart(after)) { pos = idx + 3; continue; }
    let nl = source.indexOf('\n', idx + 3);
    if (nl < 0) nl = n;
    const br = source.indexOf('[', idx + 3);
    if (br >= 0 && br < nl) {
      let close = source.indexOf(']', br + 1);
      if (close < 0 || close > nl) close = nl;
      const slice = source.slice(br + 1, close);
      if (/\bin\b/.test(slice)) return true;
    }
    pos = nl + 1;
  }
  return false;
}

// Token-based rewrite of top-level `declare module Name {` -> `declare namespace Name {` and
// `declare module "str" {` -> `declare namespace __tmt_amb__ {` outside strings/templates/comments/regexes.
function normalizeAmbientModules(source) {
  if (!source.includes('declare') || !source.includes('module')) return source;
  const toks = tokenize(source);
  if (!toks) return source;
  const edits = [];
  const allowAmbName = !source.includes('__tmt_amb__');
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'punc' && t.text === '{') { depth++; continue; }
    if (t.type === 'punc' && t.text === '}') { if (depth > 0) depth--; continue; }
    if (depth !== 0 || t.type !== 'id' || t.text !== 'declare') continue;
    const prev = i > 0 ? toks[i - 1] : null;
    if (prev && !(prev.type === 'punc' && (prev.text === ';' || prev.text === '}')) &&
        !hasNewlineBetween(source, prev.end, t.start)) continue;
    const kw = toks[i + 1];
    if (!kw || kw.type !== 'id' || kw.text !== 'module' || hasNewlineBetween(source, t.end, kw.start)) continue;
    const nameTok = toks[i + 2];
    if (!nameTok || hasNewlineBetween(source, kw.end, nameTok.start)) continue;
    if (nameTok.type === 'str') {
      if (!allowAmbName || toks[i + 3]?.text !== '{') continue;
      edits.push({ start: kw.start, end: nameTok.end, text: 'namespace __tmt_amb__' });
      i += 2;
    } else if (nameTok.type === 'id') {
      let k = i + 3;
      while (toks[k]?.text === '.' && toks[k + 1]?.type === 'id') k += 2;
      if (toks[k]?.text !== '{') continue;
      edits.push({ start: kw.start, end: kw.end, text: 'namespace' });
      i = k - 1;
    }
  }
  if (edits.length === 0) return source;
  let out = '', pos = 0;
  for (const e of edits) { out += source.slice(pos, e.start) + e.text; pos = e.end; }
  out += source.slice(pos);
  return out;
}

// Evaluates constant enum member expressions (numeric literals, strings, unary/binary/pow ops, parens, refs to prior members).
function decodeSimpleStringToken(tok) {
  const s = tok.text;
  if (s[0] === '`') {
    if (s.includes('\\') || s.includes('${')) return null;
    return s.slice(1, -1).replace(/\r\n?/g, '\n');
  }
  if (tok.type === 'str') {
    if (s.includes('\\')) return null;
    return s.slice(1, -1);
  }
  return null;
}

function evalEnumExpr(expr, env, allowComputed = false, enumName = '', allEnums = null, allMemberNames = null, constNames = null, isMergedEnum = false, enumDeclCounts = null, currentMemberName = null) {
  const s = expr.trim();
  if (!s) return null;
  const toks = tokenize(s);
  if (!toks || toks.length === 0) return null;
  if (toks.length === 1 && (toks[0].type === 'str' || toks[0].type === 'tpl')) {
    const sv = decodeSimpleStringToken(toks[0]);
    if (s[0] === '`') return sv !== null ? { kind: 'str', value: sv, raw: JSON.stringify(sv) } : null;
    return sv !== null ? { kind: 'str', value: sv, raw: s } : { kind: 'str', raw: s };
  }
  // Constant template literal with literal `${"2"}` / `${123}` interpolations (e.g. `` `1${"2"}3` `` -> `"123"`)
  if (toks.length >= 3 && toks[0].type === 'tpl' && s[0] === '`' && s[s.length - 1] === '`') {
    let ok = true, acc = '';
    for (let ti = 0; ti < toks.length; ti++) {
      const tk = toks[ti];
      if (tk.type === 'tpl') {
        const rawHead = tk.text.slice(1, -2);
        if (rawHead.includes('\\')) { ok = false; break; }
        acc += rawHead.replace(/\r\n?/g, '\n');
      } else if (tk.type === 'str' && tk.text[0] === '}' && tk.text[tk.text.length - 1] === '`') {
        const rawTail = tk.text.slice(1, -1);
        if (rawTail.includes('\\')) { ok = false; break; }
        acc += rawTail.replace(/\r\n?/g, '\n');
      } else if (tk.type === 'str') {
        const sv = decodeSimpleStringToken(tk);
        if (sv === null) { ok = false; break; }
        acc += sv;
      } else if (tk.type === 'num') {
        if (!/^(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/.test(tk.text)) { ok = false; break; }
        const nv = Number(tk.text.replace(/_/g, ''));
        if (!Number.isFinite(nv)) { ok = false; break; }
        acc += String(nv);
      } else {
        ok = false; break;
      }
    }
    if (ok) return { kind: 'str', value: acc, raw: JSON.stringify(acc) };
  }
  // Exact constant string concatenation (`"a" + "b"`, `` `a` + "b" ``, `prevStr + "b"`, `1 + "a"`).
  if (toks.some(t => t.type === 'str' || t.type === 'tpl' || (t.type === 'id' && env.get(t.text)?.kind === 'str')) &&
      toks.every((t, idx) => idx % 2 === 1 ? t.text === '+' : (t.type === 'str' || t.type === 'tpl' || t.type === 'num' || (t.type === 'id' && env.has(t.text))))) {
    let acc = null;
    let ok = true;
    for (let idx = 0; idx < toks.length; idx += 2) {
      const tk = toks[idx];
      let val;
      if (tk.type === 'str' || tk.type === 'tpl') {
        val = decodeSimpleStringToken(tk);
        if (val === null) { ok = false; break; }
      } else if (tk.type === 'num') {
        val = Number(tk.text.replace(/_/g, ''));
        if (!Number.isFinite(val)) { ok = false; break; }
      } else if (tk.type === 'id') {
        const prev = env.get(tk.text);
        if (!prev || prev.value === undefined) { ok = false; break; }
        val = prev.value;
      } else { ok = false; break; }
      acc = idx === 0 ? val : (acc + val);
    }
    if (ok && typeof acc === 'string') {
      return { kind: 'str', value: acc, raw: JSON.stringify(acc) };
    }
  }
  // Try constant numeric evaluation via recursive descent
  let pos = 0;
  function parseOr() {
    let v = parseXor();
    while (v !== null && pos < toks.length && toks[pos].text === '|' && toks[pos + 1]?.text !== '|') {
      pos++; const r = parseXor(); v = r === null ? null : (v | r);
    }
    return v;
  }
  function parseXor() {
    let v = parseAnd();
    while (v !== null && pos < toks.length && toks[pos].text === '^') {
      pos++; const r = parseAnd(); v = r === null ? null : (v ^ r);
    }
    return v;
  }
  function parseAnd() {
    let v = parseShift();
    while (v !== null && pos < toks.length && toks[pos].text === '&' && toks[pos + 1]?.text !== '&') {
      pos++; const r = parseShift(); v = r === null ? null : (v & r);
    }
    return v;
  }
  function parseShift() {
    let v = parseAdd();
    while (v !== null && pos + 1 < toks.length) {
      if (toks[pos].text === '<' && toks[pos + 1].text === '<' && toks[pos].end === toks[pos + 1].start) {
        pos += 2; const r = parseAdd(); v = r === null ? null : (v << r);
      } else if (toks[pos].text === '>' && toks[pos + 1].text === '>' && toks[pos + 2]?.text === '>' &&
          toks[pos].end === toks[pos + 1].start && toks[pos + 1].end === toks[pos + 2].start) {
        pos += 3; const r = parseAdd(); v = r === null ? null : (v >>> r);
      } else if (toks[pos].text === '>' && toks[pos + 1].text === '>' && toks[pos].end === toks[pos + 1].start) {
        pos += 2; const r = parseAdd(); v = r === null ? null : (v >> r);
      } else break;
    }
    return v;
  }
  function parseAdd() {
    let v = parseMul();
    while (v !== null && pos < toks.length && (toks[pos].text === '+' || toks[pos].text === '-')) {
      const op = toks[pos++].text; const r = parseMul(); v = r === null ? null : (op === '+' ? v + r : v - r);
    }
    return v;
  }
  function parseMul() {
    let v = parsePow();
    while (v !== null && pos < toks.length && (toks[pos].text === '*' || toks[pos].text === '/' || toks[pos].text === '%')) {
      if (toks[pos].text === '*' && toks[pos + 1]?.text === '*') break;
      const op = toks[pos++].text; const r = parsePow();
      v = r === null ? null : (op === '*' ? v * r : op === '/' ? v / r : v % r);
    }
    return v;
  }
  function parsePow() {
    const v = parseUnary();
    if (v !== null && pos + 1 < toks.length && toks[pos].text === '*' && toks[pos + 1].text === '*' && toks[pos].end === toks[pos + 1].start) {
      pos += 2;
      const r = parsePow();
      return r === null ? null : Math.pow(v, r);
    }
    return v;
  }
  function parseUnary() {
    if (pos >= toks.length) return null;
    if (toks[pos].text === '-') { pos++; const r = parseUnary(); return r === null ? null : -r; }
    if (toks[pos].text === '+') { pos++; const r = parseUnary(); return r === null ? null : +r; }
    if (toks[pos].text === '~') { pos++; const r = parseUnary(); return r === null ? null : ~r; }
    if (toks[pos].text === '(') {
      pos++; const v = parseOr();
      if (v === null || toks[pos]?.text !== ')') return null;
      pos++; return v;
    }
    if (toks[pos].type === 'num') {
      const n = Number(toks[pos++].text.replace(/_/g, ''));
      return Number.isNaN(n) ? null : n;
    }
    if (toks[pos].type === 'id' && enumName && toks[pos].text === enumName &&
        ((toks[pos + 1]?.text === '.' && toks[pos + 2]?.type === 'id') ||
         (toks[pos + 1]?.text === '[' && toks[pos + 2]?.type === 'str' && toks[pos + 3]?.text === ']'))) {
      const k = toks[pos + 1].text === '.' ? toks[pos + 2].text : decodeSimpleStringToken(toks[pos + 2]);
      pos += toks[pos + 1].text === '.' ? 3 : 4;
      if (k !== null && env.has(k)) {
        const prev = env.get(k);
        return prev.kind === 'num' ? prev.value : null;
      }
      return null;
    }
    if (toks[pos].type === 'id' && allEnums instanceof Map && allEnums.has(toks[pos].text) &&
        !env.has(toks[pos].text) && !(allMemberNames && allMemberNames.has(toks[pos].text)) &&
        ((toks[pos + 1]?.text === '.' && toks[pos + 2]?.type === 'id') ||
         (toks[pos + 1]?.text === '[' && toks[pos + 2]?.type === 'str' && toks[pos + 3]?.text === ']'))) {
      const otherName = toks[pos].text;
      const otherEnv = allEnums.get(otherName);
      const isOtherMerged = enumDeclCounts && (enumDeclCounts.get(otherName) ?? 0) > 1;
      if (otherEnv && !isOtherMerged) {
        const k = toks[pos + 1].text === '.' ? toks[pos + 2].text : decodeSimpleStringToken(toks[pos + 2]);
        if (k !== null && otherEnv.has(k)) {
          const prev = otherEnv.get(k);
          if (prev.kind === 'num') {
            pos += toks[pos + 1].text === '.' ? 3 : 4;
            return prev.value;
          }
        }
      }
      return null;
    }
    if (toks[pos].type === 'id' && env.has(toks[pos].text)) {
      const prev = env.get(toks[pos++].text);
      return prev.kind === 'num' ? prev.value : null;
    }
    return null;
  }
  const val = parseOr();
  if (val !== null && pos === toks.length) {
    if (Number.isFinite(val)) return { kind: 'num', value: val, raw: s };
    if (val === Infinity || val === -Infinity || Number.isNaN(val)) {
      return { kind: 'num', value: Number.isNaN(val) ? 'NaN' : (val > 0 ? 'Infinity' : '-Infinity'), raw: s, nonFinite: true };
    }
  }
  if (allowComputed && !s.includes('**')) {
    // Only allow strings/templates in computed enum expressions when they are clearly numeric/member-access
    // (e.g. `.length`, `E["k"]`, unary `+`/`-`, or binary `-`/`*`/`/`/`%`), never raw string-returning expressions.
    const hasQuote = /['"`]/.test(s);
    const safeQuotedComputed = hasQuote && (/\.length\b|\.valueOf\s*\(|^\s*[+-]\s*['"`]|\[['"`]/.test(s) || /[-*/%]/.test(s));
    if (!hasQuote || safeQuotedComputed) {
      // Rewrite bare references to earlier members of this enum (`a` -> `EnumName.a`)
      const rwEdits = [];
      for (let ti = 0; ti < toks.length; ti++) {
        const tk = toks[ti];
        if (tk.type !== 'id') continue;
        const prev = ti > 0 ? toks[ti - 1] : null;
        if (prev && prev.text === '.') continue;
        // Bail on bare reference to a `const` variable (TS constant-folds `const d = 'd'` / `const X = 1000000`)
        if (constNames && constNames.has(tk.text)) return null;
        if (enumName && tk.text === enumName) {
          // Allow `E.B` or `E["C"]` verbatim ONLY when `B`/`C` is NOT a member of this enum (and enum is not merged)
          if (isMergedEnum) return null;
          if (toks[ti + 1]?.text === '.' && toks[ti + 2]?.type === 'id') {
            const mName = toks[ti + 2].text;
            if (mName !== currentMemberName && (env.has(mName) || (allMemberNames && allMemberNames.has(mName)))) return null;
            ti += 2;
            continue;
          }
          if (toks[ti + 1]?.text === '[' && toks[ti + 2]?.type === 'str' && toks[ti + 3]?.text === ']') {
            const k = decodeSimpleStringToken(toks[ti + 2]);
            if (k !== null && k !== currentMemberName && (env.has(k) || (allMemberNames && allMemberNames.has(k)))) return null;
            ti += 3;
            continue;
          }
          return null;
        }
        // Self-reference (`A = A`, `D = 1 + D`) is never constant-folded in TS -> emit `E.A`
        if (currentMemberName !== null && tk.text === currentMemberName && !env.has(tk.text)) {
          if (enumName) rwEdits.push({ start: tk.start, end: tk.end, text: `${enumName}.${tk.text}` });
          else return null;
          continue;
        }
        // Bail on forward reference to an uninitialized member of this enum (takes precedence over outer enums)
        if (allMemberNames && allMemberNames.has(tk.text) && !env.has(tk.text)) return null;
        // Local member of this enum shadows any outer enum of the same name (e.g. `enum A { X=1 } enum B { A="abc", X=A.length }`)
        if (env.has(tk.text)) {
          if (enumName) rwEdits.push({ start: tk.start, end: tk.end, text: `${enumName}.${tk.text}` });
          else return null;
          continue;
        }
        if (allEnums && allEnums.has(tk.text)) {
          // Allow `OtherEnum.X` verbatim ONLY when `OtherEnum` is unmerged in `allEnums` (Map) and `X` is NOT a constant member
          // (or when a property access like `OtherEnum.X.valueOf()` follows, which TS never folds)
          if (enumDeclCounts && (enumDeclCounts.get(tk.text) ?? 0) > 1) return null;
          const otherEnv = allEnums instanceof Map ? allEnums.get(tk.text) : null;
          if (otherEnv && toks[ti + 1]?.text === '.' && toks[ti + 2]?.type === 'id') {
            if (otherEnv.has(toks[ti + 2].text) && toks[ti + 3]?.text !== '.') return null;
            ti += 2;
            continue;
          }
          return null;
        }
      }
      let outExpr = s;
      if (rwEdits.length > 0) {
        let nr = '', rp = 0;
        for (const e of rwEdits) { nr += s.slice(rp, e.start) + e.text; rp = e.end; }
        outExpr = nr + s.slice(rp);
      }
      return { kind: 'computed', raw: outExpr };
    }
  }
  return null;
}

// Lowers a single enum body `{ A, B = 2, C }` to TS-exact IIFE statements.
function lowerEnumBody(name, bodySource, sharedEnv = null, allowComputed = false, allEnums = null, constNames = null, isMergedEnum = false, enumDeclCounts = null) {
  const tokens = tokenize(bodySource);
  if (!tokens) return null;
  // Split top-level comma-separated members
  const members = [];
  let depthP = 0, depthB = 0, depthBr = 0, start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc') {
      if (t.text === '(') depthP++;
      else if (t.text === ')') depthP--;
      else if (t.text === '[') depthB++;
      else if (t.text === ']') depthB--;
      else if (t.text === '{') depthBr++;
      else if (t.text === '}') depthBr--;
      else if (t.text === ',' && depthP === 0 && depthB === 0 && depthBr === 0) {
        if (i > start) members.push(tokens.slice(start, i));
        start = i + 1;
      }
    }
  }
  if (start < tokens.length) members.push(tokens.slice(start));

  const allMemberNames = new Set();
  for (const m of members) {
    if (m.length === 0) continue;
    if (m[0].type === 'id') {
      if (m[0].text.includes('\\u')) return null;
      allMemberNames.add(m[0].text);
    } else if (m[0].type === 'str') {
      const sv = decodeSimpleStringToken(m[0]);
      if (sv !== null) allMemberNames.add(sv);
    }
  }

  const lines = [];
  const env = sharedEnv || new Map();
  let nextNum = 0;
  for (const m of members) {
    if (m.length === 0) continue;
    const keyTok = m[0];
    let propKey;
    let revVal;
    if (keyTok.type === 'id') { propKey = JSON.stringify(keyTok.text); revVal = propKey; }
    else if (keyTok.type === 'str') { propKey = keyTok.text; revVal = propKey; }
    else if (keyTok.type === 'num') {
      if (keyTok.text.endsWith('n') && /^(?:0|[1-9][0-9_]*)n$/.test(keyTok.text)) {
        propKey = keyTok.text;
        revVal = keyTok.text;
      } else {
        const nVal = Number(keyTok.text.replace(/_/g, ''));
        if (!Number.isFinite(nVal)) return null;
        propKey = String(nVal);
        revVal = String(nVal);
      }
    } else if (keyTok.type === 'punc' && keyTok.text === '[') {
      // Computed enum member key `[expr] = val`
      let closeB = -1, d = 0;
      for (let bi = 0; bi < m.length; bi++) {
        if (m[bi].text === '[') d++;
        else if (m[bi].text === ']') { if (--d === 0) { closeB = bi; break; } }
      }
      if (closeB <= 1) return null;
      const keyExpr = bodySource.slice(m[1].start, m[closeB - 1].end).trim();
      if (!keyExpr) return null;
      const restM = m.slice(closeB + 1);
      if (restM.length === 0) {
        if (nextNum === null) return null;
        lines.push(`    ${name}[${name}[${keyExpr}] = ${nextNum}] = ${keyExpr};`);
        nextNum++;
      } else if (restM.length >= 2 && restM[0].text === '=') {
        const exprSrc = bodySource.slice(restM[1].start, restM[restM.length - 1].end).trim();
        const ev = evalEnumExpr(exprSrc, env, allowComputed, name, allEnums, allMemberNames, constNames, isMergedEnum, enumDeclCounts);
        if (ev === null) return null;
        if (ev.kind === 'str') {
          lines.push(`    ${name}[${keyExpr}] = ${ev.raw};`);
          nextNum = null;
        } else if (ev.kind === 'num') {
          lines.push(`    ${name}[${name}[${keyExpr}] = ${ev.value}] = ${keyExpr};`);
          nextNum = ev.nonFinite ? null : ev.value + 1;
        } else {
          lines.push(`    ${name}[${name}[${keyExpr}] = ${ev.raw}] = ${keyExpr};`);
          nextNum = null;
        }
      } else return null;
      continue;
    } else return null;

    if (m.length === 1) {
      if (nextNum === null) {
        if (!allowComputed) return null;
        lines.push(`    ${name}[${name}[${propKey}] = void 0] = ${revVal};`);
        continue;
      }
      lines.push(`    ${name}[${name}[${propKey}] = ${nextNum}] = ${revVal};`);
      if (keyTok.type === 'id') env.set(keyTok.text, { kind: 'num', value: nextNum });
      nextNum++;
    } else if (m.length >= 3 && m[1].type === 'punc' && m[1].text === '=') {
      const exprSrc = bodySource.slice(m[2].start, m[m.length - 1].end).trim();
      const curName = keyTok.type === 'id' ? keyTok.text : (keyTok.type === 'str' ? decodeSimpleStringToken(keyTok) : null);
      const ev = evalEnumExpr(exprSrc, env, allowComputed, name, allEnums, allMemberNames, constNames, isMergedEnum, enumDeclCounts, curName);
      if (ev === null) return null;
      if (ev.kind === 'str') {
        lines.push(`    ${name}[${propKey}] = ${ev.raw};`);
        if (keyTok.type === 'id') env.set(keyTok.text, ev);
        nextNum = null;
      } else if (ev.kind === 'num') {
        lines.push(`    ${name}[${name}[${propKey}] = ${ev.value}] = ${revVal};`);
        const envKey = keyTok.type === 'id' ? keyTok.text : decodeSimpleStringToken(keyTok);
        if (envKey !== null && !ev.nonFinite) env.set(envKey, ev);
        nextNum = ev.nonFinite ? null : ev.value + 1;
      } else {
        lines.push(`    ${name}[${name}[${propKey}] = ${ev.raw}] = ${revVal};`);
        const envKey = keyTok.type === 'id' ? keyTok.text : decodeSimpleStringToken(keyTok);
        if (envKey !== null) env.set(envKey, { kind: 'computed' });
        nextNum = null;
      }
    } else {
      return null;
    }
  }
  return lines.join('\n');
}

// Checks if a namespace body contains ONLY ambient/type declarations (so TS erases the entire namespace).
function isTypeOnlyNamespaceBody(bodySource) {
  // Check top-level statements inside bodySource for non-ambient value declarations or direct `declare` value bindings
  const toks = tokenize(bodySource);
  if (!toks) return false;
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'punc' && t.text === '{') { depth++; continue; }
    if (t.type === 'punc' && t.text === '}') { if (depth > 0) depth--; continue; }
    if (depth !== 0 || t.type !== 'id') continue;
    let k = i;
    if (toks[k].text === 'export') k++;
    if (toks[k]?.text === 'declare') {
      const next = toks[k + 1]?.text;
      if (next === 'var' || next === 'let' || next === 'const' || next === 'function' || next === 'class' || next === 'enum') {
        return false;
      }
      if (next === 'module' || next === 'namespace') {
        let j = k + 2;
        while (j < toks.length && toks[j].text !== '{' && toks[j].text !== ';') j++;
        if (toks[j]?.text === '{') { const c = findMatchingBrace(toks, j); if (c >= 0) i = c; }
      }
      continue;
    }
    if (toks[k]?.text === 'async' || toks[k]?.text === 'abstract') k++;
    const kw = toks[k]?.text;
    if (kw === 'function' || kw === 'class' || kw === 'var' || kw === 'let' || kw === 'const' || kw === 'enum') {
      return false;
    }
  }
  try {
    const stripped = stripTypeScriptTypes(bodySource);
    return stripped.replace(/\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\/|\s+|;/g, '').length === 0;
  } catch {
    return false;
  }
}

// Lowers top-level (and dotted/nested) `[export] (namespace|module) A[.B] { ... }` and `[export] [const] enum E { ... }`
// into 100% TypeScript-6.0.3-exact IIFE JavaScript.
// Returns `{ code, changed }` or `null` if any construct is too complex or invalid.
function lowerNamespacesAndEnums(source, isJsx = false) {
  const allowNs = isJsx || /\bmodule[ \t]+[A-Za-z_$]/.test(source) || source.includes('// @') || source.includes('//@') || !hasTopLevelModuleSyntax(source);
  const allowComputedEnum = !isJsx && !hasTopLevelModuleSyntax(source);
  if (!/\b(?:module|enum)\b/.test(source) && !/\bnamespace[ \t]+[A-Za-z_$]/.test(source) &&
      !/\bimport[ \t]+[A-Za-z_$][\w$]*[ \t]*=/.test(source)) {
    return { code: source, changed: false };
  }
  const tokens = tokenize(source, isJsx);
  if (!tokens) return null;

  // Only proceed (and run the SWC transform pre-check) if the token stream actually contains a
  // `module Ident {`, `namespace Ident {`, `enum Ident {`, or `import Ident = Entity` code construct
  // (avoids rejecting files that merely mention `module` or `enum` inside comments like `// @module: esnext`).
  let hasTargetConstruct = false;
  for (let ti = 0; ti < tokens.length - 2; ti++) {
    const tk = tokens[ti];
    if (tk.type !== 'id') continue;
    if ((tk.text === 'module' || tk.text === 'namespace') && tokens[ti + 1].type === 'id' &&
        !hasNewlineBetween(source, tk.end, tokens[ti + 1].start)) {
      let k = ti + 2;
      while (tokens[k]?.text === '.' && tokens[k + 1]?.type === 'id') k += 2;
      if (tokens[k]?.text === '{' && (tk.text === 'module' || allowNs || tokens[k + 1]?.text === '}')) { hasTargetConstruct = true; break; }
    } else if (tk.text === 'enum' && tokens[ti + 1].type === 'id' && tokens[ti + 2]?.text === '{') {
      hasTargetConstruct = true; break;
    } else if (tk.text === 'import' && tokens[ti + 1].type === 'id' && tokens[ti + 2]?.text === '=' &&
        tokens[ti + 3]?.type === 'id' && tokens[ti + 3].text !== 'require' && tokens[ti + 3].text !== 'module') {
      hasTargetConstruct = true; break;
    }
  }
  if (!hasTargetConstruct) return { code: source, changed: false };

  // Quick syntax validation for non-JSX files: rewrite `module Ident {` -> `namespace Ident {` and
  // `import a = X.Y` -> `var a = X.Y` and validate with Node SWC transform ONLY to reject syntax errors
  // before lowering (prevents false positives on TS-error files). JSX files are validated by addon.lower.
  let allowTypeOnlyBlank = true;
  if (!isJsx) {
    let valSrc = source.replace(/(?<=^|[;\r\n{])[ \t]*((?:export[ \t]+|declare[ \t]+|async[ \t]+|public[ \t]+|private[ \t]+|protected[ \t]+)*)module(?=[ \t]+[A-Za-z_$][\w$.]*\s*\{)/g, '$1namespace');
    valSrc = valSrc.replace(/(?<=^|[;\r\n{])[ \t]*((?:export[ \t]+)*)(?:async|public|private|protected)[ \t]+(?=(?:namespace|enum)[ \t]+[A-Za-z_$])/g, '$1');
    valSrc = valSrc.replace(/(?<=^|[;\r\n{])[ \t]*(?:declare[ \t]+)?(?:export[ \t]+)?(?:(?:public|private|protected)[ \t]+)?import(?=[ \t]+[A-Za-z_$][\w$]*[ \t]*=[ \t]*(?!require\b|module\b)[A-Za-z_$][\w$.]*(?![ \t]*\())/g, 'var');
    try {
      stripTypeScriptTypes(valSrc, { mode: 'transform' });
    } catch (err) {
      const em = String(err?.message || '');
      const relaxable = em.includes('The left-hand side of an assignment expression') ||
        em.includes('Invalid assignment target') ||
        em.includes('Trailing comma is not allowed') ||
        em.includes('Variable declaration list cannot be empty') ||
        em.includes("The 'with' statement is not supported") ||
        em.includes("'const' declarations must be initialized") ||
        em.includes("A 'continue' statement") ||
        em.includes("A 'break' statement") ||
        em.includes('`await` cannot be used') ||
        em.includes("Expected ';', '}' or <eof>") ||
        em.includes('Expression expected') ||
        em.includes('Unexpected token `ident`. Expected * for generator') ||
        em.includes('A parameter initializer is only allowed') ||
        em.includes('An implementation cannot be declared in ambient contexts') ||
        em.includes('ESM-style module declarations are not permitted') ||
        em.includes("Expected '{', got 'export'") ||
        em.includes("Expected ']', got ','") ||
        em.includes("'import', and 'export' cannot be used outside") ||
        em.includes('cannot be used as an identifier in strict mode') ||
        em.includes('A parameter property is only allowed') ||
        em.includes('`declare` modifier not allowed') ||
        em.includes('An enum member cannot have a numeric name') ||
        em.includes('Computed property names are not allowed in enums') ||
        em.includes('Import declarations in a namespace cannot reference a module') ||
        em.includes('An interface can only extend an identifier') ||
        em.includes('Unexpected token `let`') ||
        em.includes('Unexpected line break between arrow head and arrow') ||
        em.includes("Expected '{', got 'public'") ||
        em.includes('Expected a string literal') ||
        em.includes('Expected ident');
      if (!relaxable) return null;
      allowTypeOnlyBlank = false;
    }
  }

  function lowerBlock(src, parentNs) {
    const toks = tokenize(src, isJsx);
    if (!toks) return null;
    const edits = [];
    const declaredVars = new Set();
    const enumEnvs = new Map();
    const enumDeclCounts = new Map();
    {
      let ed = 0;
      for (let ei = 0; ei < toks.length - 2; ei++) {
        if (toks[ei].text === '{') { ed++; continue; }
        if (toks[ei].text === '}') { if (ed > 0) ed--; continue; }
        if (ed === 0 && toks[ei].type === 'id' &&
            (toks[ei].text === 'enum' || toks[ei].text === 'namespace' || toks[ei].text === 'module') &&
            toks[ei - 1]?.text !== '.' &&
            toks[ei + 1]?.type === 'id' && (toks[ei + 2]?.text === '{' || toks[ei + 2]?.text === '.')) {
          const en = toks[ei + 1].text;
          enumDeclCounts.set(en, (enumDeclCounts.get(en) ?? 0) + 1);
        }
      }
    }
    const exportedVars = []; // { name, stmtStart, stmtEnd } for local bare-identifier rewriting inside parentNs
    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'punc' && t.text === '{') { depth++; continue; }
      if (t.type === 'punc' && t.text === '}') { if (depth > 0) depth--; continue; }
      if (t.type !== 'id') continue;
      if (depth !== 0) {
        // Also lower `[const] enum E { ... }` inside block/if/function scopes when `!parentNs`
        if (!parentNs && (t.text === 'enum' || (t.text === 'const' && toks[i + 1]?.text === 'enum' && !hasNewlineBetween(src, t.end, toks[i + 1].start)))) {
          const prev = i > 0 ? toks[i - 1] : null;
          if (prev && (prev.text === '.' || prev.text === 'declare' || prev.text === ':')) continue;
          const eIdx = t.text === 'const' ? i + 1 : i;
          if (toks[eIdx + 1]?.type === 'id' && toks[eIdx + 2]?.text === '{') {
            const enumName = toks[eIdx + 1].text;
            const openIdx = eIdx + 2;
            const closeIdx = findMatchingBrace(toks, openIdx);
            if (closeIdx < 0) return null;
            const bodySrc = src.slice(toks[openIdx].end, toks[closeIdx].start);
            const loweredBody = lowerEnumBody(enumName, bodySrc, new Map(), allowComputedEnum, null);
            if (loweredBody === null) return null;
            const emitted = `{ var ${enumName}; (function (${enumName}) {\n${loweredBody}${loweredBody ? '\n' : ''}})(${enumName} || (${enumName} = {})); }`;
            edits.push({ start: t.start, end: toks[closeIdx].end, text: emitted });
            i = closeIdx;
          }
        }
        continue;
      }

      const prev = i > 0 ? toks[i - 1] : null;
      const isLabeled = !parentNs && prev && prev.text === ':' && i >= 2 && toks[i - 2].type === 'id';
      if (prev && !(prev.type === 'punc' && (prev.text === ';' || prev.text === '}')) && !isLabeled &&
          !hasNewlineBetween(src, prev.end, t.start)) {
        continue;
      }

      // Skip `declare ...` (except `declare [export] import a = b;`, which we lower below)
      if (t.text === 'declare') {
        const afterDec = toks[i + 1]?.text === 'export' ? i + 2 : i + 1;
        if (toks[afterDec]?.text === 'import' && toks[afterDec + 1]?.type === 'id' && toks[afterDec + 2]?.text === '=' &&
            toks[afterDec + 3]?.type === 'id' && toks[afterDec + 3].text !== 'require' && toks[afterDec + 3].text !== 'module') {
          // fall through with idx = i + 1
        } else {
          // Jump past `{ ... }` if it's `declare namespace/module/class/enum`
          let j = i + 1;
          while (j < toks.length && !(toks[j].type === 'punc' && (toks[j].text === '{' || toks[j].text === ';'))) j++;
          if (j < toks.length && toks[j].text === '{') {
            const close = findMatchingBrace(toks, j);
            if (close >= 0) i = close;
          }
          continue;
        }
      }

      let idx = i;
      if (toks[idx].text === 'declare') idx++;
      let isExport = false;
      while (toks[idx]?.text === 'export') {
        isExport = true;
        idx++;
        if (idx >= toks.length) break;
      }
      if (idx >= toks.length) break;
      if (toks[idx].type === 'id' && toks[idx].text === 'declare') {
        if (parentNs && isExport) {
          // `export declare ...` inside a namespace: strip `export ` so stripTypeScriptTypes erases `declare ...`
          edits.push({ start: t.start, end: toks[idx].start, text: '' });
        }
        let j = idx + 1;
        while (j < toks.length && !(toks[j].type === 'punc' && (toks[j].text === '{' || toks[j].text === ';'))) j++;
        if (j < toks.length && toks[j].text === '{') {
          const close = findMatchingBrace(toks, j);
          if (close >= 0) i = close;
        }
        continue;
      }

      // Record already-declared value bindings (`function Foo`, `class Foo`, `import { Foo }`)
      // so merged `namespace Foo {}` does not emit a duplicate `var Foo;` / `let Foo;`.
      {
        let k = idx;
        if (toks[k]?.text === 'default') k++;
        if (toks[k]?.text === 'async' || toks[k]?.text === 'abstract') k++;
        if ((toks[k]?.text === 'function' || toks[k]?.text === 'class') && toks[k + 1]?.type === 'id') {
          declaredVars.add(toks[k + 1].text);
        } else if (!parentNs && toks[k]?.text === 'import') {
          if (toks[k + 1]?.type === 'id' && toks[k + 1].text !== 'type') declaredVars.add(toks[k + 1].text);
          if (toks[k + 1]?.text === '{') {
            const close = findMatchingBrace(toks, k + 1);
            if (close > k + 1) {
              for (let m = k + 2; m < close; m++) {
                if (toks[m].type === 'id' && toks[m + 1]?.text !== 'as' && toks[m].text !== 'type' && toks[m].text !== 'as') {
                  declaredVars.add(toks[m].text);
                }
              }
            }
          }
        }
      }

      // Case 1: `[export] [async|public|private|protected] [const] enum E { ... }`
      if (toks[idx].type === 'id' && (toks[idx].text === 'async' || toks[idx].text === 'public' || toks[idx].text === 'private' || toks[idx].text === 'protected') &&
          toks[idx + 1]?.type === 'id' && (toks[idx + 1].text === 'enum' || toks[idx + 1].text === 'module' || toks[idx + 1].text === 'namespace' || (toks[idx + 1].text === 'const' && toks[idx + 2]?.text === 'enum')) &&
          !hasNewlineBetween(src, toks[idx].end, toks[idx + 1].start)) {
        idx++;
      }
      let isConstEnum = false;
      if (toks[idx].type === 'id' && toks[idx].text === 'const' &&
          toks[idx + 1]?.type === 'id' && toks[idx + 1].text === 'enum' &&
          !hasNewlineBetween(src, toks[idx].end, toks[idx + 1].start)) {
        isConstEnum = true;
        idx++;
      }
      if (toks[idx].type === 'id' && toks[idx].text === 'enum' &&
          toks[idx + 1]?.type === 'id' &&
          toks[idx + 2]?.type === 'punc' && toks[idx + 2].text === '{') {
        const enumName = toks[idx + 1].text;
        const openIdx = idx + 2;
        const closeIdx = findMatchingBrace(toks, openIdx);
        if (closeIdx < 0) return null;
        const bodySrc = src.slice(toks[openIdx].end, toks[closeIdx].start);
        let sharedEnv = enumEnvs.get(enumName);
        if (!sharedEnv) { sharedEnv = new Map(); enumEnvs.set(enumName, sharedEnv); }
        const knownDecls = new Map();
        for (const [en, ev] of enumEnvs.entries()) knownDecls.set(en, ev);
        for (const dv of declaredVars) { if (!knownDecls.has(dv)) knownDecls.set(dv, null); }
        const constNames = new Set();
        for (const cm of src.matchAll(/\bconst[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=;\n]+)?=/g)) constNames.add(cm[1]);
        const isMergedEnum = (enumDeclCounts.get(enumName) ?? 0) > 1;
        const loweredBody = lowerEnumBody(enumName, bodySrc, sharedEnv, allowComputedEnum && exportedVars.length === 0, knownDecls, constNames, isMergedEnum, enumDeclCounts);
        if (loweredBody === null) return null;
        const arg = parentNs && isExport
          ? `${enumName} = ${parentNs}.${enumName} || (${parentNs}.${enumName} = {})`
          : `${enumName} || (${enumName} = {})`;
        const varKw = parentNs ? 'let' : 'var';
        const varDecl = declaredVars.has(enumName) ? '' : (isExport && !parentNs ? `export var ${enumName};\n` : `${varKw} ${enumName};\n`);
        declaredVars.add(enumName);
        const bodyEmitted = `${varDecl}(function (${enumName}) {\n${loweredBody}${loweredBody ? '\n' : ''}})(${arg});`;
        const needsBlockWrap = !parentNs && prev && (prev.text === ')' || prev.text === 'else' || prev.text === 'do' || isLabeled);
        const emitted = needsBlockWrap ? `{ ${bodyEmitted} }` : bodyEmitted;
        edits.push({ start: t.start, end: toks[closeIdx].end, text: emitted });
        i = closeIdx;
        continue;
      }

        // Labeled `label: interface I {}` / `label: type T = ...` -> `label: ;`
        if (isLabeled && !isExport && toks[idx].type === 'id' && (toks[idx].text === 'interface' || toks[idx].text === 'type') &&
            toks[idx + 1]?.type === 'id' && !hasNewlineBetween(src, toks[idx].end, toks[idx + 1].start)) {
          if (toks[idx].text === 'interface') {
            let k = idx + 2;
            while (k < toks.length && toks[k].text !== '{') k++;
            if (k < toks.length) {
              const cb = findMatchingBrace(toks, k);
              if (cb > k) {
                edits.push({ start: t.start, end: toks[cb].end, text: ';' });
                i = cb;
                continue;
              }
            }
          } else {
            let k = idx + 2;
            while (k < toks.length && toks[k].text !== '=' && toks[k].text !== ';') k++;
            if (toks[k]?.text === '=') {
              k++;
              let dBr = 0, dP = 0, dB = 0;
              while (k < toks.length) {
                const tk = toks[k].text;
                if (tk === '{') dBr++; else if (tk === '}') { if (dBr === 0) break; dBr--; }
                else if (tk === '(') dP++; else if (tk === ')') dP--;
                else if (tk === '[') dB++; else if (tk === ']') dB--;
                else if (dBr === 0 && dP === 0 && dB === 0 && tk === ';') { k++; break; }
                else if (dBr === 0 && dP === 0 && dB === 0 && k > idx + 3 && hasNewlineBetween(src, toks[k - 1].end, toks[k].start)) break;
                k++;
              }
              edits.push({ start: t.start, end: toks[k - 1].end, text: ';' });
              i = k - 1;
              continue;
            }
          }
        }

      // Case 2: `[export] (namespace|module) A[.B.C] { ... }`
      if (toks[idx].type === 'id' && (toks[idx].text === 'module' || toks[idx].text === 'namespace') &&
          toks[idx + 1]?.type === 'id' && !hasNewlineBetween(src, toks[idx].end, toks[idx + 1].start)) {
        const isNsKw = toks[idx].text === 'namespace';
        const names = [toks[idx + 1].text];
        let j = idx + 2;
        while (toks[j]?.type === 'punc' && toks[j].text === '.' && toks[j + 1]?.type === 'id') {
          names.push(toks[j + 1].text);
          j += 2;
        }
        if (toks[j]?.type !== 'punc' || toks[j].text !== '{') continue;
        if (names.some(nm => RESERVED_NS.has(nm))) return null;
        const openIdx = j;
        const closeIdx = findMatchingBrace(toks, openIdx);
        if (closeIdx < 0) return null;
        const bodySrc = src.slice(toks[openIdx].end, toks[closeIdx].start);
        if (isNsKw && !allowNs && bodySrc.trim() !== '') continue;

        if (isTypeOnlyNamespaceBody(bodySrc)) {
          if (!allowTypeOnlyBlank && bodySrc.trim() !== '') return null;
          const blank = isLabeled ? ';' : src.slice(t.start, toks[closeIdx].end).replace(/[^\r\n]/g, ' ');
          edits.push({ start: t.start, end: toks[closeIdx].end, text: blank });
          i = closeIdx;
          continue;
        }

        // Lower innermost namespace body, renaming IIFE parameter to `${innerName}_1` if body shadows `innerName`.
        const innerName = names[names.length - 1];
        const shadowsSelf = new RegExp(`(?<!\\bdeclare\\s+)\\b(?:class|function|var|let|const|enum|namespace|module)\\s+${innerName}\\b|(?:\\(|,)\\s*${innerName}\\b`).test(bodySrc) ||
          names.slice(0, -1).includes(innerName) || parentNs === innerName;
        if (shadowsSelf && bodySrc.includes(`${innerName}_1`)) return null;
        const innerParam = shadowsSelf ? `${innerName}_1` : innerName;
        const loweredInner = lowerNamespaceBody(bodySrc, innerParam);
        if (loweredInner === null) return null;
        if (loweredInner !== bodySrc && isTypeOnlyNamespaceBody(loweredInner)) {
          // Only erase as uninstantiated if the original body did NOT contain an instantiating
          // non-empty `export { x }` or `export import x = require(...)` statement.
          const origToks = tokenize(bodySrc, isJsx);
          let origInstantiates = false;
          if (origToks) {
            let d = 0;
            for (let oi = 0; oi < origToks.length; oi++) {
              if (origToks[oi].text === '{') { d++; continue; }
              if (origToks[oi].text === '}') { if (d > 0) d--; continue; }
              if (d !== 0) continue;
              if (origToks[oi].type === 'id' && origToks[oi].text === 'export') {
                const n1 = origToks[oi + 1];
                if (n1?.text === 'import' || n1?.text === '*') { origInstantiates = true; break; }
                if (n1?.text === '{' && origToks[oi + 2]?.text !== '}') { origInstantiates = true; break; }
              }
            }
          }
          if (!origInstantiates) {
            const blank = isLabeled ? ';' : src.slice(t.start, toks[closeIdx].end).replace(/[^\r\n]/g, ' ');
            edits.push({ start: t.start, end: toks[closeIdx].end, text: blank });
            i = closeIdx;
            continue;
          }
        }

        // Wrap from innermost to outermost
        let innerCode = loweredInner;
        for (let k = names.length - 1; k >= 0; k--) {
          const nm = names[k];
          const outerNames = names.slice(0, k);
          const needsRename = k < names.length - 1 && (outerNames.includes(nm) || parentNs === nm);
          const param = k === names.length - 1 ? innerParam : (needsRename ? `${nm}_1` : nm);
          const outer = k > 0 ? names[k - 1] : parentNs;
          const exported = k > 0 ? true : isExport;
          const arg = outer && exported
            ? `${nm} = ${outer}.${nm} || (${outer}.${nm} = {})`
            : `${nm} || (${nm} = {})`;
          const varKw = (k === 0 && parentNs && isExport) ? 'let' : 'var';
          const varDecl = (k === 0 && declaredVars.has(nm)) ? '' :
            (exported && !outer ? `export var ${nm};\n` : `${varKw} ${nm};\n`);
          if (k === 0) declaredVars.add(nm);
          innerCode = `${varDecl}(function (${param}) {\n${innerCode}\n})(${arg});`;
        }
        const needsBlockWrap = !parentNs && prev && (prev.text === ')' || prev.text === 'else' || prev.text === 'do' || isLabeled);
        const emitted = needsBlockWrap ? `{ ${innerCode} }` : innerCode;
        edits.push({ start: t.start, end: toks[closeIdx].end, text: emitted });
        i = closeIdx;
        continue;
      }

      // Case 3: Inside a namespace body, handle `export function/class/var/let/const`
      if (parentNs && isExport) {
        const kw = toks[idx];
        // `export { ... };` inside a namespace (not followed by `from`) is erased by TypeScript
        if (kw && kw.text === '{') {
          const cb = findMatchingBrace(toks, idx);
          if (cb > idx && toks[cb + 1]?.text !== 'from') {
            let endIdx = cb;
            const hasSemi = toks[endIdx + 1]?.text === ';';
            if (hasSemi) endIdx++;
            else if (toks[endIdx + 1] && toks[endIdx + 1].text !== '}' && !hasNewlineBetween(src, toks[endIdx].end, toks[endIdx + 1].start)) {
              return null;
            }
            const stmt = src.slice(t.start, toks[endIdx].end);
            try { stripTypeScriptTypes(stmt); } catch { return null; }
            edits.push({ start: t.start, end: toks[endIdx].end, text: stmt.replace(/[^\r\n]/g, ' '), isVarDecl: true });
            i = endIdx;
            continue;
          }
        }
        // `export * from Ident;` / `export * from "str";` inside a namespace is erased by TypeScript
        if (kw && kw.text === '*' && toks[idx + 1]?.type === 'id' && toks[idx + 1].text === 'from' &&
            toks[idx + 2] && (toks[idx + 2].type === 'id' || toks[idx + 2].type === 'str')) {
          if (toks[idx + 2].type === 'id') {
            try { stripTypeScriptTypes(`(${toks[idx + 2].text});`); } catch { return null; }
          }
          let endIdx = idx + 2;
          if (toks[endIdx + 1]?.text === ';') endIdx++;
          else if (toks[endIdx + 1] && toks[endIdx + 1].text !== '}') return null;
          edits.push({ start: t.start, end: toks[endIdx].end, text: src.slice(t.start, toks[endIdx].end).replace(/[^\r\n]/g, ' '), isVarDecl: true });
          i = endIdx;
          continue;
        }
        if (!kw || kw.type !== 'id') return null;
        // Type-only exports inside namespace: strip `export ` so stripTypeScriptTypes erases them inside the IIFE.
        if (kw.text === 'interface' || kw.text === 'type' || kw.text === 'declare') {
          edits.push({ start: t.start, end: kw.start, text: '' });
          continue;
        }
        // `export default ...` inside a namespace: strip `export default ` (invalid in TS namespace);
        // wrap anonymous `[abstract] class {}` / `[async] function () {}` in parens so it stays a valid statement.
        if (kw.text === 'default') {
          let declIdx = idx + 1;
          let isAbstract = false;
          if (toks[declIdx]?.text === 'abstract') { isAbstract = true; declIdx++; }
          else if (toks[declIdx]?.text === 'async' && toks[declIdx + 1]?.text === 'function') declIdx++;
          const afterDef = toks[declIdx];
          if (afterDef && (afterDef.text === 'class' || afterDef.text === 'function') &&
              (toks[declIdx + 1]?.text === '{' || toks[declIdx + 1]?.text === '(' || toks[declIdx + 1]?.text === 'extends' || toks[declIdx + 1]?.text === '*')) {
            let k = declIdx + 1;
            while (k < toks.length && toks[k].text !== '{') k++;
            const close = k < toks.length ? findMatchingBrace(toks, k) : -1;
            if (close > k && !src.includes('default_1')) {
              const kwPrefix = (!isAbstract && declIdx > idx + 1) ? `${toks[idx + 1].text} ` : '';
              const afterKw = src.slice(afterDef.end, toks[close].end);
              const emitted = `${kwPrefix}${afterDef.text} default_1${afterKw}\n${parentNs}.default_1 = default_1;`;
              edits.push({ start: t.start, end: toks[close].end, text: emitted });
              i = close;
              continue;
            }
          }
          edits.push({ start: t.start, end: kw.end, text: '' });
          continue;
        }
        // `export async function f(...) { ... }` or `export function f(...) { ... }`
        let fnIdx = idx;
        if (kw.text === 'async' && toks[idx + 1]?.text === 'function') fnIdx = idx + 1;
        if (toks[fnIdx]?.text === 'function') {
          let nameIdx = fnIdx + 1;
          if (toks[nameIdx]?.text === '*') nameIdx++;
          if (toks[nameIdx]?.type !== 'id') return null;
          const fnName = toks[nameIdx].text;
          let k = nameIdx + 1;
          let seenParams = false;
          while (k < toks.length) {
            const tk = toks[k];
            if (tk.type === 'punc' && tk.text === '(') {
              const cp = findMatchingParen(toks, k);
              if (cp < 0) return null;
              if (!seenParams) seenParams = true;
              k = cp + 1;
              continue;
            }
            if (tk.type === 'punc' && tk.text === ';') break;
            if (tk.type === 'punc' && tk.text === '{') {
              // Skip object-type literal inside return type annotation (e.g. `: number | { new <T>(data: T): T; } { ... }`)
              const prevK = toks[k - 1]?.text;
              if (seenParams && (prevK === ':' || prevK === '|' || prevK === '&' || prevK === '=>' || prevK === '<' || prevK === '[' || prevK === ',')) {
                const cb = findMatchingBrace(toks, k);
                if (cb < 0) return null;
                k = cb + 1;
                continue;
              }
              break;
            }
            k++;
          }
          if (k >= toks.length) return null;
          if (toks[k].text === ';') {
            // Overload signature: strip `export ` so stripTypeScriptTypes erases the overload
            edits.push({ start: t.start, end: kw.start, text: '' });
            i = k;
            continue;
          }
          const close = findMatchingBrace(toks, k);
          if (close < 0) return null;
          const fnSrc = src.slice(kw.start, toks[close].end);
          edits.push({ start: t.start, end: toks[close].end, text: `${fnSrc}\n${parentNs}.${fnName} = ${fnName};` });
          i = close;
          continue;
        }
        // `export [abstract] class C ... { ... }`
        let clsIdx = idx;
        if (kw.text === 'abstract' && toks[idx + 1]?.text === 'class') clsIdx = idx + 1;
        if (toks[clsIdx]?.text === 'class' && toks[clsIdx + 1]?.type === 'id') {
          const clsName = toks[clsIdx + 1].text;
          let k = clsIdx + 2;
          while (k < toks.length && !(toks[k].type === 'punc' && toks[k].text === '{')) k++;
          if (k >= toks.length) return null;
          const close = findMatchingBrace(toks, k);
          if (close < 0) return null;
          const clsSrc = src.slice(kw.start, toks[close].end);
          edits.push({ start: t.start, end: toks[close].end, text: `${clsSrc}\n${parentNs}.${clsName} = ${clsName};` });
          i = close;
          continue;
        }
        // `export var/let/const x[: T] = expr[, y[: U] = expr2];` (single or multi-declarator without destructuring)
        if (kw.text === 'var' || kw.text === 'let' || kw.text === 'const') {
          let k = idx + 1, dP = 0, dB = 0, dBr = 0, dA = 0, endIdx = -1;
          const declRanges = [];
          let declStart = idx + 1;
          while (k < toks.length) {
            const tk = toks[k];
            if (tk.type === 'punc') {
              if (tk.text === '(') dP++;
              else if (tk.text === ')') dP--;
              else if (tk.text === '[') dB++;
              else if (tk.text === ']') dB--;
              else if (tk.text === '{') dBr++;
              else if (tk.text === '}') { if (dBr === 0) break; dBr--; }
              else if (tk.text === '<') dA++;
              else if (tk.text === '>') { if (dA > 0) dA--; }
              else if (dP === 0 && dB === 0 && dBr === 0 && dA === 0) {
                if (tk.text === ',') { declRanges.push([declStart, k]); declStart = k + 1; }
                else if (tk.text === ';') { declRanges.push([declStart, k]); endIdx = k; break; }
              }
            }
            if (dP === 0 && dB === 0 && dBr === 0 && dA === 0 && k > declStart &&
                hasNewlineBetween(src, toks[k - 1].end, tk.start) &&
                (tk.type === 'id' && ['export', 'var', 'let', 'const', 'function', 'class', 'namespace', 'module', 'enum', 'interface', 'type', 'declare', 'return', 'if', 'for', 'while'].includes(tk.text))) {
              declRanges.push([declStart, k]);
              endIdx = k - 1;
              break;
            }
            k++;
          }
          if (endIdx < 0) {
            endIdx = Math.min(k, toks.length) - 1;
            if (declStart <= endIdx) declRanges.push([declStart, endIdx + 1]);
          }
          if (declRanges.length === 0) return null;
          const rest = src.slice(0, t.start) + src.slice(toks[endIdx].end);
          const outParts = [];
          for (const [ds, de] of declRanges) {
            const nameTok = toks[ds];
            if (!nameTok) return null;
            if (nameTok.type === 'punc' && (nameTok.text === '{' || nameTok.text === '[')) {
              // Destructuring `export var { a, b } = expr;` or `export var [a, b] = expr;` inside namespace
              let eqIdx = -1, pD = 0, bD = 0, brD = 0, aD = 0;
              for (let m = ds; m < de; m++) {
                const mt = toks[m];
                if (mt.type === 'punc') {
                  if (mt.text === '(') pD++;
                  else if (mt.text === ')') pD--;
                  else if (mt.text === '[') bD++;
                  else if (mt.text === ']') bD--;
                  else if (mt.text === '{') brD++;
                  else if (mt.text === '}') brD--;
                  else if (mt.text === '<') aD++;
                  else if (mt.text === '>') { if (aD > 0) aD--; }
                  else if (mt.text === '=' && pD === 0 && bD === 0 && brD === 0 && aD === 0) { eqIdx = m; break; }
                }
              }
              if (eqIdx < 0) return null;
              // Extract bound identifiers from the pattern (toks[ds..eqIdx-1])
              const bound = [];
              let patEnd = eqIdx;
              // Skip optional `: Type` before `=`
              for (let m = ds, dB = 0, dBr = 0; m < eqIdx; m++) {
                if (toks[m].text === '[') dB++;
                else if (toks[m].text === ']') dB--;
                else if (toks[m].text === '{') dBr++;
                else if (toks[m].text === '}') dBr--;
                else if (toks[m].text === ':' && dB === 0 && dBr === 0) { patEnd = m; break; }
              }
              for (let m = ds; m < patEnd; m++) {
                if (toks[m].type === 'id' && toks[m + 1]?.text !== ':' && toks[m - 1]?.text !== '.') {
                  // Skip default values after `=` inside pattern
                  if (toks[m - 1]?.text === '=') continue;
                  bound.push(toks[m].text);
                }
              }
              const declText = src.slice(toks[ds].start, toks[de - 1].end).trim();
              outParts.push(`${kw.text} ${declText};`);
              for (const bn of bound) outParts.push(`${parentNs}.${bn} = ${bn};`);
              continue;
            }
            if (nameTok.type !== 'id') return null;
            const varName = nameTok.text;
            let eqIdx = -1, pD = 0, bD = 0, brD = 0, aD = 0;
            for (let m = ds + 1; m < de; m++) {
              const mt = toks[m];
              if (mt.type === 'punc') {
                if (mt.text === '(') pD++;
                else if (mt.text === ')') pD--;
                else if (mt.text === '[') bD++;
                else if (mt.text === ']') bD--;
                else if (mt.text === '{') brD++;
                else if (mt.text === '}') brD--;
                else if (mt.text === '<') aD++;
                else if (mt.text === '>') { if (aD > 0) aD--; }
                else if (mt.text === '=' && pD === 0 && bD === 0 && brD === 0 && aD === 0) { eqIdx = m; break; }
              }
            }
            if (eqIdx < 0) continue; // uninitialized `export var x: T;` is erased by TS
            let rhs = src.slice(toks[eqIdx + 1].start, toks[de - 1].end).trim();
            // Rewrite references to previously exported vars in this namespace inside `rhs`
            if (exportedVars.length > 0) {
              const prevNames = new Set(exportedVars.map(v => v.name));
              const rhsToks = tokenize(rhs, isJsx);
              if (!rhsToks) return null;
              const rhsEdits = [];
              let hasConflict = false;
              for (let ri = 0; ri < rhsToks.length; ri++) {
                const rt = rhsToks[ri];
                if (rt.type !== 'id' || !prevNames.has(rt.text)) continue;
                const rPrev = ri > 0 ? rhsToks[ri - 1] : null;
                const rNext = rhsToks[ri + 1];
                if (rPrev && rPrev.text === '.') continue;
                if (rNext && rNext.text === ':' && rPrev && (rPrev.text === '{' || rPrev.text === ',')) continue;
                if (/\b(?:function|class)\b/.test(rhs) || (rPrev && (rPrev.text === '{' || rPrev.text === ',') && rNext && (rNext.text === '}' || rNext.text === ','))) {
                  hasConflict = true;
                  break;
                }
                rhsEdits.push({ start: rt.start, end: rt.end, text: `${parentNs}.${rt.text}` });
              }
              if (hasConflict) return null;
              if (rhsEdits.length > 0) {
                let nr = '', rp = 0;
                for (const e of rhsEdits) { nr += rhs.slice(rp, e.start) + e.text; rp = e.end; }
                rhs = nr + rhs.slice(rp);
              }
            }
            if (declRanges.length > 1) {
              // Bail if any later declarator in this same statement references `varName`
              const tailSrc = src.slice(toks[de - 1].end, toks[endIdx].end);
              if (new RegExp(`(?<![\\w$.])${varName}(?![\\w$])`).test(tailSrc)) return null;
            }
            // Check if `varName` is referenced as a bare identifier outside this statement (ignoring `.varName`,
            // `varName:` property keys/class fields, `interface`/`type` names, and erased `export { ... }` lists).
            let hasBareRef = false;
            for (let ri = 0; ri < toks.length; ri++) {
              if (ri >= i && ri <= endIdx) continue;
              if (toks[ri].type === 'id' && toks[ri].text === 'export' && toks[ri + 1]?.text === '{') {
                const cb = findMatchingBrace(toks, ri + 1);
                if (cb > ri + 1 && toks[cb + 1]?.text !== 'from') { ri = cb; continue; }
              }
              const rt = toks[ri];
              if (rt.type !== 'id' || rt.text !== varName) continue;
              const rPrev = ri > 0 ? toks[ri - 1] : null;
              const rNext = toks[ri + 1];
              if (rPrev && (rPrev.text === '.' || rPrev.text === 'interface' || rPrev.text === 'type')) continue;
              // Property key / class field / parameter property (`foo: ...`) is not a variable reference
              if (rNext && rNext.text === ':' && rPrev &&
                  (rPrev.text === '{' || rPrev.text === ',' || rPrev.text === ';' || rPrev.text === '(' || rPrev.text === '}' ||
                   (rPrev.type === 'id' && /^(?:public|private|protected|readonly|override|static|abstract|declare|accessor)$/.test(rPrev.text)))) continue;
              // Duplicate `export var x = ...` in the same namespace is not a bare variable reference
              if (rPrev && (rPrev.text === 'var' || rPrev.text === 'let' || rPrev.text === 'const') && toks[ri - 2]?.text === 'export') continue;
              // Sibling `export class Foo` / `class Foo` declared BEFORE `export var Foo = 1` does not need rewriting
              if (rPrev && rPrev.text === 'class' && ri < i) continue;
              hasBareRef = true;
              break;
            }
            if (hasBareRef) {
              if (/\bimport\s+[A-Za-z_$][\w$]*\s*=/.test(rest) ||
                  new RegExp(`\\b(?:var|let|const|function|class|enum|namespace|module)\\s+${varName}\\b|\\((?:[^)=]*,)?\\s*(?:(?:public|private|protected|readonly|override)\\s+)?${varName}\\b|\\b${varName}\\s*:`).test(rest)) {
                return null;
              }
              exportedVars.push({ name: varName, stmtStart: t.start, stmtEnd: toks[endIdx].end });
            }
            outParts.push(`${parentNs}.${varName} = ${rhs};`);
          }
          const replacement = outParts.length > 0
            ? outParts.join('\n')
            : src.slice(t.start, toks[endIdx].end).replace(/[^\r\n]/g, ' ');
          edits.push({ start: t.start, end: toks[endIdx].end, text: replacement, isVarDecl: true });
          i = endIdx;
          continue;
        }
        // `export import x = require("...");` inside an internal namespace/module is erased by TypeScript
        // (bail if `x` is referenced anywhere else in the namespace so TS rewrites it to `${parentNs}.x`)
        if (kw.text === 'import' && toks[idx + 1]?.type === 'id' &&
            toks[idx + 2]?.text === '=' && toks[idx + 3]?.text === 'require' && toks[idx + 4]?.text === '(' &&
            toks[idx + 5]?.type === 'str' && toks[idx + 6]?.text === ')') {
          const aliasName = toks[idx + 1].text;
          if (aliasName.includes('\\u')) return null;
          let endIdx = idx + 6;
          if (toks[endIdx + 1]?.text === ';') endIdx++;
          for (let ri = 0; ri < toks.length; ri++) {
            if (ri >= i && ri <= endIdx) continue;
            const rt = toks[ri];
            if (rt.type !== 'id') continue;
            if (rt.text.includes('\\u') || (rt.text === aliasName && toks[ri - 1]?.text !== '.')) return null;
          }
          edits.push({ start: t.start, end: toks[endIdx].end, text: src.slice(t.start, toks[endIdx].end).replace(/[^\r\n]/g, ' '), isVarDecl: true });
          i = endIdx;
          continue;
        }
        // `export import a = X.Y;` inside a namespace -> `${parentNs}.a = X.Y;`
        if (kw.text === 'import' && toks[idx + 1]?.type === 'id' &&
            toks[idx + 2]?.type === 'punc' && toks[idx + 2].text === '=' &&
            toks[idx + 3]?.type === 'id' && toks[idx + 3].text !== 'require' && toks[idx + 3].text !== 'module') {
          const aliasName = toks[idx + 1].text;
          let k = idx + 3;
          while (toks[k + 1]?.type === 'punc' && toks[k + 1].text === '.' && toks[k + 2]?.type === 'id') k += 2;
          if (toks[k + 1]?.text === '(') return null;
          let endIdx = k;
          if (toks[endIdx + 1]?.type === 'punc' && toks[endIdx + 1].text === ';') endIdx++;
          const rhs = src.slice(toks[idx + 3].start, toks[k].end);
          const rest = src.slice(0, t.start) + src.slice(toks[endIdx].end);
          if (new RegExp(`(?<![\\w$.])${aliasName}(?![\\w$])`).test(rest)) {
            if (new RegExp(`\\b(?:var|let|const|function|class|enum|namespace|module)\\s+${aliasName}\\b|\\([^)]*\\b${aliasName}\\b|\\b${aliasName}\\s*:`).test(rest)) {
              return null;
            }
            exportedVars.push({ name: aliasName, stmtStart: t.start, stmtEnd: toks[endIdx].end });
          }
          edits.push({ start: t.start, end: toks[endIdx].end, text: `${parentNs}.${aliasName} = ${rhs};`, isVarDecl: true });
          i = endIdx;
          continue;
        }
        // Any other `export ...` inside a namespace: bail safely
        return null;
      }
      // Top-level `export [public|private|protected] import a = X.Y;` -> `export var a = X.Y;`
      if (!parentNs && isExport) {
        let impIdx = idx;
        while (toks[impIdx]?.type === 'id' && /^(?:public|private|protected)$/.test(toks[impIdx].text)) impIdx++;
        if (toks[impIdx]?.text === 'import' && toks[impIdx + 1]?.type === 'id' &&
            toks[impIdx + 2]?.type === 'punc' && toks[impIdx + 2].text === '=' &&
            toks[impIdx + 3]?.type === 'id' && toks[impIdx + 3].text !== 'require' && toks[impIdx + 3].text !== 'module') {
          const aliasName = toks[impIdx + 1].text;
          let k = impIdx + 3;
          while (toks[k + 1]?.type === 'punc' && toks[k + 1].text === '.' && toks[k + 2]?.type === 'id') k += 2;
          if (toks[k + 1]?.text === '(') return null;
          let endIdx = k;
          if (toks[endIdx + 1]?.type === 'punc' && toks[endIdx + 1].text === ';') endIdx++;
          else {
            const nextTk = toks[endIdx + 1];
            if (nextTk && (nextTk.text === '(' || nextTk.text === '[' || nextTk.text === '/' || nextTk.type === 'regex' || nextTk.text.startsWith('in'))) return null;
          }
          const rhs = src.slice(toks[impIdx + 3].start, toks[k].end);
          if (rhs.split('.').some(part => RESERVED_NS.has(part))) return null;
          edits.push({ start: t.start, end: toks[endIdx].end, text: `export var ${aliasName} = ${rhs};` });
          i = endIdx;
          continue;
        }
      }
      // Inside an internal namespace/module, `import x = require("...");` and static `import ... from "...";` / `import "...";` are erased by TypeScript
      if (parentNs && !isExport && toks[idx].text === 'import') {
        const afterImp = toks[idx + 1];
        if (!afterImp || afterImp.text === '(' || afterImp.text === '.') continue;
        if (afterImp.type === 'id' &&
            toks[idx + 2]?.text === '=' && toks[idx + 3]?.text === 'require' && toks[idx + 4]?.text === '(' &&
            toks[idx + 5]?.type === 'str' && toks[idx + 6]?.text === ')') {
          let endIdx = idx + 6;
          if (toks[endIdx + 1]?.text === ';') endIdx++;
          edits.push({ start: t.start, end: toks[endIdx].end, text: src.slice(t.start, toks[endIdx].end).replace(/[^\r\n]/g, ' '), isVarDecl: true });
          i = endIdx;
          continue;
        }
        // `import a = X.Y;` is handled right below
        if (afterImp.type === 'id' && toks[idx + 2]?.text === '=') {
          // fall through to import-equals lowering below
        } else if (afterImp.type === 'str') {
          // Side-effect `import "a";` inside a namespace
          let endIdx = idx + 1;
          if (toks[endIdx + 1]?.text === ';') endIdx++;
          else if (toks[endIdx + 1] && toks[endIdx + 1].text !== '}' && !hasNewlineBetween(src, toks[endIdx].end, toks[endIdx + 1].start)) {
            return null;
          }
          const stmt = src.slice(t.start, toks[endIdx].end);
          try { stripTypeScriptTypes(stmt); } catch { return null; }
          edits.push({ start: t.start, end: toks[endIdx].end, text: stmt.replace(/[^\r\n]/g, ' '), isVarDecl: true });
          i = endIdx;
          continue;
        } else if (afterImp.text === '*' || afterImp.text === '{' || afterImp.type === 'id') {
          // Static `import * as X from "...";` / `import X from "...";` / `import { ... } from "...";` (start at idx+2 so `import from from "a"` works)
          let k = idx + 2, dBr = afterImp.text === '{' ? 1 : 0;
          while (k < toks.length) {
            const tk = toks[k];
            if (tk.text === '{') { dBr++; k++; continue; }
            if (tk.text === '}') { if (dBr === 0) break; dBr--; k++; continue; }
            if (dBr === 0 && (tk.text === ';' || tk.text === '=')) break;
            if (dBr === 0 && tk.type === 'id' && tk.text === 'from' && toks[k - 1]?.text !== '.') break;
            k++;
          }
          if (toks[k]?.text === 'from' && toks[k - 1]?.text !== '.' && toks[k + 1]?.type === 'str') {
            let endIdx = k + 1;
            if (toks[endIdx + 1]?.text === ';') endIdx++;
            else if (toks[endIdx + 1] && toks[endIdx + 1].text !== '}' && !hasNewlineBetween(src, toks[endIdx].end, toks[endIdx + 1].start)) {
              return null;
            }
            const stmt = src.slice(t.start, toks[endIdx].end);
            try { stripTypeScriptTypes(stmt); } catch { return null; }
            edits.push({ start: t.start, end: toks[endIdx].end, text: stmt.replace(/[^\r\n]/g, ' '), isVarDecl: true });
            i = endIdx;
            continue;
          }
          return null;
        } else {
          return null;
        }
      }
      // Non-exported `import a = X.Y;` (top-level or inside a namespace) -> `var a = X.Y;`
      if (!isExport && toks[idx].text === 'import' && toks[idx + 1]?.type === 'id' &&
          toks[idx + 2]?.type === 'punc' && toks[idx + 2].text === '=' &&
          toks[idx + 3]?.type === 'id' && toks[idx + 3].text !== 'require' && toks[idx + 3].text !== 'module') {
        const aliasName = toks[idx + 1].text;
        let k = idx + 3;
        while (toks[k + 1]?.type === 'punc' && toks[k + 1].text === '.' && toks[k + 2]?.type === 'id') k += 2;
        if (toks[k + 1]?.text === '(') return null;
        let endIdx = k;
        if (toks[endIdx + 1]?.type === 'punc' && toks[endIdx + 1].text === ';') endIdx++;
        else {
          const nextTk = toks[endIdx + 1];
          if (nextTk && (nextTk.text === '(' || nextTk.text === '[' || nextTk.text === '/' || nextTk.type === 'regex' || nextTk.text.startsWith('in'))) return null;
        }
        const rhs = src.slice(toks[idx + 3].start, toks[k].end);
        if (rhs.split('.').some(part => RESERVED_NS.has(part))) return null;
        edits.push({ start: t.start, end: toks[endIdx].end, text: `var ${aliasName} = ${rhs};` });
        i = endIdx;
        continue;
      }
    }
    if (exportedVars.length > 0 && parentNs) {
      // Rewrite bare identifier references to exported namespace vars/aliases to `${parentNs}.${name}`
      const nameSet = new Set(exportedVars.map(v => v.name));
      for (let ti = 0; ti < toks.length; ti++) {
        const tk = toks[ti];
        if (tk.type !== 'id' || !nameSet.has(tk.text)) continue;
        // Skip if inside a var-decl edit (already rewritten via rhsEdits / own declaration);
        // bail if inside a non-var edit (e.g. export function/class body that was copied verbatim)
        const enclosingEdit = edits.find(e => tk.start >= e.start && tk.end <= e.end);
        if (enclosingEdit) {
          if (enclosingEdit.isVarDecl) continue;
          const prev0 = ti > 0 ? toks[ti - 1] : null;
          if (prev0 && (prev0.text === '.' || prev0.text === 'interface' || prev0.text === 'type')) continue;
          return null;
        }
        const prev = ti > 0 ? toks[ti - 1] : null;
        const next = toks[ti + 1];
        if (prev && prev.type === 'punc' && prev.text === '.') continue;
        if (prev && prev.type === 'id' && (prev.text === 'interface' || prev.text === 'type')) continue;
        // Bail on shorthand object property `{ a }` or binding default `{ a = 1 }` (needs `a: N.a`, not `N.a`)
        if (prev && (prev.text === '{' || prev.text === ',') && next && (next.text === '}' || next.text === ',' || next.text === '=')) return null;
        edits.push({ start: tk.start, end: tk.end, text: `${parentNs}.${tk.text}` });
      }
      edits.sort((a, b) => a.start - b.start);
    }
    if (edits.length === 0) return { code: src, changed: false };
    let out = '', pos = 0;
    for (const e of edits) {
      out += src.slice(pos, e.start) + e.text;
      pos = e.end;
    }
    out += src.slice(pos);
    return { code: out, changed: true };
  }

  function lowerNamespaceBody(bodySrc, nsName) {
    const res = lowerBlock(bodySrc, nsName);
    return res ? res.code : null;
  }

  return lowerBlock(source, null);
}

// Lowers simple class constructor parameter properties (`constructor(public x: T = 1) { ... }`)
// to ESNext TypeScript output (`x;\nconstructor(x = 1) { this.x = x; ... }`).
// Conservatively declines constructors containing `super(`, decorators, or `override` modifiers.
function lowerParameterProperties(source) {
  if (!/\bconstructor\s*\(/.test(source) || !/\b(?:public|private|protected|readonly|override)\b/.test(source)) {
    return { code: source, changed: false };
  }
  const toks = tokenize(source);
  if (!toks) return null;
  const edits = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'id' || t.text !== 'constructor') continue;
    if (toks[i + 1]?.type !== 'punc' || toks[i + 1].text !== '(') continue;
    const prev = i > 0 ? toks[i - 1] : null;
    if (prev && prev.type === 'punc' && prev.text === '.') continue;
    const closeParen = findMatchingParen(toks, i + 1);
    if (closeParen < 0) return null;
    // Must have a body `{ ... }` right after `)`
    if (toks[closeParen + 1]?.type !== 'punc' || toks[closeParen + 1].text !== '{') continue;
    const closeBody = findMatchingBrace(toks, closeParen + 1);
    if (closeBody < 0) return null;
    // Split params at depth 0
    const params = [];
    let dP = 0, dB = 0, dBr = 0, dA = 0, pStart = i + 2;
    for (let k = i + 2; k < closeParen; k++) {
      const tk = toks[k];
      if (tk.type === 'punc') {
        if (tk.text === '(') dP++;
        else if (tk.text === ')') dP--;
        else if (tk.text === '[') dB++;
        else if (tk.text === ']') dB--;
        else if (tk.text === '{') dBr++;
        else if (tk.text === '}') dBr--;
        else if (tk.text === '<') dA++;
        else if (tk.text === '>') { if (dA > 0) dA--; }
        else if (tk.text === ',' && dP === 0 && dB === 0 && dBr === 0 && dA === 0) {
          params.push(toks.slice(pStart, k));
          pStart = k + 1;
        }
      }
    }
    if (pStart < closeParen) params.push(toks.slice(pStart, closeParen));

    const propNames = [];
    const modRemovals = [];
    let abort = false;
    for (const p of params) {
      if (p.length === 0) continue;
      let j = 0;
      // Skip any leading parameter decorators (`@Dec`, `@ns.Dec(arg)`) so TS keeps them while we strip modifiers
      while (j < p.length && p[j].text === '@') {
        j++;
        if (j < p.length && p[j].type === 'id') {
          j++;
          while (j + 1 < p.length && p[j].text === '.' && p[j + 1].type === 'id') j += 2;
          if (j < p.length && p[j].text === '(') {
            let dp = 1; j++;
            while (j < p.length && dp > 0) {
              if (p[j].text === '(') dp++;
              else if (p[j].text === ')') dp--;
              j++;
            }
          }
        } else {
          abort = true;
          break;
        }
      }
      if (abort) break;
      const modStartIdx = j;
      let hasMod = false;
      while (j < p.length && p[j].type === 'id' &&
          (p[j].text === 'public' || p[j].text === 'private' || p[j].text === 'protected' || p[j].text === 'readonly' || p[j].text === 'override')) {
        hasMod = true;
        j++;
      }
      if (abort) break;
      if (!hasMod) continue;
      if (j >= p.length || p[j].type !== 'id') {
        if (j < p.length && (p[j].text === '{' || p[j].text === '[' || p[j].text === '...')) {
          modRemovals.push({ start: p[modStartIdx].start, end: p[j].start });
          continue;
        }
        abort = true;
        break;
      }
      propNames.push(p[j].text);
      modRemovals.push({ start: p[modStartIdx].start, end: p[j].start });
    }
    if (abort) return null;
    if (propNames.length === 0 && modRemovals.length === 0) continue;
    if (propNames.length === 0) {
      for (const mr of modRemovals) edits.push({ start: mr.start, end: mr.end, text: '' });
      continue;
    }
    // Skip any leading directive prologues (e.g. "ngInject1";) — TS places parameter property assignments after them.
    let bodyCursor = closeParen + 2;
    let assignInsertPos = toks[closeParen + 1].end;
    while (bodyCursor < closeBody && toks[bodyCursor]?.type === 'str' && toks[bodyCursor].text[0] !== '`') {
      const nextAfterStr = toks[bodyCursor + 1];
      const isTplAfter = nextAfterStr && (nextAfterStr.type === 'tpl' || (nextAfterStr.type === 'str' && nextAfterStr.text[0] === '`'));
      const isPrefixIncDec = nextAfterStr && (nextAfterStr.text === '+' || nextAfterStr.text === '-') &&
        toks[bodyCursor + 2]?.text === nextAfterStr.text && nextAfterStr.end === toks[bodyCursor + 2].start;
      const isDirective = nextAfterStr?.text === ';' ||
        (nextAfterStr && hasNewlineBetween(source, toks[bodyCursor].end, nextAfterStr.start) &&
          !isTplAfter &&
          (isPrefixIncDec || !['+', '-', '*', '/', '%', '.', '?.', '(', '[', '?', ',', '=', '&&', '||', '??', '==', '===', '!=', '!==', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(nextAfterStr.text))) ||
        bodyCursor + 1 === closeBody;
      if (!isDirective) break;
      if (nextAfterStr?.text === ';') {
        assignInsertPos = nextAfterStr.end;
        bodyCursor += 2;
      } else {
        assignInsertPos = toks[bodyCursor].end;
        bodyCursor += 1;
      }
    }
    // Handle `super(...)` if it appears as a single top-level statement in the constructor body; otherwise bail if `super` appears
    const bodySrc = source.slice(toks[closeParen + 1].end, toks[closeBody].start);
    if (/\bsuper\b/.test(bodySrc)) {
      let superCount = 0;
      let superEndPos = -1;
      let dBr = 0, dP = 0, dB = 0;
      for (let k = bodyCursor; k < closeBody; k++) {
        const tk = toks[k];
        if (tk.text === '{') dBr++;
        else if (tk.text === '}') dBr--;
        else if (tk.text === '(') dP++;
        else if (tk.text === ')') dP--;
        else if (tk.text === '[') dB++;
        else if (tk.text === ']') dB--;
        else if (tk.type === 'id' && tk.text === 'super' && toks[k - 1]?.text !== '.') {
          superCount++;
          if (dBr === 0 && dP === 0 && dB === 0 && toks[k + 1]?.text === '(') {
            // Verify `super(...)` is a standalone top-level statement (very first statement after prologues, or
            // immediately preceded by `;` or `}`), never a braceless control body or newline-continued expression (`void\nsuper()`).
            if (k > bodyCursor) {
              const prevTk = toks[k - 1];
              if (prevTk.text !== ';' && prevTk.text !== '}') return null;
            }
            const closeSuper = findMatchingParen(toks, k + 1);
            if (closeSuper < 0 || closeSuper >= closeBody) return null;
            let afterSuper = closeSuper;
            if (toks[afterSuper + 1]?.text === ';') afterSuper++;
            else if (toks[afterSuper + 1] && !hasNewlineBetween(source, toks[afterSuper].end, toks[afterSuper + 1].start) && afterSuper + 1 < closeBody) return null;
            superEndPos = toks[afterSuper].end;
            k = afterSuper;
          } else {
            return null;
          }
        }
      }
      if (superCount !== 1 || superEndPos < 0) return null;
      assignInsertPos = superEndPos;
    }

    // Emit field declarations at the top of the enclosing class body `{` (matching ESNext TypeScript output).
    // Walk backwards to find the enclosing `{` of the class body.
    let classOpenIdx = -1;
    let cBr = 0;
    for (let k = i - 1; k >= 0; k--) {
      if (toks[k].type === 'punc' && toks[k].text === '}') cBr++;
      else if (toks[k].type === 'punc' && toks[k].text === '{') {
        if (cBr === 0) { classOpenIdx = k; break; }
        cBr--;
      }
    }
    if (classOpenIdx < 0) return null;
    const fieldInsertPos = toks[classOpenIdx].end;
    const fieldDecls = '\n' + propNames.map(n => `${n};`).join('\n') + '\n';
    const assigns = '\n' + propNames.map(n => `this.${n} = ${n};`).join('\n') + '\n';
    edits.push({ start: fieldInsertPos, end: fieldInsertPos, text: fieldDecls });
    for (const r of modRemovals) edits.push({ start: r.start, end: r.end, text: '' });
    edits.push({ start: assignInsertPos, end: assignInsertPos, text: assigns });
    i = closeBody;
  }
  // Also erase stray `override` modifiers on non-constructor class method parameters (e.g. `class C { m(override p1: T) {} }`),
  // strictly at class-body member depth 1 so call expressions like `true ? foo(override x) : 0` or `foo(override x)\n{}` are never touched.
  if (source.includes('override')) {
    const classBodyDepths = [];
    let brDepth = 0;
    for (let i = 0; i < toks.length - 2; i++) {
      const tk0 = toks[i];
      if (tk0.type === 'id' && tk0.text === 'class' && toks[i - 1]?.text !== '.') {
        let k = i + 1;
        while (k < toks.length && toks[k].text !== '{') k++;
        if (k < toks.length) classBodyDepths.push({ openIdx: k, depth: brDepth + 1 });
      } else if (tk0.text === '{') {
        brDepth++;
      } else if (tk0.text === '}') {
        if (classBodyDepths.length > 0 && classBodyDepths[classBodyDepths.length - 1].depth === brDepth) classBodyDepths.pop();
        if (brDepth > 0) brDepth--;
      } else if (tk0.text === '(' && classBodyDepths.length > 0 && brDepth === classBodyDepths[classBodyDepths.length - 1].depth) {
        const beforeOpen = toks[i - 1];
        if (!beforeOpen || (beforeOpen.type !== 'id' && beforeOpen.text !== ']' && beforeOpen.text !== '>')) continue;
        const closeP = findMatchingParen(toks, i);
        if (closeP <= i + 1) continue;
        // Require a method body `{` after optional `: ReturnType` (with no statement boundary before `{`)
        let mEnd = closeP + 1;
        if (toks[mEnd]?.text === ':') {
          mEnd++;
          let rP = 0, rB = 0, rBr = 0;
          while (mEnd < toks.length) {
            const mt = toks[mEnd].text;
            if (mt === '(') rP++; else if (mt === ')') rP--;
            else if (mt === '[') rB++; else if (mt === ']') rB--;
            else if (mt === '{') { if (rP === 0 && rB === 0 && rBr === 0) break; rBr++; }
            else if (mt === '}') { if (rBr === 0) break; rBr--; }
            else if (mt === ';' && rP === 0 && rB === 0 && rBr === 0) break;
            mEnd++;
          }
        }
        if (toks[mEnd]?.text !== '{') continue;
        let dP = 0, dB = 0, dBr = 0, dA = 0;
        for (let k = i + 1; k < closeP; k++) {
          const tk = toks[k];
          if (tk.text === '(') dP++; else if (tk.text === ')') dP--;
          else if (tk.text === '[') dB++; else if (tk.text === ']') dB--;
          else if (tk.text === '{') dBr++; else if (tk.text === '}') dBr--;
          else if (tk.text === '<') dA++; else if (tk.text === '>') { if (dA > 0) dA--; }
          else if (dP === 0 && dB === 0 && dBr === 0 && dA === 0 &&
              tk.type === 'id' && tk.text === 'override' &&
              (k === i + 1 || toks[k - 1].text === ',') &&
              toks[k + 1]?.type === 'id' &&
              (toks[k + 2]?.text === ':' || toks[k + 2]?.text === '?' || toks[k + 2]?.text === '=' || toks[k + 2]?.text === ',' || toks[k + 2]?.text === ')')) {
            if (!edits.some(e => e.start <= tk.start && e.end >= tk.end)) {
              edits.push({ start: tk.start, end: toks[k + 1].start, text: '' });
            }
          }
        }
      }
    }
  }
  if (edits.length === 0) return { code: source, changed: false };
  edits.sort((a, b) => a.start - b.start);
  let out = '', pos = 0;
  for (const e of edits) {
    out += source.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += source.slice(pos);
  return { code: out, changed: true };
}

// Erases non-ES-Stage-3 decorators that TypeScript erases when `experimentalDecorators` is false:
// parameter decorators `(@dec x)`, and decorators on `static {`, `constructor`, `enum`, `function`,
// `interface`, `type`, `var`, `let`, `const`, `namespace`, `module`, `import`.
function eraseNonEsDecorators(source) {
  if (!source.includes('@')) return { code: source, changed: false };
  const toks = tokenize(source);
  if (!toks) return null;
  const edits = [];
  let parenDepth = 0;
  const INVALID_TARGETS = new Set(['constructor', 'enum', 'function', 'interface', 'type', 'var', 'let', 'const', 'namespace', 'module', 'import']);

  function consumeDecorator(startIdx) {
    // Expect `@` at startIdx
    let k = startIdx + 1;
    if (k >= toks.length) return -1;
    if (toks[k].type === 'punc' && toks[k].text === '(') {
      const cp = findMatchingParen(toks, k);
      if (cp < 0) return -1;
      k = cp + 1;
    } else if (toks[k].type === 'id') {
      k++;
      while (k < toks.length && toks[k].type === 'punc' && toks[k].text === '.' && toks[k + 1]?.type === 'id') k += 2;
    } else {
      return -1;
    }
    if (k < toks.length && toks[k].type === 'punc' && toks[k].text === '(') {
      const cp = findMatchingParen(toks, k);
      if (cp < 0) return -1;
      k = cp + 1;
    }
    return k; // index of first token after decorator
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'punc' && t.text === '(') { parenDepth++; continue; }
    if (t.type === 'punc' && t.text === ')') { if (parenDepth > 0) parenDepth--; continue; }
    if (t.type !== 'punc' || t.text !== '@') continue;

    // Collect a contiguous run of decorators starting at i
    let k = i;
    while (k < toks.length && toks[k].type === 'punc' && toks[k].text === '@') {
      const next = consumeDecorator(k);
      if (next < 0) return null;
      k = next;
    }
    const target = toks[k];
    let shouldErase = false;
    if (parenDepth === 0 && target && target.type === 'id') {
      const prev = i > 0 ? toks[i - 1] : null;
      const stmtStart = !prev || (prev.type === 'punc' && (prev.text === ';' || prev.text === '{' || prev.text === '}')) ||
        hasNewlineBetween(source, prev.end, t.start);
      let tk = k;
      if (toks[tk]?.text === 'export') tk++;
      if (toks[tk]?.text === 'default' || toks[tk]?.text === 'declare' || toks[tk]?.text === 'async') tk++;
      const kw = toks[tk]?.text;
      if (stmtStart && kw && INVALID_TARGETS.has(kw)) shouldErase = true;
      else if (stmtStart && kw === 'static' && toks[tk + 1]?.type === 'punc' && toks[tk + 1].text === '{') shouldErase = true;
    }
    if (shouldErase) {
      const startOff = toks[i].start;
      const endOff = toks[k - 1].end;
      const blank = source.slice(startOff, endOff).replace(/[^\r\n]/g, ' ');
      edits.push({ start: startOff, end: endOff, text: blank });
    }
    i = k - 1;
  }
  if (edits.length === 0) return { code: source, changed: false };
  let out = '', pos = 0;
  for (const e of edits) {
    out += source.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += source.slice(pos);
  return { code: out, changed: true };
}

// Erases simple angle-bracket type assertions `<Type>expr` in `.ts` files when Node's stripTypeScriptTypes
// rejects them with "The angle-bracket syntax for type assertions".
function eraseAngleBracketAssertions(source) {
  if (!source.includes('<')) return null;
  const toks = tokenize(source);
  if (!toks) return null;
  const EXPR_PREFIX = new Set(['=', '(', '[', ',', ':', '?', ';', '{', '}', '=>', '...', 'return', 'throw', 'await', 'yield', 'typeof', 'void', 'delete', 'of', 'in', '!', '~', '+', '-', '*', '/', '%', '&', '|', '^']);
  const EXPR_OBJ_PREFIX = new Set(['=', '(', '[', ',', ':', '?', '...', 'return', 'throw', 'await', 'yield']);
  const edits = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== 'punc' || toks[i].text !== '<') continue;
    const prev = i > 0 ? toks[i - 1] : null;
    if (prev && !EXPR_PREFIX.has(prev.text)) continue;
    if (prev && prev.text === 'of') {
      // Only treat `of` as an expression prefix inside a `for (... of ...)` header (not `for (; of < 1 > +2;)` or `obj.of < 1 > +2`).
      let dP = 0, pIdx = -1, sawSemi = false;
      for (let b = i - 2; b >= 0; b--) {
        if (toks[b].text === ')') dP++;
        else if (toks[b].text === '(') { if (dP === 0) { pIdx = b; break; } dP--; }
        else if (dP === 0 && toks[b].text === ';') sawSemi = true;
      }
      const beforeOf = i >= 2 ? toks[i - 2] : null;
      const isForOf = !sawSemi && pIdx > 0 && beforeOf &&
        beforeOf.text !== '(' && beforeOf.text !== ';' && beforeOf.text !== '.' &&
        (toks[pIdx - 1].text === 'for' || (pIdx > 1 && toks[pIdx - 1].text === 'await' && toks[pIdx - 2].text === 'for'));
      if (!isForOf) continue;
    }
    // Scan one or more chained balanced `< ... >` (e.g. `<any><any>{}`).
    let k = i;
    let chainCount = 0;
    while (k < toks.length && toks[k].type === 'punc' && toks[k].text === '<') {
      let m = k + 1, dA = 1, dBr = 0, dP = 0, dB = 0;
      while (m < toks.length && dA > 0) {
        const tk = toks[m];
        if (tk.text === ';' && dBr === 0) break;
        if (tk.text === '<') dA++;
        else if (tk.text === '>') dA--;
        else if (tk.text === '{') dBr++;
        else if (tk.text === '}') dBr--;
        else if (tk.text === '(') dP++;
        else if (tk.text === ')') dP--;
        else if (tk.text === '[') dB++;
        else if (tk.text === ']') dB--;
        m++;
      }
      if (dA !== 0 || m >= toks.length) { chainCount = 0; break; }
      k = m;
      chainCount++;
    }
    if (chainCount === 0 || k >= toks.length) continue;
    const after = toks[k];
    // True ONLY when `return`/`yield` has NO newline before `<T>` (so it is NOT ASI-terminated)
    // AND there IS a newline between `<T>` and the operand (so erasing `<T>` alone would introduce ASI).
    const isAsiKwBefore = prev && (prev.text === 'return' || prev.text === 'yield') &&
      !hasNewlineBetween(source, prev.end, toks[i].start) &&
      hasNewlineBetween(source, toks[i].start, after.start);
    const isAsiTerminatedBefore = prev && (prev.text === 'return' || prev.text === 'yield') &&
      hasNewlineBetween(source, prev.end, toks[i].start);
    // Handle `<T>{ ... }`:
    // - After `=>`, at statement start (`!prev`, `;`, `{`, `}`), or after ASI-terminated `return\n` / `yield\n`, wrap `{ ... }` in `({ ... })` so it stays an object literal expression.
    // - After expression prefixes (`=`, `(`, `[`, `,`, `:`, `?`, `...`, `return`, `throw`), simply erase `<T>`.
    if (after.text === '{') {
      const closeBr = findMatchingBrace(toks, k);
      if (closeBr > k) {
        const needsParens = !prev || prev.text === '=>' || prev.text === ';' || prev.text === '{' || prev.text === '}' || isAsiKwBefore || isAsiTerminatedBefore;
        if (needsParens || EXPR_OBJ_PREFIX.has(prev.text)) {
          if (isAsiKwBefore) {
            // Keep `(` on the same line as `return`/`yield` to prevent ASI (`return;\n({});`)
            edits.push({ start: prev.end, end: after.start, text: ' (' });
            edits.push({ start: toks[closeBr].end, end: toks[closeBr].end, text: ')' });
          } else {
            const startOff = toks[i].start;
            const endOff = toks[k - 1].end;
            const blank = source.slice(startOff, endOff).replace(/[^\r\n]/g, ' ');
            edits.push({ start: startOff, end: endOff, text: blank });
            if (needsParens) {
              edits.push({ start: after.start, end: after.start, text: '(' });
              edits.push({ start: toks[closeBr].end, end: toks[closeBr].end, text: ')' });
            }
          }
          i = k - 1;
        }
      }
      continue;
    }
    // Handle `<T>(expr)` when not a generic arrow `<T>(x) =>`
    if (after.text === '(') {
      const closeP = findMatchingParen(toks, k);
      if (closeP > k && toks[closeP + 1]?.text !== '=>' && toks[closeP + 1]?.text !== ':' && toks[closeP + 1]?.text !== '{') {
        if (isAsiKwBefore) {
          edits.push({ start: prev.end, end: after.start, text: ' ' });
        } else {
          const startOff = toks[i].start;
          const endOff = toks[k - 1].end;
          const blank = source.slice(startOff, endOff).replace(/[^\r\n]/g, ' ');
          edits.push({ start: startOff, end: endOff, text: blank });
        }
        i = k - 1;
      }
      continue;
    }
    if (after.text === '=>' || after.text === ';' || after.text === ',' || after.text === ')') continue;
    if (after.type === 'id' || after.type === 'num' || after.type === 'str' || after.type === 'tpl' || after.type === 'regex' || after.text === '[' ||
        after.text === '!' || after.text === '~' || after.text === '+' || after.text === '-') {
      if (isAsiKwBefore) {
        edits.push({ start: prev.end, end: after.start, text: ' ' });
      } else {
        const startOff = toks[i].start;
        const endOff = toks[k - 1].end;
        const blank = source.slice(startOff, endOff).replace(/[^\r\n]/g, ' ');
        edits.push({ start: startOff, end: endOff, text: blank });
      }
      i = k - 1;
    }
  }
  if (edits.length === 0) return null;
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '', pos = 0;
  for (const e of edits) {
    out += source.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += source.slice(pos);
  return out;
}

// Relaxes 5 semantic-only SWC rejections in Node's stripTypeScriptTypes that TypeScript's
// syntax-only transpileModule accepts without error:
//   1. `'eval' and 'arguments' cannot be used as a binding identifier`
//   2. `A 'continue' statement` / `A 'break' statement`
//   3. ``A `set` accessor must have exactly one parameter``
//   4. `'const' declarations must be initialized`
//   5. `` `await` cannot be used as an identifier in an async context ``
// Each transform substitutes a unique placeholder outside comments/strings/regexes, runs
// stripTypeScriptTypes on the copy (preserving full TS syntax validation), and restores the original text.
function stripWithSwcRelaxations(source, errMsg, depth = 0) {
  if (!errMsg || depth > 10) return null;
  if (source.includes('await') || source.includes('yield')) {
    const checkToks = tokenize(source);
    if (checkToks) {
      for (let i = 0; i < checkToks.length - 1; i++) {
        if (checkToks[i].type === 'id' && (checkToks[i].text === 'await' || checkToks[i].text === 'yield') && checkToks[i + 1].text === '=>') {
          return null;
        }
      }
    }
  }
  const tryStrip = (work) => {
    try {
      return stripTypeScriptTypes(work);
    } catch (e) {
      const nextMsg = String(e?.message || '');
      if (depth >= 10 || !nextMsg || nextMsg === errMsg) return null;
      if (nextMsg.includes('angle-bracket') && work.includes('<')) {
        const ang = eraseAngleBracketAssertions(work);
        if (ang !== null) {
          try { return stripTypeScriptTypes(ang); } catch {}
        }
      }
      return stripWithSwcRelaxations(work, nextMsg, depth + 1);
    }
  };

  if (errMsg.includes("'eval' and 'arguments'")) {
    if (source.includes('__tmt_ev__') || source.includes('__tmt_ar__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'id' || (t.text !== 'eval' && t.text !== 'arguments')) continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && prev.type === 'punc' && prev.text === '.') continue;
      edits.push({ start: t.start, end: t.end, text: t.text === 'eval' ? '__tmt_ev__' : '__tmt_ar__' });
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    if (stripped !== null) {
      return stripped.replace(/__tmt_ev__/g, 'eval').replace(/__tmt_ar__/g, 'arguments');
    }
    return null;
  }

  if (errMsg.includes("A 'continue' statement") || errMsg.includes("A 'break' statement") ||
      errMsg.includes('Jump target cannot cross function boundary')) {
    if (source.includes('__tmt_jmp_')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const saved = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'id' || (t.text !== 'continue' && t.text !== 'break')) continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && prev.type === 'punc' && prev.text === '.') continue;
      let endIdx = i;
      if (toks[i + 1]?.type === 'id' && !hasNewlineBetween(source, t.end, toks[i + 1].start)) {
        endIdx = i + 1;
      }
      const placeholder = `__tmt_jmp_${saved.length}__`;
      saved.push([placeholder, source.slice(t.start, toks[endIdx].end)]);
      edits.push({ start: t.start, end: toks[endIdx].end, text: placeholder });
      i = endIdx;
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    let stripped = tryStrip(work);
    if (stripped !== null) {
      for (const [ph, orig] of saved) stripped = stripped.replace(ph, () => orig);
      return stripped;
    }
  }

  if (errMsg.includes('A `set` accessor must have exactly one parameter')) {
    if (source.includes('__tmt_sp__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'id' || t.text !== 'set') continue;
      // Find `(` of setter after property name (ident, str, num, or `[...]`)
      let k = i + 1;
      if (k >= toks.length) continue;
      if (toks[k].type === 'punc' && toks[k].text === '[') {
        let d = 1; k++;
        while (k < toks.length && d > 0) { if (toks[k].text === '[') d++; else if (toks[k].text === ']') d--; k++; }
      } else if (toks[k].type === 'id' || toks[k].type === 'str' || toks[k].type === 'num') {
        k++;
      } else continue;
      if (toks[k]?.type === 'punc' && toks[k].text === '(' && toks[k + 1]?.type === 'punc' && toks[k + 1].text === ')' &&
          toks[k + 2]?.type === 'punc' && toks[k + 2].text === '{') {
        edits.push({ start: toks[k].end, end: toks[k].end, text: '__tmt_sp__' });
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped.replace(/__tmt_sp__/g, '');
    }
  }

  if (errMsg.includes("'const' declarations must be initialized")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const offsets = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'id' || t.text !== 'const') continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && prev.type === 'punc' && prev.text === '.') continue;
      if (toks[i + 1]?.text === 'enum') continue;
      // Same-length replacement `const` -> `let  ` so positions match
      edits.push({ start: t.start, end: t.end, text: 'let  ' });
      offsets.push(t.start);
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    if (stripped !== null && stripped.length === work.length) {
      let out = '', p = 0;
      for (const off of offsets) {
        if (stripped.slice(off, off + 5) === 'let  ') {
          out += stripped.slice(p, off) + 'const';
          p = off + 5;
        }
      }
      out += stripped.slice(p);
      return out;
    }
  }

  if (errMsg.includes('`await` cannot be used as an identifier') || errMsg.includes('Expected ident')) {
    if (!source.includes('__tmt_aw__') && /\bawait\b/.test(source) && !/\b(?:await|yield)[ \t]*=>/.test(source)) {
      const toks = tokenize(source);
      if (toks) {
        const isExpectedIdent = errMsg.includes('Expected ident');
        const edits = [];
        for (let i = 0; i < toks.length; i++) {
          const t = toks[i];
          if (t.type !== 'id' || t.text !== 'await') continue;
          const prev = i > 0 ? toks[i - 1] : null;
          const next = toks[i + 1];
          if (prev && prev.type === 'punc' && prev.text === '.') continue;
          if (next && next.text === '=>') return null;
          if (isExpectedIdent && next && next.text === ':' && (!prev || (prev.text !== 'var' && prev.text !== 'let' && prev.text !== 'const' && prev.text !== '(' && prev.text !== ','))) return null;
          const isBinding = (prev && (prev.text === '(' || prev.text === ',' || prev.text === 'var' || prev.text === 'let' || prev.text === 'const' || prev.text === 'function' || prev.text === '{' || prev.text === '[')) ||
            (next && (next.text === ')' || next.text === ',' || (!isExpectedIdent && next.text === ':') || next.text === '=' || next.text === ';' || next.text === '}' || next.text === ']'));
          if (isBinding) {
            edits.push({ start: t.start, end: t.end, text: '__tmt_aw__' });
          }
        }
        if (edits.length > 0) {
          let work = '', pos = 0;
          for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          const stripped = tryStrip(work);
          if (stripped !== null) return stripped.replace(/__tmt_aw__/g, 'await');
        }
      }
    }
  }

  if (errMsg.includes('let is reserved in const, let')) {
    if (source.includes('__tmt_lt__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'id' || t.text !== 'let') continue;
      const prev = toks[i - 1];
      const next = toks[i + 1];
      if (prev.text === '.') continue;
      if (prev.text === 'let' || prev.text === 'const' || prev.text === 'class' || prev.text === ',' || prev.text === '[' ||
          (next && (next.text === '=' || next.text === ',' || next.text === ';' || next.text === ':' || next.text === ')' || next.text === ']' || next.text === '}'))) {
        edits.push({ start: t.start, end: t.end, text: '__tmt_lt__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    return stripped === null ? null : stripped.replace(/__tmt_lt__/g, 'let');
  }

  if (errMsg.includes('Expected one variable binding') || errMsg.includes('Unexpected initializer in for in/of loop')) {
    if (source.includes('__tmt_fo_')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const saved = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'id' || toks[i].text !== 'for') continue;
      let pIdx = i + 1;
      if (toks[pIdx]?.text === 'await') pIdx++;
      if (toks[pIdx]?.text !== '(') continue;
      const closeP = findMatchingParen(toks, pIdx);
      if (closeP < 0) continue;
      const kw = toks[pIdx + 1];
      if (!kw || (kw.text !== 'var' && kw.text !== 'let' && kw.text !== 'const')) continue;
      // Find top-level `=` or `,` and `of`/`in` inside `for (...)`
      let dP = 0, dB = 0, dBr = 0, firstCut = -1, ofIdx = -1;
      for (let k = pIdx + 2; k < closeP; k++) {
        const tk = toks[k];
        if (tk.text === '(') dP++;
        else if (tk.text === ')') dP--;
        else if (tk.text === '[') dB++;
        else if (tk.text === ']') dB--;
        else if (tk.text === '{') dBr++;
        else if (tk.text === '}') dBr--;
        else if (dP === 0 && dB === 0 && dBr === 0) {
          if ((tk.text === ',' || tk.text === '=') && firstCut < 0) firstCut = k;
          else if (tk.type === 'id' && (tk.text === 'of' || tk.text === 'in')) { ofIdx = k; break; }
        }
      }
      if (firstCut > 0 && ofIdx > firstCut) {
        const restSrc = source.slice(toks[firstCut].start, toks[ofIdx].start);
        let strippedRest = restSrc;
        if (restSrc.includes(':')) {
          try {
            const dummy = 'var __x__' + restSrc + ';';
            const s = stripTypeScriptTypes(dummy);
            strippedRest = s.slice('var __x__'.length, s.length - 1);
          } catch { strippedRest = restSrc; }
        }
        const ph = `/*__tmt_fo_${saved.length}__*/`;
        saved.push([ph, strippedRest]);
        edits.push({ start: toks[firstCut].start, end: toks[ofIdx].start, text: ph + ' ' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    if (stripped === null) return null;
    let out = stripped;
    for (const [ph, orig] of saved) out = out.replace(ph + ' ', () => orig);
    return out;
  }

  if (errMsg.includes('A rest parameter must be last in a parameter list')) {
    if (source.includes('__tmt_rp__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'punc' && toks[i].text === '...' && toks[i + 1]?.type === 'id') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '/*__tmt_rp__*/' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    if (stripped !== null) return stripped.replace(/\/\*__tmt_rp__\*\//g, '...');
  }

  if (errMsg.includes('A parameter property is only allowed in a constructor')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    let parenDepth = 0;
    const MODS = new Set(['public', 'private', 'protected', 'readonly']);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.text === '(') { parenDepth++; continue; }
      if (t.text === ')') { if (parenDepth > 0) parenDepth--; continue; }
      if (parenDepth > 0 && t.type === 'id' && MODS.has(t.text) && toks[i + 1]?.type === 'id') {
        const prev = i > 0 ? toks[i - 1] : null;
        if (prev && (prev.text === '(' || prev.text === ',' || MODS.has(prev.text))) {
          edits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
        }
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `The 'with' statement is not supported` in TS script/module -> temporarily replace `with` with `if`
  if (errMsg.includes("The 'with' statement is not supported")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const offsets = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'with' && toks[i + 1].text === '(' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: 'if  ' });
        offsets.push(toks[i].start);
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    if (stripped === null || stripped.length !== work.length) return null;
    let out = '', p = 0;
    for (const off of offsets) {
      if (stripped.slice(off, off + 4) === 'if  ') {
        out += stripped.slice(p, off) + 'with';
        p = off + 4;
      }
    }
    out += stripped.slice(p);
    return out;
  }

  // `The left-hand side of an assignment expression` / `Invalid assignment target`:
  //   1. Optional chaining LHS (`a?.b = 1`, `a?.["b"]++`, `a?.() = 1`): `?.` -> `. ` / `  ` (same length 2)
  //   2. Invalid update/assignment LHS (`--ENUM`, `v++`, `f() = 1`, `1 = 2`): same-length operator swap -> strip -> restore
  if (errMsg.includes('The left-hand side of an assignment expression') || errMsg.includes('Invalid assignment target')) {
    const toks = tokenize(source);
    if (!toks) return null;
    if (source.includes('?.')) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'punc' && toks[i].text === '?' &&
            toks[i + 1].type === 'punc' && toks[i + 1].text === '.' &&
            toks[i].end === toks[i + 1].start) {
          const nt = toks[i + 2];
          if (nt.type === 'id') {
            edits.push({ start: toks[i].start, end: toks[i + 1].end, text: '. ' });
            offsets.push([toks[i].start, '. ']);
          } else if (nt.text === '[' || nt.text === '(') {
            edits.push({ start: toks[i].start, end: toks[i + 1].end, text: '  ' });
            offsets.push([toks[i].start, '  ']);
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        try {
          const stripped = stripTypeScriptTypes(work);
          if (stripped.length === work.length) {
            let out = '', p = 0;
            for (const [off, repl] of offsets) {
              if (stripped.slice(off, off + 2) === repl) {
                out += stripped.slice(p, off) + '?.';
                p = off + 2;
              }
            }
            out += stripped.slice(p);
            return out;
          }
        } catch {}
      }
    }
    // Same-length `++`/`--` relaxation on invalid LHS (`--ENUM`, `foo()++`, `for (v++ of [])`)
    // Reject double-ended `++x++` / `--x--` (TS syntax error `';' expected`).
    const edits = [];
    const offsets = [];
    const UNARY_KW = new Set(['+', '-', '!', '~', 'delete', 'typeof', 'void', 'await', 'yield']);
    const isPostfixPrev = (pt) => pt && !UNARY_KW.has(pt.text) && (pt.type === 'id' || pt.type === 'num' || pt.type === 'str' || pt.type === 'tpl' || pt.text === ')' || pt.text === ']' || pt.text === '}');
    if (!/(?:\+\+|--)[ \t]*[A-Za-z_$][\w$.\[\]0-9]*[ \t]*(?:\+\+|--)/.test(source)) {
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.type === 'punc' && (t.text === '+' || t.text === '-') &&
            toks[i + 1]?.type === 'punc' && toks[i + 1].text === t.text && t.end === toks[i + 1].start) {
          const prev = i > 0 ? toks[i - 1] : null;
          const next = toks[i + 2];
          if (isPostfixPrev(prev) && !hasNewlineBetween(source, prev.end, t.start)) {
            edits.push({ start: t.start, end: toks[i + 1].end, text: '  ' });
            offsets.push([t.start, '  ', t.text + t.text]);
          } else if (next && !UNARY_KW.has(next.text) && !hasNewlineBetween(source, toks[i + 1].end, next.start)) {
            const repl = t.text + ' ';
            edits.push({ start: t.start, end: toks[i + 1].end, text: repl });
            offsets.push([t.start, repl, t.text + t.text]);
          }
          i++;
        }
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null && stripped.length === work.length) {
        let out = '', p = 0;
        for (const [off, repl, orig] of offsets) {
          if (stripped.slice(off, off + 2) === repl) {
            out += stripped.slice(p, off) + orig;
            p = off + 2;
          }
        }
        out += stripped.slice(p);
        return out;
      }
    }
    // Same-length assignment operator relaxation on invalid LHS (`f() = 1`, `1 = 2`, `(a + b) += 1`, `(#x in y) = 1`)
    const aEdits = [];
    const aOffsets = [];
    const ASSIGN_MAP = new Map([
      ['=', '+'], ['+=', '=='], ['-=', '=='], ['*=', '=='], ['/=', '=='], ['%=', '=='],
      ['&=', '=='], ['|=', '=='], ['^=', '=='], ['**=', '==='], ['<<=', '==='], ['>>=', '==='],
      ['&&=', '==='], ['||=', '==='], ['??=', '==='], ['>>>=', '=== '],
    ]);
    const LHS_ENDS = new Set([')', '}', ']', 'true', 'false', 'null', 'target']);
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type !== 'punc') continue;
      // Gather contiguous punctuation run up to 4 chars (`=`, `+=`, `>>=`, `>>>=`, `&&=`, etc.)
      let endIdx = i;
      while (endIdx + 1 < toks.length && toks[endIdx + 1].type === 'punc' &&
          toks[endIdx].end === toks[endIdx + 1].start && endIdx - i < 3 &&
          toks[endIdx + 1].text !== '(' && toks[endIdx + 1].text !== ')' &&
          toks[endIdx + 1].text !== '[' && toks[endIdx + 1].text !== ']' &&
          toks[endIdx + 1].text !== '{' && toks[endIdx + 1].text !== '}' &&
          toks[endIdx + 1].text !== ';' && toks[endIdx + 1].text !== ',') {
        endIdx++;
      }
      const op = source.slice(t.start, toks[endIdx].end);
      if (op === '=' && (toks[i - 1].text === '=' || toks[i - 1].text === '!' || toks[i - 1].text === '<' || toks[i - 1].text === '>' || toks[endIdx + 1]?.text === '=' || toks[endIdx + 1]?.text === '>')) {
        i = endIdx;
        continue;
      }
      if (!ASSIGN_MAP.has(op)) { i = endIdx; continue; }
      const prev = toks[i - 1];
      if (LHS_ENDS.has(prev.text) || prev.type === 'num' || prev.type === 'str' || prev.type === 'tpl' ||
          (prev.type === 'id' && toks[i - 2]?.text === 'new')) {
        if (prev.text === '}' && /\bfunction\b/.test(source.slice(Math.max(0, prev.start - 60), prev.start))) {
          i = endIdx;
          continue;
        }
        const repl = ASSIGN_MAP.get(op);
        aEdits.push({ start: t.start, end: toks[endIdx].end, text: repl });
        aOffsets.push([t.start, repl, op]);
      }
      i = endIdx;
    }
    if (aEdits.length > 0) {
      let work = '', pos = 0;
      for (const e of aEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null && stripped.length === work.length) {
        let out = '', p = 0;
        for (const [off, repl, orig] of aOffsets) {
          if (stripped.slice(off, off + orig.length) === repl) {
            out += stripped.slice(p, off) + orig;
            p = off + orig.length;
          }
        }
        out += stripped.slice(p);
        return out;
      }
    }
    // `for (a = 1 in b)` / `for (new foo() in b)` / `for (this in b)` -> mask invalid for-in/of LHS expression
    if (!source.includes('__tmt_fl_')) {
      const fEdits = [];
      const fSaved = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].type !== 'id' || toks[i].text !== 'for') continue;
        let pIdx = i + 1;
        if (toks[pIdx]?.text === 'await') pIdx++;
        if (toks[pIdx]?.text !== '(') continue;
        const closeP = findMatchingParen(toks, pIdx);
        if (closeP < 0) continue;
        const first = toks[pIdx + 1];
        if (!first || first.text === 'var' || first.text === 'let' || first.text === 'const' || first.text === 'using') continue;
        let dP = 0, dB = 0, dBr = 0, inIdx = -1;
        for (let k = pIdx + 1; k < closeP; k++) {
          const tk = toks[k];
          if (tk.text === '(') dP++;
          else if (tk.text === ')') dP--;
          else if (tk.text === '[') dB++;
          else if (tk.text === ']') dB--;
          else if (tk.text === '{') dBr++;
          else if (tk.text === '}') dBr--;
          else if (dP === 0 && dB === 0 && dBr === 0 && tk.type === 'id' && (tk.text === 'in' || tk.text === 'of')) { inIdx = k; break; }
        }
        if (inIdx > pIdx + 1) {
          const lhsSrc = source.slice(toks[pIdx + 1].start, toks[inIdx - 1].end);
          const ph = `__tmt_fl_${fSaved.length}__`;
          fSaved.push([ph, lhsSrc]);
          fEdits.push({ start: toks[pIdx + 1].start, end: toks[inIdx - 1].end, text: ph });
        }
      }
      if (fEdits.length > 0) {
        let work = '', pos = 0;
        for (const e of fEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) {
          let out = stripped;
          for (const [ph, orig] of fSaved) out = out.replace(ph, () => orig);
          return out;
        }
      }
    }
    // Strict-mode `eval = 1`, `arguments = 1`, `++eval` reported as invalid LHS
    if ((source.includes('eval') || source.includes('arguments')) && !source.includes('__tmt_ev__') && !source.includes('__tmt_ar__')) {
      const evEdits = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.type !== 'id' || (t.text !== 'eval' && t.text !== 'arguments')) continue;
        if (toks[i - 1]?.text === '.') continue;
        evEdits.push({ start: t.start, end: t.end, text: t.text === 'eval' ? '__tmt_ev__' : '__tmt_ar__' });
      }
      if (evEdits.length > 0) {
        let work = '', pos = 0;
        for (const e of evEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/__tmt_ev__/g, 'eval').replace(/__tmt_ar__/g, 'arguments');
      }
    }
  }

  // `` `declare` modifier not allowed for code already in an ambient context ``
  // Erase inner `declare` tokens inside `declare ... { ... }` blocks (same-length spaces).
  if (errMsg.includes('`declare` modifier not allowed for code already in an ambient context')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    let braceDepth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'punc') {
        if (t.text === '{') braceDepth++;
        else if (t.text === '}') braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }
      if (braceDepth > 0 && t.type === 'id' && t.text === 'declare' && toks[i - 1]?.text !== '.') {
        edits.push({ start: t.start, end: t.end, text: '       ' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return tryStrip(work);
  }

  // `A parameter initializer is only allowed in a function or constructor implementation`
  // or `Unexpected token ')'. Expected an identifier, [ for an array pattern` (e.g. `function f(a = 3);`, `(a = 1) => void` in type)
  // In overload/ambient/call signatures (ended by `;` or `=>` in type), strip `= <default>` (and `?` before `=`).
  if (errMsg.includes('A parameter initializer is only allowed') ||
      errMsg.includes("Unexpected token `)`. Expected an identifier")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'punc' || toks[i].text !== '(') continue;
      const closeP = findMatchingParen(toks, i);
      if (closeP < 0) continue;
      // Check whether this parameter list belongs to a bodyless signature (followed by `:` return type then `;` or newline, NOT `{` or `=>`)
      let k = closeP + 1, isSig = false;
      if (toks[k]?.text === ':') {
        k++;
        let dP = 0, dB = 0, dBr = 0, dA = 0;
        while (k < toks.length) {
          const tk = toks[k];
          if (tk.text === '(') dP++;
          else if (tk.text === ')') dP--;
          else if (tk.text === '[') dB++;
          else if (tk.text === ']') dB--;
          else if (tk.text === '{') { if (dP === 0 && dB === 0 && dBr === 0 && dA === 0) break; dBr++; }
          else if (tk.text === '}') { if (dBr === 0) { isSig = true; break; } dBr--; }
          else if (tk.text === '<') dA++;
          else if (tk.text === '>') { if (dA > 0) dA--; }
          else if (tk.text === ';' && dP === 0 && dB === 0 && dBr === 0 && dA === 0) { isSig = true; break; }
          k++;
        }
      } else if (toks[k]?.text === ';' || toks[k]?.text === '=>') {
        isSig = true;
      }
      if (!isSig) continue;
      // Erase `= <expr>` (and `?` before `=`) inside this signature's parameter list
      let p = i + 1, dP = 0, dB = 0, dBr = 0, dA = 0;
      while (p < closeP) {
        const pt = toks[p];
        if (pt.text === '(') dP++;
        else if (pt.text === ')') dP--;
        else if (pt.text === '[') dB++;
        else if (pt.text === ']') dB--;
        else if (pt.text === '{') dBr++;
        else if (pt.text === '}') dBr--;
        else if (pt.text === '<') dA++;
        else if (pt.text === '>') { if (dA > 0) dA--; }
        else if (pt.text === '=' && dP === 0 && dB === 0 && dA === 0) {
          let e = p + 1, eP = 0, eB = 0, eBr = 0, eA = 0;
          while (e < closeP) {
            const et = toks[e];
            if (et.text === '(') eP++;
            else if (et.text === ')') eP--;
            else if (et.text === '[') eB++;
            else if (et.text === ']') { if (eB === 0) break; eB--; }
            else if (et.text === '{') eBr++;
            else if (et.text === '}') { if (eBr === 0) break; eBr--; }
            else if (et.text === '<') eA++;
            else if (et.text === '>') { if (eA > 0) eA--; }
            else if (eP === 0 && eB === 0 && eBr === 0 && eA === 0 && et.text === ',') break;
            e++;
          }
          const cutStart = (toks[p - 1]?.text === '?') ? toks[p - 1].start : pt.start;
          edits.push({ start: cutStart, end: toks[e - 1].end, text: source.slice(cutStart, toks[e - 1].end).replace(/[^\r\n]/g, ' ') });
          p = e;
          continue;
        }
        p++;
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return tryStrip(work);
  }

  // `Unexpected token 'ident'. Expected * for generator...`: out-of-order TS-only class member modifiers
  // (`abstract public`, `static public`, `readonly private`, `override public`, `override static`, `static const`, etc.)
  if (errMsg.includes('Unexpected token `ident`. Expected * for generator')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const ALL_MODS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'static', 'override', 'declare', 'accessor', 'async', 'const']);
    const TS_ONLY_MODS = new Set(['public', 'private', 'protected', 'readonly', 'override', 'abstract', 'declare', 'const']);
    const TS_BEFORE_JS = new Set(['public', 'private', 'protected', 'readonly', 'override', 'abstract', 'const']);
    const edits = [];
    const editedStarts = new Set();
    const pushEdit = (tok) => {
      if (!editedStarts.has(tok.start)) {
        editedStarts.add(tok.start);
        edits.push({ start: tok.start, end: tok.end, text: ' '.repeat(tok.end - tok.start) });
      }
    };
    let braceDepth = 0;
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.text === '{') { braceDepth++; continue; }
      if (t.text === '}') { braceDepth = Math.max(0, braceDepth - 1); continue; }
      if (i === 0) continue;
      const prev = toks[i - 1];
      const next = toks[i + 1];
      if (t.type === 'id' && (t.text === 'static' || t.text === 'async' || t.text === 'accessor' || t.text === 'abstract' || t.text === 'declare') &&
          prev.type === 'id' && TS_BEFORE_JS.has(prev.text) && prev.text !== t.text && !hasNewlineBetween(source, prev.end, t.start) &&
          (next.type === 'id' || next.text === '[' || next.text === '*' || next.text === '#' || next.type === 'str' || next.type === 'num') &&
          !hasNewlineBetween(source, t.end, next.start)) {
        pushEdit(prev);
        continue;
      }
      if (braceDepth > 0 && t.type === 'id' && (t.text === 'const' || t.text === 'export') &&
          (prev.text === '{' || prev.text === ';' || hasNewlineBetween(source, prev.end, t.start)) &&
          (next.type === 'id' || next.text === '[' || next.text === '*') && !hasNewlineBetween(source, t.end, next.start)) {
        pushEdit(t);
        continue;
      }
      if (t.type !== 'id' || (!TS_ONLY_MODS.has(t.text) && !(t.text === 'accessor' && prev.text === 'accessor'))) continue;
      if (prev.type === 'id' && ALL_MODS.has(prev.text) && !hasNewlineBetween(source, prev.end, t.start) &&
          (next.type === 'id' || next.text === '[' || next.text === '*' || next.text === '#' || next.type === 'str' || next.type === 'num') &&
          !hasNewlineBetween(source, t.end, next.start)) {
        pushEdit(t);
      }
    }
    if (edits.length > 0) {
      edits.sort((a, b) => a.start - b.start);
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `async class C {}`, `async get x() {}`, `async set x(v) {}`, `async interface I {}`,
  // `declare async function f();`, and `yield expr` / `await expr` in non-generator/static-block contexts
  if (errMsg.includes("Expected ';', '}' or <eof>") || errMsg.includes("Expected '(', got 'ident'") ||
      errMsg.includes("Expected '=>', got 'ident'") || errMsg.includes('Expression expected')) {
    if (/\b(?:await|yield)[ \t]*=>/.test(source)) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const restoreOffsets = []; // [offset, origText, replText]
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type !== 'id' || toks[i - 1]?.text === '.') continue;
      const next = toks[i + 1];
      if (t.text === 'async' && next.type === 'id' && !hasNewlineBetween(source, t.end, next.start)) {
        if (toks[i - 1]?.text === 'declare' && next.text === 'function') {
          edits.push({ start: t.start, end: t.end, text: '     ' });
        } else if (next.text === 'class' || next.text === 'get' || next.text === 'set') {
          edits.push({ start: t.start, end: t.end, text: '     ' });
          restoreOffsets.push([t.start, 'async', '     ']);
        } else if (next.text === 'interface' || next.text === 'type' || next.text === 'declare') {
          edits.push({ start: t.start, end: t.end, text: '     ' });
        }
      } else if ((t.text === 'yield' || t.text === 'await') && !hasNewlineBetween(source, t.end, next.start) &&
          (next.type === 'id' || next.type === 'num' || next.type === 'str' || next.type === 'tpl' || next.text === '(' || next.text === '[' || next.text === '{')) {
        const prev = i > 0 ? toks[i - 1] : null;
        if (!prev || prev.text === '{' || prev.text === ';' || prev.text === '}' || prev.text === '(' || prev.text === '=' || prev.text === ':' || prev.text === ',' || prev.text === 'return' || hasNewlineBetween(source, prev.end, t.start)) {
          edits.push({ start: t.start, end: t.end, text: 'void ' });
          restoreOffsets.push([t.start, t.text, 'void ']);
        }
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null && stripped.length === work.length) {
        let out = '', p = 0;
        for (const [off, orig, repl] of restoreOffsets) {
          if (stripped.slice(off, off + orig.length) === repl) {
            out += stripped.slice(p, off) + orig;
            p = off + orig.length;
          }
        }
        out += stripped.slice(p);
        return out;
      }
    }
    // `if (...) const x = 1;` / `else let x = 1;` / `while (...) let x = 1;` / `do const x = 1;` / `with (...) const x = 1;`
    if (errMsg.includes('Expression expected') || errMsg.includes("Expected ';', '}' or <eof>")) {
      const cEdits = [];
      const cOffsets = [];
      for (let i = 1; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.type !== 'id' || (t.text !== 'const' && t.text !== 'let')) continue;
        if (toks[i + 1].text === 'enum') continue;
        const prev = toks[i - 1];
        if (prev.text === ')' || prev.text === 'else' || prev.text === 'do' ||
            (prev.text === ':' && !/\bexport\b/.test(source) && toks[i - 2]?.type === 'id')) {
          const repl = t.text === 'const' ? 'var  ' : 'var';
          cEdits.push({ start: t.start, end: t.end, text: repl });
          cOffsets.push([t.start, t.text, repl]);
        }
      }
      if (cEdits.length > 0) {
        let work = '', pos = 0;
        for (const e of cEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const [off, orig, repl] of cOffsets) {
            if (stripped.slice(off, off + orig.length) === repl) {
              out += stripped.slice(p, off) + orig;
              p = off + orig.length;
            }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
    // Duplicate `declare declare ...`, `declare import ...`, `declare export ...`,
    // and invalid modifiers on top-level/module statements (`protected class C`, `public var x`, `static function f`)
    if (errMsg.includes("Expected ';', '}' or <eof>")) {
      const dEdits = [];
      const BAD_STMT_MODS = new Set(['public', 'private', 'protected', 'static']);
      const STMT_KWS = new Set(['var', 'let', 'const', 'function', 'class', 'interface', 'type', 'enum', 'module', 'namespace']);
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.type === 'id' && t.text === 'declare' && toks[i - 1]?.text !== '.' &&
            !hasNewlineBetween(source, t.end, toks[i + 1].start) &&
            (toks[i + 1].text === 'declare' || toks[i + 1].text === 'import' || toks[i + 1].text === 'export')) {
          dEdits.push({ start: t.start, end: t.end, text: '       ' });
        } else if (t.type === 'id' && BAD_STMT_MODS.has(t.text) && toks[i - 1]?.text !== '.' &&
            !hasNewlineBetween(source, t.end, toks[i + 1].start) &&
            STMT_KWS.has(toks[i + 1].text)) {
          dEdits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
        }
      }
      if (dEdits.length > 0) {
        let work = '', pos = 0;
        for (const e of dEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
    // `import<T>("./a")` / `import<>("./a")` -> erase invalid type arguments on dynamic `import(...)`
    if (errMsg.includes('Expression expected') && source.includes('import')) {
      const icEdits = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i + 1].text === '<') {
          let k = i + 2, dA = 1;
          while (k < toks.length && dA > 0) {
            if (toks[k].text === '<') dA++;
            else if (toks[k].text === '>') dA--;
            k++;
          }
          if (dA === 0 && toks[k]?.text === '(') {
            icEdits.push({ start: toks[i + 1].start, end: toks[k - 1].end, text: source.slice(toks[i + 1].start, toks[k - 1].end).replace(/[^\r\n]/g, ' ') });
          }
        }
      }
      if (icEdits.length > 0) {
        let work = '', pos = 0;
        for (const e of icEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `export import defaultBinding, { ... } from "..."` / `export import * as ns from "..."` / `export import "..."` -> strip `export `
  if (errMsg.includes("Expected '=', got ','") || errMsg.includes("Expected '=', got '*'") ||
      errMsg.includes("Expected '=', got 'from'") || errMsg.includes('Expected ident')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'export' &&
            toks[i + 1].type === 'id' && toks[i + 1].text === 'import' &&
            !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
          // Only when it is NOT `export import id = ...`
          if (!(toks[i + 2].type === 'id' && toks[i + 3]?.text === '=')) {
            edits.push({ start: toks[i].start, end: toks[i].end, text: '      ' });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `'import', and 'export' cannot be used outside of module code`: `export` inside blocks (TS keeps `export` in output)
  if (errMsg.includes("'import', and 'export' cannot be used outside of module code")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      let braceDepth = 0;
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.type === 'punc') {
          if (t.text === '{') braceDepth++;
          else if (t.text === '}') braceDepth = Math.max(0, braceDepth - 1);
          continue;
        }
        if ((braceDepth > 0 || toks[i - 1]?.text === ')' || toks[i - 1]?.text === 'else' || toks[i - 1]?.text === ':') &&
            t.type === 'id' && t.text === 'export' && toks[i - 1]?.text !== '.' &&
            !hasNewlineBetween(source, t.end, toks[i + 1].start) &&
            (toks[i + 1].text === 'function' || toks[i + 1].text === 'class' || toks[i + 1].text === 'var' ||
             toks[i + 1].text === 'let' || toks[i + 1].text === 'const' || toks[i + 1].text === 'async' ||
             toks[i + 1].text === 'abstract' || toks[i + 1].text === 'declare')) {
          edits.push({ start: t.start, end: t.end, text: '      ' });
          if (toks[i + 1].text !== 'declare') offsets.push(t.start);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const off of offsets) {
            if (stripped.slice(off, off + 6) === '      ') {
              out += stripped.slice(p, off) + 'export';
              p = off + 6;
            }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `interface name is invalid` (e.g. `interface any {}`, `interface number {}`, `public interface I {}`, `abstract interface I {}`)
  if (errMsg.includes('interface name is invalid')) {
    if (source.includes('__tmt_if__')) return null;
    const PREDEFINED = new Set(['any', 'number', 'string', 'boolean', 'symbol', 'object', 'unknown', 'never', 'bigint', 'undefined']);
    const BAD_IF_MODS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'abstract', 'override']);
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && BAD_IF_MODS.has(toks[i].text) && toks[i - 1]?.text !== '.' &&
          toks[i + 1].type === 'id' && toks[i + 1].text === 'interface' &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: ' '.repeat(toks[i].end - toks[i].start) });
      } else if (toks[i].type === 'id' && toks[i].text === 'interface' && toks[i - 1]?.text !== '.' &&
          toks[i + 1].type === 'id' && PREDEFINED.has(toks[i + 1].text) &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        edits.push({ start: toks[i + 1].start, end: toks[i + 1].end, text: '__tmt_if__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return tryStrip(work);
  }

  // `Expected ',', got 'ident'` / `Expected ident`: invalid modifier on parameter (`constructor(static a: number)`, `constructor(export a: number)`)
  if (errMsg.includes("Expected ',', got 'ident'") || errMsg.includes('Expected ident')) {
    const toks = tokenize(source);
    if (toks) {
      const BAD_PMODS = new Set(['static', 'export', 'declare', 'abstract', 'async']);
      const edits = [];
      let parenDepth = 0;
      for (let i = 1; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.text === '(') { parenDepth++; continue; }
        if (t.text === ')') { if (parenDepth > 0) parenDepth--; continue; }
        if (parenDepth > 0 && t.type === 'id' && BAD_PMODS.has(t.text) &&
            (toks[i - 1].text === '(' || toks[i - 1].text === ',' || BAD_PMODS.has(toks[i - 1].text)) &&
            toks[i + 1].type === 'id' && !hasNewlineBetween(source, t.end, toks[i + 1].start)) {
          edits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `A class can only have one constructor`: rename 2nd+ `constructor` implementations inside a class, strip, restore
  if (errMsg.includes('A class can only have one constructor')) {
    if (!source.includes('__tmt_ctor__')) {
      const toks = tokenize(source);
      if (toks) {
        const edits = [];
        const classStack = [];
        let braceDepth = 0;
        for (let i = 0; i < toks.length - 1; i++) {
          const t = toks[i];
          if (t.type === 'id' && t.text === 'class' && toks[i - 1]?.text !== '.') {
            // Mark next `{` at current braceDepth as a class body
            let k = i + 1;
            while (k < toks.length && toks[k].text !== '{') k++;
            if (k < toks.length) classStack.push({ openIdx: k, depth: braceDepth + 1, seenCtor: false });
          } else if (t.text === '{') {
            braceDepth++;
          } else if (t.text === '}') {
            if (classStack.length > 0 && classStack[classStack.length - 1].depth === braceDepth) classStack.pop();
            braceDepth = Math.max(0, braceDepth - 1);
          } else if (classStack.length > 0 && braceDepth === classStack[classStack.length - 1].depth &&
              t.type === 'id' && t.text === 'constructor') {
            let pIdx = i + 1;
            let emptyTypeArgs = null;
            if (toks[pIdx]?.text === '<') {
              let k = pIdx + 1, dA = 1;
              while (k < toks.length && dA > 0) {
                if (toks[k].text === '<') dA++;
                else if (toks[k].text === '>') dA--;
                k++;
              }
              if (dA === 0 && toks[k]?.text === '(') {
                if (k === pIdx + 2) emptyTypeArgs = { start: toks[pIdx].start, end: toks[k - 1].end };
                pIdx = k;
              }
            }
            if (toks[pIdx]?.text === '(') {
              const closeP = findMatchingParen(toks, pIdx);
              if (closeP > pIdx && toks[closeP + 1]?.text === '{') {
                const top = classStack[classStack.length - 1];
                if (top.seenCtor) {
                  edits.push({ start: t.start, end: t.end, text: '__tmt_ctor__' });
                } else {
                  top.seenCtor = true;
                }
                if (emptyTypeArgs) {
                  edits.push({ start: emptyTypeArgs.start, end: emptyTypeArgs.end, text: ' '.repeat(emptyTypeArgs.end - emptyTypeArgs.start) });
                }
              }
            }
          }
        }
        if (edits.length > 0) {
          let work = '', pos = 0;
          for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          const stripped = tryStrip(work);
          if (stripped !== null) return stripped.replace(/__tmt_ctor__/g, 'constructor');
        }
      }
    }
  }

  // `Expected ']', got ','`: trailing comma or multi-parameter index signature `[key: string,]: T;` / `[p1: string, p2: number]: T;`
  if (errMsg.includes("Expected ']', got ','")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 2; i++) {
        if (toks[i].text === ',' && toks[i + 1].text === ']' && toks[i + 2].text === ':') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: ' ' });
        } else if (toks[i].text === '[' && toks[i + 1].type === 'id' && toks[i + 2]?.text === ':') {
          let k = i + 3, dB = 1, commaIdx = -1;
          while (k < toks.length && dB > 0) {
            if (toks[k].text === '[') dB++;
            else if (toks[k].text === ']') { if (--dB === 0) break; }
            else if (dB === 1 && toks[k].text === ',' && commaIdx < 0) commaIdx = k;
            k++;
          }
          if (dB === 0 && commaIdx > i && toks[k]?.text === ']') {
            edits.push({ start: toks[commaIdx].start, end: toks[k].start, text: source.slice(toks[commaIdx].start, toks[k].start).replace(/[^\r\n]/g, ' ') });
            i = k;
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Parameter cannot have question mark and initializer` (`x?: number = 1`, `x? = 0`)
  if (errMsg.includes('Parameter cannot have question mark and initializer')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      let parenDepth = 0;
      for (let i = 1; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.text === '(') { parenDepth++; continue; }
        if (t.text === ')') { if (parenDepth > 0) parenDepth--; continue; }
        if (parenDepth > 0 && t.type === 'punc' && t.text === '?' && toks[i - 1].type === 'id' &&
            (toks[i + 1].text === ':' || toks[i + 1].text === '=')) {
          edits.push({ start: t.start, end: t.end, text: ' ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Illegal 'use strict' directive in function with non-simple parameter list`
  if (errMsg.includes("Illegal 'use strict' directive")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.type === 'str' && (t.text === '"use strict"' || t.text === "'use strict'")) {
          const q = t.text[0];
          const repl = `${q}__tmt_us__${q}`;
          edits.push({ start: t.start, end: t.end, text: repl });
          offsets.push([t.start, t.text, repl]);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const [off, orig, repl] of offsets) {
            if (stripped.slice(off, off + orig.length) === repl) {
              out += stripped.slice(p, off) + orig;
              p = off + orig.length;
            }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `An interface can only extend an identifier/qualified-name` (`interface C extends Foo?.Bar {}`)
  if (errMsg.includes('An interface can only extend an identifier') && source.includes('?.')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].text === '?' && toks[i + 1].text === '.' && toks[i].end === toks[i + 1].start) {
          edits.push({ start: toks[i].start, end: toks[i + 1].end, text: '. ' });
          offsets.push(toks[i].start);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const off of offsets) {
            if (stripped.slice(off, off + 2) === '. ') {
              out += stripped.slice(p, off) + '?.';
              p = off + 2;
            }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `Expected '{', got 'export'`: duplicate `export export`
  if (errMsg.includes("Expected '{', got 'export'")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'export' &&
            toks[i + 1].type === 'id' && toks[i + 1].text === 'export' &&
            !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '      ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Unexpected token 'get'` / `Unexpected token 'set'` / `Unexpected token '['`: duplicate or `export` class member modifiers
  if (errMsg.includes('Unexpected token `get`') || errMsg.includes('Unexpected token `set`') || errMsg.includes('Unexpected token `[`')) {
    const toks = tokenize(source);
    if (toks) {
      const MODS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'static', 'override', 'declare', 'export']);
      const edits = [];
      let braceDepth = 0;
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].text === '{') { braceDepth++; continue; }
        if (toks[i].text === '}') { braceDepth = Math.max(0, braceDepth - 1); continue; }
        if (braceDepth > 0 && toks[i].type === 'id' && toks[i].text === 'export' &&
            (toks[i + 1].text === 'get' || toks[i + 1].text === 'set' || toks[i + 1].text === '[') &&
            !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '      ' });
        } else if (i > 0 && toks[i].type === 'id' && MODS.has(toks[i].text) &&
            toks[i - 1].type === 'id' && MODS.has(toks[i - 1].text) &&
            !hasNewlineBetween(source, toks[i - 1].end, toks[i].start)) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: ' '.repeat(toks[i].end - toks[i].start) });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `await isn't allowed in non-async function`: `for await (...)` and `await expr` inside non-async functions
  if (errMsg.includes("await isn't allowed in non-async function")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.type !== 'id' || t.text !== 'await' || toks[i - 1]?.text === '.') continue;
        if (toks[i - 1]?.text === 'for' && toks[i + 1].text === '(') {
          edits.push({ start: t.start, end: t.end, text: '     ' });
          offsets.push([t.start, 'await', '     ']);
        } else if (toks[i + 1].text !== '=>') {
          edits.push({ start: t.start, end: t.end, text: 'void ' });
          offsets.push([t.start, 'await', 'void ']);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const [off, orig, repl] of offsets) {
            if (stripped.slice(off, off + orig.length) === repl) {
              out += stripped.slice(p, off) + orig;
              p = off + orig.length;
            }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `Expected ';', got '='`: initializer in interface/type/object-type-literal property (`interface Foo { bar: number = 5; }`, `var Foo: { bar: number = 5; }`)
  if (errMsg.includes("Expected ';', got '='")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        const isTypeBlock = (toks[i].type === 'id' && (toks[i].text === 'interface' || toks[i].text === 'type') && toks[i - 1]?.text !== '.') ||
          (toks[i].text === ':' && toks[i + 1].text === '{');
        if (isTypeBlock) {
          let k = i + 1;
          while (k < toks.length && toks[k].text !== '{' && toks[k].text !== ';') k++;
          if (k >= toks.length || toks[k].text !== '{') continue;
          const closeBr = findMatchingBrace(toks, k);
          if (closeBr < 0) continue;
          let dP = 0, dB = 0, dBr = 0;
          for (let m = k + 1; m < closeBr; m++) {
            const mt = toks[m];
            if (mt.text === '(') dP++;
            else if (mt.text === ')') dP--;
            else if (mt.text === '[') dB++;
            else if (mt.text === ']') dB--;
            else if (mt.text === '{') dBr++;
            else if (mt.text === '}') dBr--;
            else if (mt.text === '=' && dP === 0 && dB === 0 && dBr === 0 && toks[m - 1]?.text !== '=' && toks[m + 1]?.text !== '=' && toks[m + 1]?.text !== '>') {
              let e = m + 1, eP = 0, eB = 0, eBr = 0;
              while (e < closeBr) {
                const et = toks[e];
                if (et.text === '(') eP++;
                else if (et.text === ')') eP--;
                else if (et.text === '[') eB++;
                else if (et.text === ']') eB--;
                else if (et.text === '{') eBr++;
                else if (et.text === '}') eBr--;
                else if (eP === 0 && eB === 0 && eBr === 0 && (et.text === ';' || et.text === ',' || hasNewlineBetween(source, toks[e - 1].end, et.start))) break;
                e++;
              }
              edits.push({ start: mt.start, end: toks[e - 1].end, text: source.slice(mt.start, toks[e - 1].end).replace(/[^\r\n]/g, ' ') });
              m = e - 1;
            }
          }
          i = closeBr;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `'readonly' modifier already seen.` / `A method cannot be readonly` -> erase redundant `readonly`
  if (errMsg.includes("'readonly' modifier already seen") || errMsg.includes('A method cannot be readonly')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'readonly' && toks[i - 1]?.text !== '.' &&
            !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '        ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `private names are not allowed in interface` -> replace `#name` inside `interface`/`type`/`declare` type blocks (erased by TS)
  if (errMsg.includes('private names are not allowed in interface')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        const isTypeBlock = (toks[i].type === 'id' && (toks[i].text === 'interface' || toks[i].text === 'type' || toks[i].text === 'declare') && toks[i - 1]?.text !== '.');
        if (!isTypeBlock) continue;
        let k = i + 1;
        while (k < toks.length && toks[k].text !== '{' && toks[k].text !== ';' && toks[k].text !== '[') k++;
        if (k >= toks.length || toks[k].text === ';') continue;
        const closeIdx = toks[k].text === '{' ? findMatchingBrace(toks, k) : (() => {
          let d = 0;
          for (let q = k; q < toks.length; q++) {
            if (toks[q].text === '[') d++;
            else if (toks[q].text === ']') { if (--d === 0) return q; }
          }
          return -1;
        })();
        if (closeIdx < 0) continue;
        for (let m = k + 1; m < closeIdx; m++) {
          if (toks[m].type === 'punc' && toks[m].text === '#' && toks[m + 1]?.type === 'id') {
            edits.push({ start: toks[m].start, end: toks[m].end, text: '_' });
          }
        }
        i = closeIdx;
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Classes can't have a private field named '#constructor'` -> rename `#constructor` -> `#__tmt_ctor__`, strip, restore
  if (errMsg.includes("private field named '#constructor'") && !source.includes('#__tmt_ctor__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'punc' && toks[i].text === '#' && toks[i + 1].type === 'id' && toks[i + 1].text === 'constructor' &&
            toks[i].end === toks[i + 1].start) {
          edits.push({ start: toks[i + 1].start, end: toks[i + 1].end, text: '__tmt_ctor__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/__tmt_ctor__/g, 'constructor');
      }
    }
  }

  // `Classes may not have a non-static field named 'constructor'` -> rename `constructor` field -> `__tmt_cf__`, strip, restore
  if (errMsg.includes("field named 'constructor'") && !source.includes('__tmt_cf__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i];
        const next = toks[i + 1];
        if (((t.type === 'id' && t.text === 'constructor') || (t.type === 'str' && (t.text === '"constructor"' || t.text === "'constructor'"))) &&
            toks[i - 1]?.text !== '.' &&
            (next.text === ':' || next.text === '=' || next.text === '?' || next.text === '!')) {
          edits.push({ start: t.start, end: t.end, text: t.type === 'str' ? `${t.text[0]}__tmt_cf__${t.text[0]}` : '__tmt_cf__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/__tmt_cf__/g, 'constructor');
      }
    }
  }

  // `Rest element must be final element` / `Expected ',', got '='` / `Expected ',', got ':'` in rest pattern
  if (errMsg.includes('Rest element must be final element') || errMsg.includes("Expected ',', got '='") || errMsg.includes("Expected ',', got ':'")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].type === 'punc' && toks[i].text === '...') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '   ' });
          offsets.push(toks[i].start);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const off of offsets) {
            if (stripped.slice(off, off + 3) === '   ') {
              out += stripped.slice(p, off) + '...';
              p = off + 3;
            }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `An implementation cannot be declared in ambient contexts` (`export declare class Foo { bar() {} }`)
  if (errMsg.includes('An implementation cannot be declared in ambient contexts') && /\bdeclare[ \t]+(?:abstract[ \t]+)?class\b/.test(source)) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'declare' && toks[i - 1]?.text !== '.') {
          let k = i + 1;
          if (toks[k]?.text === 'abstract') k++;
          if (toks[k]?.text !== 'class') continue;
          while (k < toks.length && toks[k].text !== '{') k++;
          if (k >= toks.length) continue;
          const closeCls = findMatchingBrace(toks, k);
          if (closeCls < 0) continue;
          for (let m = k + 1; m < closeCls; m++) {
            if (toks[m].text === '{') {
              const cm = findMatchingBrace(toks, m);
              if (cm > m && cm < closeCls) {
                edits.push({ start: toks[m].start, end: toks[cm].end, text: ';' + source.slice(toks[m].start + 1, toks[cm].end).replace(/[^\r\n]/g, ' ') });
                m = cm;
              }
            }
          }
          i = closeCls;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Unexpected token 'ident'. Expected target` (`new.targ`)
  if (errMsg.includes('Expected target') && !source.includes('__tmt_nt_')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const saved = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'new' && toks[i - 1]?.text !== '.' &&
            toks[i + 1].type === 'punc' && toks[i + 1].text === '.' &&
            toks[i + 2].type === 'id' && toks[i + 2].text !== 'target') {
          const ph = `/*__tmt_nt_${saved.length}__*/target`;
          saved.push([ph, toks[i + 2].text]);
          edits.push({ start: toks[i + 2].start, end: toks[i + 2].end, text: ph });
          i += 2;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        let stripped = tryStrip(work);
        if (stripped !== null) {
          for (const [ph, orig] of saved) stripped = stripped.replace(ph, () => orig);
          return stripped;
        }
      }
    }
  }

  // `Expected ']', got 'ident'` / `Expected ']', got '='` in index signature (`[public x: string]: any`, `[a: string = ""]: number`)
  if (errMsg.includes("Expected ']', got 'ident'") || errMsg.includes("Expected ']', got '='")) {
    let work = source.replace(/(\[[ \t]*)(?:public|private|protected|static)([ \t]+[A-Za-z_$][\w$]*[ \t]*:)/g, '$1$2');
    let invalidInit = false;
    work = work.replace(/(\[[ \t]*[A-Za-z_$][\w$]*[ \t]*:[ \t]*[A-Za-z_$][\w$]*)[ \t]*=([^\]\n]+)(?=\])/g, (m, head, init) => {
      const itoks = tokenize(init);
      if (!itoks || itoks.length === 0) { invalidInit = true; return m; }
      let dP = 0, dB = 0, dBr = 0;
      for (const tk of itoks) {
        if (tk.text === '(') dP++; else if (tk.text === ')') { if (--dP < 0) { invalidInit = true; return m; } }
        else if (tk.text === '[') dB++; else if (tk.text === ']') { if (--dB < 0) { invalidInit = true; return m; } }
        else if (tk.text === '{') dBr++; else if (tk.text === '}') { if (--dBr < 0) { invalidInit = true; return m; } }
        else if (dP === 0 && dB === 0 && dBr === 0 && (tk.text === ';' || tk.text === ',')) { invalidInit = true; return m; }
      }
      if (dP !== 0 || dB !== 0 || dBr !== 0) { invalidInit = true; return m; }
      try { stripTypeScriptTypes(`const __tmt_i__ = (${init});`); return head; }
      catch { invalidInit = true; return m; }
    });
    if (!invalidInit && work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Expected ',', got '('` (`interface I extends foo() {}`)
  if (errMsg.includes("Expected ',', got '('") && /\binterface\b/.test(source)) {
    const work = source.replace(/(\binterface[ \t]+[A-Za-z_$][\w$]*[ \t]+extends[ \t]+[A-Za-z_$][\w$.]*)\(\)/g, '$1');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `The 'type' modifier cannot be used on a named export when 'export type'`
  if (errMsg.includes("The 'type' modifier cannot be used on a named export")) {
    const work = source.replace(/(\bexport[ \t]+type[ \t]*\{[^}]*)\btype([ \t]+)/g, '$1    $2');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Unexpected token '?'. Expected an identifier` (`?number`, `Array.<number>`)
  if (errMsg.includes('Unexpected token `?`. Expected an identifier')) {
    let work = source.replace(/\b([A-Za-z_$][\w$]*)\.</g, '$1<');
    work = work.replace(/(:[ \t]*)\?(?=[A-Za-z_$])/g, '$1 ');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Expected ')', got 'ident'` (`import({x: 12})` in type position)
  if (errMsg.includes("Expected ')', got 'ident'") && /:[ \t]*import[ \t]*\(/.test(source) && !source.includes('__tmt_it__')) {
    let invalidObj = false;
    const work = source.replace(/(:[ \t]*import[ \t]*\()(\{[^}]*\})(\))/g, (m, pre, obj, post) => {
      try {
        if (stripTypeScriptTypes(`type __tmt_it__ = (${obj});`).trim() !== '') { invalidObj = true; return m; }
        return `${pre}"__tmt_it__"${post}`;
      } catch { invalidObj = true; return m; }
    });
    if (!invalidObj && work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null && !stripped.includes('"__tmt_it__"')) return stripped;
    }
  }

  // `Expected ']', got 'in'` (mixed properties + mapped type in `type T = { a: 1; [K in U]: V }`)
  if (errMsg.includes("Expected ']', got 'in'") && /\btype\b/.test(source)) {
    let invalidRhs = false;
    const work = source.replace(/\[[ \t]*[A-Za-z_$][\w$]*[ \t]+in[ \t]+([^\]\n]+)\][ \t]*:/g, (m, rhs) => {
      try {
        if (stripTypeScriptTypes(`type __tmt_mt__ = (${rhs});`).trim() !== '') { invalidRhs = true; return m; }
        return '[__k: string]:';
      } catch { invalidRhs = true; return m; }
    });
    if (!invalidRhs && work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Expected '{', got 'ident'` (mixed named + unnamed tuple members `[a: number, string]`)
  if (errMsg.includes("Expected '{', got 'ident'") && /\btype\b/.test(source)) {
    const work = source.replace(/([\[,][ \t]*)[A-Za-z_$][\w$]*\??[ \t]*:(?=[ \t]*[A-Za-z_$(\[{])/g, '$1');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Expected '{', got '!'` (`!string` JSDoc non-nullable type in type alias)
  if (errMsg.includes("Expected '{', got '!'") && /\btype\b/.test(source)) {
    const work = source.replace(/([:=|&(\[<,][ \t]*)!(?=[A-Za-z_$(\[{])/g, '$1 ');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Class constructor can't be an accessor.` (`get constructor()`, `set constructor(v)`)
  if (errMsg.includes("Class constructor can't be an accessor") && !source.includes('__tmt_ca__')) {
    const work = source.replace(/\b(get|set)([ \t]+)constructor(?=[ \t]*\()/g, '$1$2__tmt_ca__');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped.replace(/__tmt_ca__/g, 'constructor');
    }
  }

  // `Invalid 'super()'` (`new super(...)`)
  if (errMsg.includes('Invalid `super()`') && !source.includes('__tmt_sp__')) {
    const work = source.replace(/\bnew([ \t]+)super(?=[ \t]*\()/g, 'new$1__tmt_sp__');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped.replace(/__tmt_sp__/g, 'super');
    }
  }

  // `A switch block cannot have multiple defaults`
  if (errMsg.includes('A switch block cannot have multiple defaults') && !source.includes('__tmt_df__')) {
    let seen = false;
    const work = source.replace(/\bdefault([ \t]*):/g, (m, sp) => { if (!seen) { seen = true; return m; } return `case __tmt_df__${sp}:`; });
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped.replace(/case __tmt_df__([ \t]*):/g, 'default$1:');
    }
  }

  // `LineBreak cannot follow 'throw'`
  if (errMsg.includes("LineBreak cannot follow 'throw'") && !source.includes('__tmt_th__')) {
    const work = source.replace(/\bthrow([ \t]*\r?\n)/g, 'throw /*__tmt_th__*/ 0;$1');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped.replace(/throw \/\*__tmt_th__\*\/ 0;/g, 'throw');
    }
  }

  // `literal in an import type should be string literal` (`import(T)` in type position only)
  if (errMsg.includes('literal in an import type should be string literal') && !source.includes('__tmt_it__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 3; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i + 1].text === '(' &&
            toks[i + 2].type === 'id' && toks[i + 3].text === ')') {
          const prevIdx = toks[i - 1].text === 'typeof' && i >= 2 ? i - 2 : i - 1;
          const prev = toks[prevIdx].text;
          const isTypeEq = prev === '=' && prevIdx >= 2 && (toks[prevIdx - 2]?.text === 'type' || toks[prevIdx - 1]?.text === '>');
          if (prev === ':' || prev === '<' || prev === '|' || prev === '&' || prev === 'extends' || isTypeEq) {
            edits.push({ start: toks[i + 2].start, end: toks[i + 2].end, text: '"__tmt_it__"' });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && !stripped.includes('"__tmt_it__"')) return stripped;
      }
    }
  }

  // `Expected ';', got 'ident'`: accessibility modifier inside interface/object type (`interface I { private x: string; }`)
  if (errMsg.includes("Expected ';', got 'ident'")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 2; i++) {
        const isTypeBlock = (toks[i].type === 'id' && (toks[i].text === 'interface' || toks[i].text === 'type') && toks[i - 1]?.text !== '.') ||
          (toks[i].text === ':' && toks[i + 1].text === '{');
        if (!isTypeBlock) continue;
        let k = i + 1;
        while (k < toks.length && toks[k].text !== '{' && toks[k].text !== ';') k++;
        if (k >= toks.length || toks[k].text !== '{') continue;
        const closeBr = findMatchingBrace(toks, k);
        if (closeBr < 0) continue;
        for (let m = k + 1; m < closeBr - 1; m++) {
          if (toks[m].type === 'id' && (toks[m].text === 'public' || toks[m].text === 'private' || toks[m].text === 'protected') &&
              toks[m + 1].type === 'id' && !hasNewlineBetween(source, toks[m].end, toks[m + 1].start)) {
            edits.push({ start: toks[m].start, end: toks[m].end, text: ' '.repeat(toks[m].end - toks[m].start) });
          }
        }
        i = closeBr;
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `'public' modifier cannot appear on a type parameter`
  if (errMsg.includes('modifier cannot appear on a type parameter')) {
    const work = source.replace(/(<[ \t]*)(?:public|private|protected|readonly)([ \t]+)/g, '$1$2');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Unexpected token 'ident'. Expected ... , *, (, [, :, , ?, =`: accessibility/abstract modifiers in object literals (`{ public foo: 1 }`)
  if (errMsg.includes('Expected ... , *,  (, [, :')) {
    const work = source.replace(/([{,][ \t\r\n]*)(?:public|private|protected|abstract|readonly)([ \t]+)(?=[A-Za-z_$][\w$]*[ \t]*[:(])/g, (m, pre, sp) => pre + ' '.repeat(m.length - pre.length - sp.length) + sp);
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Destructuring bindings require initializers` (`var [a], {b}, c;`)
  if (errMsg.includes('Destructuring bindings require initializers') && !source.includes('__tmt_di__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && (toks[i].text === 'var' || toks[i].text === 'let' || toks[i].text === 'const')) {
          let k = i + 1;
          while (k < toks.length && toks[k].text !== ';') {
            if ((toks[k].text === '[' || toks[k].text === '{') && (k === i + 1 || toks[k - 1].text === ',')) {
              const close = toks[k].text === '{' ? findMatchingBrace(toks, k) : (() => {
                let d = 0;
                for (let q = k; q < toks.length; q++) {
                  if (toks[q].text === '[') d++;
                  else if (toks[q].text === ']') { if (--d === 0) return q; }
                }
                return -1;
              })();
              if (close < 0) break;
              let after = close + 1;
              // Skip optional `: Type` annotation
              if (toks[after]?.text === ':') {
                after++;
                let dP = 0, dB = 0, dBr = 0;
                while (after < toks.length) {
                  const at = toks[after].text;
                  if (at === '(') dP++; else if (at === ')') dP--;
                  else if (at === '[') dB++; else if (at === ']') dB--;
                  else if (at === '{') dBr++; else if (at === '}') dBr--;
                  else if (dP === 0 && dB === 0 && dBr === 0 && (at === '=' || at === ',' || at === ';')) break;
                  after++;
                }
              }
              if (toks[after]?.text === ',' || toks[after]?.text === ';' || !toks[after] || hasNewlineBetween(source, toks[after - 1].end, toks[after].start)) {
                const insPos = toks[after] ? toks[after].start : toks[after - 1].end;
                edits.push({ start: insPos, end: insPos, text: '/*__tmt_di__*/ = 0' });
              }
              k = after;
              continue;
            }
            if (toks[k].text === '(') { const cp = findMatchingParen(toks, k); if (cp < 0) break; k = cp + 1; continue; }
            k++;
          }
          i = k;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/\/\*__tmt_di__\*\/ = 0/g, '');
      }
    }
  }

  // `Expression expected`: `@decorator default class {}` (bare `default` without `export`)
  if (errMsg.includes('Expression expected') && /\bdefault[ \t]+(?:abstract[ \t]+)?class\b/.test(source)) {
    const work = source.replace(/(?<!\bexport[ \t]+)\bdefault([ \t]+)(?=(?:abstract[ \t]+)?class\b)/g, '       $1');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Unexpected line break between arrow head and arrow` (code tokens only, never inside strings/templates/regexes)
  if (errMsg.includes('Unexpected line break between arrow head and arrow')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length; i++) {
        if (toks[i].type === 'punc' && toks[i].text === '=>' && hasNewlineBetween(source, toks[i - 1].end, toks[i].start)) {
          edits.push({ start: toks[i - 1].end, end: toks[i].start, text: ' ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected ident`: tagged template in optional chain (`a?.`hello``) -> TS emits `a`hello`` (code tokens only)
  if (errMsg.includes('Expected ident') && source.includes('?.') && source.includes('`')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'punc' && toks[i].text === '?' && toks[i + 1].type === 'punc' && toks[i + 1].text === '.' &&
            toks[i].end === toks[i + 1].start &&
            (toks[i + 2].type === 'tpl' || (toks[i + 2].type === 'str' && toks[i + 2].text.startsWith('`')))) {
          edits.push({ start: toks[i].start, end: toks[i + 1].end, text: '  ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected ';', '}' or <eof>` / `Expected ')', got 'of'` / `Expression expected`: `using {a} = null`, `for ([await] using of of of)`
  if ((errMsg.includes("Expected ';', '}' or <eof>") || errMsg.includes("Expected ')', got 'of'") || errMsg.includes('Expression expected')) &&
      /\busing\b/.test(source) && !source.includes('__tmt_us__')) {
    let work = source.replace(/(?<!\bfor[ \t]*\([ \t]*)\b(await[ \t]+)?using(?=[ \t]*\{)/g, (m, aw) => (aw ? `${aw.replace(/await/, '/*__tmt_ua__*/')}` : '') + '/*__tmt_us__*/const');
    work = work.replace(/(\bfor[ \t]*\([ \t]*)(await[ \t]+)using([ \t]+of[ \t]+of\b)/g, (m, pre, aw, post) => `${pre}/*__tmt_ua__*/ /*__tmt_us__*/const${post}`);
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped.replace(/\/\*__tmt_ua__\*\//g, 'await').replace(/\/\*__tmt_us__\*\/const/g, 'using');
    }
  }

  // `A method cannot be readonly` / accessibility modifier on `#private` member (`public #foo`, `readonly #quxMethod()`, `public get #fooProp()`, `abstract #foo`)
  if ((errMsg.includes('A method cannot be readonly') || errMsg.includes('cannot appear on a private')) && source.includes('#')) {
    const work = source.replace(/\b(?:public|private|protected|readonly|abstract)([ \t]+)(?=(?:(?:get|set)[ \t]+)?#)/g, (m, sp) => ' '.repeat(m.length - sp.length) + sp);
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Unexpected token 'ident'. Expected * for generator`: disallowed/duplicate class modifiers (`override accessor`, `override declare`, `override readonly`, `abstract override`, `override public`, etc.)
  if (errMsg.includes('Expected * for generator')) {
    const toks = tokenize(source);
    if (toks) {
      const MOD_LEFT = new Set(['override', 'abstract', 'readonly', 'declare', 'public', 'private', 'protected']);
      const MOD_RIGHT = new Set(['accessor', 'override', 'static', 'abstract', 'public', 'private', 'protected', 'declare', 'readonly']);
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i], next = toks[i + 1];
        if (t.type !== 'id' || toks[i - 1]?.text === '.' || hasNewlineBetween(source, t.end, next.start)) continue;
        if (MOD_LEFT.has(t.text) && next.type === 'id' && MOD_RIGHT.has(next.text)) {
          edits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
        } else if (t.text === 'declare' && next.type === 'id' && (next.text === 'get' || next.text === 'set') &&
            toks[i + 2] && !hasNewlineBetween(source, next.end, toks[i + 2].start) &&
            ((toks[i + 2].type === 'id' && toks[i + 3]?.text === '(') ||
             (toks[i + 2].text === '#' && toks[i + 3]?.type === 'id' && toks[i + 4]?.text === '(') ||
             ((toks[i + 2].type === 'str' || toks[i + 2].type === 'num') && toks[i + 3]?.text === '('))) {
          edits.push({ start: t.start, end: t.end, text: '       ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `` `<kw>` cannot be used as an identifier in strict mode `` (`public`, `private`, `protected`, `package`, `interface`, `implements`, `static`)
  {
    const m = /`([a-z]+)` cannot be used as an identifier in strict mode/.exec(errMsg);
    if (m && ['static', 'public', 'private', 'protected', 'package', 'interface', 'implements'].includes(m[1])) {
      const kw = m[1];
      const ph = `__tmt_skw_${kw}__`;
      if (!source.includes(ph)) {
        const toks = tokenize(source);
        if (toks) {
          const edits = [];
          for (let i = 0; i < toks.length; i++) {
            if (toks[i].type !== 'id' || toks[i].text !== kw || toks[i - 1]?.text === '.') continue;
            const prev = i > 0 ? toks[i - 1] : null;
            const next = toks[i + 1];
            const isIdentUse = (prev && ['var', 'let', 'const', 'function', 'class', '(', ',', '[', '{', ':', '=', '...', 'return'].includes(prev.text)) ||
              (next && [')', ',', ';', '=', ']', '}', ':', '.', '('].includes(next.text));
            if (isIdentUse) edits.push({ start: toks[i].start, end: toks[i].end, text: ph });
          }
          if (edits.length > 0) {
            let work = '', pos = 0;
            for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
            work += source.slice(pos);
            const stripped = tryStrip(work);
            if (stripped !== null) return stripped.replaceAll(ph, kw);
          }
        }
      }
    }
  }

  // `Expected ';', got '['` / `Expected ';', got 'readonly'` (`static [x: string]: any;`, `public [a: string]: number;`)
  if (errMsg.includes("Expected ';', got '['") || errMsg.includes("Expected ';', got 'readonly'")) {
    const toks = tokenize(source);
    if (toks) {
      const IDX_MODS = new Set(['static', 'public', 'private', 'protected']);
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && IDX_MODS.has(toks[i].text) && toks[i - 1]?.text !== '.' &&
            !hasNewlineBetween(source, toks[i].end, toks[i + 1].start) &&
            (toks[i + 1].text === '[' || (toks[i + 1].text === 'readonly' && toks[i + 2]?.text === '['))) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: ' '.repeat(toks[i].end - toks[i].start) });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `` `await` expressions cannot be used in a parameter `` -> `await` -> `void `, strip, restore
  if (errMsg.includes('`await` expressions cannot be used in a parameter')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'await' && toks[i - 1]?.text !== '.' && toks[i + 1].text !== '=>') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: 'void ' });
          offsets.push(toks[i].start);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const off of offsets) {
            if (stripped.slice(off, off + 5) === 'void ') {
              out += stripped.slice(p, off) + 'await';
              p = off + 5;
            }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `Expected '(', got '{'` (`public static {}`, `async static {}`, `readonly private static {}`) -> erase modifiers before `static {`
  if (errMsg.includes("Expected '(', got '{'")) {
    const toks = tokenize(source);
    if (toks) {
      const MODS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare', 'async']);
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'static' && toks[i + 1].text === '{') {
          let m = i - 1;
          while (m >= 0 && toks[m].type === 'id' && MODS.has(toks[m].text) && !hasNewlineBetween(source, toks[m].end, toks[m + 1].start)) {
            edits.push({ start: toks[m].start, end: toks[m].end, text: ' '.repeat(toks[m].end - toks[m].start) });
            m--;
          }
        }
      }
      if (edits.length > 0) {
        edits.sort((a, b) => a.start - b.start);
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected ',', got '!'` (`{ a! }`) -> erase `!` to space
  if (errMsg.includes("Expected ',', got '!'")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].type === 'punc' && toks[i].text === '!' && toks[i - 1].type === 'id' &&
            (toks[i + 1].text === '}' || toks[i + 1].text === ',' || toks[i + 1].text === '=')) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: ' ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `` `extends` clause already seen. `` (`class D extends C extends C {}`) -> erase 2nd+ `extends <heritage>`
  if (errMsg.includes('`extends` clause already seen')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'extends' && toks[i - 1]?.text !== '.') {
          // Find next `extends` before `{`
          let k = i + 1;
          while (k < toks.length && toks[k].text !== '{') {
            if (toks[k].type === 'id' && toks[k].text === 'extends') {
              let e = k + 1;
              while (e < toks.length && toks[e].text !== '{' && toks[e].text !== 'implements' && toks[e].text !== 'extends') e++;
              edits.push({ start: toks[k].start, end: toks[e - 1].end, text: source.slice(toks[k].start, toks[e - 1].end).replace(/[^\r\n]/g, ' ') });
              k = e;
              continue;
            }
            k++;
          }
          i = k;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected ')', got '('`: nested `import(import("./a").LookAt).Value` in type position (erased by TS)
  if (errMsg.includes("Expected ')', got '('") && source.includes('import(')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 4; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i + 1].text === '(' &&
            toks[i + 2].type === 'id' && toks[i + 2].text === 'import' && toks[i + 3].text === '(') {
          const closeOuter = findMatchingParen(toks, i + 1);
          if (closeOuter > i + 3) {
            edits.push({ start: toks[i + 2].start, end: toks[closeOuter - 1].end, text: '"__tmt__"' });
            i = closeOuter;
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `` `abstract` modifier can only appear on a class or method `` / `Abstract methods can only appear within an abstract class`
  if (errMsg.includes('`abstract` modifier can only appear') || errMsg.includes('Abstract methods can only appear within an abstract class')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'abstract' && toks[i - 1]?.text !== '.' &&
            toks[i + 1].text !== 'class' && !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
          // If it's a bodyless method/field ending in `;` before `{`, erase the whole declaration; otherwise erase `abstract`
          let k = i + 1, hasBody = false;
          while (k < toks.length && toks[k].text !== ';' && toks[k].text !== '}') {
            if (toks[k].text === '(') { const cp = findMatchingParen(toks, k); if (cp > k) { k = cp + 1; continue; } }
            if (toks[k].text === '{') { hasBody = true; break; }
            k++;
          }
          if (!hasBody && k < toks.length && toks[k].text === ';') {
            edits.push({ start: toks[i].start, end: toks[k].end, text: source.slice(toks[i].start, toks[k].end).replace(/[^\r\n]/g, ' ') });
            i = k;
          } else {
            edits.push({ start: toks[i].start, end: toks[i].end, text: '        ' });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Unexpected token '...'. Expected yield, an identifier, [ or {` (`constructor(public ...rest: string[]) {}`)
  if (errMsg.includes('Unexpected token `...`')) {
    const toks = tokenize(source);
    if (toks) {
      const MODS = new Set(['public', 'private', 'protected', 'readonly']);
      const edits = [];
      let parenDepth = 0;
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.text === '(') { parenDepth++; continue; }
        if (t.text === ')') { if (parenDepth > 0) parenDepth--; continue; }
        if (parenDepth > 0 && t.type === 'id' && MODS.has(t.text) && toks[i + 1].text === '...') {
          edits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expression expected`:
  //   1. Malformed type-only index signatures (`[...x]: T`, `[idx?: T]: U`, `[]: T`, `[a?]`) inside interface/type/class
  //   2. Strict-mode contextual keywords used as identifiers (`[public]()`, `static()`, `var interface`, `(private, public, static)`)
  //   3. `using` / `await using` declarations in non-standard positions
  if (errMsg.includes('Expression expected') || errMsg.includes("Expected ';', '}' or <eof>")) {
    const toks = tokenize(source);
    if (toks) {
      // 1. Index signatures `[...x]`, `[x?: T]`, `[x?]`, `[]`
      if (errMsg.includes('Expression expected')) {
        const ixEdits = [];
        for (let i = 0; i < toks.length - 1; i++) {
          if (toks[i].text !== '[') continue;
          const prev = i > 0 ? toks[i - 1] : null;
          const isMemberStart = prev && (prev.text === '{' || prev.text === ';' || prev.text === '}' || hasNewlineBetween(source, prev.end, toks[i].start));
          if (!isMemberStart) continue;
          if (toks[i + 1].text === ']' && (toks[i + 2]?.text === ':' || toks[i + 2]?.text === ';' || toks[i + 2]?.text === '}')) {
            ixEdits.push({ start: toks[i].end, end: toks[i].end, text: '__tmt_ix__: any' });
          } else if (toks[i + 1].text === '...' && toks[i + 2]?.type === 'id') {
            ixEdits.push({ start: toks[i + 1].start, end: toks[i + 1].end, text: '   ' });
          } else if (toks[i + 1].type === 'id' && toks[i + 2]?.text === '?' && (toks[i + 3]?.text === ':' || toks[i + 3]?.text === ']')) {
            ixEdits.push({ start: toks[i + 2].start, end: toks[i + 2].end, text: ' ' });
          }
        }
        if (ixEdits.length > 0) {
          let work = '', pos = 0;
          for (const e of ixEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          const stripped = tryStrip(work);
          if (stripped !== null) return stripped;
        }
        // 2. Strict-mode contextual keywords (`public`, `private`, `protected`, `static`, `interface`, `package`, `implements`) as expressions/bindings
        const CTX_KWS = new Set(['public', 'private', 'protected', 'static', 'interface', 'package', 'implements']);
        if (!source.includes('__tmt_ck_')) {
          const ckEdits = [];
          const ckSaved = [];
          for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.type !== 'id' || !CTX_KWS.has(t.text)) continue;
            const prev = i > 0 ? toks[i - 1] : null;
            const next = toks[i + 1];
            if (prev && prev.text === '.') continue;
            const asExpr = (prev && (prev.text === '[' || prev.text === '(' || prev.text === ',' || prev.text === 'var' || prev.text === 'let' || prev.text === 'const')) ||
              (next && (next.text === ']' || next.text === '(' || next.text === ')' || next.text === ',' || next.text === ':' || next.text === ';'));
            if (asExpr && !(t.text === 'interface' && next?.type === 'id' && !hasNewlineBetween(source, t.end, next.start))) {
              const ph = `__tmt_ck_${ckSaved.length}__`;
              ckSaved.push([ph, t.text]);
              ckEdits.push({ start: t.start, end: t.end, text: ph });
            }
          }
          if (ckEdits.length > 0) {
            let work = '', pos = 0;
            for (const e of ckEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
            work += source.slice(pos);
            const stripped = tryStrip(work);
            if (stripped !== null) {
              let out = stripped;
              for (const [ph, orig] of ckSaved) out = out.replace(ph, () => orig);
              return out;
            }
          }
        }
      }
      // 3. `using` / `await using` declarations -> same-length `var  ` / `var        ` -> strip -> restore
      if (source.includes('using')) {
        const uEdits = [];
        const uOffsets = [];
        for (let i = 0; i < toks.length - 1; i++) {
          const t = toks[i];
          if (t.type === 'id' && t.text === 'using' && toks[i - 1]?.text !== '.' &&
              !hasNewlineBetween(source, t.end, toks[i + 1].start) &&
              toks[i + 1].type === 'id' && toks[i + 1].text !== 'of') {
            if (toks[i - 1]?.type === 'id' && toks[i - 1].text === 'await' && !hasNewlineBetween(source, toks[i - 1].end, t.start)) {
              const len = t.end - toks[i - 1].start;
              const repl = 'var' + ' '.repeat(len - 3);
              uEdits.push({ start: toks[i - 1].start, end: t.end, text: repl });
              uOffsets.push([toks[i - 1].start, source.slice(toks[i - 1].start, t.end), repl]);
            } else {
              uEdits.push({ start: t.start, end: t.end, text: 'var  ' });
              uOffsets.push([t.start, 'using', 'var  ']);
            }
          }
        }
        if (uEdits.length > 0) {
          let work = '', pos = 0;
          for (const e of uEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          const stripped = tryStrip(work);
          if (stripped !== null && stripped.length === work.length) {
            let out = '', p = 0;
            for (const [off, orig, repl] of uOffsets) {
              if (stripped.slice(off, off + orig.length) === repl) {
                out += stripped.slice(p, off) + orig;
                p = off + orig.length;
              }
            }
            out += stripped.slice(p);
            return out;
          }
        }
      }
      // 4. Labeled `function*` / `async function` / `class` / `let` / `const` (`label: function* gen() {}`, `label: class C {}`)
      if (errMsg.includes("Expected ';', '}' or <eof>")) {
        const lEdits = [];
        const lOffsets = [];
        const allowLexLabel = !/\bexport\b/.test(source) || source.includes('// @') || source.includes('//@');
        for (let i = 0; i < toks.length - 2; i++) {
          if (toks[i].type === 'id' && toks[i + 1].text === ':' &&
              (toks[i + 2].text === 'function' || toks[i + 2].text === 'async' || toks[i + 2].text === 'class' ||
               (allowLexLabel && (toks[i + 2].text === 'let' || toks[i + 2].text === 'const'))) &&
              (i === 0 || toks[i - 1].text === ';' || toks[i - 1].text === '{' || toks[i - 1].text === '}' || hasNewlineBetween(source, toks[i - 1].end, toks[i].start))) {
            const len = toks[i + 1].end - toks[i].start;
            const repl = ' '.repeat(len);
            lEdits.push({ start: toks[i].start, end: toks[i + 1].end, text: repl });
            lOffsets.push([toks[i].start, source.slice(toks[i].start, toks[i + 1].end), repl]);
          }
        }
        if (lEdits.length > 0) {
          let work = '', pos = 0;
          for (const e of lEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          const stripped = tryStrip(work);
          if (stripped !== null && stripped.length === work.length) {
            let out = '', p = 0;
            for (const [off, orig, repl] of lOffsets) {
              if (stripped.slice(off, off + orig.length) === repl) {
                out += stripped.slice(p, off) + orig;
                p = off + orig.length;
              }
            }
            out += stripped.slice(p);
            return out;
          }
        }
      }
    }
  }

  // `Expected ident`:
  //   1. Tagged template optional chain (`a?.`b``) -> `?.` -> `  `, strip, restore
  //   2. `export class {}` -> `export class __tmt_cls__ {}`, strip, restore
  //   3. `interface X extends (...) {}` -> replace `(...)` with `__tmt_base__` (erased by TS)
  if (errMsg.includes('Expected ident')) {
    const toks = tokenize(source);
    if (toks) {
      if (source.includes('?.`')) {
        const edits = [];
        const offsets = [];
        for (let i = 0; i < toks.length - 2; i++) {
          if (toks[i].text === '?' && toks[i + 1].text === '.' && toks[i].end === toks[i + 1].start && toks[i + 2].type === 'tpl') {
            edits.push({ start: toks[i].start, end: toks[i + 1].end, text: '  ' });
            offsets.push(toks[i].start);
          }
        }
        if (edits.length > 0) {
          let work = '', pos = 0;
          for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          const stripped = tryStrip(work);
          if (stripped !== null && stripped.length === work.length) {
            let out = '', p = 0;
            for (const off of offsets) {
              if (stripped.slice(off, off + 2) === '  ') { out += stripped.slice(p, off) + '?.'; p = off + 2; }
            }
            out += stripped.slice(p);
            return out;
          }
        }
      }
      if (!source.includes('__tmt_cls__') && !source.includes('__tmt_base__')) {
        const edits = [];
        for (let i = 0; i < toks.length - 1; i++) {
          if (toks[i].type === 'id' && toks[i].text === 'class' && toks[i - 1]?.text === 'export' && toks[i + 1].text === '{') {
            edits.push({ start: toks[i].end, end: toks[i].end, text: ' __tmt_cls__' });
          } else if (toks[i].type === 'id' && toks[i].text === 'extends' && toks[i + 1].text === '(') {
            // Only inside `interface ... extends (...)`
            let isIf = false;
            for (let b = i - 1; b >= Math.max(0, i - 6); b--) {
              if (toks[b].text === 'interface') { isIf = true; break; }
              if (toks[b].text === 'class' || toks[b].text === ';' || toks[b].text === '}') break;
            }
            if (isIf) {
              const cp = findMatchingParen(toks, i + 1);
              if (cp > i + 1) edits.push({ start: toks[i + 1].start, end: toks[cp].end, text: '__tmt_base__' });
            }
          }
        }
        if (edits.length > 0) {
          let work = '', pos = 0;
          for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          const stripped = tryStrip(work);
          if (stripped !== null) return stripped.replace(/ __tmt_cls__/g, '');
        }
      }
    }
  }

  // `Rest pattern is not allowed in setter` (`set X(...v) {}`) -> mask `...` -> strip -> restore
  if (errMsg.includes('Rest pattern is not allowed in setter') && !source.includes('__tmt_sr__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 4; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'set' && toks[i + 2]?.text === '(' && toks[i + 3]?.text === '...') {
          edits.push({ start: toks[i + 3].start, end: toks[i + 3].end, text: '/*__tmt_sr__*/' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/\/\*__tmt_sr__\*\//g, '...');
      }
    }
  }

  // `Unexpected token ':'` (`var b = { x?: 1 }`, `{ x ?: 1 }`) -> erase `?` before `:` in object literal property
  if (errMsg.includes('Unexpected token `:`')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].text === '?' && toks[i + 1].text === ':' && (toks[i - 1].type === 'id' || toks[i - 1].type === 'str' || toks[i - 1].type === 'num' || toks[i - 1].text === ']')) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: ' ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Type argument list cannot be empty.` (`I<>`) -> `I<any>` (type arg is erased by TS)
  if (errMsg.includes('Type argument list cannot be empty')) {
    const work = source.replace(/<>/g, '<any>');
    if (work !== source) {
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Expected ')', got '='` (`catch (e = 1) {}`) -> mask `= <expr>` before `)`, strip, restore
  if (errMsg.includes("Expected ')', got '='") && source.includes('catch') && !source.includes('__tmt_ci_')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const saved = [];
      for (let i = 0; i < toks.length - 4; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'catch' && toks[i + 1].text === '(') {
          const cp = findMatchingParen(toks, i + 1);
          if (cp > i + 2) {
            for (let k = i + 2; k < cp; k++) {
              if (toks[k].text === '=') {
                const orig = source.slice(toks[k].start, toks[cp].start);
                const ph = `/*__tmt_ci_${saved.length}__*/`;
                saved.push([ph, orig]);
                edits.push({ start: toks[k].start, end: toks[cp].start, text: ph });
                break;
              }
            }
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) {
          let out = stripped;
          for (const [ph, orig] of saved) out = out.replace(ph, () => orig);
          return out;
        }
      }
    }
  }

  // `Classes can only extend a single class` (`class C extends A, B {}`) -> mask `, B...` before `{`/`implements`
  if (errMsg.includes('Classes can only extend a single class')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'extends' && toks[i - 1]?.text !== '.') {
          let k = i + 1, dP = 0, dA = 0, commaIdx = -1;
          while (k < toks.length && !(dP === 0 && dA === 0 && (toks[k].text === '{' || toks[k].text === 'implements'))) {
            if (toks[k].text === '(') dP++;
            else if (toks[k].text === ')') dP--;
            else if (toks[k].text === '<') dA++;
            else if (toks[k].text === '>') { if (dA > 0) dA--; }
            else if (toks[k].text === ',' && dP === 0 && dA === 0 && commaIdx < 0) commaIdx = k;
            k++;
          }
          if (commaIdx > i && k < toks.length) {
            edits.push({ start: toks[commaIdx].start, end: toks[k - 1].end, text: source.slice(toks[commaIdx].start, toks[k - 1].end).replace(/[^\r\n]/g, ' ') });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Type parameters cannot appear on a constructor` (`constructor<T>() {}`) -> erase `<T>`
  if (errMsg.includes('Type parameters cannot appear on a constructor')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'constructor' && toks[i + 1].text === '<') {
          let k = i + 2, dA = 1;
          while (k < toks.length && dA > 0) {
            if (toks[k].text === '<') dA++;
            else if (toks[k].text === '>') dA--;
            k++;
          }
          if (dA === 0 && toks[k]?.text === '(') {
            edits.push({ start: toks[i + 1].start, end: toks[k - 1].end, text: source.slice(toks[i + 1].start, toks[k - 1].end).replace(/[^\r\n]/g, ' ') });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Type annotation cannot appear on a constructor` (`constructor(): number {}`) -> erase `: T` before `{`
  if (errMsg.includes('Type annotation cannot appear on a constructor')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'constructor' && toks[i + 1].text === '(') {
          const cp = findMatchingParen(toks, i + 1);
          if (cp > i + 1 && toks[cp + 1]?.text === ':') {
            let k = cp + 2;
            while (k < toks.length && toks[k].text !== '{' && toks[k].text !== ';') k++;
            if (k < toks.length) {
              edits.push({ start: toks[cp + 1].start, end: toks[k - 1].end, text: source.slice(toks[cp + 1].start, toks[k - 1].end).replace(/[^\r\n]/g, ' ') });
            }
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Class constructor can't be an accessor` / `A constructor cannot be generator` -> rename `constructor` -> `__tmt_ca__`, strip, restore
  if ((errMsg.includes("constructor can't be an accessor") || errMsg.includes('A constructor cannot be generator')) && !source.includes('__tmt_ca__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'constructor' &&
            (toks[i - 1].text === 'get' || toks[i - 1].text === 'set' || toks[i - 1].text === '*')) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_ca__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/__tmt_ca__/g, 'constructor');
      }
    }
  }

  // `The left-hand side of a 'for...of' statement` (`for (async of [1, 2]) {}`) -> rename `async` -> `__tmt_as__`, strip, restore
  if (errMsg.includes('The left-hand side of a `for...of` statement') && !source.includes('__tmt_as__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'async' && toks[i - 1].text === '(' && toks[i + 1].text === 'of') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_as__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/__tmt_as__/g, 'async');
      }
    }
  }

  // `A comma expression is not allowed in a computed property` (`{ [0, 1]: {} }`) -> wrap inner expr in `(...)`, strip, restore
  if (errMsg.includes('A comma expression is not allowed in a computed property') && !source.includes('__tmt_cp')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].text === '[') {
          let k = i + 1, d = 1, hasComma = false;
          while (k < toks.length && d > 0) {
            if (toks[k].text === '[') d++;
            else if (toks[k].text === ']') d--;
            else if (toks[k].text === ',' && d === 1) hasComma = true;
            k++;
          }
          if (d === 0 && hasComma && (toks[k]?.text === ':' || toks[k]?.text === '(')) {
            edits.push({ start: toks[i].end, end: toks[i].end, text: '/*__tmt_cpL*/(' });
            edits.push({ start: toks[k - 1].start, end: toks[k - 1].start, text: ')/*__tmt_cpR*/' });
          }
        }
      }
      if (edits.length > 0) {
        edits.sort((a, b) => a.start - b.start);
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/\/\*__tmt_cpL\*\/\(/g, '').replace(/\)\/\*__tmt_cpR\*\//g, '');
      }
    }
  }

  // `import defer ...` invalid forms (`import defer from "a"`, `import defer x from "a"`, `import defer { a } from "a"`)
  if ((errMsg.includes("Unexpected token `from`") || errMsg.includes("Expected 'from', got 'ident'") || errMsg.includes("Expected 'from', got '{'")) &&
      source.includes('defer')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 1; i < toks.length; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'defer' && toks[i - 1].text === 'import') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '     ' });
          offsets.push(toks[i].start);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const off of offsets) {
            if (stripped.slice(off, off + 5) === '     ') { out += stripped.slice(p, off) + 'defer'; p = off + 5; }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `Expected '(', got 'yield'` (`function* yield() {}`) / `'yield' cannot be used as a parameter`
  if ((errMsg.includes("Expected '(', got 'yield'") || errMsg.includes("'yield' cannot be used as a parameter")) && !source.includes('__tmt_yd__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'yield' && toks[i - 1]?.text !== '.' && toks[i + 1]?.text !== '=>') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: errMsg.includes('Expected \'(\'') ? '__tmt_yd__' : 'void ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) {
          return errMsg.includes("Expected '('") ? stripped.replace(/__tmt_yd__/g, 'yield') : stripped.replace(/void /g, 'yield');
        }
      }
    }
  }

  // `Expected ',', got '='` (`var [...x = a] = a;`) -> mask `= expr` inside `[...x = expr]`
  if (errMsg.includes("Expected ',', got '='") && source.includes('...') && !source.includes('__tmt_re_')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const saved = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].text === '...' && toks[i + 1].type === 'id' && toks[i + 2].text === '=') {
          let k = i + 3, dP = 0, dB = 0, dBr = 0;
          while (k < toks.length && !(dP === 0 && dB === 0 && dBr === 0 && (toks[k].text === ']' || toks[k].text === '}' || toks[k].text === ','))) {
            if (toks[k].text === '(') dP++; else if (toks[k].text === ')') dP--;
            else if (toks[k].text === '[') dB++; else if (toks[k].text === ']') dB--;
            else if (toks[k].text === '{') dBr++; else if (toks[k].text === '}') dBr--;
            k++;
          }
          if (k < toks.length) {
            const orig = source.slice(toks[i + 2].start, toks[k].start);
            const ph = `/*__tmt_re_${saved.length}__*/`;
            saved.push([ph, orig]);
            edits.push({ start: toks[i + 2].start, end: toks[k].start, text: ph });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) {
          let out = stripped;
          for (const [ph, orig] of saved) out = out.replace(ph, () => orig);
          return out;
        }
      }
    }
  }

  // `Expected ',', got '#'` (`const obj = { get #foo() {} }`) -> rename `#id` -> `__tmt_op__`, strip, restore
  if (errMsg.includes("Expected ',', got '#'") && !source.includes('__tmt_op_')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const saved = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].text === '#' && toks[i + 1].type === 'id' && toks[i].end === toks[i + 1].start) {
          const orig = '#' + toks[i + 1].text;
          const ph = `__tmt_op_${saved.length}__`;
          saved.push([ph, orig]);
          edits.push({ start: toks[i].start, end: toks[i + 1].end, text: ph });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) {
          let out = stripped;
          for (const [ph, orig] of saved) out = out.replace(ph, () => orig);
          return out;
        }
      }
    }
  }

  // `An index signature must have exactly one parameter` / `Expected ']', got 'ident'` (`interface I { [a, b]: T }`, `interface I { [public a] }`)
  if (errMsg.includes('An index signature must have exactly one parameter') || errMsg.includes("Expected ']', got 'ident'")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'interface' && toks[i - 1]?.text !== '.') {
          let k = i + 1;
          while (k < toks.length && toks[k].text !== '{' && toks[k].text !== ';') k++;
          if (k >= toks.length || toks[k].text !== '{') continue;
          const closeBr = findMatchingBrace(toks, k);
          if (closeBr < 0) continue;
          for (let m = k + 1; m < closeBr; m++) {
            if (toks[m].text === '[') {
              let e = m + 1, d = 1;
              while (e < closeBr && d > 0) { if (toks[e].text === '[') d++; else if (toks[e].text === ']') d--; e++; }
              if (d === 0) {
                edits.push({ start: toks[m].end, end: toks[e - 1].start, text: '__tmt_ix__: any' });
                m = e - 1;
              }
            }
          }
          i = closeBr;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected ')', got 'ident'` (`import(foo).Bar` in type position) -> `import("__tmt__").Bar` (erased by TS)
  if (errMsg.includes("Expected ')', got 'ident'") && source.includes('import(')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i + 1].text === '(' && toks[i + 2].type === 'id') {
          const cp = findMatchingParen(toks, i + 1);
          if (cp > i + 2 && toks[cp + 1]?.text === '.') {
            edits.push({ start: toks[i + 2].start, end: toks[cp].start, text: '"__tmt__"' });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected '{', got 'using'` / `Expected '{', got 'await'` (`export using x = ...`, `export await using x = ...`)
  if ((errMsg.includes("Expected '{', got 'using'") || errMsg.includes("Expected '{', got 'await'")) && source.includes('using')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'using' && toks[i + 1].type === 'id' && toks[i + 1].text !== 'of') {
          if (toks[i - 1]?.text === 'await') {
            const len = toks[i].end - toks[i - 1].start;
            const repl = 'var' + ' '.repeat(len - 3);
            edits.push({ start: toks[i - 1].start, end: toks[i].end, text: repl });
            offsets.push([toks[i - 1].start, source.slice(toks[i - 1].start, toks[i].end), repl]);
          } else {
            edits.push({ start: toks[i].start, end: toks[i].end, text: 'var  ' });
            offsets.push([toks[i].start, 'using', 'var  ']);
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const [off, orig, repl] of offsets) {
            if (stripped.slice(off, off + orig.length) === repl) { out += stripped.slice(p, off) + orig; p = off + orig.length; }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `` `<kw>` cannot be used as an identifier in strict mode `` (`"use strict"; let`, `export var static: any;`)
  if (errMsg.includes('cannot be used as an identifier in strict mode') && !source.includes('__tmt_sm_')) {
    const STRICT_CTX = new Set(['let', 'static', 'public', 'private', 'protected', 'interface', 'package', 'implements', 'yield']);
    const m = /`([a-z]+)` cannot be used as an identifier in strict mode/.exec(errMsg);
    if (m && STRICT_CTX.has(m[1])) {
      const kw = m[1];
      const toks = tokenize(source);
      if (toks) {
        const edits = [];
        for (let i = 0; i < toks.length; i++) {
          if (toks[i].type === 'id' && toks[i].text === kw && toks[i - 1]?.text !== '.') {
            const next = toks[i + 1];
            // Only replace when used as an identifier (not as a keyword like `let x = 1` or `static foo()`)
            if (!next || next.text === ';' || next.text === ',' || next.text === ':' || next.text === '=' || next.text === ')' || next.text === '}' || next.text === ']' || hasNewlineBetween(source, toks[i].end, next.start)) {
              edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_sm__' });
            }
          }
        }
        if (edits.length > 0) {
          let work = '', pos = 0;
          for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          const stripped = tryStrip(work);
          if (stripped !== null) return stripped.replace(/__tmt_sm__/g, kw);
        }
      }
    }
  }

  // `Expected ',', got 'numeric literal'` / `Expected a semicolon` (`() => ({ b: yield 1 })`) -> `yield` -> `void `, strip, restore
  if ((errMsg.includes("Expected ',', got 'numeric literal'") || errMsg.includes('Expected a semicolon')) &&
      source.includes('yield') && !/\byield[ \t]*=>/.test(source)) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'yield' && toks[i - 1]?.text !== '.' && toks[i - 1]?.text !== 'let' &&
            !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: 'void ' });
          offsets.push(toks[i].start);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const off of offsets) {
            if (stripped.slice(off, off + 5) === 'void ') { out += stripped.slice(p, off) + 'yield'; p = off + 5; }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `Trailing comma is not allowed` (`var a,;`) -> mask `,` before `;`, strip, restore
  if (errMsg.includes('Trailing comma is not allowed')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].text === ',' && toks[i + 1].text === ';') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: ' ' });
          offsets.push(toks[i].start);
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const off of offsets) {
            if (stripped[off] === ' ') { out += stripped.slice(p, off) + ','; p = off + 1; }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `Unknown regular expression flags.` (`if (1) /regexp/a.foo();`) -> mask invalid regex flags, strip, restore
  if (errMsg.includes('Unknown regular expression flags')) {
    const toks = tokenize(source);
    if (toks) {
      const VALID_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
      const edits = [];
      const offsets = [];
      for (const t of toks) {
        if (t.type === 'regex') {
          const lastSlash = t.text.lastIndexOf('/');
          if (lastSlash > 0 && lastSlash < t.text.length - 1) {
            const flags = t.text.slice(lastSlash + 1);
            const cleanFlags = [...flags].map(ch => VALID_FLAGS.has(ch) ? ch : ' ').join('');
            if (cleanFlags !== flags) {
              const start = t.start + lastSlash + 1;
              edits.push({ start, end: t.end, text: cleanFlags });
              offsets.push([start, flags, cleanFlags]);
            }
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const [off, orig, repl] of offsets) {
            if (stripped.slice(off, off + orig.length) === repl) { out += stripped.slice(p, off) + orig; p = off + orig.length; }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `Expected ';', got 'ident'` (`type A = { get foo() { return 0 } }`) -> erase accessor body inside type/interface (erased by TS)
  if (errMsg.includes("Expected ';', got 'ident'")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && (toks[i].text === 'type' || toks[i].text === 'interface') && toks[i - 1]?.text !== '.') {
          let k = i + 1;
          while (k < toks.length && toks[k].text !== '{' && toks[k].text !== ';') k++;
          if (k >= toks.length || toks[k].text !== '{') continue;
          const closeBr = findMatchingBrace(toks, k);
          if (closeBr < 0) continue;
          for (let m = k + 1; m < closeBr - 2; m++) {
            if (toks[m].text === ')' && toks[m + 1].text === '{') {
              const cb = findMatchingBrace(toks, m + 1);
              if (cb > m + 1 && cb < closeBr) {
                edits.push({ start: toks[m + 1].start, end: toks[cb].end, text: ';' });
                m = cb;
              }
            }
          }
          i = closeBr;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `An implementation cannot be declared in ambient contexts` (`export declare class C { m() {} }`) -> erase method bodies inside `declare class`
  if (errMsg.includes('An implementation cannot be declared in ambient contexts') && source.includes('declare')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'declare' &&
            (toks[i + 1].text === 'class' || (toks[i + 1].text === 'abstract' && toks[i + 2]?.text === 'class'))) {
          let k = i + 2;
          while (k < toks.length && toks[k].text !== '{') k++;
          if (k >= toks.length) continue;
          const closeCls = findMatchingBrace(toks, k);
          if (closeCls < 0) continue;
          for (let m = k + 1; m < closeCls - 1; m++) {
            if (toks[m].text === '{') {
              const cb = findMatchingBrace(toks, m);
              if (cb > m && cb < closeCls) {
                edits.push({ start: toks[m].start, end: toks[cb].end, text: ';' });
                m = cb;
              }
            }
          }
          i = closeCls;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected 'from', got 'public'` / `'private'` / `'protected'` / `'static'` / `'package'` -> strict-mode words in import
  if (/Expected 'from', got '(?:public|private|protected|static|package|interface|implements)'/.test(errMsg) && !source.includes('__tmt_im_')) {
    const CTX_IM = new Set(['public', 'private', 'protected', 'static', 'package', 'interface', 'implements']);
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const saved = [];
      for (let i = 1; i < toks.length; i++) {
        if (toks[i].type === 'id' && CTX_IM.has(toks[i].text) && (toks[i - 1].text === 'import' || toks[i - 1].text === 'as')) {
          const ph = `__tmt_im_${saved.length}__`;
          saved.push([ph, toks[i].text]);
          edits.push({ start: toks[i].start, end: toks[i].end, text: ph });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) {
          let out = stripped;
          for (const [ph, orig] of saved) out = out.replace(ph, () => orig);
          return out;
        }
      }
    }
  }

  // `Cannot assign to this` (`({...{}} = {})`, `for ([""] of [[""]]) {}`) -> mask invalid destructuring target, strip, restore
  if (errMsg.includes('Cannot assign to this') && !source.includes('__tmt_dt_')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const saved = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].text === '...' && (toks[i + 1].text === '{' || toks[i + 1].text === '[' || toks[i + 1].text === '(')) {
          const open = toks[i + 1].text;
          const closeCh = open === '{' ? '}' : open === '[' ? ']' : ')';
          let k = i + 2, d = 1;
          while (k < toks.length && d > 0) {
            if (toks[k].text === open) d++;
            else if (toks[k].text === closeCh) d--;
            k++;
          }
          if (d === 0) {
            const orig = source.slice(toks[i + 1].start, toks[k - 1].end);
            const ph = `__tmt_dt_${saved.length}__`;
            saved.push([ph, orig]);
            edits.push({ start: toks[i + 1].start, end: toks[k - 1].end, text: ph });
            i = k - 1;
          }
        } else if (toks[i].type === 'str' && toks[i - 1]?.text === '[' && toks[i + 1]?.text === ']') {
          const ph = `__tmt_dt_${saved.length}__`;
          saved.push([ph, toks[i].text]);
          edits.push({ start: toks[i].start, end: toks[i].end, text: ph });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) {
          let out = stripped;
          for (const [ph, orig] of saved) out = out.replace(ph, () => orig);
          return out;
        }
      }
    }
  }

  // `Expected '{', got '<eof>'` / `Expression expected`: empty `extends` clause (`class C extends {}`, `class C extends implements A {}`)
  if (errMsg.includes("Expected '{', got '<eof>'") || errMsg.includes('Expression expected')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'extends' && toks[i - 1]?.text !== '.' &&
            (toks[i + 1].text === '{' || toks[i + 1].text === 'implements')) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '       ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Nullish coalescing operator(??) requires parens when mixing with` (`a ?? b || c`) -> `??` -> `||`, strip, restore
  if (errMsg.includes('Nullish coalescing operator(??) requires parens')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const offsets = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].text === '?' && toks[i + 1].text === '?' && toks[i].end === toks[i + 1].start) {
          edits.push({ start: toks[i].start, end: toks[i + 1].end, text: '||' });
          offsets.push(toks[i].start);
          i++;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null && stripped.length === work.length) {
          let out = '', p = 0;
          for (const off of offsets) {
            if (stripped.slice(off, off + 2) === '||') { out += stripped.slice(p, off) + '??'; p = off + 2; }
          }
          out += stripped.slice(p);
          return out;
        }
      }
    }
  }

  // `'arguments' is only allowed in functions and class methods` -> rename `arguments` -> `__tmt_ar__`, strip, restore
  if (errMsg.includes("'arguments' is only allowed in functions") && !source.includes('__tmt_ar__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'arguments' && toks[i - 1]?.text !== '.') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_ar__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/__tmt_ar__/g, 'arguments');
      }
    }
  }

  // `An object member cannot be declared optional` (`{ a? }`) -> erase `?` to space
  if (errMsg.includes('An object member cannot be declared optional')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].type === 'punc' && toks[i].text === '?' && toks[i - 1].type === 'id' &&
            (toks[i + 1].text === '}' || toks[i + 1].text === ',' || toks[i + 1].text === '=')) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: ' ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected ident` for `yield` parameter in generator (`function* f(yield) {}`) -> placeholder -> strip -> restore
  if (errMsg.includes('Expected ident') && source.includes('yield') && !source.includes('__tmt_yd__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.type !== 'id' || t.text !== 'yield') continue;
        const prev = toks[i - 1];
        const next = toks[i + 1];
        if (prev.text === '.') continue;
        if (next.text === '=>') return null;
        if ((prev.text === '(' || prev.text === ',' || prev.text === 'var' || prev.text === 'let' || prev.text === 'const' || prev.text === '[' || prev.text === '{') &&
            (next.text === ')' || next.text === ',' || next.text === '=' || next.text === ':' || next.text === ';' || next.text === ']' || next.text === '}')) {
          edits.push({ start: t.start, end: t.end, text: '__tmt_yd__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/__tmt_yd__/g, 'yield');
      }
    }
  }

  // `Expected ']', got ':'` (e.g. `public [x: string]: any;` class index signature with accessibility modifier)
  if (errMsg.includes("Expected ']', got ':'")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const MODS = new Set(['public', 'private', 'protected']);
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && MODS.has(toks[i].text) && toks[i + 1].text === '[') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: ' '.repeat(toks[i].end - toks[i].start) });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `Typescript parameter property must be an identifier or assignment` (`constructor(public { a }: T) {}`)
  if (errMsg.includes('parameter property must be an identifier')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const MODS = new Set(['public', 'private', 'protected', 'readonly']);
    let parenDepth = 0;
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.text === '(') { parenDepth++; continue; }
      if (t.text === ')') { if (parenDepth > 0) parenDepth--; continue; }
      if (parenDepth > 0 && t.type === 'id' && MODS.has(t.text) && (toks[i + 1].text === '{' || toks[i + 1].text === '[')) {
        edits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `Destructuring bindings require initializers` (`var {};`, `let [];`)
  if (errMsg.includes('Destructuring bindings require initializers')) {
    if (source.includes('__tmt_di__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type === 'id' && (t.text === 'var' || t.text === 'let' || t.text === 'const') &&
          (toks[i + 1].text === '{' || toks[i + 1].text === '[')) {
        const close = toks[i + 1].text === '{' ? findMatchingBrace(toks, i + 1) : (() => {
          let d = 0;
          for (let k = i + 1; k < toks.length; k++) {
            if (toks[k].text === '[') d++;
            else if (toks[k].text === ']') { if (--d === 0) return k; }
          }
          return -1;
        })();
        if (close < 0) continue;
        // Skip optional `: Type`
        let endPat = close;
        if (toks[endPat + 1]?.text === ':') {
          let k = endPat + 2, dP = 0, dB = 0, dBr = 0;
          while (k < toks.length) {
            const tk = toks[k];
            if (tk.text === '(') dP++;
            else if (tk.text === ')') dP--;
            else if (tk.text === '[') dB++;
            else if (tk.text === ']') dB--;
            else if (tk.text === '{') dBr++;
            else if (tk.text === '}') { if (dBr === 0) break; dBr--; }
            else if (dP === 0 && dB === 0 && dBr === 0 && (tk.text === ';' || tk.text === ',' || tk.text === '=')) break;
            k++;
          }
          endPat = k - 1;
        }
        const next = toks[endPat + 1];
        if (!next || next.text === ';' || next.text === ',' || hasNewlineBetween(source, toks[endPat].end, next.start)) {
          edits.push({ start: toks[endPat].end, end: toks[endPat].end, text: ' /*__tmt_di__*/ = 0' });
        }
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/ \/\*__tmt_di__\*\/ = 0/g, '');
    } catch { return null; }
  }

  // `An implementation cannot be declared in ambient contexts` (`declare class C { get x() { return 1; } }`, `declare function f() {}`)
  // Replace `{ ... }` method/accessor/function bodies inside `declare` declarations with `;` (TS erases the whole `declare` anyway).
  if (errMsg.includes('An implementation cannot be declared in ambient contexts')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    let i = 0;
    while (i < toks.length) {
      if (toks[i].type === 'id' && toks[i].text === 'declare' && toks[i - 1]?.text !== '.') {
        const kw = toks[i + 1]?.text;
        if (kw === 'class' || kw === 'abstract' || kw === 'namespace' || kw === 'module') {
          let j = i + 2;
          while (j < toks.length && toks[j].text !== '{') j++;
          if (j < toks.length) {
            const close = findMatchingBrace(toks, j);
            if (close > j) {
              // Inside this ambient class/namespace, replace any `(...) [: Type] { ... }` body with `;`
              for (let k = j + 1; k < close; k++) {
                if (toks[k].text === '(') {
                  const cp = findMatchingParen(toks, k);
                  if (cp < 0 || cp >= close) continue;
                  let m = cp + 1;
                  while (m < close && toks[m].text !== '{' && toks[m].text !== ';') m++;
                  if (m < close && toks[m].text === '{') {
                    const cb = findMatchingBrace(toks, m);
                    if (cb > m && cb < close) {
                      edits.push({ start: toks[m].start, end: toks[cb].end, text: ';' + source.slice(toks[m].start + 1, toks[cb].end).replace(/[^\r\n]/g, ' ') });
                      k = cb;
                    }
                  }
                }
              }
              i = close + 1;
              continue;
            }
          }
        } else if (kw === 'function' || kw === 'async') {
          let j = i + 2;
          while (j < toks.length && toks[j].text !== '{' && toks[j].text !== ';') j++;
          if (j < toks.length && toks[j].text === '{') {
            const cb = findMatchingBrace(toks, j);
            if (cb > j) {
              edits.push({ start: toks[j].start, end: toks[cb].end, text: ';' + source.slice(toks[j].start + 1, toks[cb].end).replace(/[^\r\n]/g, ' ') });
              i = cb + 1;
              continue;
            }
          }
        }
      }
      i++;
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `Expected ';', got 'ident'` (accessibility/override modifiers inside `interface ... { ... }`)
  if (errMsg.includes("Expected ';', got 'ident'")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const MODS = new Set(['public', 'private', 'protected', 'override', 'static']);
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'interface' && toks[i - 1]?.text !== '.') {
        let j = i + 1;
        while (j < toks.length && toks[j].text !== '{') j++;
        if (j >= toks.length) continue;
        const close = findMatchingBrace(toks, j);
        if (close < 0) continue;
        for (let k = j + 1; k < close - 1; k++) {
          if (toks[k].type === 'id' && MODS.has(toks[k].text) &&
              (toks[k + 1].type === 'id' || toks[k + 1].text === '[' || toks[k + 1].text === '(') &&
              !hasNewlineBetween(source, toks[k].end, toks[k + 1].start)) {
            edits.push({ start: toks[k].start, end: toks[k].end, text: ' '.repeat(toks[k].end - toks[k].start) });
          }
        }
        i = close;
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `Variable declaration list cannot be empty` (`for (var of x)`, `var;`)
  // Only relax `var` (TypeScript rejects `for (let of x)` / `for (const of x)` as syntax errors).
  if (errMsg.includes('Variable declaration list cannot be empty')) {
    if (source.includes('__tmt_vd__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type === 'id' && t.text === 'var' &&
          (toks[i + 1].text === 'of' || toks[i + 1].text === 'in' || toks[i + 1].text === ';')) {
        edits.push({ start: t.end, end: t.end, text: ' __tmt_vd__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/ __tmt_vd__/g, '');
    } catch { return null; }
  }

  // `'import', and 'export' cannot be used outside of module code` in TS files
  if (errMsg.includes("'import', and 'export' cannot be used outside of module code")) {
    if (source.includes('__tmt_ie_')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const saved = [];
    let braceDepth = 0, parenDepth = 0;
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.type === 'punc') {
        if (tk.text === '{') braceDepth++;
        else if (tk.text === '}') braceDepth = Math.max(0, braceDepth - 1);
        else if (tk.text === '(') parenDepth++;
        else if (tk.text === ')') parenDepth = Math.max(0, parenDepth - 1);
        continue;
      }
      if (tk.type === 'id' && (tk.text === 'import' || tk.text === 'export')) {
        const prev = i > 0 ? toks[i - 1] : null;
        if (prev && prev.text === '.') continue;
        if (tk.text === 'import' && (toks[i + 1]?.text === '(' || toks[i + 1]?.text === '.')) continue;
        const isNested = braceDepth > 0 || (parenDepth === 0 && prev && (prev.text === ')' || prev.text === 'else' || prev.text === 'do' || prev.text === ':'));
        if (!isNested) continue;
        // Reject malformed `for (a; b)` before `export` (missing 2nd `;`)
        if (braceDepth === 0 && prev && prev.text === ')') {
          let p = i - 2, pd2 = 1, semis = 0, hasInOf = false;
          while (p >= 0 && pd2 > 0) {
            if (toks[p].text === ')') pd2++;
            else if (toks[p].text === '(') pd2--;
            else if (pd2 === 1 && toks[p].text === ';') semis++;
            else if (pd2 === 1 && (toks[p].text === 'in' || toks[p].text === 'of')) hasInOf = true;
            p--;
          }
          if (p >= 0 && toks[p].text === 'for' && !hasInOf && semis !== 2) return null;
        }
        let k = i + 1, bd = 0, pd = 0, bkd = 0, endIdx = -1;
        while (k < toks.length) {
          const nt = toks[k];
          if (nt.type === 'punc') {
            if (nt.text === '{') bd++;
            else if (nt.text === '}') {
              if (bd === 0) { endIdx = k - 1; break; }
              bd--;
              if (bd === 0 && pd === 0 && bkd === 0 && toks[k + 1]?.text !== 'from' && toks[k + 1]?.text !== ';') {
                const second = toks[i + 1]?.text;
                if (second === 'function' || second === 'class' || second === 'async' ||
                    (second === 'default' && (toks[i + 2]?.text === 'function' || toks[i + 2]?.text === 'class' || toks[i + 2]?.text === 'async'))) {
                  endIdx = k;
                  break;
                }
              }
            } else if (nt.text === '(') pd++;
            else if (nt.text === ')') pd--;
            else if (nt.text === '[') bkd++;
            else if (nt.text === ']') bkd--;
            else if (nt.text === ';' && bd === 0 && pd === 0 && bkd === 0) { endIdx = k; break; }
          }
          k++;
        }
        if (endIdx < i) return null;
        const stmt = source.slice(tk.start, toks[endIdx].end);
        let strippedStmt;
        try { strippedStmt = stripTypeScriptTypes(stmt); } catch { return null; }
        const ph = `/*__tmt_ie_${saved.length}__*/;`;
        saved.push([ph, strippedStmt]);
        edits.push({ start: tk.start, end: toks[endIdx].end, text: ph });
        i = endIdx;
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    let stripped = tryStrip(work);
    if (stripped !== null) {
      for (const [ph, orig] of saved) stripped = stripped.replace(ph, () => orig);
      return stripped;
    }
  }

  // `Return statement is not allowed here` -> wrap in a function, strip, and unwrap
  if (errMsg.includes('Return statement is not allowed here')) {
    if (source.includes('__tmt_ret__')) return null;
    const prefix = 'function __tmt_ret__() {\n';
    const suffix = '\n}';
    try {
      const stripped = stripTypeScriptTypes(prefix + source + suffix);
      if (stripped.startsWith(prefix) && stripped.endsWith(suffix)) {
        return stripped.slice(prefix.length, stripped.length - suffix.length);
      }
      return null;
    } catch { return null; }
  }

  // `The left-hand side of a 'for...of' statement cannot use a type` (and `for...in`):
  // Strip `: Type` before `of`/`in` inside `for (var/let/const <pat>: <Type> of/in ...)`
  if (errMsg.includes("cannot use a type annotation")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'id' || toks[i].text !== 'for') continue;
      let pIdx = i + 1;
      if (toks[pIdx]?.text === 'await') pIdx++;
      if (toks[pIdx]?.text !== '(') continue;
      const closeP = findMatchingParen(toks, pIdx);
      if (closeP < 0) continue;
      let dP = 0, dB = 0, dBr = 0, colonIdx = -1, ofIdx = -1;
      for (let k = pIdx + 1; k < closeP; k++) {
        const tk = toks[k];
        if (tk.text === '(') dP++;
        else if (tk.text === ')') dP--;
        else if (tk.text === '[') dB++;
        else if (tk.text === ']') dB--;
        else if (tk.text === '{') dBr++;
        else if (tk.text === '}') dBr--;
        else if (dP === 0 && dB === 0 && dBr === 0) {
          if (tk.text === ':' && colonIdx < 0) colonIdx = k;
          else if (tk.type === 'id' && (tk.text === 'of' || tk.text === 'in')) { ofIdx = k; break; }
        }
      }
      if (colonIdx > 0 && ofIdx > colonIdx) {
        edits.push({ start: toks[colonIdx].start, end: toks[ofIdx].start, text: source.slice(toks[colonIdx].start, toks[ofIdx].start).replace(/[^\r\n]/g, ' ') });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `Using declaration requires initializer` (`using x;`, `await using x;`)
  if (errMsg.includes('Using declaration requires initializer')) {
    if (source.includes('__tmt_ui__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'using' && toks[i + 1].type === 'id' &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        let k = i + 1;
        while (k < toks.length) {
          if (toks[k].type === 'id') {
            let endDecl = k;
            if (toks[endDecl + 1]?.text === ':') {
              let m = endDecl + 2, dP = 0, dB = 0, dBr = 0;
              while (m < toks.length) {
                const mt = toks[m];
                if (mt.text === '(') dP++;
                else if (mt.text === ')') dP--;
                else if (mt.text === '[') dB++;
                else if (mt.text === ']') dB--;
                else if (mt.text === '{') dBr++;
                else if (mt.text === '}') { if (dBr === 0) break; dBr--; }
                else if (dP === 0 && dB === 0 && dBr === 0 && (mt.text === ',' || mt.text === ';' || mt.text === '=')) break;
                m++;
              }
              endDecl = m - 1;
            }
            const next = toks[endDecl + 1];
            if (!next || next.text === ';' || next.text === ',' || next.text === '}' || hasNewlineBetween(source, toks[endDecl].end, next.start)) {
              edits.push({ start: toks[endDecl].end, end: toks[endDecl].end, text: ' /*__tmt_ui__*/ = 0' });
            }
            if (next && next.text === ',') { k = endDecl + 2; continue; }
          }
          break;
        }
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/ \/\*__tmt_ui__\*\/ = 0/g, '');
    } catch { return null; }
  }

  // `Using declaration only allows identifiers` / `Using declaration is not allowed in for-in loop` / `Expected ';', got '{'`
  if (errMsg.includes('Using declaration only allows identifiers') ||
      errMsg.includes('Using declaration is not allowed in for-in loop') ||
      errMsg.includes("Expected ';', got '{'")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const offsets = []; // [offset, origText, replText]
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'using' && toks[i - 1]?.text !== '.' &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start) &&
          (toks[i + 1].text === '{' || toks[i + 1].text === '[' || toks[i + 1].type === 'id')) {
        if (toks[i - 1]?.type === 'id' && toks[i - 1].text === 'await' && !hasNewlineBetween(source, toks[i - 1].end, toks[i].start)) {
          edits.push({ start: toks[i - 1].start, end: toks[i - 1].end, text: '     ' });
          offsets.push([toks[i - 1].start, 'await', '     ']);
        }
        edits.push({ start: toks[i].start, end: toks[i].end, text: 'const' });
        offsets.push([toks[i].start, 'using', 'const']);
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      try {
        const stripped = stripTypeScriptTypes(work);
        if (stripped.length === work.length) {
          let out = '', p = 0;
          for (const [off, orig, repl] of offsets) {
            if (stripped.slice(off, off + orig.length) === repl) {
              out += stripped.slice(p, off) + orig;
              p = off + orig.length;
            }
          }
          out += stripped.slice(p);
          return out;
        }
      } catch {}
    }
  }

  // `Constructor can't be an async function` (`async constructor()` -> blank `async`, strip, restore)
  if (errMsg.includes("Constructor can't be an async function")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const offsets = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'async' &&
          toks[i + 1].type === 'id' && toks[i + 1].text === 'constructor' &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '     ' });
        offsets.push(toks[i].start);
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      if (stripped.length !== work.length) return null;
      let out = '', p = 0;
      for (const off of offsets) {
        if (stripped.slice(off, off + 5) === '     ') {
          out += stripped.slice(p, off) + 'async';
          p = off + 5;
        }
      }
      out += stripped.slice(p);
      return out;
    } catch { return null; }
  }

  // `Abstract methods can only appear within an abstract class.` -> insert `abstract ` before `class` (SWC erases it too)
  if (errMsg.includes('Abstract methods can only appear within an abstract class')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'class' && toks[i - 1]?.text !== 'abstract' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].start, text: 'abstract ' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `` `declare` modifier cannot appear on class elements of this kind `` (`declare constructor() {}`, `declare method() {}`)
  if (errMsg.includes('`declare` modifier cannot appear on class elements')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    let braceDepth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.text === '{') { braceDepth++; continue; }
      if (t.text === '}') { if (braceDepth > 0) braceDepth--; continue; }
      if (braceDepth > 0 && t.type === 'id' && t.text === 'declare' && toks[i - 1]?.text !== '.') {
        edits.push({ start: t.start, end: t.end, text: '       ' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `` `import()` requires `` in TS files
  if (errMsg.includes('`import()` requires')) {
    if (source.includes('__tmt_im__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i + 1].text === '(' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_im__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/__tmt_im__/g, 'import');
    } catch { return null; }
  }

  // `Rest element must be final element` / `Trailing comma isn't permitted after a rest` / `A rest parameter cannot have an initializer` / `Unexpected token '...'`
  if (errMsg.includes('Rest element must be final') || errMsg.includes("Trailing comma isn't permitted after a rest") ||
      errMsg.includes('A rest parameter cannot have an initializer') || errMsg.includes('Unexpected token `...`')) {
    if (source.includes('__tmt_re__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'punc' && toks[i].text === '...') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '/*__tmt_re__*/' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    return stripped === null ? null : stripped.replace(/\/\*__tmt_re__\*\//g, '...');
  }

  // `Expected 'from', got 'await'` / `Expected '(', got 'await'` (`import await from ...`, `async function await() {}`)
  // Reject `await =>` (TS syntax error `',' expected`).
  if (errMsg.includes("Expected 'from', got 'await'") || errMsg.includes("Expected '(', got 'await'")) {
    if (source.includes('__tmt_aw__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'await' && toks[i - 1]?.text !== '.') {
        if (toks[i + 1]?.text === '=>') return null;
        edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_aw__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/__tmt_aw__/g, 'await');
    } catch { return null; }
  }

  // `Unexpected token '#'. Expected identifier` (`{ #x: 1, #m() {} }` private names in object literals)
  if (errMsg.includes("Unexpected token `#`. Expected identifier")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const offsets = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'punc' && toks[i].text === '#' && toks[i + 1].type === 'id' && toks[i].end === toks[i + 1].start) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '_' });
        offsets.push(toks[i].start);
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      if (stripped.length !== work.length) return null;
      let out = '', p = 0;
      for (const off of offsets) {
        if (stripped[off] === '_') {
          out += stripped.slice(p, off) + '#';
          p = off + 1;
        }
      }
      out += stripped.slice(p);
      return out;
    } catch { return null; }
  }

  // `Illegal 'use strict' directive in function with non-simple parameter`
  if (errMsg.includes("Illegal 'use strict' directive")) {
    const offsets = [];
    let work = source.replace(/(["'])use strict\1/g, (m, q, off) => {
      offsets.push(off + 1);
      return q + 'use_strict' + q;
    });
    if (offsets.length === 0) return null;
    try {
      const stripped = stripTypeScriptTypes(work);
      if (stripped.length !== work.length) return null;
      let out = '', p = 0;
      for (const off of offsets) {
        if (stripped.slice(off, off + 10) === 'use_strict') {
          out += stripped.slice(p, off) + 'use strict';
          p = off + 10;
        }
      }
      out += stripped.slice(p);
      return out;
    } catch { return null; }
  }

  // `A 'get' accessor cannot have parameters` / `A 'set' accessor must have exactly one parameter` (2+ params)
  if (errMsg.includes('`get` accessor cannot have parameters') || errMsg.includes('`set` accessor must have exactly one parameter')) {
    const kw = errMsg.includes('`get`') ? 'get' : 'set';
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const offsets = [];
    for (let i = 0; i < toks.length - 2; i++) {
      if (toks[i].type === 'id' && toks[i].text === kw && toks[i - 1]?.text !== '.' &&
          (toks[i + 1].type === 'id' || toks[i + 1].text === '[' || toks[i + 1].type === 'str' || toks[i + 1].type === 'num') &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '   ' });
        offsets.push(toks[i].start);
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      if (stripped.length !== work.length) return null;
      let out = '', p = 0;
      for (const off of offsets) {
        if (stripped.slice(off, off + 3) === '   ') {
          out += stripped.slice(p, off) + kw;
          p = off + 3;
        }
      }
      out += stripped.slice(p);
      return out;
    } catch { return null; }
  }

  // `Abstract method cannot have an implementation.` / `Abstract property cannot have an initializer.`
  if (errMsg.includes('Abstract method cannot have an implementation') || errMsg.includes('Abstract property cannot have an initializer')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    let braceDepth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.text === '{') { braceDepth++; continue; }
      if (t.text === '}') { if (braceDepth > 0) braceDepth--; continue; }
      if (braceDepth > 0 && t.type === 'id' && t.text === 'abstract' && toks[i - 1]?.text !== '.') {
        edits.push({ start: t.start, end: t.end, text: '        ' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `A rest parameter cannot be optional` (`...a?: T` -> hide `...`, strip, restore `...`)
  if (errMsg.includes('A rest parameter cannot be optional')) {
    if (source.includes('__tmt_re__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'punc' && toks[i].text === '...') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '/*__tmt_re__*/' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    return stripped === null ? null : stripped.replace(/\/\*__tmt_re__\*\//g, '...');
  }

  // `Cannot assign to this` -> replace `this` with `__tmt_th__`, strip, restore
  if (errMsg.includes('Cannot assign to this')) {
    if (source.includes('__tmt_th__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'this' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_th__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/__tmt_th__/g, 'this');
    } catch { return null; }
  }

  // `'yield' cannot be used as a parameter within generator`
  if (errMsg.includes("'yield' cannot be used as a parameter")) {
    if (source.includes('__tmt_yd__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'yield' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_yd__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/__tmt_yd__/g, 'yield');
    } catch { return null; }
  }

  // `'new.target' is only allowed in the body of a function`
  if (errMsg.includes("'new.target' is only allowed")) {
    if (source.includes('__tmt_nt__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length - 2; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'new' && toks[i + 1].text === '.' && toks[i + 2].text === 'target') {
        edits.push({ start: toks[i].start, end: toks[i + 2].end, text: '__tmt_nt__' });
        i += 2;
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/__tmt_nt__/g, 'new.target');
    } catch { return null; }
  }

  // `` `<kw>` cannot be used as an identifier in strict mode `` (`static`, `public`, `private`, `protected`, `package`, `interface`, `implements`, `yield`, `let`)
  {
    const m = /`([a-z]+)` cannot be used as an identifier in strict mode/.exec(errMsg);
    if (m && ['static', 'public', 'private', 'protected', 'package', 'interface', 'implements', 'yield', 'let'].includes(m[1])) {
      const kw = m[1];
      const ph = '__tmt_kw__';
      if (!source.includes(ph)) {
        const toks = tokenize(source);
        if (toks) {
          const edits = [];
          for (let i = 0; i < toks.length; i++) {
            if (toks[i].type !== 'id' || toks[i].text !== kw) continue;
            const prev = i > 0 ? toks[i - 1] : null;
            if (prev && prev.text === '.') continue;
            const next = toks[i + 1];
            const isIdentUse = (prev && ['var', 'let', 'const', 'function', 'class', '(', ',', '[', '{', ':', '=', '...'].includes(prev.text)) ||
              (next && [')', ',', ';', '=', ']', '}', ':'].includes(next.text));
            if (isIdentUse) edits.push({ start: toks[i].start, end: toks[i].end, text: ph });
          }
          if (edits.length > 0) {
            let work = '', pos = 0;
            for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
            work += source.slice(pos);
            try {
              const stripped = stripTypeScriptTypes(work);
              return stripped.replace(new RegExp(ph, 'g'), kw);
            } catch {}
          }
        }
      }
    }
  }

  // `` `async` modifier cannot be used here `` -> blank `async` (5 spaces, restore) or TS-only accessibility modifier (`public`/`private`/`protected`) in object literal
  if (errMsg.includes('`async` modifier cannot be used here')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    const offsets = [];
    const ACC = new Set(['public', 'private', 'protected']);
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'async' && toks[i - 1]?.text !== '.' &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '     ' });
        offsets.push(toks[i].start);
      } else if (toks[i].type === 'id' && ACC.has(toks[i].text) && toks[i - 1]?.text !== '.' &&
          (toks[i + 1].text === 'get' || toks[i + 1].text === 'set') &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: ' '.repeat(toks[i].end - toks[i].start) });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      if (stripped.length !== work.length) return null;
      let out = '', p = 0;
      for (const off of offsets) {
        if (stripped.slice(off, off + 5) === '     ') {
          out += stripped.slice(p, off) + 'async';
          p = off + 5;
        }
      }
      out += stripped.slice(p);
      return out;
    } catch { return null; }
  }

  // `A required element cannot follow an optional element.` (tuple type `[number?, string]`)
  if (errMsg.includes('A required element cannot follow an optional element')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    let brkDepth = 0;
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].text === '[') { brkDepth++; continue; }
      if (toks[i].text === ']') { if (brkDepth > 0) brkDepth--; continue; }
      if (brkDepth > 0 && toks[i].text === '?' && (toks[i + 1].text === ',' || toks[i + 1].text === ']')) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: ' ' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `Label target is already declared` -> rename duplicate `L:` -> `__tmt_lb_N__:`, strip, restore
  if (errMsg.includes('Label target is already declared')) {
    if (source.includes('__tmt_lb_')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const seen = new Set();
    const edits = [];
    const saved = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i + 1].text === ':') {
        const prev = i > 0 ? toks[i - 1] : null;
        if (!prev || prev.text === ';' || prev.text === '{' || prev.text === '}' || prev.text === ')' || prev.text === ':' || hasNewlineBetween(source, prev.end, toks[i].start)) {
          const name = toks[i].text;
          if (seen.has(name)) {
            const ph = `__tmt_lb_${saved.length}__`;
            saved.push([ph, name]);
            edits.push({ start: toks[i].start, end: toks[i].end, text: ph });
          } else {
            seen.add(name);
          }
        }
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    let stripped = tryStrip(work);
    if (stripped !== null) {
      for (const [ph, orig] of saved) stripped = stripped.replace(ph, () => orig);
      return stripped;
    }
  }

  // `Trailing comma is not allowed` (empty `var;` / `let;` / `const;`) & `Unexpected token '<eof>'. Expected yield, an identifier`
  if (errMsg.includes('Trailing comma is not allowed') || errMsg.includes('Unexpected token `<eof>`. Expected yield, an identifier')) {
    if (source.includes('__tmt_vd__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'id' && (t.text === 'var' || t.text === 'let' || t.text === 'const')) {
        const next = toks[i + 1];
        if (!next || next.text === ';') {
          edits.push({ start: t.end, end: t.end, text: ' __tmt_vd__' });
        }
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped.replace(/ __tmt_vd__/g, '');
    }
  }

  // Heritage clause errors (`'implements' clause already seen`, `'extends' clause must precede 'implements'`,
  // `Expected '{', got 'implements'`, `An interface can only extend...`, `extends clause already seen` on interface):
  // TS erases all `implements ...` clauses on classes and all `interface` declarations.
  if (errMsg.includes('`implements` clause already seen') ||
      errMsg.includes("'extends' clause must precede 'implements'") ||
      errMsg.includes("Expected '{', got 'implements'") ||
      errMsg.includes('An interface can only extend') ||
      errMsg.includes('`extends` clause already seen')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'implements' && toks[i - 1]?.text !== '.') {
        let j = i + 1, dA = 0, dP = 0, dB = 0;
        while (j < toks.length) {
          const tj = toks[j];
          if (tj.text === '<') dA++;
          else if (tj.text === '>') { if (dA > 0) dA--; }
          else if (tj.text === '(') dP++;
          else if (tj.text === ')') dP--;
          else if (tj.text === '[') dB++;
          else if (tj.text === ']') dB--;
          else if (dA === 0 && dP === 0 && dB === 0 && (tj.text === '{' || tj.text === 'extends' || tj.text === 'implements')) break;
          j++;
        }
        if (j > i + 1 && j < toks.length) {
          edits.push({ start: toks[i].start, end: toks[j - 1].end, text: source.slice(toks[i].start, toks[j - 1].end).replace(/[^\r\n]/g, ' ') });
          i = j - 1;
        }
      } else if (toks[i].type === 'id' && toks[i].text === 'interface' && toks[i - 1]?.text !== '.' &&
          (errMsg.includes('An interface can only extend') || errMsg.includes('`extends` clause already seen'))) {
        let j = i + 1;
        while (j < toks.length && toks[j].text !== 'extends' && toks[j].text !== '{') j++;
        if (j < toks.length && toks[j].text === 'extends') {
          let k = j + 1;
          while (k < toks.length && toks[k].text !== '{') k++;
          if (k < toks.length) {
            edits.push({ start: toks[j].start, end: toks[k - 1].end, text: source.slice(toks[j].start, toks[k - 1].end).replace(/[^\r\n]/g, ' ') });
            i = k;
          }
        }
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return tryStrip(work);
  }

  // `Unexpected token 'get'. Expected * for generator...` (`get public foo() {}` / `public get get() {}`)
  if (errMsg.includes('Unexpected token `get`. Expected * for generator') ||
      errMsg.includes('Unexpected token `set`. Expected * for generator')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const MODS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'static', 'override']);
    const edits = [];
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type === 'id' && MODS.has(t.text) && (toks[i - 1].text === 'get' || toks[i - 1].text === 'set') &&
          !hasNewlineBetween(source, toks[i - 1].end, t.start)) {
        edits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
      } else if (t.type === 'id' && (t.text === 'get' || t.text === 'set') &&
          (toks[i - 1].text === 'get' || toks[i - 1].text === 'set') &&
          !hasNewlineBetween(source, toks[i - 1].end, t.start)) {
        edits.push({ start: toks[i - 1].start, end: toks[i - 1].end, text: '   ' });
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Expected '{', got 'export'` (`export` inside `interface` or misplaced `export` after `interface Name`)
  if (errMsg.includes("Expected '{', got 'export'")) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 1; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'export' &&
          (toks[i - 1].text === 'interface' || toks[i - 1].text === 'class' || toks[i - 2]?.text === 'interface')) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '      ' });
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Rest element must be final element` (`var { ...mustBeLast, a } = o;`)
  if (errMsg.includes('Rest element must be final') && !source.includes('__tmt_rst_')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const saved = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].text === '...' && toks[i + 1]?.type === 'id') {
          let k = i + 2;
          while (k < toks.length && toks[k].text === '.' && toks[k + 1]?.type === 'id') k += 2;
          if (toks[k]?.text === ',' && toks[k + 1] && toks[k + 1].text !== '}' && toks[k + 1].text !== ']') {
            const ph = `__tmt_rst_${saved.length}__`;
            saved.push(ph);
            edits.push({ start: toks[i].start, end: toks[i].end, text: `${ph}: ` });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        let stripped = tryStrip(work);
        if (stripped !== null) {
          for (const ph of saved) stripped = stripped.replace(`${ph}: `, '...');
          return stripped;
        }
      }
    }
  }

  // `A method cannot be readonly` / incompatible modifiers on `#private` members (`public #foo`, `readonly #qux`, `declare #what`)
  if (errMsg.includes('A method cannot be readonly') ||
      (source.includes('#') && (errMsg.includes('modifier cannot be used') || errMsg.includes('Expected ident') || errMsg.includes('Unexpected token') || errMsg.includes("Expected ';', '}' or <eof>") || errMsg.includes("Expected '(', got '#'")))) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const PRIV_MODS = new Set(['public', 'private', 'protected', 'readonly']);
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i];
        if (t.type === 'id' && PRIV_MODS.has(t.text) && (toks[i + 1]?.text === '#' || ((toks[i + 1]?.text === 'get' || toks[i + 1]?.text === 'set') && toks[i + 2]?.text === '#'))) {
          edits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
        } else if (t.type === 'id' && t.text === 'readonly' &&
            (toks[i + 1]?.type === 'id' || toks[i + 1]?.text === '#') &&
            (toks[i + 2]?.text === '(' || (toks[i + 1]?.text === '#' && toks[i + 3]?.text === '('))) {
          edits.push({ start: t.start, end: t.end, text: '        ' });
        } else if (t.type === 'id' && t.text === 'declare' && (toks[i + 1]?.text === 'get' || toks[i + 1]?.text === 'set') && toks[i + 2]?.text === '#') {
          edits.push({ start: t.start, end: t.end, text: '       ' });
          let k = i + 3;
          while (k < toks.length && toks[k].text !== '(') k++;
          if (k < toks.length) {
            const cp = findMatchingParen(toks, k);
            if (cp > k) {
              let r = cp + 1;
              while (r < toks.length && toks[r].text !== '{' && toks[r].text !== ';') r++;
              if (toks[r]?.text === ';') {
                edits.push({ start: toks[r].start, end: toks[r].end, text: '{}' });
                i = r;
              }
            }
          }
        } else if (t.type === 'id' && t.text === 'declare' && toks[i + 1]?.text === '#') {
          const DECL_LEAD_MODS = new Set(['static', 'public', 'private', 'protected', 'readonly', 'abstract', 'override', 'accessor', 'async']);
          let startIdx = i;
          while (startIdx > 0 && toks[startIdx - 1].type === 'id' && DECL_LEAD_MODS.has(toks[startIdx - 1].text) &&
              !hasNewlineBetween(source, toks[startIdx - 1].end, toks[startIdx].start)) {
            startIdx--;
          }
          const memberStart = toks[startIdx].start;
          let k = i + 2;
          let dP = 0, dB = 0, dBr = 0, dA = 0;
          while (k < toks.length && !(dP === 0 && dB === 0 && dBr === 0 && dA === 0 && (toks[k].text === ';' || toks[k].text === '}'))) {
            if (dP === 0 && dB === 0 && dBr === 0 && dA === 0 && k > i + 2 &&
                hasNewlineBetween(source, toks[k - 1].end, toks[k].start) &&
                ![':', '|', '&', '=', ',', '<', '(', '[', '{', '=>', '?'].includes(toks[k - 1].text) &&
                !['|', '&', '?', ':', '=>', 'extends'].includes(toks[k].text)) {
              const endOff = toks[k - 1].end;
              edits.push({ start: memberStart, end: endOff, text: source.slice(memberStart, endOff).replace(/[^\r\n]/g, ' ') });
              i = k - 1;
              k = -1;
              break;
            }
            if (toks[k].text === '(') dP++;
            else if (toks[k].text === ')') { if (dP > 0) dP--; }
            else if (toks[k].text === '[') dB++;
            else if (toks[k].text === ']') { if (dB > 0) dB--; }
            else if (toks[k].text === '{') dBr++;
            else if (toks[k].text === '}') { if (dBr > 0) dBr--; }
            else if (toks[k].text === '<') dA++;
            else if (toks[k].text === '>') { if (dA > 0) dA--; }
            k++;
          }
          if (k >= 0 && k < toks.length) {
            const endOff = toks[k].text === ';' ? toks[k].end : toks[k - 1].end;
            edits.push({ start: memberStart, end: endOff, text: source.slice(memberStart, endOff).replace(/[^\r\n]/g, ' ') });
            i = k;
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // Object literal `?` on method (`{ foo?() {} }`) and `!` on shorthand (`{ a! }`)
  if (errMsg.includes('Unexpected token `(`. Expected') || errMsg.includes("Expected ',', got '!'")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        const prev = toks[i - 1], cur = toks[i], next = toks[i + 1];
        if (cur.text === '?' && prev.type === 'id' && next.text === '(' &&
            (toks[i - 2]?.text === '{' || toks[i - 2]?.text === ',')) {
          edits.push({ start: cur.start, end: cur.end, text: ' ' });
        } else if (cur.text === '!' && prev.type === 'id' && (next.text === '}' || next.text === ',') &&
            (toks[i - 2]?.text === '{' || toks[i - 2]?.text === ',')) {
          edits.push({ start: cur.start, end: cur.end, text: ' ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `'override' modifier cannot appear on a constructor declaration` (`override constructor() {}`)
  if (errMsg.includes("'override' modifier cannot appear on a constructor")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'override' && toks[i + 1]?.text === 'constructor' &&
            toks[i + 2]?.text === '(' && !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '        ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `'public' modifier cannot appear on a type parameter` / `'in' modifier can only appear...` / duplicate or reversed `in`/`out` variance modifiers
  if (errMsg.includes('modifier cannot appear on a type parameter') ||
      errMsg.includes('modifier can only appear on a type parameter') ||
      errMsg.includes('modifier already seen') ||
      errMsg.includes('must precede')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const TP_MODS = new Set(['public', 'private', 'protected', 'readonly', 'static', 'abstract', 'in', 'out']);
      // Track class body brace depths so `in a = 0` / `out b = 0` is ONLY stripped inside a `class { ... }` body
      const classBodyDepths = new Set();
      let braceDepth = 0, pendingClassBrace = false;
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'class' && toks[i - 1]?.text !== '.' && toks[i + 1]?.text !== ':') {
          pendingClassBrace = true;
          continue;
        }
        if (toks[i].text === '{') {
          braceDepth++;
          if (pendingClassBrace) { classBodyDepths.add(braceDepth); pendingClassBrace = false; }
          continue;
        }
        if (toks[i].text === '}') {
          classBodyDepths.delete(braceDepth);
          if (braceDepth > 0) braceDepth--;
          continue;
        }
        if (i === 0) continue;
        if (toks[i].type === 'id' && TP_MODS.has(toks[i].text) &&
            (toks[i - 1].text === '<' || toks[i - 1].text === ',' || toks[i - 1].text === 'const')) {
          let k = i;
          while (k < toks.length && toks[k].type === 'id' && TP_MODS.has(toks[k].text)) k++;
          if (k < toks.length && toks[k].type === 'id' &&
              (toks[k + 1]?.text === '>' || toks[k + 1]?.text === ',' || toks[k + 1]?.text === '=' || toks[k + 1]?.text === 'extends')) {
            edits.push({ start: toks[i].start, end: toks[k].start, text: source.slice(toks[i].start, toks[k].start).replace(/[^\r\n]/g, ' ') });
            i = k;
          }
        } else if (classBodyDepths.has(braceDepth) && toks[i].type === 'id' && (toks[i].text === 'in' || toks[i].text === 'out') &&
            (toks[i - 1].text === '{' || toks[i - 1].text === ';') &&
            toks[i + 1]?.type === 'id' && !hasNewlineBetween(source, toks[i].end, toks[i + 1].start) &&
            (toks[i + 2]?.text === '=' || toks[i + 2]?.text === ':' || toks[i + 2]?.text === ';' || toks[i + 2]?.text === '?' || toks[i + 2]?.text === '!')) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: ' '.repeat(toks[i].end - toks[i].start) });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected ';', got '['` (`type OH_NO = { get [K in WAT](): string };`)
  if (errMsg.includes("Expected ';', got '['")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 4; i++) {
        if (toks[i].type === 'id' && (toks[i].text === 'get' || toks[i].text === 'set') &&
            toks[i + 1]?.text === '[' && toks[i + 2]?.type === 'id' && toks[i + 3]?.text === 'in') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '   ' });
          let k = i + 4;
          while (k < toks.length && toks[k].text !== ']') k++;
          if (toks[k]?.text === ']' && toks[k + 1]?.text === '(' && toks[k + 2]?.text === ')' && toks[k + 3]?.text === ':') {
            edits.push({ start: toks[k + 1].start, end: toks[k + 2].end, text: '  ' });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Unexpected line break between arrow head and arrow` (`() \n => {}`)
  if (errMsg.includes('Unexpected line break between arrow head and arrow')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length; i++) {
        if (toks[i].text === '=>' && hasNewlineBetween(source, toks[i - 1].end, toks[i].start)) {
          edits.push({ start: toks[i - 1].end, end: toks[i].start, text: ' ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `asiPublicPrivateProtected`: ASI turns `public\nclass` into `public;\nclass` and `public\nprivate f()` into `public;\nprivate f()`
  if (errMsg.includes('Unexpected token `ident`. Expected * for generator') && /\b(?:public|private|protected)\b/.test(source)) {
    const toks = tokenize(source);
    if (toks) {
      const ACC = new Set(['public', 'private', 'protected']);
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i], next = toks[i + 1];
        if (t.type === 'id' && ACC.has(t.text) && toks[i - 1]?.text !== '.' &&
            next.type === 'id' && (next.text === 'class' || ACC.has(next.text)) &&
            hasNewlineBetween(source, t.end, next.start)) {
          edits.push({ start: t.end, end: t.end, text: ';' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `override` in disallowed modifier combinations (`override declare`, `readonly override`, `override public`, `override override`)
  if (errMsg.includes('Unexpected token `ident`. Expected * for generator') && source.includes('override')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        const t = toks[i];
        const prev = i > 0 ? toks[i - 1] : null;
        const next = toks[i + 1];
        if (t.type === 'id' && t.text === 'override' && prev?.text !== '.' &&
            next && (next.type === 'id' || next.text === '[' || next.text === '#' || next.text === '*') &&
            !hasNewlineBetween(source, t.end, next.start)) {
          edits.push({ start: t.start, end: t.end, text: '        ' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // JSDoc nullable/non-nullable type syntax (`?T`, `!T`, `T?`, `T!`, `Array.<T>`, `function(...)`) that TS erases in type positions
  if ((errMsg.includes("Expected '{', got '!'") ||
       errMsg.includes("Expected '=', got '!'") ||
       errMsg.includes('Unexpected token `!`') ||
       errMsg.includes('Unexpected token `?`') ||
       errMsg.includes('Unexpected token `function`') ||
       errMsg.includes("Expected '>', got 'ident'") ||
       errMsg.includes("Expected ',', got '.'") ||
       errMsg.includes("Expected ';', '}' or <eof>") ||
       errMsg.includes("Expected ')', got '('")) &&
      (source.includes('?') || source.includes('!') || source.includes('.<') || source.includes('function('))) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      const DECL_MOD = new Set(['var', 'let', 'const', 'public', 'private', 'protected', 'readonly', 'static', 'override', 'abstract', 'declare', 'accessor']);
      for (let i = 1; i < toks.length - 1; i++) {
        const prev = toks[i - 1], cur = toks[i], next = toks[i + 1];
        if (cur.type === 'id' && cur.text === 'function' && prev.text === ':' && next.text === '(') {
          const cp = findMatchingParen(toks, i + 1);
          if (cp > i + 1) {
            let endIdx = cp;
            // Also consume optional JSDoc return type `: RetType` after `function(...)` (stop at `{`, `;`, `,`, `=`, `)`, or newline)
            if (toks[cp + 1]?.text === ':') {
              let r = cp + 2, dP = 0, dB = 0, dBr = 0, dA = 0;
              while (r < toks.length) {
                const rt = toks[r].text;
                if (dP === 0 && dB === 0 && dBr === 0 && dA === 0 && r > cp + 2 && hasNewlineBetween(source, toks[r - 1].end, toks[r].start)) break;
                if (rt === '(') dP++; else if (rt === ')') { if (dP === 0) break; dP--; }
                else if (rt === '[') dB++; else if (rt === ']') { if (dB === 0) break; dB--; }
                else if (rt === '{') { if (dP === 0 && dB === 0 && dBr === 0 && dA === 0) break; dBr++; }
                else if (rt === '}') { if (dBr === 0) break; dBr--; }
                else if (rt === '<') dA++; else if (rt === '>') { if (dA === 0) break; dA--; }
                else if (dP === 0 && dB === 0 && dBr === 0 && dA === 0 && (rt === ',' || rt === ';' || rt === '=')) break;
                r++;
              }
              if (r > cp + 2) {
                const retSrc = source.slice(toks[cp + 2].start, toks[r - 1].end);
                try {
                  stripTypeScriptTypes(`type __tmt_ret__ = ${retSrc};`);
                  endIdx = r - 1;
                } catch {
                  continue;
                }
              }
            }
            edits.push({ start: cur.start, end: toks[endIdx].end, text: 'any' + ' '.repeat(Math.max(0, toks[endIdx].end - cur.start - 3)) });
            i = endIdx;
            continue;
          }
        }
        if ((cur.text === '!' || cur.text === '?') &&
            (prev.text === ':' || prev.text === 'is' || prev.text === 'as' || prev.text === '<' || (cur.text === '?' && prev.text === '|')) &&
            next.type === 'id') {
          if (prev.text === ':') {
            const p2 = toks[i - 2], p3 = toks[i - 3];
            let isRetType = false;
            if (p2?.text === ')' && (toks[i + 2]?.text === '{' || toks[i + 2]?.text === '=>' || toks[i + 2]?.text === ';')) {
              let dP = 0, op = -1;
              for (let b = i - 2; b >= 0; b--) {
                if (toks[b].text === ')') dP++;
                else if (toks[b].text === '(') { if (--dP === 0) { op = b; break; } }
              }
              if (op >= 0 && toks[op - 1]?.text !== '?') isRetType = true;
            }
            const isFnParam = p2?.type === 'id' && p3?.text === '(' &&
              (toks[i - 4]?.text === 'function' || (toks[i - 4]?.type === 'id' && toks[i - 5]?.text === 'function'));
            const isParamOrDecl = p2?.type === 'id' && p3 && (DECL_MOD.has(p3.text) || isFnParam || (cur.text === '?' && (p3.text === '(' || p3.text === ',')));
            const isTypePos = isRetType || p2?.text === '?' || isParamOrDecl;
            if (!isTypePos) continue;
          }
          edits.push({ start: cur.start, end: cur.end, text: ' ' });
        } else if ((cur.text === '!' || cur.text === '?') && prev.type === 'id' &&
            (next.text === ')' || next.text === ',' || next.text === ';' || next.text === '{' || next.text === '>' || next.text === '|' || next.text === '=') &&
            (toks[i - 2]?.text === ':' || toks[i - 2]?.text === 'is' || toks[i - 2]?.text === 'as' || toks[i - 2]?.text === '<')) {
          edits.push({ start: cur.start, end: cur.end, text: ' ' });
        } else if (cur.text === '.' && prev.type === 'id' && next.text === '<' &&
            (toks[i - 2]?.text === ':' || toks[i - 2]?.text === 'is' || toks[i - 2]?.text === 'as' || toks[i - 2]?.text === '<' || toks[i - 2]?.text === '|')) {
          edits.push({ start: cur.start, end: cur.end, text: ' ' });
        } else if (cur.text === '*' && prev.text === ':' &&
            (next.text === ';' || next.text === ',' || next.text === ')' || next.text === '}' || next.text === '|' || next.text === '=')) {
          edits.push({ start: cur.start, end: cur.end, text: 'any' });
        } else if (cur.text === '?' && prev.text === ':' && next.text === '=') {
          const p2 = toks[i - 2], p3 = toks[i - 3];
          if (p2?.type === 'id' && p3?.type === 'id' && DECL_MOD.has(p3.text)) {
            edits.push({ start: cur.start, end: cur.end, text: 'any' });
          }
        } else if (cur.text === '*' && prev.text === '<' && (next.text === '>' || next.text === ',')) {
          edits.push({ start: cur.start, end: cur.end, text: 'any' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `for (using of = null;;)` / `for (using of: T = null;;)` / `for (using of;;)`
  if (errMsg.includes('Expression expected') && /\bfor\s*\(\s*using\s+of\b/.test(source) && !source.includes('__tmt_uof__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 4; i++) {
        if (toks[i].text === 'for' && toks[i + 1]?.text === '(' &&
            toks[i + 2]?.text === 'using' && toks[i + 3]?.text === 'of' &&
            (toks[i + 4]?.text === '=' || toks[i + 4]?.text === ':' || toks[i + 4]?.text === ';')) {
          edits.push({ start: toks[i + 2].start, end: toks[i + 2].end, text: 'var  ' });
          edits.push({ start: toks[i + 3].start, end: toks[i + 3].end, text: '__tmt_uof__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/var  \s*__tmt_uof__/g, 'using of');
      }
    }
  }

  // `An implementation cannot be declared in ambient contexts` (`export declare class C { m() {} }`)
  if (errMsg.includes('An implementation cannot be declared in ambient contexts')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'declare' &&
            (toks[i + 1]?.text === 'class' || (toks[i + 1]?.text === 'abstract' && toks[i + 2]?.text === 'class'))) {
          let k = i + 2;
          while (k < toks.length && toks[k].text !== '{') k++;
          if (k >= toks.length) continue;
          const closeClass = findMatchingBrace(toks, k);
          if (closeClass < 0) continue;
          let d = 0;
          for (let j = k + 1; j < closeClass; j++) {
            if (toks[j].text === '{') {
              if (d === 0 && (toks[j - 1]?.text === ')' || toks[j - 1]?.type === 'id')) {
                const cb = findMatchingBrace(toks, j);
                if (cb > j && cb < closeClass) {
                  edits.push({ start: toks[j].start, end: toks[cb].end, text: ';' + ' '.repeat(Math.max(0, toks[cb].end - toks[j].start - 1)) });
                  j = cb;
                  continue;
                }
              }
              d++;
            } else if (toks[j].text === '}') {
              if (d > 0) d--;
            }
          }
          i = closeClass;
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `The left-hand side of an assignment expression`: `++eval`/`arguments--` and parenthesized LHS `(1, x) = 0;`
  if (errMsg.includes('The left-hand side of an assignment expression')) {
    if ((source.includes('eval') || source.includes('arguments')) && !source.includes('__tmt_ea_')) {
      const toks = tokenize(source);
      if (toks) {
        const eaEdits = [];
        const eaSaved = [];
        for (let i = 0; i < toks.length; i++) {
          const t = toks[i];
          if (t.type !== 'id' || (t.text !== 'eval' && t.text !== 'arguments') || toks[i - 1]?.text === '.') continue;
          const prevInc = i >= 2 && (toks[i - 1].text === '+' || toks[i - 1].text === '-') && toks[i - 2].text === toks[i - 1].text && toks[i - 2].end === toks[i - 1].start;
          const nextInc = i + 2 < toks.length && (toks[i + 1].text === '+' || toks[i + 1].text === '-') && toks[i + 2].text === toks[i + 1].text && toks[i + 1].end === toks[i + 2].start;
          if (prevInc || nextInc) {
            const ph = `__tmt_ea_${eaSaved.length}__`;
            eaSaved.push([ph, t.text]);
            eaEdits.push({ start: t.start, end: t.end, text: ph });
          }
        }
        if (eaEdits.length > 0) {
          let work = '', pos = 0;
          for (const e of eaEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          // Validate directly with stripTypeScriptTypes (no recursive LHS relaxation that could hide e.g. `x as any = 1;`)
          try {
            let stripped = stripTypeScriptTypes(work);
            for (const [ph, orig] of eaSaved) stripped = stripped.replace(ph, orig);
            return stripped;
          } catch {}
        }
      }
    }
    if (!source.includes('__tmt_plhs_')) {
      const toks = tokenize(source);
      if (toks) {
        const pEdits = [];
        const pSaved = [];
        for (let i = 0; i < toks.length - 3; i++) {
          if (toks[i].text === '(' && (i === 0 || toks[i - 1].text === ';' || toks[i - 1].text === '{' || toks[i - 1].text === '}' || toks[i - 1].text === ',' || hasNewlineBetween(source, toks[i - 1].end, toks[i].start))) {
            const cp = findMatchingParen(toks, i);
            if (cp > i + 1 && toks[cp + 1]?.text === '=' && toks[cp + 2]?.text !== '=') {
              const inner = source.slice(toks[i].start, toks[cp].end);
              let strippedInner;
              try {
                const s = stripTypeScriptTypes(`(${inner});`);
                strippedInner = s.slice(1, s.lastIndexOf(')'));
              } catch { continue; }
              const ph = `__tmt_plhs_${pSaved.length}__`;
              pSaved.push([ph, strippedInner]);
              pEdits.push({ start: toks[i].start, end: toks[cp].end, text: ph });
              i = cp;
            }
          }
        }
        if (pEdits.length > 0) {
          let work = '', pos = 0;
          for (const e of pEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          let stripped = tryStrip(work);
          if (stripped !== null) {
            for (const [ph, orig] of pSaved) stripped = stripped.replace(ph, () => orig);
            return stripped;
          }
        }
      }
    }
  }

  // Labeled type/interface declarations (`label: interface I {}`, `label: type T = {}`) -> `label: ;`
  if (errMsg.includes("Expected ';', '}' or <eof>") && /\b(?:interface|type)\b/.test(source)) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 2; i < toks.length - 1; i++) {
        if (toks[i - 2].type === 'id' && toks[i - 1].text === ':' &&
            toks[i].type === 'id' && (toks[i].text === 'interface' || toks[i].text === 'type') &&
            toks[i + 1].type === 'id') {
          if (toks[i].text === 'interface') {
            let k = i + 2;
            while (k < toks.length && toks[k].text !== '{') k++;
            if (k < toks.length) {
              const cb = findMatchingBrace(toks, k);
              if (cb > k) {
                edits.push({ start: toks[i].start, end: toks[cb].end, text: ';' });
                i = cb;
              }
            }
          } else {
            let k = i + 2;
            while (k < toks.length && toks[k].text !== '=' && toks[k].text !== ';') k++;
            if (toks[k]?.text === '=') {
              k++;
              let dBr = 0, dP = 0, dB = 0;
              while (k < toks.length) {
                const tk = toks[k].text;
                if (tk === '{') dBr++; else if (tk === '}') { if (dBr === 0) break; dBr--; }
                else if (tk === '(') dP++; else if (tk === ')') dP--;
                else if (tk === '[') dB++; else if (tk === ']') dB--;
                else if (dBr === 0 && dP === 0 && dB === 0 && tk === ';') { k++; break; }
                else if (dBr === 0 && dP === 0 && dB === 0 && k > i + 3 && hasNewlineBetween(source, toks[k - 1].end, toks[k].start)) break;
                k++;
              }
              edits.push({ start: toks[i].start, end: toks[k - 1].end, text: ';' });
              i = k - 1;
            }
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // Named tuple member errors inside `type Name = [ ... ];` (`[element: string?]`, `[first: string, rest: ...string[]]`, `[first: string, ...rest?: string[]]`)
  if ((errMsg.includes("Expected '{', got 'ident'") || errMsg.includes("Expected ',', got ':'") || errMsg.includes('Expected type')) &&
      /\btype[ \t]+[A-Za-z_$][\w$]*[ \t]*=[ \t]*\[/.test(source)) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'type' && toks[i + 1].type === 'id' &&
            toks[i + 2].text === '=' && toks[i + 3].text === '[') {
          let k = i + 4, dB = 1;
          while (k < toks.length && dB > 0) {
            if (toks[k].text === '[') dB++;
            else if (toks[k].text === ']') dB--;
            k++;
          }
          if (dB === 0) {
            // Rewrite ONLY malformed named-tuple markers token-by-token so other syntax errors inside `[ ... ]` are preserved!
            const closeB = k - 1;
            let nP = 0, nB = 0, nBr = 0, nA = 0, elemHasLabel = false, elemStart = i + 4;
            for (let j = i + 4; j < closeB; j++) {
              const tj = toks[j];
              if (tj.text === '(') { nP++; continue; }
              if (tj.text === ')') { nP--; continue; }
              if (tj.text === '[') { nB++; continue; }
              if (tj.text === ']') { nB--; continue; }
              if (tj.text === '{') { nBr++; continue; }
              if (tj.text === '}') { nBr--; continue; }
              if (tj.text === '<') { nA++; continue; }
              if (tj.text === '>') { if (nA > 0) nA--; continue; }
              if (nP !== 0 || nB !== 0 || nBr !== 0 || nA !== 0) continue;
              if (tj.text === ',') { elemHasLabel = false; elemStart = j + 1; continue; }
              if (tj.text === ':' && j > elemStart) elemHasLabel = true;
              // `...label?: T` -> `...label: T`
              if (tj.text === '...' && toks[j + 1]?.type === 'id' && toks[j + 2]?.text === '?' && toks[j + 3]?.text === ':') {
                edits.push({ start: toks[j + 2].start, end: toks[j + 2].end, text: ' ' });
                elemHasLabel = true;
                j += 3;
                continue;
              }
              // `label: ...T` -> `...label: T`
              if (tj.type === 'id' && j === elemStart &&
                  toks[j + 1]?.text === ':' && toks[j + 2]?.text === '...') {
                edits.push({ start: tj.start, end: tj.start, text: '...' });
                edits.push({ start: toks[j + 2].start, end: toks[j + 2].end, text: '   ' });
                elemHasLabel = true;
                j += 2;
                continue;
              }
              // `label: T?` followed by `,` or `]` -> `label: T` (only when this element has a label and a non-empty type before `?`)
              if (tj.text === '?' && elemHasLabel && toks[j - 1]?.text !== ':' && (toks[j + 1]?.text === ',' || j + 1 === closeB)) {
                edits.push({ start: tj.start, end: tj.end, text: ' ' });
              }
            }
            i = closeB;
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Expected ',', got 'string literal'`: `import { type "<A>" as A }` / `export { type "<A>" as "<B>" }`
  if (errMsg.includes("Expected ',', got 'string literal'") && /\b(?:import|export)\b/.test(source)) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].type === 'id' && (toks[i].text === 'import' || toks[i].text === 'export') && toks[i + 1]?.text === '{') {
          const cb = findMatchingBrace(toks, i + 1);
          if (cb > i + 1) {
            let j = i + 2;
            while (j < cb) {
              if (toks[j].type === 'id' && toks[j].text === 'type' && toks[j + 1]?.type === 'str') {
                // Must start a specifier (right after `{` or `,`)
                if (j !== i + 2 && toks[j - 1].text !== ',') return null;
                let endK = j + 1;
                if (toks[endK + 1]?.type === 'id' && toks[endK + 1].text === 'as') {
                  if (!toks[endK + 2] || (toks[endK + 2].type !== 'id' && toks[endK + 2].type !== 'str')) return null;
                  endK += 2;
                }
                const afterSpec = toks[endK + 1];
                if (endK + 1 !== cb && afterSpec?.text !== ',') return null;
                if (afterSpec?.text === ',') endK++;
                edits.push({ start: toks[j].start, end: toks[endK].end, text: source.slice(toks[j].start, toks[endK].end).replace(/[^\r\n]/g, ' ') });
                j = endK + 1;
                continue;
              }
              j++;
            }
            i = cb;
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped;
      }
    }
  }

  // `Unexpected token '<eof>'. Expected yield, an identifier, [ or {` (`var a,` trailing comma at EOF)
  if (errMsg.includes('Unexpected token `<eof>`. Expected yield, an identifier')) {
    const toks = tokenize(source);
    if (toks && toks.length >= 3 && toks[toks.length - 1].text === ',' &&
        toks[0].type === 'id' && (toks[0].text === 'var' || toks[0].text === 'let' || toks[0].text === 'const') &&
        toks[toks.length - 2].type === 'id') {
      const last = toks[toks.length - 1];
      const work = source.slice(0, last.start) + ';' + source.slice(last.end);
      const stripped = tryStrip(work);
      if (stripped !== null) return stripped;
    }
  }

  // `Classes may not have a non-static field named 'constructor'` (from lowered `constructor(public constructor: T) {}`)
  if (errMsg.includes("field named 'constructor'") && !source.includes('__tmt_ctorf__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'constructor' &&
            (toks[i - 1].text === '{' || toks[i - 1].text === ';') &&
            toks[i + 1].text === ';' &&
            toks[i + 2]?.text === 'constructor' && toks[i + 3]?.text === '(') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_ctorf__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        try {
          return stripTypeScriptTypes(work).replace(/__tmt_ctorf__/g, 'constructor');
        } catch {}
      }
    }
  }

  // `Expected 'from', got 'public'` / `Expected 'from', got 'await'` (`import * as await from "./other"`, `import public = require("1")`)
  if ((errMsg.includes("Expected 'from', got 'await'") || errMsg.includes("Expected 'from', got 'public'") ||
       errMsg.includes("`await` cannot be used as an identifier")) && !source.includes('__tmt_awim__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'await' &&
            ((toks[i - 1].text === 'as' && toks[i + 1].text === 'from') ||
             (toks[i - 1].text === 'const' && toks[i + 1].text === '='))) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_awim__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        const stripped = tryStrip(work);
        if (stripped !== null) return stripped.replace(/__tmt_awim__/g, 'await');
      }
    }
  }

  return null;
}

// Validates a pure-JavaScript module/script that Node's stripTypeScriptTypes rejected only for an
// ECMAScript semantic early error that TypeScript 6.0.3's syntax-only transpileModule accepts verbatim.
// Substitutes only the targeted construct, runs stripTypeScriptTypes to verify full grammar validity
// AND identity output (no TypeScript syntax erased), and returns true iff valid.
function validPureJsWithSwcRelaxations(source, errMsg, depth = 0) {
  if (!errMsg || depth > 2) return false;
  if (source.includes('await') || source.includes('yield')) {
    const checkToks = tokenize(source);
    if (checkToks) {
      for (let i = 0; i < checkToks.length - 1; i++) {
        if (checkToks[i].type === 'id' && (checkToks[i].text === 'await' || checkToks[i].text === 'yield') && checkToks[i + 1].text === '=>') {
          return false;
        }
      }
    }
  }
  const checkId = (work) => {
    try { return stripTypeScriptTypes(work) === work; }
    catch (e) {
      const nextMsg = String(e?.message || '');
      if (depth >= 2 || !nextMsg || nextMsg === errMsg) return false;
      return validPureJsWithSwcRelaxations(work, nextMsg, depth + 1);
    }
  };

  // 1. `"use strict"` inside function with non-simple parameter list
  if (errMsg.includes("Illegal 'use strict' directive")) {
    if (!/["']use strict["']/.test(source)) return false;
    const work = source.replace(/(["'])use strict\1/g, '$1use_strict$1');
    return work !== source && checkId(work);
  }

  // 2. `with (expr)` statement in strict/module code
  if (errMsg.includes("The 'with' statement is not supported")) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'with' && toks[i + 1]?.text === '(') {
        const prev = i > 0 ? toks[i - 1] : null;
        if (prev && prev.text === '.') continue;
        edits.push({ start: toks[i].start, end: toks[i].end, text: 'if' });
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 3. `yield` used as an identifier in strict mode / async generator
  if (errMsg.includes('`yield` cannot be used as an identifier')) {
    if (source.includes('__tmt_yd__')) return false;
    if (/\bfunction\s*\*/.test(source) && /\{\s*yield\s*[,}]/.test(source)) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'id' || toks[i].text !== 'yield') continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && prev.text === '.') continue;
      if (prev && prev.text === '(' && toks[i - 2]?.text === 'for') continue;
      const next = toks[i + 1];
      const isIdentUse = (prev && ['var', 'let', 'const', 'function', 'class', '(', ',', '[', '{', ':', '=', '...', '@'].includes(prev.text)) ||
        (next && [')', ',', ';', '=', ']', '}', '.', '('].includes(next.text));
      if (isIdentUse) edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_yd__' });
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 4. `'arguments' is only allowed in functions and class methods` (e.g. class field initializer / static block)
  if (errMsg.includes("'arguments' is only allowed in functions")) {
    if (source.includes('__tmt_ag__')) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i - 1]?.text !== '.') {
        const dec = toks[i].text.includes('\\u')
          ? toks[i].text.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (_, a, b) => String.fromCodePoint(parseInt(a ?? b, 16)))
          : toks[i].text;
        if (dec === 'arguments') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_ag__' });
        }
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 5. Rest element early errors: `[...a, b] = []`, `[...a,] = []`, `[...a = 1] = []`, `(...a = 1) => {}`
  if (errMsg.includes('Rest element must be final') ||
      errMsg.includes("Expected ',', got '='") ||
      errMsg.includes("Trailing comma isn't permitted after a rest") ||
      errMsg.includes('A rest parameter cannot have an initializer')) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'punc' && toks[i].text === '...') {
        // Removing `...` in a destructuring/parameter pattern turns a rest element into a normal element
        // so SWC still validates the entire pattern, initializer, and trailing elements.
        edits.push({ start: toks[i].start, end: toks[i].end, text: '   ' });
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      if (checkId(work)) return true;
    }
  }

  // 6. Invalid assignment LHS (`a?.b = 1`, `f() = 1`, `++f()`, `1 = 2`, `1 += 2`) in pure JS:
  if (errMsg.includes('The left-hand side of an assignment expression') || errMsg.includes('Invalid assignment target')) {
    if (source.includes('?.')) {
      const work = source.replace(/\?\.(?=\[|\()/g, '  ').replace(/\?\./g, '. ');
      if (work !== source && checkId(work)) return true;
    }
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    const assignOps = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
    const lhsEnds = new Set([')', ']', 'true', 'false', 'null', 'target', 'this', 'meta', 'eval', 'arguments']);
    const UNARY_KW = new Set(['+', '-', '!', '~', 'delete', 'typeof', 'void', 'await', 'yield']);
    const isPostfixPrev = (pt) => pt && !UNARY_KW.has(pt.text) && (pt.type === 'id' || pt.type === 'num' || pt.type === 'str' || pt.type === 'tpl' || pt.text === ')' || pt.text === ']' || pt.text === '}');
    const noDoubleInc = !/(?:\+\+|--)[ \t]*[A-Za-z_$][\w$.\[\]0-9]*[ \t]*(?:\+\+|--)/.test(source);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'punc') continue;
      // Check `++` / `--` (two adjacent `+` or `-` tokens)
      if (noDoubleInc && (t.text === '+' || t.text === '-') && toks[i + 1]?.text === t.text && t.end === toks[i + 1].start) {
        const prev = i > 0 ? toks[i - 1] : null;
        const next = toks[i + 2];
        if (isPostfixPrev(prev) && !hasNewlineBetween(source, prev.end, t.start)) {
          edits.push({ start: t.start, end: toks[i + 1].end, text: '  ' });
        } else if (next && !UNARY_KW.has(next.text) && !hasNewlineBetween(source, toks[i + 1].end, next.start)) {
          edits.push({ start: t.start, end: toks[i + 1].end, text: t.text + ' ' });
        }
        i++;
        continue;
      }
      if (i === 0 || i >= toks.length - 1) continue;
      // Gather contiguous punc run up to 4 chars for assignment ops
      let endIdx = i;
      while (endIdx + 1 < toks.length && toks[endIdx + 1].type === 'punc' &&
          toks[endIdx].end === toks[endIdx + 1].start && endIdx - i < 3 &&
          !'()[]{};,'.includes(toks[endIdx + 1].text)) {
        endIdx++;
      }
      const op = source.slice(t.start, toks[endIdx].end);
      if (op === '=' && (toks[i - 1].text === '=' || toks[i - 1].text === '!' || toks[i - 1].text === '<' || toks[i - 1].text === '>' || toks[endIdx + 1]?.text === '=' || toks[endIdx + 1]?.text === '>')) {
        i = endIdx;
        continue;
      }
      if (assignOps.has(op)) {
        const prev = toks[i - 1];
        if (lhsEnds.has(prev.text) || prev.type === 'num' || prev.type === 'str' || prev.type === 'tpl' || prev.type === 'regex') {
          edits.push({ start: t.start, end: toks[endIdx].end, text: '==' });
        }
      }
      i = endIdx;
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      if (checkId(work)) return true;
    }
  }

  // 7. `import()` / `import.defer()` / `import.source()` with 0 or 3+ arguments
  if (errMsg.includes('`import()` requires')) {
    if (source.includes('__tmt_im__')) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i - 1]?.text !== '.') {
        if (toks[i + 1].text === '(') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_im__' });
        } else if (toks[i + 1].text === '.' && (toks[i + 2]?.text === 'defer' || toks[i + 2]?.text === 'source') && toks[i + 3]?.text === '(') {
          edits.push({ start: toks[i].start, end: toks[i + 2].end, text: '__tmt_im__' });
          i += 2;
        }
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 8. `'eval' and 'arguments' cannot be used as a binding identifier in strict mode`
  if (errMsg.includes("'eval' and 'arguments' cannot be used as a binding identifier")) {
    if (source.includes('__tmt_ev__') || source.includes('__tmt_ag__')) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && (toks[i].text === 'eval' || toks[i].text === 'arguments') && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: toks[i].text === 'eval' ? '__tmt_ev__' : '__tmt_ag__' });
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 9. `` `let` cannot be used as an identifier in strict mode `` / `let is reserved in const, let, or class` / `Expected '{', got 'let'`
  if (errMsg.includes('`let` cannot be used as an identifier') || errMsg.includes('let is reserved in const, let, or class') ||
      errMsg.includes("Expected '{', got 'let'")) {
    if (source.includes('__tmt_lt__')) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'id' || toks[i].text !== 'let') continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && prev.text === '.') continue;
      const next = toks[i + 1];
      if (prev && prev.text === '(' && toks[i - 2]?.text === 'for' && (next?.text === ';' || next?.text === '=')) return false;
      const isIdentUse = (prev && ['var', 'let', 'const', 'function', 'class', '(', ',', '[', '{', ':', '=', '...', 'return', 'do', ')', 'else'].includes(prev.text)) ||
        (next && [')', ',', ';', '=', ']', '}', '.', '(', '['].includes(next.text));
      if (isIdentUse) edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_lt__' });
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      if (checkId(work)) return true;
    }
  }

  // 10. `` `await` cannot be used as an identifier in an async context ``
  if (errMsg.includes('`await` cannot be used as an identifier')) {
    if (source.includes('__tmt_aw__')) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'id' || toks[i].text !== 'await') continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && prev.text === '.') continue;
      if (prev && prev.text === '(' && toks[i - 2]?.text === 'for') continue;
      const next = toks[i + 1];
      const isIdentUse = (prev && ['var', 'let', 'const', 'function', 'class', '(', ',', '[', '{', ':', '=', '...'].includes(prev.text)) ||
        (next && [')', ',', ';', '=', ']', '}', ':'].includes(next.text));
      if (isIdentUse) edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_aw__' });
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 11. `'import', and 'export' cannot be used outside of module code`
  //     Lift nested `import`/`export` statements (at braceDepth > 0 or after `)`/`else`/`do`/`:`)
  //     to top-level so SWC still validates both the enclosing statement and the import/export syntax.
  if (errMsg.includes("'import', and 'export' cannot be used outside of module code")) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    const lifted = [];
    let braceDepth = 0, parenDepth = 0;
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.type === 'punc') {
        if (tk.text === '{') braceDepth++;
        else if (tk.text === '}') braceDepth = Math.max(0, braceDepth - 1);
        else if (tk.text === '(') parenDepth++;
        else if (tk.text === ')') parenDepth = Math.max(0, parenDepth - 1);
        continue;
      }
      if (tk.type === 'id' && (tk.text === 'import' || tk.text === 'export')) {
        const prev = i > 0 ? toks[i - 1] : null;
        if (prev && prev.text === '.') continue;
        if (tk.text === 'import' && (toks[i + 1]?.text === '(' || toks[i + 1]?.text === '.')) continue;
        const isNested = braceDepth > 0 || (parenDepth === 0 && prev && (prev.text === ')' || prev.text === 'else' || prev.text === 'do' || prev.text === ':'));
        if (!isNested) continue;
        // Reject malformed `for (a; b)` before `export` (missing 2nd `;`)
        if (braceDepth === 0 && prev && prev.text === ')') {
          let p = i - 2, pd2 = 1, semis = 0, hasInOf = false;
          while (p >= 0 && pd2 > 0) {
            if (toks[p].text === ')') pd2++;
            else if (toks[p].text === '(') pd2--;
            else if (pd2 === 1 && toks[p].text === ';') semis++;
            else if (pd2 === 1 && (toks[p].text === 'in' || toks[p].text === 'of')) hasInOf = true;
            p--;
          }
          if (p >= 0 && toks[p].text === 'for' && !hasInOf && semis !== 2) return null;
        }
        // Scan until `;` or matching `}` at current braceDepth
        let k = i + 1, bd = 0, pd = 0, bkd = 0, endIdx = -1;
        while (k < toks.length) {
          const nt = toks[k];
          if (nt.type === 'punc') {
            if (nt.text === '{') bd++;
            else if (nt.text === '}') {
              if (bd === 0) { endIdx = k - 1; break; }
              bd--;
              if (bd === 0 && pd === 0 && bkd === 0 && toks[k + 1]?.text !== 'from' && toks[k + 1]?.text !== ';') {
                // `export function f() {}` or `export class C {}`
                const second = toks[i + 1]?.text;
                if (second === 'function' || second === 'class' || second === 'async' ||
                    (second === 'default' && (toks[i + 2]?.text === 'function' || toks[i + 2]?.text === 'class' || toks[i + 2]?.text === 'async'))) {
                  endIdx = k;
                  break;
                }
              }
            } else if (nt.text === '(') pd++;
            else if (nt.text === ')') pd--;
            else if (nt.text === '[') bkd++;
            else if (nt.text === ']') bkd--;
            else if (nt.text === ';' && bd === 0 && pd === 0 && bkd === 0) { endIdx = k; break; }
          }
          k++;
        }
        if (endIdx < i) return false;
        lifted.push(source.slice(tk.start, toks[endIdx].end));
        edits.push({ start: tk.start, end: toks[endIdx].end, text: ';' });
        i = endIdx;
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos) + '\n' + lifted.join('\n') + '\n';
    return checkId(work);
  }

  // 12. `Declaration is not allowed` (`while (false) function f() {}`, `do class C {} while (false)`, `if (x) let y = 1;`)
  if (errMsg.includes('Declaration is not allowed')) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type !== 'id') continue;
      const prev = toks[i - 1];
      if (prev.text !== ')' && prev.text !== 'else' && prev.text !== 'do' && prev.text !== ':') continue;
      if (t.text === 'function' || t.text === 'class' || (t.text === 'async' && toks[i + 1]?.text === 'function')) {
        let k = i + 1;
        while (k < toks.length && toks[k].text !== '{') k++;
        if (k >= toks.length) continue;
        const close = findMatchingBrace(toks, k);
        if (close < 0) continue;
        edits.push({ start: t.start, end: toks[close].end, text: `{ ${source.slice(t.start, toks[close].end)} }` });
        i = close;
      } else if (t.text === 'let' || t.text === 'const') {
        let k = i + 1;
        while (k < toks.length && toks[k].text !== ';' && !hasNewlineBetween(source, toks[k - 1].end, toks[k].start)) k++;
        const endIdx = (k < toks.length && toks[k].text === ';') ? k : k - 1;
        if (endIdx > i) {
          edits.push({ start: t.start, end: toks[endIdx].end, text: `{ ${source.slice(t.start, toks[endIdx].end)} }` });
          i = endIdx;
        }
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 13. `Unexpected initializer in for in/of loop` (`for (const [a] = [] of x) {}`)
  if (errMsg.includes('Unexpected initializer in for in/of loop')) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'id' || toks[i].text !== 'for') continue;
      let pIdx = i + 1;
      if (toks[pIdx]?.text === 'await') pIdx++;
      if (toks[pIdx]?.text !== '(') continue;
      const closeP = findMatchingParen(toks, pIdx);
      if (closeP < 0) continue;
      let dP = 0, dB = 0, dBr = 0, eqIdx = -1, ofIdx = -1;
      for (let k = pIdx + 1; k < closeP; k++) {
        const tk = toks[k];
        if (tk.text === '(') dP++;
        else if (tk.text === ')') dP--;
        else if (tk.text === '[') dB++;
        else if (tk.text === ']') dB--;
        else if (tk.text === '{') dBr++;
        else if (tk.text === '}') dBr--;
        else if (dP === 0 && dB === 0 && dBr === 0) {
          if (tk.text === '=' && eqIdx < 0) eqIdx = k;
          else if (tk.type === 'id' && (tk.text === 'of' || tk.text === 'in')) { ofIdx = k; break; }
        }
      }
      if (eqIdx > 0 && ofIdx > eqIdx) {
        edits.push({ start: toks[eqIdx].start, end: toks[ofIdx].start, text: ' ' });
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 14. `Expected ';', '}' or <eof>` / `Expression expected` / `Expected ident`:
  //     `yield expr` / `await expr` in non-generator/static-block, or `yield` as binding ident in `Expected ident`
  if (errMsg.includes("Expected ';', '}' or <eof>") || errMsg.includes('Expression expected') || errMsg.includes('Expected ident')) {
    const toks = tokenize(source);
    if (!toks) return false;
    if (errMsg.includes('Expected ident') && source.includes('?.`')) {
      const work = source.replace(/\?\.(?=`)/g, '  ');
      if (work !== source && checkId(work)) return true;
    }
    if (errMsg.includes('Expected ident') && /\bawait\b/.test(source) && !source.includes('__tmt_aw__')) {
      const aEdits = [];
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'await' && toks[i - 1]?.text !== '.') {
          if (toks[i + 1]?.text === ':' || toks[i + 1]?.text === '=>') return false;
          const prev = i > 0 ? toks[i - 1] : null;
          if (prev && ['var', 'let', 'const', 'function', 'class', '(', ',', '[', '{', '...', 'get', 'set', '*'].includes(prev.text)) {
            aEdits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_aw__' });
          }
        }
      }
      if (aEdits.length > 0) {
        let work = '', pos = 0;
        for (const e of aEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
    if ((errMsg.includes('Expected ident') || errMsg.includes('Expression expected')) && /\byield\b/.test(source) && !source.includes('__tmt_yd__')) {
      const edits = [];
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'yield' && toks[i - 1]?.text !== '.') {
          if (toks[i - 1]?.text === 'let' && hasNewlineBetween(source, toks[i - 1].end, toks[i].start)) return false;
          if (toks[i + 1]?.text === '*') return false;
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_yd__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
    // `import.source` / `import.defer` / `import.unknown(...)` property access in `Expected ';', '}' or <eof>`
    if (errMsg.includes("Expected ';', '}' or <eof>") && /\bimport\b/.test(source) && !source.includes('__tmt_im__')) {
      const iEdits = [];
      for (let i = 0; i < toks.length - 2; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i - 1]?.text !== '.' &&
            toks[i + 1].text === '.' && toks[i + 2].type === 'id' && toks[i + 2].text !== 'meta') {
          iEdits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_im__' });
        }
      }
      if (iEdits.length > 0) {
        let work = '', pos = 0;
        for (const e of iEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type !== 'id' || (t.text !== 'yield' && t.text !== 'await') || toks[i - 1]?.text === '.') continue;
      const next = toks[i + 1];
      if (!hasNewlineBetween(source, t.end, next.start) &&
          (next.type === 'id' || next.type === 'num' || next.type === 'str' || next.type === 'tpl' || next.text === '(' || next.text === '[' || next.text === '{')) {
        const prev = i > 0 ? toks[i - 1] : null;
        if (!prev || prev.text === '{' || prev.text === ';' || prev.text === '}' || prev.text === '(' || prev.text === '=' || prev.text === ':' || prev.text === ',' || prev.text === 'return' || hasNewlineBetween(source, prev.end, t.start)) {
          const isAssign = next.type === 'id' && toks[i + 2]?.text === '=' && toks[i + 3]?.text !== '=';
          edits.push({ start: t.start, end: t.end, text: isAssign ? '     ' : 'void ' });
        }
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      if (checkId(work)) return true;
    }
  }

  // 15. `Cannot assign to this` (`this = 1`, `[[(x, y)]] = [[]]`)
  if (errMsg.includes('Cannot assign to this')) {
    const toks = tokenize(source);
    if (!toks) return false;
    if (!source.includes('__tmt_th__')) {
      const edits = [];
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].type === 'id' && toks[i].text === 'this' && toks[i - 1]?.text !== '.') {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_th__' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
    // `[[(x, y)]] = [[]]` -> replace `=` after `]`/`}` with `==`
    const aEdits = [];
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type === 'punc' && t.text === '=' && toks[i - 1].text !== '=' && toks[i - 1].text !== '!' &&
          toks[i - 1].text !== '<' && toks[i - 1].text !== '>' && toks[i + 1].text !== '=' && toks[i + 1].text !== '>' &&
          (toks[i - 1].text === ']' || toks[i - 1].text === '}')) {
        aEdits.push({ start: t.start, end: t.end, text: '==' });
      }
    }
    if (aEdits.length > 0) {
      let work = '', pos = 0;
      for (const e of aEdits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      if (checkId(work)) return true;
    }
  }

  // 16. `Unexpected token '('. Expected meta` / `Import is not allowed here` (`import.unknown(...)`, `typeof import.source`)
  if ((errMsg.includes('Unexpected token `(`. Expected meta') || errMsg.includes('Import is not allowed here')) && !source.includes('__tmt_im__')) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length - 2; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i - 1]?.text !== '.' &&
          toks[i + 1].text === '.' && toks[i + 2].type === 'id' && toks[i + 2].text !== 'meta') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_im__' });
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 17. `Classes can't have a private field named '#constructor'.`
  if (errMsg.includes("'#constructor'") && !source.includes('#__tmt_ctor__')) {
    const work = source.replace(/#constructor\b/g, '#__tmt_ctor__');
    if (work !== source && checkId(work)) return true;
  }

  // 18. `Return statement is not allowed here`
  if (errMsg.includes('Return statement is not allowed here') && !source.includes('__tmt_ret__')) {
    const trail = /^([\s\S]*)\nexport \{\};\n?$/.exec(source);
    const work = trail
      ? `function __tmt_ret__() {\n${trail[1]}\n}\nexport {};\n`
      : `function __tmt_ret__() {\n${source}\n}\n`;
    if (checkId(work)) return true;
  }

  // 19. `A 'break' statement` / `A 'continue' statement` / `Jump target cannot cross function boundary`
  if (errMsg.includes("A 'break' statement") || errMsg.includes("A 'continue' statement") || errMsg.includes('Jump target cannot cross function boundary')) {
    if (source.includes('__tmt_jmp__')) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'id' || (t.text !== 'break' && t.text !== 'continue') || toks[i - 1]?.text === '.') continue;
      let endIdx = i;
      if (toks[i + 1]?.type === 'id' && !hasNewlineBetween(source, t.end, toks[i + 1].start)) endIdx = i + 1;
      edits.push({ start: t.start, end: toks[endIdx].end, text: '__tmt_jmp__' });
      i = endIdx;
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 20. `` `<kw>` cannot be used as an identifier in strict mode `` (`static`, `public`, `private`, `protected`, `package`, `interface`, `implements`)
  {
    const m = /`([a-z]+)` cannot be used as an identifier in strict mode/.exec(errMsg);
    if (m && ['static', 'public', 'private', 'protected', 'package', 'interface', 'implements'].includes(m[1]) && !source.includes('__tmt_kw__')) {
      const kw = m[1];
      const toks = tokenize(source);
      if (toks) {
        const edits = [];
        for (let i = 0; i < toks.length; i++) {
          if (toks[i].type !== 'id' || toks[i].text !== kw || toks[i - 1]?.text === '.') continue;
          const prev = i > 0 ? toks[i - 1] : null;
          const next = toks[i + 1];
          const isIdentUse = (prev && ['var', 'let', 'const', 'function', 'class', '(', ',', '[', '{', ':', '=', '...', 'return'].includes(prev.text)) ||
            (next && [')', ',', ';', '=', ']', '}', ':', '.', '('].includes(next.text));
          if (isIdentUse) edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_kw__' });
        }
        if (edits.length > 0) {
          let work = '', pos = 0;
          for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
          work += source.slice(pos);
          if (checkId(work)) return true;
        }
      }
    }
  }

  // 21. `'yield' cannot be used as a parameter within generator`
  if (errMsg.includes("'yield' cannot be used as a parameter") && !source.includes('__tmt_yd__')) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'yield' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_yd__' });
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 22. `Unexpected token '#'. Expected identifier` / `Expected ',', got '#'` (`{ async #m() {} }`, `{ #x } = o`)
  if (errMsg.includes("Unexpected token `#`. Expected identifier") || errMsg.includes("Expected ',', got '#'")) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'punc' && toks[i].text === '#' && toks[i + 1].type === 'id' && toks[i].end === toks[i + 1].start) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '_' });
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 23. `Using declaration requires initializer` (`using x;`, `await using x, y = 1;`)
  if (errMsg.includes('Using declaration requires initializer')) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'using' && toks[i + 1].type === 'id' &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        let k = i + 1;
        while (k < toks.length && toks[k].type === 'id') {
          const next = toks[k + 1];
          if (!next || next.text === ';' || next.text === ',' || next.text === '}' || hasNewlineBetween(source, toks[k].end, next.start)) {
            edits.push({ start: toks[k].end, end: toks[k].end, text: ' = 0' });
            if (next && next.text === ',') { k += 2; continue; }
            break;
          }
          // Skip `= <expr>` until `,` or `;`
          if (next.text === '=') {
            let m = k + 2, dP = 0, dB = 0, dBr = 0;
            while (m < toks.length) {
              const mt = toks[m];
              if (mt.text === '(') dP++;
              else if (mt.text === ')') dP--;
              else if (mt.text === '[') dB++;
              else if (mt.text === ']') dB--;
              else if (mt.text === '{') dBr++;
              else if (mt.text === '}') { if (dBr === 0) break; dBr--; }
              else if (dP === 0 && dB === 0 && dBr === 0 && (mt.text === ',' || mt.text === ';')) break;
              m++;
            }
            if (toks[m]?.text === ',') { k = m + 1; continue; }
          }
          break;
        }
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 24. `Not a pattern` (`[{ a: 1 }] = []`, `[a.b = 1] = []`) -> replace `=` after `]`/`}` with `==`
  if (errMsg.includes('Not a pattern')) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type === 'punc' && t.text === '=' && toks[i - 1].text !== '=' && toks[i - 1].text !== '!' &&
          toks[i - 1].text !== '<' && toks[i - 1].text !== '>' && toks[i + 1].text !== '=' && toks[i + 1].text !== '>' &&
          (toks[i - 1].text === ']' || toks[i - 1].text === '}')) {
        edits.push({ start: t.start, end: t.end, text: '==' });
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      if (checkId(work)) return true;
    }
  }

  // 25. `'const' declarations must be initialized` (`const a;` -> `let   a;`)
  if (errMsg.includes("'const' declarations must be initialized")) {
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'const' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: 'let  ' });
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 26. `A 'set' accessor must have exactly one parameter` / `A 'get' accessor cannot have parameters`
  if (errMsg.includes('`get` accessor cannot have parameters') || errMsg.includes('`set` accessor must have exactly one parameter')) {
    const kw = errMsg.includes('`get`') ? 'get' : 'set';
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length - 2; i++) {
      if (toks[i].type === 'id' && toks[i].text === kw && toks[i - 1]?.text !== '.' &&
          (toks[i + 1].type === 'id' || toks[i + 1].text === '[' || toks[i + 1].type === 'str' || toks[i + 1].type === 'num') &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '   ' });
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 27. `Label target is already declared` / `'new.target' is only allowed` / `Duplicate` / `async` modifier
  if (errMsg.includes("'new.target' is only allowed") && !source.includes('__tmt_nt__')) {
    const work = source.replace(/\bnew\s*\.\s*target\b/g, '__tmt_nt__');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes("Constructor can't be an async function") || errMsg.includes('`async` modifier cannot be used here')) {
    const work = source.replace(/\basync(?=[ \t]+(?:constructor|get|set)\b)/g, '     ');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('Using declaration only allows identifiers') || errMsg.includes('Using declaration is not allowed in for-in loop')) {
    const work = source.replace(/\b(?:await[ \t]+)?using(?=[ \t]+[{[\w$])/g, 'const');
    if (work !== source && checkId(work)) return true;
  }

  // 28. `Nullish coalescing operator(??) requires parens when mixing with` (`a ?? b || c`)
  if (errMsg.includes('Nullish coalescing operator(??) requires parens')) {
    const work = source.replace(/\?\?/g, '||');
    if (work !== source && checkId(work)) return true;
  }
  // 29. `Tagged template literal is not allowed in optional chain.` (`null?.fn`hello``) / `Expected ident` (`a?.\n`hello``)
  if (errMsg.includes('Tagged template literal is not allowed in optional chain') ||
      (errMsg.includes('Expected ident') && source.includes('?.') && source.includes('`'))) {
    const work = source.replace(/\?\.(?=[ \t\r\n]*`)/g, '  ').replace(/\?\./g, '. ');
    if (work !== source && checkId(work)) return true;
  }
  // 30. `Rest element must be final element` / `Trailing comma isn't permitted after a rest element`
  if (errMsg.includes('Rest element must be final element') || errMsg.includes("Trailing comma isn't permitted after a rest element")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 1; i++) {
        if (toks[i].text === '...') edits.push({ start: toks[i].start, end: toks[i].end, text: '   ' });
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
  }
  // 31. `Classes may not have a non-static field named 'constructor'`
  if (errMsg.includes("field named 'constructor'") && !source.includes('__tmt_cf__')) {
    const work = source.replace(/(["'])constructor\1/g, '$1__tmt_cf__$1');
    if (work !== source && checkId(work)) return true;
  }
  // 32. `Invalid 'super()'` (`super.#x`)
  if (errMsg.includes('Invalid `super()`') && !source.includes('__tmt_sp__')) {
    const work = source.replace(/\bsuper(?=[ \t]*\.[ \t]*#)/g, 'this ');
    if (work !== source && checkId(work)) return true;
  }
  // 33. `Constructor can't be an async function` (including `async *constructor`)
  if (errMsg.includes("Constructor can't be an async function")) {
    const work = source.replace(/\basync(?=[ \t]*\*?[ \t]*constructor\b)/g, '     ').replace(/\*(?=[ \t]*constructor\b)/g, ' ');
    if (work !== source && checkId(work)) return true;
  }
  // 34. `LineBreak cannot follow 'throw'`
  if (errMsg.includes("LineBreak cannot follow 'throw'")) {
    const work = source.replace(/\bthrow[ \t]*\r?\n[ \t]*/g, 'throw ');
    if (work !== source && checkId(work)) return true;
  }
  // 35. `Invalid use of 'arguments' in strict mode` (SWC also emits this for `eval = 42`)
  if (errMsg.includes("Invalid use of 'arguments'") && !source.includes('__tmt_ar__')) {
    const work = source.replace(/\b(?:arguments|eval)\b/g, '__tmt_ar__');
    if (work !== source && checkId(work)) return true;
  }
  // 36. `Unexpected line break between arrow head and arrow`
  if (errMsg.includes('Unexpected line break between arrow head and arrow')) {
    const work = source.replace(/[\r\n]+([ \t]*=>)/g, ' $1');
    if (work !== source && checkId(work)) return true;
  }
  // 37. `Expected '{', got 'await'` / `'static'` / `'yield'` / `'<lexing error>'` / `Expected ident` (`class aw\u0061it {}`)
  if ((errMsg.includes("Expected '{', got 'await'") || errMsg.includes("Expected '{', got 'static'") || errMsg.includes("Expected '{', got 'yield'") ||
       errMsg.includes("Expected '{', got '<lexing error>'") || errMsg.includes('Expected ident') ||
       errMsg.includes('Unexpected token `let`. Expected let is reserved')) && !source.includes('__tmt_cn__')) {
    const work = source.replace(/\bclass([ \t]+)(?:await|static|yield|let|[A-Za-z_$\\u{}\w]*\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})[A-Za-z_$\\u{}\w]*)(?=[ \t\r\n]*(?:\{|extends\b))/g, 'class$1__tmt_cn__');
    if (work !== source && checkId(work)) return true;
  }
  // 38. `Cannot assign to this` / `Not a pattern` (`0, [[(x, y)]] = [[]];`, `0, [{ get x() {} }] = [{}];`)
  if (errMsg.includes('Cannot assign to this') || errMsg.includes('Not a pattern')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 1; i < toks.length - 1; i++) {
        if (toks[i].text === '=' && toks[i + 1].text !== '=' && toks[i + 1].text !== '>' &&
            (toks[i - 1].text === ']' || toks[i - 1].text === '}')) {
          edits.push({ start: toks[i].start, end: toks[i].end, text: '==' });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
  }
  // 39. Invalid `for [await] (<lhs> in|of <rhs>)` destructuring/LHS patterns:
  //     Keep `<lhs>` validated as an expression via `for [await] (__tmt_fl__ of ((<lhs>), (<rhs>)))`.
  if ((errMsg.includes('The left-hand side of an assignment expression') ||
       errMsg.includes('Cannot assign to this') || errMsg.includes('Not a pattern') ||
       errMsg.includes('Rest element must be final') || errMsg.includes("Trailing comma isn't permitted after a rest") ||
       errMsg.includes('A rest parameter cannot have an initializer') ||
       errMsg.includes('cannot be a destructuring pattern')) && !source.includes('__tmt_fl__')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 3; i++) {
        if (toks[i].type !== 'id' || toks[i].text !== 'for') continue;
        let pIdx = i + 1;
        if (toks[pIdx]?.text === 'await') pIdx++;
        if (toks[pIdx]?.text !== '(') continue;
        const cp = findMatchingParen(toks, pIdx);
        if (cp < 0) continue;
        const first = toks[pIdx + 1];
        if (!first || first.text === 'var' || first.text === 'let' || first.text === 'const' || first.text === 'using') continue;
        let dP = 0, dB = 0, dBr = 0, inIdx = -1;
        for (let k = pIdx + 1; k < cp; k++) {
          const tk = toks[k];
          if (tk.text === '(') dP++; else if (tk.text === ')') dP--;
          else if (tk.text === '[') dB++; else if (tk.text === ']') dB--;
          else if (tk.text === '{') dBr++; else if (tk.text === '}') dBr--;
          else if (dP === 0 && dB === 0 && dBr === 0 && tk.type === 'id' && (tk.text === 'in' || tk.text === 'of')) { inIdx = k; break; }
        }
        if (inIdx > pIdx + 1 && inIdx + 1 < cp) {
          const lhs = source.slice(toks[pIdx + 1].start, toks[inIdx - 1].end);
          const rhs = source.slice(toks[inIdx + 1].start, toks[cp - 1].end);
          const safeLhs = errMsg.includes('cannot be a destructuring pattern') ? lhs.replace(/\byield\b/g, '__tmt_yd__') : lhs;
          edits.push({ start: toks[pIdx + 1].start, end: toks[cp - 1].end, text: `__tmt_fl__ of ((${safeLhs}), (${rhs}))` });
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
  }
  // 40. `Expression expected`: line break before `=>` (`var af = x\n=> {};`)
  if (errMsg.includes('Expression expected') && /[\r\n]+[ \t]*=>/.test(source)) {
    const work = source.replace(/[\r\n]+([ \t]*=>)/g, ' $1');
    if (work !== source && checkId(work)) return true;
  }
  // 41. `Expected ';', got 'ident'` (`for await (using x = obj of []) {}`) / `Expected ';', got ')'` (`for (let x = 3 in {}) {}`)
  if (errMsg.includes("Expected ';', got 'ident'") || errMsg.includes("Expected ';', got ')'")) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (let i = 0; i < toks.length - 4; i++) {
        if (toks[i].type !== 'id' || toks[i].text !== 'for') continue;
        let pIdx = i + 1;
        if (toks[pIdx]?.text === 'await') pIdx++;
        if (toks[pIdx]?.text !== '(') continue;
        const cp = findMatchingParen(toks, pIdx);
        if (cp < 0) continue;
        let kwIdx = pIdx + 1;
        if (toks[kwIdx]?.text === 'await' && toks[kwIdx + 1]?.text === 'using') {
          edits.push({ start: toks[kwIdx].start, end: toks[kwIdx + 1].end, text: 'const' });
          kwIdx += 1;
        } else if (toks[kwIdx]?.text === 'using') {
          edits.push({ start: toks[kwIdx].start, end: toks[kwIdx].end, text: 'const' });
        } else if (toks[kwIdx]?.text !== 'var' && toks[kwIdx]?.text !== 'let' && toks[kwIdx]?.text !== 'const') {
          continue;
        }
        let dP = 0, dB = 0, dBr = 0, cutIdx = -1, inIdx = -1;
        for (let k = kwIdx + 1; k < cp; k++) {
          const tk = toks[k];
          if (tk.text === '(') dP++; else if (tk.text === ')') dP--;
          else if (tk.text === '[') dB++; else if (tk.text === ']') dB--;
          else if (tk.text === '{') dBr++; else if (tk.text === '}') dBr--;
          else if (dP === 0 && dB === 0 && dBr === 0) {
            if ((tk.text === '=' || tk.text === ',') && cutIdx < 0) cutIdx = k;
            else if (tk.type === 'id' && (tk.text === 'in' || tk.text === 'of')) { inIdx = k; break; }
          }
        }
        if (cutIdx > 0 && inIdx > cutIdx) {
          edits.push({ start: toks[cutIdx].start, end: toks[inIdx].start, text: ' ' });
        }
      }
      if (edits.length > 0) {
        edits.sort((a, b) => a.start - b.start);
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
  }
  // 42. `import.source.X` (`Expected ';', got '.'`, `Expected ',', got '.'`, `Expected ')', got '.'`)
  if ((errMsg.includes("got '.'") && source.includes('import.source')) && !source.includes('__tmt_is__')) {
    const work = source.replace(/\bimport[ \t]*\.[ \t]*source\b/g, '__tmt_is__');
    if (work !== source && checkId(work)) return true;
  }
  // 43. `` `let` cannot be used as an identifier in strict mode `` (`for (using let of []) {}`)
  if (errMsg.includes('`let` cannot be used as an identifier in strict mode') && !source.includes('__tmt_lt__')) {
    const work = source.replace(/\b(?:await[ \t]+)?using([ \t]+)let\b/g, 'const$1__tmt_lt__');
    if (work !== source && checkId(work)) return true;
  }
  // 44. Misc Test262 SWC semantic rejections accepted by TS 6.0.3
  if (errMsg.includes('Unexpected escape sequence in reserved word: yield') && !source.includes('__tmt_yd__')) {
    const work = source.replace(/(?:y|\\u0079|\\u\{0*79\})(?:i|\\u0069|\\u\{0*69\})(?:e|\\u0065|\\u\{0*65\})(?:l|\\u006[cC]|\\u\{0*6[cC]\})(?:d|\\u0064|\\u\{0*64\})/g, '__tmt_yd__');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes("'arguments' is only allowed in functions") && !source.includes('__tmt_ar__')) {
    const work = source.replace(/\barguments\b|(?:a|\\u0061|\\u\{0*61\})(?:r|\\u0072|\\u\{0*72\})(?:g|\\u0067|\\u\{0*67\})(?:u|\\u0075|\\u\{0*75\})(?:m|\\u006[dD]|\\u\{0*6[dD]\})(?:e|\\u0065|\\u\{0*65\})(?:n|\\u006[eE]|\\u\{0*6[eE]\})(?:t|\\u0074|\\u\{0*74\})(?:s|\\u0073|\\u\{0*73\})/g, '__tmt_ar__');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('Expected meta') && source.includes('\\u')) {
    const work = source.replace(/\bimport[ \t]*\.[ \t]*(?:m|\\u006[dD]|\\u\{0*6[dD]\})(?:e|\\u0065|\\u\{0*65\})(?:t|\\u0074|\\u\{0*74\})(?:a|\\u0061|\\u\{0*61\})/g, 'import.meta');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes("await isn't allowed in non-async function") && !source.includes('__tmt_aw__')) {
    const work = source.replace(/\bawait(?=[ \t]*\()/g, '__tmt_aw__');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes("Expected '(', got '}'") && /\basync[ \t]+async\b/.test(source)) {
    const work = source.replace(/\basync([ \t]+)async\b/g, 'async:$1async');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('A string literal cannot be used as an exported binding without') && !source.includes('__tmt_ex__')) {
    const work = source.replace(/(\bexport[ \t]*\{[ \t]*)(["'][^"']*["'])([ \t]+as[ \t]+)/g, '$1__tmt_ex__$3');
    if (work !== source && checkId(work)) return true;
  }
  if ((errMsg.includes("Expected ';', '}' or <eof>") || errMsg.includes('Expression expected')) && /\busing[ \t]*\{/.test(source)) {
    const work = source.replace(/\b(?:await[ \t]+)?using(?=[ \t]*\{)/g, 'const');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('Expression expected') && !source.includes('__tmt_kw__') && /\b(?:public|private|protected|package|interface|implements)[ \t]*=/.test(source)) {
    const work = source.replace(/\b(?:public|private|protected|package|interface|implements)(?=[ \t]*=)/g, '__tmt_kw__');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes("Expected ',', got 'ident'") && /\([ \t]*yield[ \t]+/.test(source)) {
    const work = source.replace(/\([ \t]*yield[ \t]+([A-Za-z_$][\w$]*)[ \t]*\)[ \t]*=(?![=>])/g, '($1) ==');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('is already declared') && errMsg.startsWith('Label ') && !source.includes('__tmt_lb_')) {
    let idx = 0;
    const work = source.replace(/\b([A-Za-z_$][\w$]*)[ \t]*:(?=[ \t\r\n]*(?:\{|for\b|while\b|do\b|switch\b|if\b|try\b|with\b|[A-Za-z_$]))/g, (m, lb) => `__tmt_lb_${idx++}__:`);
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('Duplicated regular expression flag')) {
    const toks = tokenize(source);
    if (toks) {
      const edits = [];
      for (const t of toks) {
        if (t.type === 'regex') {
          const sl = t.text.lastIndexOf('/');
          const flags = [...new Set(t.text.slice(sl + 1))].join('');
          if (flags.length !== t.text.length - sl - 1) {
            edits.push({ start: t.start + sl + 1, end: t.end, text: flags });
          }
        }
      }
      if (edits.length > 0) {
        let work = '', pos = 0;
        for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
        work += source.slice(pos);
        if (checkId(work)) return true;
      }
    }
  }
  if (errMsg.includes('A switch block cannot have multiple defaults')) {
    let seen = false;
    const work = source.replace(/\bdefault[ \t]*:/g, (m) => { if (!seen) { seen = true; return m; } return 'case 0:'; });
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('Generator or async function cannot be labelled') || errMsg.includes("Expected ';', '}' or <eof>") || errMsg.includes('Expression expected')) {
    const work = source.replace(/(?<=^|[;\r\n{])[ \t]*[A-Za-z_$][\w$]*[ \t]*:(?=[ \t\r\n]*(?:function\b|async\b|let\b|const\b|class\b))/g, '');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('A rest parameter cannot have an initializer')) {
    const work = source.replace(/\.\.\.([A-Za-z_$][\w$]*)[ \t]*=/g, '$1 =');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('assignment property is invalid syntax')) {
    const work = source.replace(/\{([ \t]*[A-Za-z_$][\w$]*)[ \t]*=/g, '{$1:');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('`yield` cannot be used as an identifier in strict mode') && !source.includes('__tmt_yd__')) {
    const work = source.replace(/\byield\b/g, '__tmt_yd__');
    if (work !== source && checkId(work)) return true;
  }
  if (errMsg.includes('The left-hand side of a `for...in` statement cannot be a destructuring') && !source.includes('__tmt_fi__')) {
    const work = source.replace(/\bfor[ \t]*\([ \t]*(?:var|let|const)[ \t]*(\{[^}]*\}|\[[^\]]*\])[ \t]*=[ \t]*[^)]*?\bin\b/g, 'for (var __tmt_fi__ in');
    if (work !== source && checkId(work)) return true;
  }

  return false;
}

module.exports = {
  tokenize,
  hasForBracketIn,
  normalizeAmbientModules,
  hasTopLevelModuleSyntax,
  preprocessPreserveCjs,
  eraseValidatedAmbientBlocks,
  lowerNamespacesAndEnums,
  lowerParameterProperties,
  eraseNonEsDecorators,
  eraseAngleBracketAssertions,
  stripWithSwcRelaxations,
  validPureJsWithSwcRelaxations,
};
