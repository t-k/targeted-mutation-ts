'use strict';

// Native downlevel lowering for ES2015–ES2020 targets on already-erased JS modules/scripts:
// - ES2021 (year < 2021): logical assignment on plain identifiers (`a ||= rhs`, `a &&= rhs`, `a ??= rhs`)
// - ES2020 (year < 2020): nullish coalescing on plain identifiers (`a ?? rhs`), single-step optional
//   chaining on plain identifiers (`a?.b`, `a?.(args)`, `a?.[idx]`)
// - ES2016 (year < 2016): exponentiation (`a ** b` -> `Math.pow(a, b)`, `a **= rhs` -> `a = Math.pow(a, rhs)`)
// Declines conservatively (returns null) on any ambiguous or multi-step form so TypeScript handles it.

const regexAfter = new Set([
  '', '(', '[', '{', '${', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~', '<', '>', '+', '-', '*', '%', '/', '=>', ')ctrl', '...',
  '||=', '&&=', '??=', '**=', '??', '**', '==', '!=', '===', '!==', '<=', '>=', '<<', '>>', '>>>', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=',
  'return', 'throw', 'case', 'default', 'typeof', 'void', 'delete', 'in', 'instanceof', 'new', 'else', 'do',
]);

const keywords = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

// Tokenizes JS into an array of { type, value, start, end }, or returns null on ambiguous/unsupported syntax.
function tokenize(code) {
  const numLit = /0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?n?|\.\d[\d_]*(?:[eE][+-]?[\d_]+)?/y;
  const tokens = [];
  const braces = [], parens = [];
  let prev = '', at = 0;
  if (code.startsWith('#!')) {
    const start = 0;
    while (at < code.length && code[at] !== '\n' && code[at] !== '\r') at++;
    tokens.push({ type: 'shebang', value: code.slice(start, at), start, end: at });
  }
  const skipTpl = (pos, isTail) => {
    const start = pos - 1;
    while (pos < code.length) {
      const c = code[pos];
      if (c === '\\') { pos += 2; continue; }
      if (c === '`') {
        tokens.push({ type: isTail ? 'tplTail' : 'tpl', value: code.slice(start, pos + 1), start, end: pos + 1 });
        prev = 'lit';
        return pos + 1;
      }
      if (c === '$' && code[pos + 1] === '{') {
        tokens.push({ type: isTail ? 'tplMid' : 'tplHead', value: code.slice(start, pos + 2), start, end: pos + 2 });
        braces.push('tpl');
        prev = '${';
        return pos + 2;
      }
      pos++;
    }
    return -1;
  };
  while (at < code.length) {
    const c = code[at];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { at++; continue; }
    if (c === '/' && code[at + 1] === '/') {
      at += 2;
      while (at < code.length && code[at] !== '\n' && code[at] !== '\r') at++;
      continue;
    }
    if (c === '/' && code[at + 1] === '*') {
      const end = code.indexOf('*/', at + 2);
      if (end < 0) return null;
      at = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = at++;
      while (at < code.length && code[at] !== c) {
        if (code[at] === '\\') at += 2;
        else if (code[at] === '\n' || code[at] === '\r') return null;
        else at++;
      }
      if (at >= code.length) return null;
      at++;
      tokens.push({ type: 'str', value: code.slice(start, at), start, end: at });
      prev = 'lit';
      continue;
    }
    if (c === '`') {
      at = skipTpl(at + 1, false);
      if (at < 0) return null;
      continue;
    }
    if (c === '}') {
      if (braces.length > 0 && braces[braces.length - 1] === 'tpl') {
        braces.pop();
        at = skipTpl(at + 1, true);
        if (at < 0) return null;
        continue;
      }
      if (braces.length > 0) braces.pop();
      tokens.push({ type: 'punc', value: '}', start: at, end: at + 1 });
      prev = '}';
      at++;
      continue;
    }
    if (c === '{') {
      braces.push('{');
      tokens.push({ type: 'punc', value: '{', start: at, end: at + 1 });
      prev = '{';
      at++;
      continue;
    }
    if (c === '(') {
      parens.push(prev === 'if' || prev === 'while' || prev === 'for' || prev === 'with' || prev === 'await-for');
      tokens.push({ type: 'punc', value: '(', start: at, end: at + 1 });
      prev = '(';
      at++;
      continue;
    }
    if (c === ')') {
      prev = parens.pop() ? ')ctrl' : ')';
      tokens.push({ type: 'punc', value: ')', start: at, end: at + 1 });
      at++;
      continue;
    }
    if (c === '/') {
      if (prev === '}' || prev === '++' || prev === '--' || prev === 'of' || prev === 'debugger' || prev === 'break' || prev === 'continue' || prev === 'await' || prev === 'yield') return null;
      if (regexAfter.has(prev)) {
        const start = at++;
        let inClass = false, closed = false;
        while (at < code.length) {
          const rc = code[at];
          if (rc === '\\') { at += 2; continue; }
          if (rc === '\n' || rc === '\r') return null;
          if (inClass) { if (rc === ']') inClass = false; }
          else if (rc === '[') inClass = true;
          else if (rc === '/') { at++; closed = true; break; }
          at++;
        }
        if (!closed) return null;
        while (at < code.length && /[a-z]/i.test(code[at])) at++;
        tokens.push({ type: 'regex', value: code.slice(start, at), start, end: at });
        prev = 'lit';
        continue;
      }
      const len = code[at + 1] === '=' ? 2 : 1;
      tokens.push({ type: 'punc', value: code.slice(at, at + len), start: at, end: at + len });
      prev = '/';
      at += len;
      continue;
    }
    const ch = code.charCodeAt(at);
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36 || ch >= 128) {
      const start = at++;
      while (at < code.length) {
        const u = code.charCodeAt(at);
        if ((u >= 65 && u <= 90) || (u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u === 95 || u === 36 || u >= 128) at++;
        else break;
      }
      const value = code.slice(start, at);
      tokens.push({ type: 'id', value, start, end: at });
      prev = (prev === '.' || prev === '?.') ? 'id' : (prev === 'for' && value === 'await') ? 'await-for' : value;
      continue;
    }
    if ((ch >= 48 && ch <= 57) || (c === '.' && code.charCodeAt(at + 1) >= 48 && code.charCodeAt(at + 1) <= 57)) {
      numLit.lastIndex = at;
      const m = numLit.exec(code);
      if (m === null) return null;
      tokens.push({ type: 'num', value: m[0], start: at, end: numLit.lastIndex });
      at = numLit.lastIndex;
      prev = 'lit';
      continue;
    }
    // Multi-char operators
    const s3 = code.slice(at, at + 3), s2 = code.slice(at, at + 2);
    if (s3 === '||=' || s3 === '&&=' || s3 === '??=' || s3 === '**=' || s3 === '...' || s3 === '===' || s3 === '!==' || s3 === '>>>' || s3 === '<<=' || s3 === '>>=') {
      tokens.push({ type: 'punc', value: s3, start: at, end: at + 3 });
      prev = s3 === '...' ? '...' : s3;
      at += 3;
      continue;
    }
    if (s2 === '?.') {
      const nextCh = code.charCodeAt(at + 2);
      if (!(nextCh >= 48 && nextCh <= 57)) {
        tokens.push({ type: 'punc', value: '?.', start: at, end: at + 2 });
        prev = '?.';
        at += 2;
        continue;
      }
    }
    if (s2 === '??' || s2 === '**' || s2 === '=>' || s2 === '++' || s2 === '--' || s2 === '||' || s2 === '&&' ||
        s2 === '==' || s2 === '!=' || s2 === '<=' || s2 === '>=' || s2 === '<<' || s2 === '>>' ||
        s2 === '+=' || s2 === '-=' || s2 === '*=' || s2 === '%=' || s2 === '&=' || s2 === '|=' || s2 === '^=') {
      tokens.push({ type: 'punc', value: s2, start: at, end: at + 2 });
      prev = s2;
      at += 2;
      continue;
    }
    tokens.push({ type: 'punc', value: c, start: at, end: at + 1 });
    prev = c;
    at++;
  }
  return tokens;
}

