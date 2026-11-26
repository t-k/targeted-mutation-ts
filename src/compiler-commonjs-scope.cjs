'use strict';

// Conservative lexical-scope analyzer for CommonJS import-shadowing recovery.
// Only invoked on modules where an imported name appears in a non-reference position
// (e.g. a local parameter or `const`/`let`/`catch` binding). Returns a Map from
// shadowed name to an array of [start, end] byte spans where that name is bound locally,
// or null whenever scoping cannot be proven with certainty (caller declines to TypeScript).

const REGEX_AFTER = new Set([
  '', '(', '[', '{', '${', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~',
  '<', '>', '+', '-', '*', '%', '/', '=>', ')ctrl',
  'return', 'throw', 'case', 'yield', 'await', 'typeof', 'void', 'delete',
  'in', 'instanceof', 'new', 'else', 'do',
]);

function tokenizeJs(text) {
  const tokens = [];
  const braces = [];
  const parens = [];
  let prev = '';
  let at = 0;

  const skipTemplate = pos => {
    const start = pos - 1;
    while (pos < text.length) {
      const c = text[pos];
      if (c === '\\') { pos += 2; continue; }
      if (c === '`') {
        tokens.push({ type: 'tpl', value: '`', start, end: pos + 1 });
        prev = 'lit';
        return pos + 1;
      }
      if (c === '$' && text[pos + 1] === '{') {
        tokens.push({ type: 'punc', value: '${', start: pos, end: pos + 2 });
        braces.push('template');
        prev = '${';
        return pos + 2;
      }
      pos++;
    }
    return -1;
  };

  while (at < text.length) {
    const c = text[at];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f') { at++; continue; }
    if (c === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at + 2);
      at = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      if (end < 0) return null;
      at = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = at++;
      while (at < text.length && text[at] !== c) {
        if (text[at] === '\\') at += 2;
        else if (text[at] === '\n') return null;
        else at++;
      }
      if (at >= text.length) return null;
      at++;
      tokens.push({ type: 'str', value: c, start, end: at });
      prev = 'lit';
      continue;
    }
    if (c === '`') {
      at = skipTemplate(at + 1);
      if (at < 0) return null;
      continue;
    }
    if (c === '}') {
      if (braces.length > 0 && braces[braces.length - 1] === 'template') {
        tokens.push({ type: 'punc', value: '}', start: at, end: at + 1, templateClose: true });
        braces.pop();
        at = skipTemplate(at + 1);
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
      const ctrl = prev === 'if' || prev === 'while' || prev === 'for' || prev === 'with' || prev === 'await-for' || prev === 'switch';
      parens.push(ctrl);
      tokens.push({ type: 'punc', value: '(', start: at, end: at + 1, ctrl });
      prev = '(';
      at++;
      continue;
    }
    if (c === ')') {
      const ctrl = parens.pop() || false;
      tokens.push({ type: 'punc', value: ')', start: at, end: at + 1, ctrl });
      prev = ctrl ? ')ctrl' : ')';
      at++;
      continue;
    }
    if (c === '/') {
      if (prev === '}' || prev === '++' || prev === '--' || prev === 'of' || prev === 'debugger' || prev === 'break' || prev === 'continue') return null;
      if (REGEX_AFTER.has(prev)) {
        const start = at++;
        let inClass = false;
        while (at < text.length) {
          const rc = text[at];
          if (rc === '\\') { at += 2; continue; }
          if (rc === '\n') return null;
          if (inClass) { if (rc === ']') inClass = false; }
          else if (rc === '[') inClass = true;
          else if (rc === '/') { at++; break; }
          at++;
        }
        while (at < text.length && /[a-z]/i.test(text[at])) at++;
        tokens.push({ type: 'regex', value: '/', start, end: at });
        prev = 'lit';
        continue;
      }
      const start = at;
      at += text[at + 1] === '=' ? 2 : 1;
      tokens.push({ type: 'punc', value: text.slice(start, at), start, end: at });
      prev = '/';
      continue;
    }
    const code = text.charCodeAt(at);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36) {
      const start = at++;
      while (at < text.length) {
        const u = text.charCodeAt(at);
        if ((u >= 65 && u <= 90) || (u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u === 95 || u === 36) at++;
        else break;
      }
      const value = text.slice(start, at);
      tokens.push({ type: 'id', value, start, end: at, afterDot: prev === '.' });
      prev = prev === '.' ? 'id' : (prev === 'for' && value === 'await') ? 'await-for' : value;
      continue;
    }
    if (code >= 48 && code <= 57) {
      const start = at;
      const radix = c === '0' && (text[at + 1] === 'x' || text[at + 1] === 'X' || text[at + 1] === 'b' || text[at + 1] === 'B' || text[at + 1] === 'o' || text[at + 1] === 'O');
      at++;
      while (at < text.length) {
        const u = text.charCodeAt(at);
        if ((u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || u === 95 || u === 46) {
          if (!radix && (u === 69 || u === 101) && (text[at + 1] === '+' || text[at + 1] === '-')) at += 2;
          else at++;
        } else break;
      }
      tokens.push({ type: 'num', value: '0', start, end: at });
      prev = 'lit';
      continue;
    }
    if (c === '.' && text[at + 1] === '.' && text[at + 2] === '.') {
      tokens.push({ type: 'punc', value: '...', start: at, end: at + 3 });
      prev = '...';
      at += 3;
      continue;
    }
    if (c === '?' && text[at + 1] === '.' && !(text.charCodeAt(at + 2) >= 48 && text.charCodeAt(at + 2) <= 57)) {
      tokens.push({ type: 'punc', value: '?.', start: at, end: at + 2 });
      prev = '.';
      at += 2;
      continue;
    }
    if (c === '=' && text[at + 1] === '>') {
      tokens.push({ type: 'punc', value: '=>', start: at, end: at + 2 });
      prev = '=>';
      at += 2;
      continue;
    }
    if ((c === '+' && text[at + 1] === '+') || (c === '-' && text[at + 1] === '-')) {
      tokens.push({ type: 'punc', value: c + c, start: at, end: at + 2 });
      prev = c + c;
      at += 2;
      continue;
    }
    if (c === '=' && text[at + 1] === '=') {
      const len = text[at + 2] === '=' ? 3 : 2;
      tokens.push({ type: 'punc', value: text.slice(at, at + len), start: at, end: at + len });
      prev = '==';
      at += len;
      continue;
    }
    if (c === '!' && text[at + 1] === '=') {
      const len = text[at + 2] === '=' ? 3 : 2;
      tokens.push({ type: 'punc', value: text.slice(at, at + len), start: at, end: at + len });
      prev = '!=';
      at += len;
      continue;
    }
    if ((c === '&' && text[at + 1] === '&') || (c === '|' && text[at + 1] === '|') || (c === '?' && text[at + 1] === '?')) {
      const len = text[at + 2] === '=' ? 3 : 2;
      tokens.push({ type: 'punc', value: text.slice(at, at + len), start: at, end: at + len });
      prev = c;
      at += len;
      continue;
    }
    if (c === '*') {
      tokens.push({ type: 'punc', value: '*', start: at, end: at + 1 });
      prev = prev === 'function' ? 'function*' : '*';
      at++;
      continue;
    }
    tokens.push({ type: 'punc', value: c, start: at, end: at + 1 });
    prev = c;
    at++;
  }
  return tokens;
}

// Extracts bound identifier names from a binding pattern starting at `idx` up to `limit` (exclusive).
// Returns `{ names, nextIdx, hasWatchedExpr }` or `null` if the pattern is malformed/unsupported.
function parsePattern(tokens, idx, limit, matchClose, watchedNames) {
  const names = [];
  let hasWatchedExpr = false;

  function scanExprForWatched(from, to) {
    for (let k = from; k < to; k++) {
      if (tokens[k].type === 'id' && !tokens[k].afterDot && watchedNames.has(tokens[k].value)) {
        hasWatchedExpr = true;
        return;
      }
    }
  }

  function skipExprUntil(pos, stopLimit, stopOnComma) {
    let i = pos;
    while (i < stopLimit) {
      const v = tokens[i].value;
      if (v === '(' || v === '[' || v === '{' || v === '${') {
        const close = matchClose[i];
        if (close < 0 || close >= stopLimit) return -1;
        i = close + 1;
        continue;
      }
      if (stopOnComma && v === ',') return i;
      if (v === ')' || v === ']' || v === '}' || v === ';') return i;
      i++;
    }
    return i;
  }

  function walk(pos, endLimit) {
    if (pos >= endLimit) return -1;
    const t = tokens[pos];
    if (t.value === '...') return walk(pos + 1, endLimit);
    if (t.type === 'id') {
      names.push(t.value);
      return pos + 1;
    }
    if (t.value === '[') {
      const close = matchClose[pos];
      if (close < 0 || close >= endLimit) return -1;
      let i = pos + 1;
      while (i < close) {
        if (tokens[i].value === ',') { i++; continue; }
        i = walk(i, close);
        if (i < 0) return -1;
        if (i < close && tokens[i].value === '=') {
          const exprStart = i + 1;
          i = skipExprUntil(exprStart, close, true);
          if (i < 0) return -1;
          scanExprForWatched(exprStart, i);
        }
        if (i < close) {
          if (tokens[i].value !== ',') return -1;
          i++;
        }
      }
      return close + 1;
    }
    if (t.value === '{') {
      const close = matchClose[pos];
      if (close < 0 || close >= endLimit) return -1;
      let i = pos + 1;
      while (i < close) {
        if (tokens[i].value === ',') { i++; continue; }
        if (tokens[i].value === '...') {
          i = walk(i + 1, close);
          if (i < 0) return -1;
          if (i < close && tokens[i].value === ',') i++;
          continue;
        }
        // Property key: computed `[expr]: pat`, string/num `k: pat`, or identifier `k` / `k: pat` / `k = def`
        if (tokens[i].value === '[') {
          const kClose = matchClose[i];
          if (kClose < 0 || kClose >= close) return -1;
          scanExprForWatched(i + 1, kClose);
          i = kClose + 1;
          if (i >= close || tokens[i].value !== ':') return -1;
          i = walk(i + 1, close);
          if (i < 0) return -1;
        } else if (tokens[i].type === 'str' || tokens[i].type === 'num') {
          i++;
          if (i >= close || tokens[i].value !== ':') return -1;
          i = walk(i + 1, close);
          if (i < 0) return -1;
        } else if (tokens[i].type === 'id') {
          if (i + 1 < close && tokens[i + 1].value === ':') {
            i = walk(i + 2, close);
            if (i < 0) return -1;
          } else {
            names.push(tokens[i].value);
            i++;
          }
        } else {
          return -1;
        }
        if (i < close && tokens[i].value === '=') {
          const exprStart = i + 1;
          i = skipExprUntil(exprStart, close, true);
          if (i < 0) return -1;
          scanExprForWatched(exprStart, i);
        }
        if (i < close) {
          if (tokens[i].value !== ',') return -1;
          i++;
        }
      }
      return close + 1;
    }
    return -1;
  }

  const nextIdx = walk(idx, limit);
  if (nextIdx < 0) return null;
  return { names, nextIdx, hasWatchedExpr };
}

function findArrowExprEnd(tokens, startIdx, matchClose, text) {
  let i = startIdx;
  let ternaryDepth = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.value === ',' || t.value === ';' || t.value === ')' || t.value === ']' || t.value === '}') {
      return i > startIdx ? tokens[i - 1].end : -1;
    }
    if (t.value === ':') {
      if (ternaryDepth === 0) return i > startIdx ? tokens[i - 1].end : -1;
      ternaryDepth--;
      i++;
      continue;
    }
    // Decline conservatively when an unbracketed arrow body crosses a line break (avoids ASI / multiline operator ambiguity).
    if (i > startIdx && text.slice(tokens[i - 1].end, t.start).includes('\n')) {
      return -1;
    }
    if (t.value === '(' || t.value === '[' || t.value === '{' || t.value === '${') {
      const close = matchClose[i];
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (t.value === '?') {
      ternaryDepth++;
    }
    i++;
  }
  return i > startIdx ? tokens[i - 1].end : -1;
}

