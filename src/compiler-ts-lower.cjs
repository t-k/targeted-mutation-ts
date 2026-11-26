'use strict';

const { stripTypeScriptTypes } = require('node:module');

const RESERVED_NS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

const REGEX_AFTER = new Set([
  '', '(', '[', '{', '${', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~', '<', '>', '+', '-',
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
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 11 || ch === 12 || ch === 0xa0 || ch === 0xfeff) {
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
    if (isIdentStart(ch)) {
      const start = i++;
      while (i < n && isIdentPart(source.charCodeAt(i))) i++;
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
    tokens.push({ type: 'punc', text, start: i, end: i + 1 });
    prev = text;
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

    // `export = expr` -> `module.exports = expr`
    if (t.text === 'export' && tokens[i + 1]?.type === 'punc' && tokens[i + 1].text === '=' &&
        !(tokens[i + 2]?.type === 'punc' && (tokens[i + 2].text === '=' || tokens[i + 2].text === '>'))) {
      edits.push({ start: t.start, end: t.end, text: 'module.exports' });
      hasCjsModule = true;
      i += 1;
      continue;
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
      if (em.includes('`declare` modifier not allowed') || em.includes('`module` keyword is not supported')) {
        let relaxedBody = bodyText.replace(/(?<=^|[;\r\n{])[ \t]*((?:export[ \t]+|declare[ \t]+)*)module(?=[ \t]+[A-Za-z_$][\w$.]*[ \t]*\{)/g, '$1namespace');
        relaxedBody = relaxedBody.replace(/(?<=^|[;\r\n{])[ \t]*(export[ \t]+)?declare(?=[ \t]+(?:class|function|var|let|const|enum|namespace|module|interface|type|abstract|async)\b)/g, '$1       ');
        try {
          stripTypeScriptTypes(header + relaxedBody);
        } catch {
          return null;
        }
      } else if (stripWithSwcRelaxations(header + bodyText, em) === null) {
        return null;
      }
    }
    const blank = source.slice(t.start, tokens[closeIdx].end).replace(/[^\r\n]/g, ' ');
    edits.push({ start: t.start, end: tokens[closeIdx].end, text: blank });
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
function evalEnumExpr(expr, env, allowComputed = false, enumName = '', allEnums = null) {
  const s = expr.trim();
  if (!s) return null;
  if ((s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0] && s.length >= 2) {
    // Only single string literal (no `+` outside quotes)
    const toks = tokenize(s);
    if (toks && toks.length === 1 && toks[0].type === 'str') {
      return { kind: 'str', raw: s };
    }
  }
  const toks = tokenize(s);
  if (!toks || toks.length === 0) return null;
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
      if (toks[pos].text === '<' && toks[pos + 1].text === '<') { pos += 2; const r = parseAdd(); v = r === null ? null : (v << r); }
      else if (toks[pos].text === '>' && toks[pos + 1].text === '>' && toks[pos + 2]?.text === '>') { pos += 3; const r = parseAdd(); v = r === null ? null : (v >>> r); }
      else if (toks[pos].text === '>' && toks[pos + 1].text === '>') { pos += 2; const r = parseAdd(); v = r === null ? null : (v >> r); }
      else break;
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
    if (v !== null && pos + 1 < toks.length && toks[pos].text === '*' && toks[pos + 1].text === '*') {
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
      return Number.isFinite(n) ? n : null;
    }
    if (toks[pos].type === 'str' && toks[pos + 1]?.text === '.' && toks[pos + 2]?.text === 'length') {
      const lit = toks[pos].text;
      try {
        const strVal = lit.startsWith('"') ? JSON.parse(lit) : lit.slice(1, -1);
        pos += 3;
        return strVal.length;
      } catch { return null; }
    }
    if (toks[pos].type === 'id' && env.has(toks[pos].text)) {
      const prev = env.get(toks[pos++].text);
      return prev.kind === 'num' ? prev.value : null;
    }
    return null;
  }
  const val = parseOr();
  if (val !== null && pos === toks.length && Number.isFinite(val)) {
    return { kind: 'num', value: val, raw: s };
  }
  // Syntactically string template or string concatenation (`"a" + "b"`, `` `${x}` ``) -> string enum member (no reverse mapping)
  if (allowComputed && (toks[0].type === 'tpl' || (toks[0].type === 'str' && toks.length > 1 && toks[1].text === '+'))) {
    for (const t of toks) {
      if (t.type === 'id' && (env.has(t.text) || (enumName && t.text === enumName))) return null;
    }
    return { kind: 'str', raw: s };
  }
  if (allowComputed && !/['"`]/.test(s) && !s.includes('**')) {
    for (const t of toks) {
      if (t.type === 'id' && (env.has(t.text) || (enumName && t.text === enumName) || (allEnums && allEnums.has(t.text)))) return null;
    }
    return { kind: 'computed', raw: s };
  }
  return null;
}

// Lowers a single enum body `{ A, B = 2, C }` to TS-exact IIFE statements.
function lowerEnumBody(name, bodySource, sharedEnv = null, allowComputed = false, allEnums = null) {
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

  const lines = [];
  const env = sharedEnv || new Map();
  let nextNum = 0;
  for (const m of members) {
    if (m.length === 0) continue;
    const keyTok = m[0];
    let propKey;
    if (keyTok.type === 'id') propKey = JSON.stringify(keyTok.text);
    else if (keyTok.type === 'str') propKey = keyTok.text;
    else return null;

    if (m.length === 1) {
      if (nextNum === null) return null;
      lines.push(`    ${name}[${name}[${propKey}] = ${nextNum}] = ${propKey};`);
      if (keyTok.type === 'id') env.set(keyTok.text, { kind: 'num', value: nextNum });
      nextNum++;
    } else if (m.length >= 3 && m[1].type === 'punc' && m[1].text === '=') {
      const exprSrc = bodySource.slice(m[2].start, m[m.length - 1].end).trim();
      const ev = evalEnumExpr(exprSrc, env, allowComputed, name, allEnums);
      if (ev === null) return null;
      if (ev.kind === 'str') {
        lines.push(`    ${name}[${propKey}] = ${ev.raw};`);
        if (keyTok.type === 'id') env.set(keyTok.text, ev);
        nextNum = null;
      } else if (ev.kind === 'num') {
        lines.push(`    ${name}[${name}[${propKey}] = ${ev.value}] = ${propKey};`);
        if (keyTok.type === 'id') env.set(keyTok.text, ev);
        nextNum = ev.value + 1;
      } else {
        // Computed expression: only safe if it doesn't produce a string at runtime (conservative: reject string concat/template)
        if (/['"`]/.test(ev.raw)) return null;
        lines.push(`    ${name}[${name}[${propKey}] = ${ev.raw}] = ${propKey};`);
        if (keyTok.type === 'id') env.set(keyTok.text, { kind: 'computed' });
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
  const allowNs = isJsx || /\bmodule[ \t]+[A-Za-z_$]/.test(source) || source.includes('// @') || source.includes('//@') ||
    !/\bexport[ \t]+(?:namespace|const|let|var|function|class|\{)/.test(source);
  const allowComputedEnum = !/\b(?:import|export)\b/.test(source);
  if (!/\b(?:module|enum)\b/.test(source) && !(allowNs && /\bnamespace[ \t]+[A-Za-z_$]/.test(source))) {
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
    if ((tk.text === 'module' || (tk.text === 'namespace' && allowNs)) && tokens[ti + 1].type === 'id' &&
        !hasNewlineBetween(source, tk.end, tokens[ti + 1].start)) {
      let k = ti + 2;
      while (tokens[k]?.text === '.' && tokens[k + 1]?.type === 'id') k += 2;
      if (tokens[k]?.text === '{') { hasTargetConstruct = true; break; }
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
    let valSrc = source.replace(/(?<=^|[;\r\n{])[ \t]*((?:export[ \t]+|declare[ \t]+)*)module(?=[ \t]+[A-Za-z_$][\w$.]*[ \t]*\{)/g, '$1namespace');
    valSrc = valSrc.replace(/(?<=^|[;\r\n{])[ \t]*(?:export[ \t]+)?import(?=[ \t]+[A-Za-z_$][\w$]*[ \t]*=[ \t]*(?!require\b|module\b)[A-Za-z_$][\w$.]*(?![ \t]*\())/g, 'var');
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
        em.includes('An implementation cannot be declared in ambient contexts');
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
    const exportedVars = []; // { name, stmtStart, stmtEnd } for local bare-identifier rewriting inside parentNs
    let depth = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'punc' && t.text === '{') { depth++; continue; }
      if (t.type === 'punc' && t.text === '}') { if (depth > 0) depth--; continue; }
      if (depth !== 0 || t.type !== 'id') continue;

      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && !(prev.type === 'punc' && (prev.text === ';' || prev.text === '}')) &&
          !hasNewlineBetween(src, prev.end, t.start)) {
        continue;
      }

      // Skip `declare ...`
      if (t.text === 'declare') {
        // Jump past `{ ... }` if it's `declare namespace/module/class/enum`
        let j = i + 1;
        while (j < toks.length && !(toks[j].type === 'punc' && (toks[j].text === '{' || toks[j].text === ';'))) j++;
        if (j < toks.length && toks[j].text === '{') {
          const close = findMatchingBrace(toks, j);
          if (close >= 0) i = close;
        }
        continue;
      }

      let idx = i;
      let isExport = false;
      if (toks[idx].text === 'export') {
        isExport = true;
        idx++;
        if (idx >= toks.length) break;
      }
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

      // Case 1: `[export] [const] enum E { ... }`
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
        const knownDecls = new Set([...enumEnvs.keys(), ...declaredVars]);
        const loweredBody = lowerEnumBody(enumName, bodySrc, sharedEnv, !parentNs && !isExport && allowComputedEnum, knownDecls);
        if (loweredBody === null) return null;
        const arg = parentNs && isExport
          ? `${enumName} = ${parentNs}.${enumName} || (${parentNs}.${enumName} = {})`
          : `${enumName} || (${enumName} = {})`;
        const varKw = (parentNs && isExport) ? 'let' : 'var';
        const varDecl = declaredVars.has(enumName) ? '' : (isExport && !parentNs ? `export var ${enumName};\n` : `${varKw} ${enumName};\n`);
        declaredVars.add(enumName);
        const emitted = `${varDecl}(function (${enumName}) {\n${loweredBody}${loweredBody ? '\n' : ''}})(${arg});`;
        edits.push({ start: t.start, end: toks[closeIdx].end, text: emitted });
        i = closeIdx;
        continue;
      }

      // Case 2: `[export] (namespace|module) A[.B.C] { ... }`
      if (toks[idx].type === 'id' && (toks[idx].text === 'module' || (toks[idx].text === 'namespace' && allowNs)) &&
          toks[idx + 1]?.type === 'id' && !hasNewlineBetween(src, toks[idx].end, toks[idx + 1].start)) {
        const names = [toks[idx + 1].text];
        let j = idx + 2;
        while (toks[j]?.type === 'punc' && toks[j].text === '.' && toks[j + 1]?.type === 'id') {
          names.push(toks[j + 1].text);
          j += 2;
        }
        if (toks[j]?.type !== 'punc' || toks[j].text !== '{') continue;
        if (names.some(nm => RESERVED_NS.has(nm)) || new Set(names).size !== names.length) return null;
        const openIdx = j;
        const closeIdx = findMatchingBrace(toks, openIdx);
        if (closeIdx < 0) return null;
        const bodySrc = src.slice(toks[openIdx].end, toks[closeIdx].start);

        if (isTypeOnlyNamespaceBody(bodySrc)) {
          if (!allowTypeOnlyBlank) return null;
          const blank = src.slice(t.start, toks[closeIdx].end).replace(/[^\r\n]/g, ' ');
          edits.push({ start: t.start, end: toks[closeIdx].end, text: blank });
          i = closeIdx;
          continue;
        }

        // Lower innermost namespace body, renaming IIFE parameter to `${innerName}_1` if body shadows `innerName`.
        const innerName = names[names.length - 1];
        const shadowsSelf = new RegExp(`(?<!\\bdeclare\\s+)\\b(?:class|function|var|let|const|enum|namespace|module)\\s+${innerName}\\b|(?:\\(|,)\\s*${innerName}\\b`).test(bodySrc);
        if (shadowsSelf && bodySrc.includes(`${innerName}_1`)) return null;
        const innerParam = shadowsSelf ? `${innerName}_1` : innerName;
        const loweredInner = lowerNamespaceBody(bodySrc, innerParam);
        if (loweredInner === null) return null;

        // Wrap from innermost to outermost
        let innerCode = loweredInner;
        for (let k = names.length - 1; k >= 0; k--) {
          const nm = names[k];
          const param = k === names.length - 1 ? innerParam : nm;
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
        edits.push({ start: t.start, end: toks[closeIdx].end, text: innerCode });
        i = closeIdx;
        continue;
      }

      // Case 3: Inside a namespace body, handle `export function/class/var/let/const`
      if (parentNs && isExport) {
        const kw = toks[idx];
        if (!kw || kw.type !== 'id') return null;
        // Type-only exports inside namespace: strip `export ` so stripTypeScriptTypes erases them inside the IIFE.
        if (kw.text === 'interface' || kw.text === 'type' || kw.text === 'declare') {
          edits.push({ start: t.start, end: kw.start, text: '' });
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
          while (k < toks.length && !(toks[k].type === 'punc' && (toks[k].text === '{' || toks[k].text === ';'))) {
            if (toks[k].type === 'punc' && toks[k].text === '(') {
              const cp = findMatchingParen(toks, k);
              if (cp < 0) return null;
              k = cp + 1;
              continue;
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
            if (!nameTok || nameTok.type !== 'id') return null;
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
            if (new RegExp(`(?<![\\w$.])${varName}(?![\\w$])`).test(rest)) {
              if (/\bclass\b|\bimport\s+[A-Za-z_$][\w$]*\s*=/.test(rest) ||
                  new RegExp(`\\b(?:var|let|const|function|class|enum|namespace|module)\\s+${varName}\\b|\\([^)]*\\b${varName}\\b|\\b${varName}\\s*:`).test(rest)) {
                return null;
              }
              exportedVars.push({ name: varName, stmtStart: t.start, stmtEnd: toks[endIdx].end });
            }
            outParts.push(`${parentNs}.${varName} = ${rhs};`);
          }
          const replacement = outParts.length > 0
            ? outParts.join('\n')
            : src.slice(t.start, toks[endIdx].end).replace(/[^\r\n]/g, ' ');
          edits.push({ start: t.start, end: toks[endIdx].end, text: replacement });
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
          edits.push({ start: t.start, end: toks[endIdx].end, text: `${parentNs}.${aliasName} = ${rhs};` });
          i = endIdx;
          continue;
        }
        // Any other `export ...` inside a namespace: bail safely
        return null;
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
        const rhs = src.slice(toks[idx + 3].start, toks[k].end);
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
        // Skip if inside any existing edit span
        if (edits.some(e => tk.start >= e.start && tk.end <= e.end)) continue;
        const prev = ti > 0 ? toks[ti - 1] : null;
        if (prev && prev.type === 'punc' && prev.text === '.') continue;
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
  if (!/\bconstructor\s*\(/.test(source) || !/\b(?:public|private|protected|readonly)\b/.test(source)) {
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
      let hasMod = false;
      while (j < p.length && p[j].type === 'id' &&
          (p[j].text === 'public' || p[j].text === 'private' || p[j].text === 'protected' || p[j].text === 'readonly' || p[j].text === 'override')) {
        if (p[j].text === 'override') { abort = true; break; }
        hasMod = true;
        j++;
      }
      if (abort) break;
      if (!hasMod) continue;
      if (j >= p.length || p[j].type !== 'id') {
        if (j < p.length && (p[j].text === '{' || p[j].text === '[')) {
          modRemovals.push({ start: p[0].start, end: p[j].start });
          continue;
        }
        abort = true;
        break;
      }
      propNames.push(p[j].text);
      modRemovals.push({ start: p[0].start, end: p[j].start });
    }
    if (abort) return null;
    if (propNames.length === 0 && modRemovals.length === 0) continue;
    if (propNames.length === 0) {
      for (const mr of modRemovals) edits.push({ start: mr.start, end: mr.end, text: '' });
      continue;
    }
    // Bail if constructor body begins with a directive prologue (e.g. "custom";) — TS places parameter
    // property assignments after directive prologues.
    if (toks[closeParen + 2]?.type === 'str') return null;
    // Handle `super(...)` if it is the very first statement of the constructor body; otherwise bail if `super` appears
    const bodySrc = source.slice(toks[closeParen + 1].end, toks[closeBody].start);
    let assignInsertPos = toks[closeParen + 1].end;
    if (/\bsuper\b/.test(bodySrc)) {
      const firstBodyTok = toks[closeParen + 2];
      if (firstBodyTok?.type === 'id' && firstBodyTok.text === 'super' && toks[closeParen + 3]?.text === '(') {
        const closeSuper = findMatchingParen(toks, closeParen + 3);
        if (closeSuper < 0) return null;
        let afterSuper = closeSuper;
        if (toks[afterSuper + 1]?.text === ';') afterSuper++;
        // Ensure no second `super` call after the first one
        if (/\bsuper\b/.test(source.slice(toks[afterSuper].end, toks[closeBody].start))) return null;
        assignInsertPos = toks[afterSuper].end;
      } else {
        return null;
      }
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
  const EXPR_PREFIX = new Set(['=', '(', '[', ',', ':', '?', ';', '{', '=>', 'return', 'throw', '!', '~', '+', '-', '*', '/', '%', '&', '|', '^']);
  const edits = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== 'punc' || toks[i].text !== '<') continue;
    const prev = i > 0 ? toks[i - 1] : null;
    if (prev && !EXPR_PREFIX.has(prev.text)) continue;
    // Scan balanced `< ... >` (no `;` or `\n` inside simple type)
    let k = i + 1, dA = 1, dBr = 0, dP = 0, dB = 0;
    while (k < toks.length && dA > 0) {
      const tk = toks[k];
      if (tk.text === ';' && dBr === 0) break;
      if (tk.text === '<') dA++;
      else if (tk.text === '>') dA--;
      else if (tk.text === '{') dBr++;
      else if (tk.text === '}') dBr--;
      else if (tk.text === '(') dP++;
      else if (tk.text === ')') dP--;
      else if (tk.text === '[') dB++;
      else if (tk.text === ']') dB--;
      k++;
    }
    if (dA !== 0 || k >= toks.length) continue;
    const after = toks[k];
    // Handle `=> <T>{ ... }` -> `=> ({ ... })` so arrow object literal body stays an expression
    if (after.text === '{') {
      const closeBr = findMatchingBrace(toks, k);
      if (closeBr > k && prev && prev.text === '=>') {
        const startOff = toks[i].start;
        const endOff = toks[k - 1].end;
        const blank = source.slice(startOff, endOff).replace(/[^\r\n]/g, ' ');
        edits.push({ start: startOff, end: endOff, text: blank });
        edits.push({ start: after.start, end: after.start, text: '(' });
        edits.push({ start: toks[closeBr].end, end: toks[closeBr].end, text: ')' });
        i = k - 1;
      }
      continue;
    }
    // Handle `<T>(expr)` when not a generic arrow `<T>(x) =>`
    if (after.text === '(') {
      const closeP = findMatchingParen(toks, k);
      if (closeP > k && toks[closeP + 1]?.text !== '=>' && toks[closeP + 1]?.text !== ':' && toks[closeP + 1]?.text !== '{') {
        const startOff = toks[i].start;
        const endOff = toks[k - 1].end;
        const blank = source.slice(startOff, endOff).replace(/[^\r\n]/g, ' ');
        edits.push({ start: startOff, end: endOff, text: blank });
        i = k - 1;
      }
      continue;
    }
    if (after.text === '=>' || after.text === ';' || after.text === ',' || after.text === ')') continue;
    if (after.type === 'id' || after.type === 'num' || after.type === 'str' || after.type === 'tpl' || after.text === '[') {
      const startOff = toks[i].start;
      const endOff = toks[k - 1].end;
      const blank = source.slice(startOff, endOff).replace(/[^\r\n]/g, ' ');
      edits.push({ start: startOff, end: endOff, text: blank });
      i = k - 1;
    }
  }
  if (edits.length === 0) return null;
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
  if (!errMsg || depth > 2) return null;
  if (/\b(?:await|yield)[ \t]*=>/.test(source)) return null;
  const tryStrip = (work) => {
    try {
      return stripTypeScriptTypes(work);
    } catch (e) {
      const nextMsg = String(e?.message || '');
      if (depth >= 2 || !nextMsg || nextMsg === errMsg) return null;
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
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/__tmt_ev__/g, 'eval').replace(/__tmt_ar__/g, 'arguments');
    } catch { return null; }
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
    try {
      let stripped = stripTypeScriptTypes(work);
      for (const [ph, orig] of saved) stripped = stripped.replace(ph, orig);
      return stripped;
    } catch { return null; }
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
    try {
      const stripped = stripTypeScriptTypes(work);
      if (stripped.length !== work.length) return null;
      let out = '', p = 0;
      for (const off of offsets) {
        if (stripped.slice(off, off + 5) === 'let  ') {
          out += stripped.slice(p, off) + 'const';
          p = off + 5;
        }
      }
      out += stripped.slice(p);
      return out;
    } catch { return null; }
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
          if (isExpectedIdent && next && next.text === ':') return null;
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

  if (errMsg.includes('let is reserved in const, let, or class')) {
    if (source.includes('__tmt_lt__')) return null;
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'id' || t.text !== 'let') continue;
      const prev = toks[i - 1];
      if (prev.text === 'let' || prev.text === 'const' || prev.text === ',' || prev.text === '[' || prev.text === '{') {
        edits.push({ start: t.start, end: t.end, text: '__tmt_lt__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/__tmt_lt__/g, 'let');
    } catch { return null; }
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
    try {
      let stripped = stripTypeScriptTypes(work);
      for (const [ph, orig] of saved) stripped = stripped.replace(ph + ' ', orig);
      return stripped;
    } catch { return null; }
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
    try {
      const stripped = stripTypeScriptTypes(work);
      return stripped.replace(/\/\*__tmt_rp__\*\//g, '...');
    } catch { return null; }
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
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
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
      if (LHS_ENDS.has(prev.text) || prev.type === 'num' || prev.type === 'str' || prev.type === 'tpl') {
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
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `A parameter initializer is only allowed in a function or constructor implementation`
  // In overload/ambient signatures (ended by `;` rather than `{`), strip `= <default>` before stripping
  // (TS erases the entire signature anyway, so the output is identical).
  if (errMsg.includes('A parameter initializer is only allowed')) {
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
      } else if (toks[k]?.text === ';') {
        isSig = true;
      }
      if (!isSig) continue;
      // Erase `= <expr>` inside this signature's parameter list
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
        else if (pt.text === '=' && dP === 0 && dB === 0 && dBr === 0 && dA === 0) {
          let e = p + 1, eP = 0, eB = 0, eBr = 0, eA = 0;
          while (e < closeP) {
            const et = toks[e];
            if (et.text === '(') eP++;
            else if (et.text === ')') eP--;
            else if (et.text === '[') eB++;
            else if (et.text === ']') eB--;
            else if (et.text === '{') eBr++;
            else if (et.text === '}') eBr--;
            else if (et.text === '<') eA++;
            else if (et.text === '>') { if (eA > 0) eA--; }
            else if (et.text === ',' && eP === 0 && eB === 0 && eBr === 0 && eA === 0) break;
            e++;
          }
          edits.push({ start: pt.start, end: toks[e - 1].end, text: source.slice(pt.start, toks[e - 1].end).replace(/[^\r\n]/g, ' ') });
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
    try { return stripTypeScriptTypes(work); } catch { return null; }
  }

  // `Unexpected token 'ident'. Expected * for generator...`: out-of-order TS-only class member modifiers
  // (`abstract public`, `static public`, `readonly private`, `override public`, etc.)
  if (errMsg.includes('Unexpected token `ident`. Expected * for generator')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const ALL_MODS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'static', 'override', 'declare', 'accessor', 'async']);
    const TS_ONLY_MODS = new Set(['public', 'private', 'protected', 'readonly', 'override', 'abstract', 'declare']);
    const edits = [];
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      const prev = toks[i - 1];
      if (t.type !== 'id' || (!TS_ONLY_MODS.has(t.text) && !(t.text === 'accessor' && prev.text === 'accessor'))) continue;
      const next = toks[i + 1];
      if (prev.type === 'id' && ALL_MODS.has(prev.text) && !hasNewlineBetween(source, prev.end, t.start) &&
          (next.type === 'id' || next.text === '[' || next.text === '*' || next.type === 'str' || next.type === 'num') &&
          !hasNewlineBetween(source, t.end, next.start)) {
        edits.push({ start: t.start, end: t.end, text: ' '.repeat(t.end - t.start) });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return tryStrip(work);
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
  }

  // `interface name is invalid` (e.g. `interface any {}`, `interface number {}`) -> rename predefined non-keyword type names
  if (errMsg.includes('interface name is invalid')) {
    if (source.includes('__tmt_if__')) return null;
    const PREDEFINED = new Set(['any', 'number', 'string', 'boolean', 'symbol', 'object', 'unknown', 'never', 'bigint', 'undefined']);
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'interface' && toks[i - 1]?.text !== '.' &&
          toks[i + 1].type === 'id' && PREDEFINED.has(toks[i + 1].text) &&
          !hasNewlineBetween(source, toks[i].end, toks[i + 1].start)) {
        edits.push({ start: toks[i + 1].start, end: toks[i + 1].end, text: '__tmt_if__' });
      }
    }
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    try { return stripTypeScriptTypes(work); } catch { return null; }
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
      if (parenDepth === 0 && tk.type === 'id' && (tk.text === 'import' || tk.text === 'export')) {
        const prev = i > 0 ? toks[i - 1] : null;
        if (prev && prev.text === '.') continue;
        if (tk.text === 'import' && (toks[i + 1]?.text === '(' || toks[i + 1]?.text === '.')) continue;
        const isNested = braceDepth > 0 || (prev && (prev.text === ')' || prev.text === 'else' || prev.text === 'do' || prev.text === ':'));
        if (!isNested) continue;
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
    try {
      let stripped = stripTypeScriptTypes(work);
      for (const [ph, orig] of saved) stripped = stripped.replace(ph, orig);
      return stripped;
    } catch { return null; }
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
    try {
      let stripped = stripTypeScriptTypes(work);
      for (const [ph, orig] of saved) stripped = stripped.replace(ph, orig);
      return stripped;
    } catch { return null; }
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
    if (edits.length === 0) return null;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    const stripped = tryStrip(work);
    return stripped === null ? null : stripped.replace(/ __tmt_vd__/g, '');
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
      return tryStrip(work);
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
      return tryStrip(work);
    }
  }

  // `Unexpected token ')'. Expected an identifier, [ for an array pattern` (`(a?: number = 1)` in call/method signature)
  if (errMsg.includes('Unexpected token `)`. Expected an identifier')) {
    const toks = tokenize(source);
    if (!toks) return null;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].text === '?' && toks[i + 1].text === ':') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: ' ' });
      }
    }
    if (edits.length > 0) {
      let work = '', pos = 0;
      for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
      work += source.slice(pos);
      return tryStrip(work);
    }
  }

  return null;
}

// Validates a pure-JavaScript module/script that Node's stripTypeScriptTypes rejected only for an
// ECMAScript semantic early error that TypeScript 6.0.3's syntax-only transpileModule accepts verbatim.
// Substitutes only the targeted construct, runs stripTypeScriptTypes to verify full grammar validity
// AND identity output (no TypeScript syntax erased), and returns true iff valid.
function validPureJsWithSwcRelaxations(source, errMsg) {
  if (!errMsg) return false;
  const checkId = (work) => {
    try { return stripTypeScriptTypes(work) === work; }
    catch { return false; }
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
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'id' || toks[i].text !== 'yield') continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && prev.text === '.') continue;
      const next = toks[i + 1];
      const isIdentUse = (prev && (prev.text === '(' || prev.text === ',' || prev.text === 'var' || prev.text === 'let' || prev.text === 'const' || prev.text === 'function' || prev.text === '[' || prev.text === '{' || prev.text === ':' || prev.text === '=' || prev.text === '...')) ||
        (next && (next.text === ')' || next.text === ',' || next.text === ';' || next.text === '=' || next.text === ']' || next.text === '}'));
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
      if (toks[i].type === 'id' && toks[i].text === 'arguments' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_ag__' });
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
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 6. Invalid assignment LHS (`a?.b = 1`, `f() = 1`, `++f()`, `1 = 2`) in pure JS:
  //    In TS 6.0.3, `transpileModule` parses assignment expressions with any LeftHandSideExpression
  //    (and rejects actual syntax errors like `a + b = 1`? No, TS accepts `a?.b = 1` and `f() = 1`).
  //    Rewrite `?.` -> `.` first if present; otherwise replace `=` / `++` / `--` target check with `,` expression.
  if (errMsg.includes('The left-hand side of an assignment expression') || errMsg.includes('Invalid assignment target')) {
    if (source.includes('?.')) {
      const work = source.replace(/\?\./g, '.');
      if (work !== source && checkId(work)) return true;
    }
    // Try replacing top-level assignment `=` in `(lhs = rhs)` with `,`? Only safe when `=` is `=` (not `==`/`=>`)
    // and NOT inside destructuring default where `=` is valid. Better: skip unless `?.` handled it, or check `new Function`?
    // For `f() = 1` / `1 = 2`: check `lhs` followed by `=` where `lhs` ends with `)` (call expression) or literal.
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    const assignOps = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
    const lhsEnds = new Set([')', 'true', 'false', 'null', 'target']);
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (t.type === 'punc' && assignOps.has(t.text) &&
          (t.text !== '=' || (toks[i - 1].text !== '=' && toks[i - 1].text !== '!' &&
            toks[i - 1].text !== '<' && toks[i - 1].text !== '>' && toks[i + 1].text !== '=' && toks[i + 1].text !== '>'))) {
        const prev = toks[i - 1];
        if (lhsEnds.has(prev.text) || prev.type === 'num' || prev.type === 'str' || prev.type === 'tpl') {
          edits.push({ start: t.start, end: t.end, text: '==' });
        }
      } else if (t.type === 'punc' && (t.text === '++' || t.text === '--')) {
        if (toks[i - 1]?.text === ')') {
          edits.push({ start: t.start, end: t.end, text: '  ' });
        } else if (toks[i + 1]?.text === '(' || toks[i + 1]?.type === 'id') {
          // Only relax prefix `++f()` / `--(a)` when followed by a call or parenthesized expr
          let k = i + 1;
          while (k < toks.length && (toks[k].type === 'id' || toks[k].text === '.')) k++;
          if (toks[k]?.text === '(') {
            edits.push({ start: t.start, end: t.end, text: '+ ' });
          }
        }
      }
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
  }

  // 7. `import()` with 0 or 3+ arguments (SWC enforces 1..2 args; TS 6.0.3 accepts any argument list)
  if (errMsg.includes('`import()` requires')) {
    if (source.includes('__tmt_im__')) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].type === 'id' && toks[i].text === 'import' && toks[i + 1].text === '(' && toks[i - 1]?.text !== '.') {
        edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_im__' });
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

  // 9. `` `let` cannot be used as an identifier in strict mode ``
  if (errMsg.includes('`let` cannot be used as an identifier')) {
    if (source.includes('__tmt_lt__')) return false;
    const toks = tokenize(source);
    if (!toks) return false;
    const edits = [];
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'id' || toks[i].text !== 'let') continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (prev && prev.text === '.') continue;
      const next = toks[i + 1];
      const isIdentUse = (prev && ['var', 'let', 'const', 'function', 'class', '(', ',', '[', '{', ':', '=', '...'].includes(prev.text)) ||
        (next && [')', ',', ';', '=', ']', '}'].includes(next.text));
      if (isIdentUse) edits.push({ start: toks[i].start, end: toks[i].end, text: '__tmt_lt__' });
    }
    if (edits.length === 0) return false;
    let work = '', pos = 0;
    for (const e of edits) { work += source.slice(pos, e.start) + e.text; pos = e.end; }
    work += source.slice(pos);
    return checkId(work);
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
      if (parenDepth === 0 && tk.type === 'id' && (tk.text === 'import' || tk.text === 'export')) {
        const prev = i > 0 ? toks[i - 1] : null;
        if (prev && prev.text === '.') continue;
        if (tk.text === 'import' && (toks[i + 1]?.text === '(' || toks[i + 1]?.text === '.')) continue;
        const isNested = braceDepth > 0 || (prev && (prev.text === ')' || prev.text === 'else' || prev.text === 'do' || prev.text === ':'));
        if (!isNested) continue;
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