function isPlainIdent(tok, prevTok) {
  if (!tok || tok.type !== 'id' || keywords.has(tok.value)) return false;
  if (prevTok && (prevTok.value === '.' || prevTok.value === '?.' || prevTok.value === '#' || prevTok.value === 'delete' || prevTok.value === 'typeof' || prevTok.value === 'new' || prevTok.value === '++' || prevTok.value === '--')) return false;
  return true;
}

// Finds the end token index (exclusive) of a single-line balanced expression starting at `from`,
// stopping at a top-level delimiter in `stopSet`. Returns -1 if a newline occurs at depth 0
// (to avoid ASI ambiguity) or if a forbidden top-level token is encountered.
function scanExprEnd(tokens, from, stopSet, code, forbidTop) {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (depth === 0 && i > from && /[\r\n]/.test(code.slice(tokens[i - 1].end, t.start))) {
      return -1;
    }
    if (t.value === '(' || t.value === '[' || t.value === '{' || t.type === 'tplHead') { depth++; continue; }
    if (t.type === 'tplMid') continue;
    if (t.value === ')' || t.value === ']' || t.value === '}' || t.type === 'tplTail') {
      if (depth === 0) return i;
      depth--;
      continue;
    }
    if (depth === 0 && stopSet.has(t.value)) return i;
    if (depth === 0 && forbidTop && forbidTop.has(t.value)) return -1;
  }
  return depth === 0 ? tokens.length : -1;
}