function collectShadowedSpans(text, watchedNames) {
  if (watchedNames.size === 0) return new Map();
  const tokens = tokenizeJs(text);
  if (tokens === null) return null;

  // Match all (), [], {}, ${...}
  const matchClose = new Int32Array(tokens.length).fill(-1);
  const matchOpen = new Int32Array(tokens.length).fill(-1);
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (v === '(' || v === '[' || v === '{' || v === '${') {
      stack.push(i);
    } else if (v === ')' || v === ']' || v === '}') {
      if (stack.length === 0) return null;
      const open = stack.pop();
      const ov = tokens[open].value;
      if ((ov === '(' && v !== ')') || (ov === '[' && v !== ']') || ((ov === '{' || ov === '${') && v !== '}')) return null;
      matchClose[open] = i;
      matchOpen[i] = open;
    }
  }
  if (stack.length !== 0) return null;

  const isPrecededByDecorator = (toks, idx) => {
    let k = idx - 1;
    if (k < 0) return false;
    // Walk backwards through `@Dec`, `@a.b(...)`, `@(expr)`
    if (toks[k].value === ')') {
      const open = matchOpen[k];
      if (open < 0) return false;
      k = open - 1;
    }
    while (k >= 0) {
      if (toks[k].value === '@') return true;
      if (toks[k].type === 'id' || toks[k].value === '.') { k--; continue; }
      break;
    }
    return false;
  };

  // Reject dynamic scope (`eval`, `with`).
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'id' && !t.afterDot && (t.value === 'with' || (t.value === 'eval' && tokens[i + 1]?.value === '('))) {
      return null;
    }
  }

  const spans = new Map();
  const addSpan = (name, start, end) => {
    if (!watchedNames.has(name)) return;
    let list = spans.get(name);
    if (list === undefined) { list = []; spans.set(name, list); }
    list.push([start, end]);
  };

  // Track enclosing `{` token indices for block-scoped declarations.
  const braceStack = [];
  const braceEnds = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.value === '{' || t.value === '${') {
      braceStack.push(i);
      braceEnds.push(matchClose[i]);
      continue;
    }
    if (t.value === '}') {
      braceStack.pop();
      braceEnds.pop();
      continue;
    }

    // 1. Single-parameter arrow function: `id => ...`
    if (t.type === 'id' && !t.afterDot && tokens[i + 1]?.value === '=>') {
      if (watchedNames.has(t.value)) {
        const bodyIdx = i + 2;
        if (bodyIdx >= tokens.length) return null;
        let endByte;
        if (tokens[bodyIdx].value === '{') {
          const close = matchClose[bodyIdx];
          if (close < 0) return null;
          endByte = tokens[close].end;
        } else {
          endByte = findArrowExprEnd(tokens, bodyIdx, matchClose, text);
          if (endByte < 0) return null;
        }
        addSpan(t.value, t.start, endByte);
      }
      continue;
    }

    // 2. Parenthesized parameter list: `(...) => ...`, `function f(...) { ... }`, `m(...) { ... }`, `catch (...) { ... }`
    if (t.value === '(' && !t.ctrl) {
      const close = matchClose[i];
      if (close < 0) return null;
      const after = tokens[close + 1];
      if (!after) continue;
      const isArrow = after.value === '=>';
      const isCatch = i > 0 && tokens[i - 1].type === 'id' && !tokens[i - 1].afterDot && tokens[i - 1].value === 'catch';
      // For `(...) { ... }`, distinguish a function/method parameter list from a call followed by a block on the next line (`g(a)\n{ ... }`).
      const isFnKeywordHead =
        (i >= 1 && tokens[i - 1].type === 'id' && !tokens[i - 1].afterDot && tokens[i - 1].value === 'function') ||
        (i >= 2 && tokens[i - 1].value === '*' && tokens[i - 2].type === 'id' && !tokens[i - 2].afterDot && tokens[i - 2].value === 'function') ||
        (i >= 2 && tokens[i - 1].type === 'id' && tokens[i - 2].type === 'id' && !tokens[i - 2].afterDot && tokens[i - 2].value === 'function') ||
        (i >= 3 && tokens[i - 1].type === 'id' && tokens[i - 2].value === '*' && tokens[i - 3].type === 'id' && !tokens[i - 3].afterDot && tokens[i - 3].value === 'function');
      const isSameLineMethod = after.value === '{' && !isCatch && !text.slice(tokens[close].end, after.start).includes('\n');
      const isBlockFn = after.value === '{' && !isCatch && (isFnKeywordHead || isSameLineMethod);
      if (!isArrow && !isCatch && !isBlockFn) continue;

      // Quick scan inside `(...)` to see if any watched name appears at all.
      let hasWatched = false;
      for (let k = i + 1; k < close; k++) {
        if (tokens[k].type === 'id' && !tokens[k].afterDot && watchedNames.has(tokens[k].value)) {
          hasWatched = true;
          break;
        }
      }
      if (!hasWatched) continue;

      // Parse parameter list elements.
      const paramNames = [];
      let p = i + 1;
      while (p < close) {
        if (tokens[p].value === ',') { p++; continue; }
        const pat = parsePattern(tokens, p, close, matchClose, watchedNames);
        if (pat === null || pat.hasWatchedExpr) return null;
        for (const n of pat.names) paramNames.push(n);
        p = pat.nextIdx;
        if (p < close && tokens[p].value === '=') {
          const exprStart = p + 1;
          while (p < close) {
            const v = tokens[p].value;
            if (v === '(' || v === '[' || v === '{' || v === '${') {
              const c = matchClose[p];
              if (c < 0 || c >= close) return null;
              p = c + 1;
              continue;
            }
            if (v === ',') break;
            p++;
          }
          for (let k = exprStart; k < p; k++) {
            if (tokens[k].type === 'id' && !tokens[k].afterDot && watchedNames.has(tokens[k].value)) return null;
          }
        }
        if (p < close) {
          if (tokens[p].value !== ',') return null;
          p++;
        }
      }
      let bodyEnd;
      if (isArrow) {
        const bodyIdx = close + 2;
        if (bodyIdx >= tokens.length) return null;
        if (tokens[bodyIdx].value === '{') {
          const bClose = matchClose[bodyIdx];
          if (bClose < 0) return null;
          bodyEnd = tokens[bClose].end;
        } else {
          bodyEnd = findArrowExprEnd(tokens, bodyIdx, matchClose, text);
          if (bodyEnd < 0) return null;
        }
      } else {
        const bClose = matchClose[close + 1];
        if (bClose < 0) return null;
        bodyEnd = tokens[bClose].end;
      }
      for (const n of paramNames) addSpan(n, t.start, bodyEnd);
      continue;
    }

    // 3. `var` declaration of a watched name: decline (function-hoisting semantics).
    if (t.type === 'id' && !t.afterDot && t.value === 'var') {
      const pat = parsePattern(tokens, i + 1, tokens.length, matchClose, watchedNames);
      if (pat && pat.names.some(n => watchedNames.has(n))) return null;
      // Also check any watched name before `;` or newline in a `var` statement.
      let k = i + 1;
      while (k < tokens.length && tokens[k].value !== ';' && tokens[k].value !== '}') {
        if (tokens[k].value === '(' || tokens[k].value === '[' || tokens[k].value === '{' || tokens[k].value === '${') {
          k = matchClose[k] + 1;
          continue;
        }
        if (tokens[k].type === 'id' && !tokens[k].afterDot && watchedNames.has(tokens[k].value)) return null;
        k++;
      }
      continue;
    }

    // 4. Block-scoped `const` / `let` declaration inside a block or `for (...) { ... }` header.
    if (t.type === 'id' && !t.afterDot && (t.value === 'const' || t.value === 'let')) {
      const prevTok = i > 0 ? tokens[i - 1] : null;
      const inForHead = prevTok && prevTok.value === '(' && prevTok.ctrl && i >= 2 &&
        (tokens[i - 2].value === 'for' || (tokens[i - 2].value === 'await' && i >= 3 && tokens[i - 3].value === 'for'));
      if (!inForHead && braceStack.length === 0) continue; // Top-level const/let is not local shadowing.

      // Check for-loop header: `for (const/let pat of/in expr) { ... }` or `for (let pat = ...; ...; ...) { ... }`
      if (inForHead) {
        const headOpen = i - 1;
        const headClose = matchClose[headOpen];
        if (headClose < 0) return null;
        const pat = parsePattern(tokens, i + 1, headClose, matchClose, watchedNames);
        if (pat === null) continue;
        const matched = pat.names.filter(n => watchedNames.has(n));
        if (matched.length === 0) continue;
        if (pat.hasWatchedExpr) return null;
        // For `for-of`/`for-in`, ensure the RHS iterable expression does not reference the shadowed name.
        const afterPat = tokens[pat.nextIdx];
        if (afterPat && (afterPat.value === 'of' || afterPat.value === 'in')) {
          for (let k = pat.nextIdx + 1; k < headClose; k++) {
            if (tokens[k].type === 'id' && !tokens[k].afterDot && matched.includes(tokens[k].value)) return null;
          }
        }
        // Only handle braced loop bodies `{ ... }` cleanly.
        const bodyStart = headClose + 1;
        if (bodyStart >= tokens.length || tokens[bodyStart].value !== '{') return null;
        const bodyClose = matchClose[bodyStart];
        if (bodyClose < 0) return null;
        for (const n of matched) addSpan(n, t.start, tokens[bodyClose].end);
        continue;
      }

      // Regular block-scoped `const` / `let` statement (may have multiple declarators separated by `,`).
      const blockOpen = braceStack[braceStack.length - 1];
      const blockClose = braceEnds[braceEnds.length - 1];
      let p = i + 1;
      const matched = [];
      let initHasConflict = false;
      while (p < blockClose) {
        const pat = parsePattern(tokens, p, blockClose, matchClose, watchedNames);
        if (pat === null) break;
        const localMatched = pat.names.filter(n => watchedNames.has(n));
        if (pat.hasWatchedExpr && localMatched.length > 0) { initHasConflict = true; break; }
        for (const n of localMatched) matched.push(n);
        p = pat.nextIdx;
        if (p < blockClose && tokens[p].value === '=') {
          const exprStart = p + 1;
          p = exprStart;
          while (p < blockClose) {
            const v = tokens[p].value;
            if (v === '(' || v === '[' || v === '{' || v === '${') {
              const c = matchClose[p];
              if (c < 0 || c >= blockClose) { p = blockClose; break; }
              p = c + 1;
              continue;
            }
            if (v === ',' || v === ';') break;
            if (p > exprStart && text.slice(tokens[p - 1].end, tokens[p].start).includes('\n')) {
              const prevV = tokens[p - 1].value;
              const curV = v;
              const prevEnds = tokens[p - 1].type === 'id' || tokens[p - 1].type === 'num' || tokens[p - 1].type === 'str' ||
                tokens[p - 1].type === 'tpl' || prevV === ')' || prevV === ']' || prevV === '}';
              const curCont = curV === '.' || curV === '?.' || curV === '?' || curV === ':' || curV === '&&' || curV === '||' || curV === '??' ||
                curV === '+' || curV === '-' || curV === '*' || curV === '/' || curV === '(' || curV === '[';
              if (prevEnds && !curCont) break;
            }
            p++;
          }
          if (localMatched.length > 0) {
            for (let k = exprStart; k < p; k++) {
              if (tokens[k].type === 'id' && !tokens[k].afterDot && localMatched.includes(tokens[k].value)) {
                initHasConflict = true;
                break;
              }
            }
          }
          if (initHasConflict) break;
        }
        if (p < blockClose && tokens[p].value === ',') { p++; continue; }
        break;
      }
      if (initHasConflict) return null;
      if (matched.length > 0) {
        // Ensure no earlier reference to `matched` in the same block before this declaration (guards TDZ / closure capture).
        for (let k = blockOpen + 1; k < i; k++) {
          if (tokens[k].type === 'id' && !tokens[k].afterDot && matched.includes(tokens[k].value)) return null;
        }
        for (const n of matched) addSpan(n, t.start, tokens[blockClose].end);
      }
      continue;
    }

    // 5. Local `function name(...) { ... }` or `class name { ... }` inside a block or expression.
    if (t.type === 'id' && !t.afterDot && (t.value === 'function' || t.value === 'class')) {
      let nameIdx = i + 1;
      if (t.value === 'function' && tokens[nameIdx]?.value === '*') nameIdx++;
      const nameTok = tokens[nameIdx];
      if (!nameTok || nameTok.type !== 'id' || !watchedNames.has(nameTok.value)) continue;
      // Find the body `{ ... }` of this function or class.
      let bodyIdx = nameIdx + 1;
      if (t.value === 'function') {
        if (tokens[bodyIdx]?.value !== '(') continue;
        const pClose = matchClose[bodyIdx];
        if (pClose < 0) return null;
        bodyIdx = pClose + 1;
      } else {
        if (tokens[bodyIdx]?.value === 'extends') {
          bodyIdx++;
          while (bodyIdx < tokens.length && tokens[bodyIdx].value !== '{') {
            if (tokens[bodyIdx].type === 'id' && !tokens[bodyIdx].afterDot) {
              const ev = tokens[bodyIdx].value;
              if (ev === nameTok.value || ev === 'class' || ev === 'function') return null;
            }
            if (tokens[bodyIdx].value === '(' || tokens[bodyIdx].value === '[' || tokens[bodyIdx].value === '${') {
              const c = matchClose[bodyIdx];
              if (c < 0) return null;
              bodyIdx = c + 1;
              continue;
            }
            bodyIdx++;
          }
        }
      }
      if (tokens[bodyIdx]?.value !== '{') continue;
      const bodyClose = matchClose[bodyIdx];
      if (bodyClose < 0) return null;

      // Distinguish declaration (block-scoped) vs named expression (self-scoped to body).
      // Look before `async` when checking `async function name() {}`.
      let headIdx = i;
      if (t.value === 'function' && headIdx > 0 && tokens[headIdx - 1].type === 'id' && !tokens[headIdx - 1].afterDot && tokens[headIdx - 1].value === 'async') {
        headIdx--;
      }
      const prevTok = headIdx > 0 ? tokens[headIdx - 1] : null;
      let isDecl = false;
      let isExpr = false;
      if (!prevTok) {
        isDecl = true;
      } else if (prevTok.value === ':') {
        // Ambiguous between `case 0: function a(){}` / label vs object property / ternary expression: decline safely.
        return null;
      } else if (prevTok.value === ';' || prevTok.value === '{' || prevTok.value === '}' ||
          (prevTok.value === ')' && prevTok.ctrl) ||
          (prevTok.type === 'id' && !prevTok.afterDot && (prevTok.value === 'else' || prevTok.value === 'export' || prevTok.value === 'default'))) {
        isDecl = true;
      } else if (t.value === 'class' && isPrecededByDecorator(tokens, headIdx)) {
        isDecl = true;
      } else {
        const pv = prevTok.value;
        if (pv === '=' || pv === '(' || pv === '[' || pv === ',' || pv === '?' || pv === '=>' ||
            pv === '+' || pv === '-' || pv === '*' || pv === '/' || pv === '%' || pv === '!' || pv === '~' ||
            pv === '&' || pv === '|' || pv === '^' || pv === '<' || pv === '>' ||
            pv === '==' || pv === '===' || pv === '!=' || pv === '!==' ||
            pv === '&&' || pv === '||' || pv === '??' ||
            (prevTok.type === 'id' && !prevTok.afterDot && (pv === 'return' || pv === 'throw' || pv === 'yield' ||
              pv === 'await' || pv === 'new' || pv === 'typeof' || pv === 'void' || pv === 'in' || pv === 'instanceof'))) {
          isExpr = true;
        } else {
          return null;
        }
      }
      if (isDecl && braceStack.length > 0) {
        const blockOpen = braceStack[braceStack.length - 1];
        const blockClose = braceEnds[braceEnds.length - 1];
        for (let k = blockOpen + 1; k < headIdx; k++) {
          if (tokens[k].type === 'id' && !tokens[k].afterDot && tokens[k].value === nameTok.value) return null;
        }
        addSpan(nameTok.value, nameTok.start, tokens[blockClose].end);
      } else if (isExpr) {
        addSpan(nameTok.value, nameTok.start, tokens[bodyClose].end);
      }
    }
  }

  return spans;
}

module.exports = { collectShadowedSpans, tokenizeJs };