// Finds matching closing delimiter index for `(`, `[`, or `{` at `openIdx`.
function findClose(tokens, openIdx) {
  const open = tokens[openIdx].value;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (v === '(' || v === '[' || v === '{' || tokens[i].type === 'tplHead') depth++;
    else if (tokens[i].type === 'tplMid') continue;
    else if (v === ')' || v === ']' || v === '}' || tokens[i].type === 'tplTail') {
      depth--;
      if (depth === 0) return v === close ? i : -1;
    }
  }
  return -1;
}

// Checks whether the `class` at `classIdx` has only methods, constructors, and getters/setters
// (no class fields, static blocks, or private members), whose emit is identical from ES2015 to ESNext.
function isMethodOnlyClass(tokens, classIdx, code) {
  let braceIdx = -1;
  let parenDepth = 0, bracketDepth = 0;
  for (let i = classIdx + 1; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (v === '(') parenDepth++;
    else if (v === ')') { if (parenDepth === 0) return false; parenDepth--; }
    else if (v === '[') bracketDepth++;
    else if (v === ']') { if (bracketDepth === 0) return false; bracketDepth--; }
    else if (parenDepth === 0 && bracketDepth === 0) {
      if (v === '{') { braceIdx = i; break; }
      if (v === ';' || v === 'class' || v === 'function' || v === '=>') return false;
    }
  }
  if (braceIdx < 0) return false;
  const closeBrace = findClose(tokens, braceIdx);
  if (closeBrace < 0) return false;
  let i = braceIdx + 1;
  while (i < closeBrace) {
    if (tokens[i].value === ';') { i++; continue; }
    // Optional modifiers: static, async (no line terminator before next token), *, get/set
    if (tokens[i].type === 'id' && tokens[i].value === 'static') {
      if (i + 1 < closeBrace && tokens[i + 1].value === '{') return false; // static block
      if (i + 1 < closeBrace && tokens[i + 1].value !== '(') i++;
    }
    if (i < closeBrace && tokens[i].type === 'id' && tokens[i].value === 'async') {
      if (i + 1 < closeBrace && tokens[i + 1].value !== '(') {
        if (/[\r\n]/.test(code.slice(tokens[i].end, tokens[i + 1].start))) return false;
        i++;
      }
    }
    if (i < closeBrace && tokens[i].value === '*') i++;
    if (i < closeBrace && tokens[i].type === 'id' && (tokens[i].value === 'get' || tokens[i].value === 'set')) {
      if (i + 1 < closeBrace && tokens[i + 1].value !== '(') i++;
    }
    if (i >= closeBrace) return false;
    // Member name: identifier, string, number, or computed `[expr]`
    if (tokens[i].value === '[') {
      const closeBracket = findClose(tokens, i);
      if (closeBracket < 0 || closeBracket >= closeBrace) return false;
      i = closeBracket + 1;
    } else if (tokens[i].type === 'id' || tokens[i].type === 'str' || tokens[i].type === 'num') {
      i++;
    } else {
      return false;
    }
    // Must be followed by `(params) { body }` (a method/constructor/accessor, not a field).
    if (i >= closeBrace || tokens[i].value !== '(') return false;
    const closeParen = findClose(tokens, i);
    if (closeParen < 0 || closeParen >= closeBrace) return false;
    i = closeParen + 1;
    if (i >= closeBrace || tokens[i].value !== '{') return false;
    const closeBody = findClose(tokens, i);
    if (closeBody < 0 || closeBody >= closeBrace) return false;
    i = closeBody + 1;
  }
  return true;
}

function lowerDownlevel(code, year) {
  if (year >= 2022) return code;
  if (code.includes('\\u')) return null;
  const tokens = tokenize(code);
  if (tokens === null) return null;

  // Below ES2022, any real `class` keyword token in code must be a method-only class
  // (classes with fields, static blocks, or parameter properties decline to TypeScript).
  if (year < 2022) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const prev = i > 0 ? tokens[i - 1] : null;
      const next = tokens[i + 1];
      if (t.type === 'id' && t.value === 'class' &&
          (!prev || (prev.value !== '.' && prev.value !== '?.')) &&
          (!next || next.value !== ':')) {
        if (!isMethodOnlyClass(tokens, i, code)) return null;
      }
    }
  }
  if (year >= 2021) return code;

  const needLogAssign = year < 2021;
  const needNullish = year < 2020;
  const needOptChain = year < 2020;
  const needExp = year < 2016;

  // Reject if Math could be locally shadowed when lowering ** / **=.
  const hasExp = needExp && tokens.some(t => t.value === '**' || t.value === '**=');
  if (hasExp && tokens.some((tk, idx) => tk.type === 'id' && tk.value === 'Math' &&
      (idx === 0 || tokens[idx - 1].value !== '.') &&
      (idx + 1 >= tokens.length || tokens[idx + 1].value !== '.'))) return null;

  const edits = []; // [start, end, replacement]
  const stmtStarts = new Set([';', '{', '}', ',', '(', '=>', 'return', 'throw', 'else', 'do']);
  const forbidInNullishRhs = new Set(['||', '&&', '?', ':', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '=>']);
  const expUnsafePrev = new Set(['.', '?.', '++', '--', '**', '+', '-', '!', '~', 'typeof', 'void', 'delete', 'await', 'new', 'yield']);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const prev2 = i > 1 ? tokens[i - 2] : null;

    // 1. Logical assignment: `id ||= rhs`, `id &&= rhs`, `id ??= rhs`
    if (needLogAssign && (t.value === '||=' || t.value === '&&=' || t.value === '??=')) {
      if (!isPlainIdent(prev, prev2)) return null;
      if (prev2 && !stmtStarts.has(prev2.value)) return null;
      const rhsEndIdx = scanExprEnd(tokens, i + 1, new Set([';', ',', ')', ']', '}']), code, null);
      if (rhsEndIdx <= i + 1) return null;
      // Decline nested downlevel operators inside RHS (multi-pass not needed for simple forms).
      for (let k = i + 1; k < rhsEndIdx; k++) {
        const v = tokens[k].value;
        if (v === '||=' || v === '&&=' || v === '??=' || (needNullish && v === '??') || (needOptChain && v === '?.') || (needExp && (v === '**' || v === '**='))) return null;
      }
      const rhsStart = tokens[i + 1].start;
      const rhsEnd = tokens[rhsEndIdx - 1].end;
      const id = prev.value;
      const rhs = code.slice(rhsStart, rhsEnd);
      let rep;
      if (t.value === '||=') rep = `${id} || (${id} = ${rhs})`;
      else if (t.value === '&&=') rep = `${id} && (${id} = ${rhs})`;
      else if (year >= 2020) rep = `${id} ?? (${id} = ${rhs})`;
      else rep = `${id} !== null && ${id} !== void 0 ? ${id} : (${id} = ${rhs})`;
      edits.push([prev.start, rhsEnd, rep]);
      i = rhsEndIdx - 1;
      continue;
    }

    // 2. Nullish coalescing: `id ?? rhs`
    if (needNullish && t.value === '??') {
      if (!isPlainIdent(prev, prev2)) return null;
      if (prev2 && !new Set(['=', '(', '[', ',', ';', ':', '?', 'return', '=>', '{', 'throw']).has(prev2.value)) return null;
      const rhsEndIdx = scanExprEnd(tokens, i + 1, new Set([';', ',', ')', ']', '}']), code, forbidInNullishRhs);
      if (rhsEndIdx <= i + 1) return null;
      for (let k = i + 1; k < rhsEndIdx; k++) {
        const v = tokens[k].value;
        if (v === '??' || v === '?.' || v === '||=' || v === '&&=' || v === '??=' || (needExp && (v === '**' || v === '**='))) return null;
      }
      const id = prev.value;
      const rhs = code.slice(tokens[i + 1].start, tokens[rhsEndIdx - 1].end);
      const wrap = prev2 && prev2.value !== '=' && prev2.value !== 'return' && prev2.value !== '(' && prev2.value !== ',' && prev2.value !== ';';
      const core = `${id} !== null && ${id} !== void 0 ? ${id} : ${rhs}`;
      edits.push([prev.start, tokens[rhsEndIdx - 1].end, wrap ? `(${core})` : core]);
      i = rhsEndIdx - 1;
      continue;
    }

    // 3. Single-step optional chaining: `id?.prop`, `id?.(args)`, `id?.[idx]`
    if (needOptChain && t.value === '?.') {
      if (!isPlainIdent(prev, prev2) || prev.value === 'eval') return null;
      if (prev2 && (prev2.value === 'delete' || prev2.value === 'new')) return null;
      const next = tokens[i + 1];
      if (!next) return null;
      let chainEndIdx = -1, access = '';
      if (next.type === 'id') {
        chainEndIdx = i + 2;
        access = `.${next.value}`;
        // Allow a single method call `id?.prop(args)` or chained property `.prop2` when no nested downlevel ops appear.
        const nextAfter = tokens[chainEndIdx];
        if (nextAfter && nextAfter.value === '(') {
          const closeIdx = findClose(tokens, chainEndIdx);
          if (closeIdx < 0) return null;
          for (let k = chainEndIdx + 1; k < closeIdx; k++) {
            const v = tokens[k].value;
            if (v === '?.' || v === '??' || v === '||=' || v === '&&=' || v === '??=' || (needExp && (v === '**' || v === '**='))) return null;
          }
          access += code.slice(next.end, tokens[closeIdx].end);
          chainEndIdx = closeIdx + 1;
        }
      } else if (next.value === '(' || next.value === '[') {
        const closeIdx = findClose(tokens, i + 1);
        if (closeIdx < 0) return null;
        for (let k = i + 2; k < closeIdx; k++) {
          const v = tokens[k].value;
          if (v === '?.' || v === '??' || v === '||=' || v === '&&=' || v === '??=' || (needExp && (v === '**' || v === '**='))) return null;
        }
        chainEndIdx = closeIdx + 1;
        access = code.slice(next.start, tokens[closeIdx].end);
      } else return null;
      // Decline chained continuations (`a?.b?.c`, `a?.b.c`, `a?.b()`, `a?.b = 1`) and parenthesized
      // call/delete (`(a?.b)()`, `delete (a?.b)`) so TypeScript handles temps/short-circuiting/`this`.
      const after = tokens[chainEndIdx];
      if (after && (after.value === '?.' || after.value === '.' || after.value === '(' || after.value === '[' || after.value === '=' || after.value === '++' || after.value === '--' || after.type === 'tpl' || after.type === 'tplHead')) return null;
      if (prev2 && prev2.value === '(' && after && after.value === ')') {
        const beforeParen = i > 2 ? tokens[i - 3] : null;
        const afterParen = tokens[chainEndIdx + 1];
        if (beforeParen && (beforeParen.value === 'delete' || beforeParen.value === 'new')) return null;
        if (afterParen && (afterParen.value === '(' || afterParen.value === '[' || afterParen.value === '.' || afterParen.value === '?.' || afterParen.type === 'tpl' || afterParen.type === 'tplHead')) return null;
      }
      const id = prev.value;
      const safeUnwrapped = (!prev2 || new Set(['=', '(', '[', ',', ';', ':', '?', 'return', '=>', '{']).has(prev2.value)) &&
        (!after || new Set([';', ',', ')', ']', '}', ':']).has(after.value));
      // Never prepend `(` after a newline (would break ASI, e.g. `g()\na?.b;`).
      if (!safeUnwrapped && prev2 && /[\r\n]/.test(code.slice(prev2.end, prev.start))) return null;
      const core = `${id} === null || ${id} === void 0 ? void 0 : ${id}${access}`;
      edits.push([prev.start, tokens[chainEndIdx - 1].end, safeUnwrapped ? core : `(${core})`]);
      i = chainEndIdx - 1;
      continue;
    }

    // 4. Exponentiation: `a ** b` and `id **= rhs`
    if (needExp && t.value === '**=') {
      if (!isPlainIdent(prev, prev2)) return null;
      if (prev2 && !stmtStarts.has(prev2.value)) return null;
      const rhsEndIdx = scanExprEnd(tokens, i + 1, new Set([';', ',', ')', ']', '}']), code, null);
      if (rhsEndIdx <= i + 1) return null;
      for (let k = i + 1; k < rhsEndIdx; k++) {
        const v = tokens[k].value;
        if (v === '**' || v === '**=' || v === '?.' || v === '??' || v === '||=' || v === '&&=' || v === '??=') return null;
      }
      const id = prev.value;
      const rhs = code.slice(tokens[i + 1].start, tokens[rhsEndIdx - 1].end);
      edits.push([prev.start, tokens[rhsEndIdx - 1].end, `${id} = Math.pow(${id}, ${rhs})`]);
      i = rhsEndIdx - 1;
      continue;
    }
    if (needExp && t.value === '**') {
      const next = tokens[i + 1];
      const after = tokens[i + 2];
      const lhsOk = prev && ((prev.type === 'num' && !prev.value.endsWith('n')) || isPlainIdent(prev, prev2));
      const rhsOk = next && ((next.type === 'num' && !next.value.endsWith('n')) || (next.type === 'id' && !keywords.has(next.value)));
      if (!lhsOk || !rhsOk) return null;
      if (prev2 && expUnsafePrev.has(prev2.value)) return null;
      if (after && (after.value === '**' || after.value === '.' || after.value === '?.' || after.value === '(' || after.value === '[' || after.value === '++' || after.value === '--' || after.type === 'tpl' || after.type === 'tplHead')) return null;
      const mid1 = code.slice(prev.end, t.start).trim();
      const mid2 = code.slice(t.end, next.start).trim();
      const lhsOut = mid1 ? `${prev.value} ${mid1}` : prev.value;
      const rhsOut = mid2 ? `${mid2} ${next.value}` : next.value;
      edits.push([prev.start, next.end, `Math.pow(${lhsOut}, ${rhsOut})`]);
      i += 1;
      continue;
    }
  }

  if (edits.length === 0) return code;
  // Ensure edits are strictly non-overlapping and ordered.
  let out = '', last = 0;
  for (const [start, end, rep] of edits) {
    if (start < last) return null;
    out += code.slice(last, start) + rep;
    last = end;
  }
  return out + code.slice(last);
}

module.exports = { lowerDownlevel };
