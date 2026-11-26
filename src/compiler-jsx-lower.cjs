'use strict';

// Fallback JSX-to-Automatic-Runtime (`react/jsx-runtime`) lowerer for `.tsx` files
// declined by the native C++ JSX lowerer (e.g. files with namespaces, complex TS types,
// decorators, or multi-file `// @filename:` fixtures).
// Emits TypeScript-6.0.3-exact `_jsx` / `_jsxs` / `_Fragment` calls, then lets the caller
// run Node's stripTypeScriptTypes + erasure to validate all TypeScript syntax.

const EXPR_PREFIX = new Set([
  '', '=', '(', '[', ',', ':', '?', ';', '{', '}', '=>', 'return', 'throw', 'yield', 'await',
  '!', '~', '+', '-', '*', '/', '%', '&', '|', '^', '&&', '||', '??', 'case', 'default', 'of', 'in',
]);

function isIdentStart(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

function isIdentPart(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;
}

function isJsxNamePart(ch) {
  return isIdentPart(ch) || ch === '-';
}

function cleanJsxText(raw) {
  if (!raw.includes('\n') && !raw.includes('\r')) {
    return raw.length > 0 ? raw : null;
  }
  const lines = raw.split(/\r\n|\r|\n/);
  let firstNonEmpty = -1, lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = i === 0 ? lines[i].replace(/[ \t]+$/, '')
      : i === lines.length - 1 ? lines[i].replace(/^[ \t]+/, '')
      : lines[i].trim();
    if (trimmed.length > 0) {
      if (firstNonEmpty < 0) firstNonEmpty = i;
      lastNonEmpty = i;
    }
  }
  if (firstNonEmpty < 0) return null;
  const parts = [];
  for (let i = firstNonEmpty; i <= lastNonEmpty; i++) {
    let line = lines[i];
    if (i > 0) line = line.replace(/^[ \t]+/, '');
    if (i < lines.length - 1) line = line.replace(/[ \t]+$/, '');
    if (line.length > 0) parts.push(line);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function decodeJsxEntities(str) {
  if (!str.includes('&')) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function lowerJsxToAutomatic(source) {
  if (!source.includes('<') || source.includes('\u2028') || source.includes('\u2029')) return null;
  if (/\b(?:_jsx|_jsxs|_Fragment)\b/.test(source)) return null;
  // Bail if an explicit `@jsxRuntime classic` pragma is present inside a block comment.
  let importSource = 'react';
  if (/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//.test(source)) {
    const comments = source.match(/\/\*[\s\S]*?\*\//g) || [];
    for (const cm of comments) {
      if (/(?:^|[\r\n\/\*])[ \t]*@jsxRuntime[ \t]+classic\b/i.test(cm)) return null;
    }
    for (const cm of comments) {
      const m = /(?:^|[\r\n]|\/\*+)[ \t]*\*?[ \t]*@jsxImportSource[ \t]+([^\s*]+)/i.exec(cm);
      if (m) { importSource = m[1]; break; }
    }
  }

  const n = source.length;
  let usedJsx = false;
  let usedJsxs = false;
  let usedFragment = false;
  let loweredAny = false;
  let failed = false;

  function skipWs(pos) {
    while (pos < n) {
      const c = source[pos];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { pos++; continue; }
      if (c === '/' && source[pos + 1] === '/') {
        const nl = source.indexOf('\n', pos + 2);
        pos = nl < 0 ? n : nl + 1;
        continue;
      }
      if (c === '/' && source[pos + 1] === '*') {
        const end = source.indexOf('*/', pos + 2);
        if (end < 0) { failed = true; return n; }
        pos = end + 2;
        continue;
      }
      break;
    }
    return pos;
  }

  // Parse a balanced `{ ... }` JS/TS expression starting at `pos` (`source[pos] === '{'`).
  // Recursively lowers any JSX inside the expression.
  function parseEmbeddedExpr(pos) {
    if (source[pos] !== '{') { failed = true; return { expr: '', next: pos }; }
    const start = pos + 1;
    let i = start;
    let depth = 1;
    let out = '';
    let prev = '{';
    while (i < n && depth > 0 && !failed) {
      const ch = source[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { out += ch; i++; continue; }
      if (ch === '/' && source[i + 1] === '/') {
        const nl = source.indexOf('\n', i + 2);
        const end = nl < 0 ? n : nl;
        out += source.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) { failed = true; return { expr: '', next: n }; }
        out += source.slice(i, end + 2);
        i = end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < n && source[j] !== ch) { if (source[j] === '\\') j += 2; else j++; }
        if (j >= n) { failed = true; return { expr: '', next: n }; }
        out += source.slice(i, j + 1);
        i = j + 1;
        prev = 'lit';
        continue;
      }
      if (ch === '`') {
        let j = i + 1;
        out += '`';
        while (j < n && source[j] !== '`') {
          if (source[j] === '\\') { out += source.slice(j, j + 2); j += 2; continue; }
          if (source[j] === '$' && source[j + 1] === '{') {
            out += '${';
            const sub = parseEmbeddedExpr(j + 1);
            out += sub.expr + '}';
            j = sub.next;
            continue;
          }
          out += source[j++];
        }
        if (j >= n) { failed = true; return { expr: '', next: n }; }
        out += '`';
        i = j + 1;
        prev = 'lit';
        continue;
      }
      if (ch === '{') { depth++; out += ch; prev = '{'; i++; continue; }
      if (ch === '}') {
        depth--;
        if (depth === 0) { i++; break; }
        out += ch; prev = '}'; i++; continue;
      }
      if (ch === '<' && EXPR_PREFIX.has(prev) && looksLikeJsxStart(i)) {
        const el = parseJsxElement(i);
        if (failed) return { expr: '', next: n };
        out += el.code;
        i = el.next;
        prev = ')';
        continue;
      }
      if (ch === '=' && source[i + 1] === '>') { out += '=>'; prev = '=>'; i += 2; continue; }
      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < n && isIdentPart(source[j])) j++;
        const word = source.slice(i, j);
        out += word;
        prev = prev === '.' ? 'prop' : word;
        i = j;
        continue;
      }
      out += ch;
      prev = ch;
      i++;
    }
    if (depth !== 0) { failed = true; return { expr: '', next: n }; }
    return { expr: out, next: i };
  }

  // Distinguish JSX `<Tag ...>` / `<>` from generic arrow `<T>(x) =>` / `<T extends U>` / `<T, U>`.
  function looksLikeJsxStart(pos) {
    if (source[pos] !== '<') return false;
    const afterLt = skipWs(pos + 1);
    if (source[afterLt] === '>') return true; // Fragment `<>` or `<   >`
    const c1 = source[afterLt];
    if (!c1 || !isIdentStart(c1)) return false;
    let j = afterLt;
    while (j < n && isJsxNamePart(source[j])) j++;
    const afterFirst = skipWs(j);
    // Namespaced tag `a:b` or `a : b` or member tag `A.B`
    if (source[afterFirst] === ':') return true;
    if (source[j] === '.') return true;
    const afterName = afterFirst;
    const ch = source[afterName];
    if (ch === '>' || ch === '/') return true;
    // Generic arrow `<T, ...>` or `<T extends ...>` or `<T = ...>` is NOT JSX
    if (ch === ',' || ch === '=') return false;
    if (source.slice(afterName, afterName + 8).startsWith('extends') && !isIdentPart(source[afterName + 7] || ' ')) return false;
    // `<Tag attr...>` or `<Tag {...spread}>` or `<Tag<TypeArg> ...>`
    if (ch === '{' || ch === '<' || isIdentStart(ch)) {
      return true;
    }
    return false;
  }

  // Skip balanced `<...>` type arguments on a JSX opening tag `<Comp<T, U> ...>`
  function skipTypeArgs(pos) {
    if (source[pos] !== '<') return pos;
    let i = pos + 1, d = 1;
    while (i < n && d > 0) {
      const c = source[i];
      if (c === '"' || c === "'") {
        i++;
        while (i < n && source[i] !== c) { if (source[i] === '\\') i += 2; else i++; }
      } else if (c === '<') d++;
      else if (c === '>') d--;
      i++;
    }
    if (d !== 0) { failed = true; return n; }
    return i;
  }

  function parseJsxElement(pos) {
    if (source[pos] !== '<') { failed = true; return { code: '', next: pos }; }
    let i = pos + 1;
    let isFragment = false;
    let tagName = '';
    let isNamespacedTag = false;
    const afterLt = skipWs(i);
    if (source[afterLt] === '>') {
      isFragment = true;
      i = afterLt + 1;
    } else {
      i = afterLt;
      const nameStart = i;
      if (!isIdentStart(source[i] || '')) { failed = true; return { code: '', next: pos }; }
      while (i < n && (isJsxNamePart(source[i]) || source[i] === '.')) i++;
      tagName = source.slice(nameStart, i);
      const afterBase = skipWs(i);
      if (source[afterBase] === ':' && !tagName.includes('.')) {
        const nsLocalStart = skipWs(afterBase + 1);
        if (!isIdentStart(source[nsLocalStart] || '')) { failed = true; return { code: '', next: pos }; }
        let k = nsLocalStart;
        while (k < n && isJsxNamePart(source[k])) k++;
        tagName = tagName + ':' + source.slice(nsLocalStart, k);
        isNamespacedTag = true;
        i = k;
      }
      // Optional type arguments `<Comp<T> ...>`
      if (source[i] === '<') {
        i = skipTypeArgs(i);
        if (failed) return { code: '', next: n };
      }
    }

    const props = [];
    let keyExpr = null;
    let sawSpread = false;
    let selfClosing = false;

    if (!isFragment) {
      while (i < n && !failed) {
        i = skipWs(i);
        if (i >= n) { failed = true; return { code: '', next: n }; }
        if (source[i] === '/' && source[i + 1] === '>') {
          selfClosing = true;
          i += 2;
          break;
        }
        if (source[i] === '>') {
          i++;
          break;
        }
        if (source[i] === '{') {
          const emb = parseEmbeddedExpr(i);
          if (failed) return { code: '', next: n };
          const trimmed = emb.expr.trim();
          if (!trimmed.startsWith('...') || /^\.\.\.\s*\{/.test(trimmed)) { failed = true; return { code: '', next: n }; }
          props.push(trimmed);
          sawSpread = true;
          i = emb.next;
          continue;
        }
        if (!isIdentStart(source[i])) { failed = true; return { code: '', next: n }; }
        const aStart = i;
        while (i < n && (isJsxNamePart(source[i]) || source[i] === ':')) i++;
        const attrName = source.slice(aStart, i);
        const propKey = /^[A-Za-z_$][\w$]*$/.test(attrName) ? attrName : JSON.stringify(attrName);
        i = skipWs(i);
        let valCode = 'true';
        if (source[i] === '=') {
          i = skipWs(i + 1);
          if (source[i] === '"' || source[i] === "'") {
            const q = source[i++];
            const sStart = i;
            while (i < n && source[i] !== q) i++;
            if (i >= n) { failed = true; return { code: '', next: n }; }
            valCode = JSON.stringify(decodeJsxEntities(source.slice(sStart, i)));
            i++;
          } else if (source[i] === '{') {
            const emb = parseEmbeddedExpr(i);
            if (failed) return { code: '', next: n };
            const trimmed = emb.expr.trim();
            if (!trimmed) { failed = true; return { code: '', next: n }; }
            valCode = trimmed;
            i = emb.next;
          } else if (source[i] === '<') {
            const sub = parseJsxElement(i);
            if (failed) return { code: '', next: n };
            valCode = sub.code;
            i = sub.next;
          } else {
            failed = true;
            return { code: '', next: n };
          }
        }
        if (attrName === 'key') {
          if (sawSpread) { failed = true; return { code: '', next: n }; } // TS uses createElement when key follows spread
          keyExpr = valCode;
        } else {
          props.push(`${propKey}: ${valCode}`);
        }
      }
    }

    const children = [];
    if (!selfClosing) {
      let closed = false;
      while (i < n && !failed) {
        if (source[i] === '<' && source[i + 1] === '/') {
          i += 2;
          const cStart = i;
          while (i < n && source[i] !== '>') i++;
          if (i >= n) { failed = true; return { code: '', next: n }; }
          const rawClose = source.slice(cStart, i).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
          if (isFragment ? rawClose !== '' : rawClose !== tagName) {
            failed = true;
            return { code: '', next: n };
          }
          i++; // skip '>'
          closed = true;
          break;
        }
        if (source[i] === '<') {
          const child = parseJsxElement(i);
          if (failed) return { code: '', next: n };
          children.push(child.code);
          i = child.next;
          continue;
        }
        if (source[i] === '{') {
          const emb = parseEmbeddedExpr(i);
          if (failed) return { code: '', next: n };
          const cleaned = emb.expr.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\r\n]*/g, '').trim();
          if (cleaned.length > 0) {
            children.push(emb.expr.trim());
          }
          i = emb.next;
          continue;
        }
        // JSX text
        const tStart = i;
        while (i < n && source[i] !== '<' && source[i] !== '{') {
          if (source[i] === '}' || source[i] === '>') { failed = true; return { code: '', next: n }; }
          i++;
        }
        const rawText = source.slice(tStart, i);
        const cleaned = cleanJsxText(rawText);
        if (cleaned !== null) {
          children.push(JSON.stringify(decodeJsxEntities(cleaned)));
        }
      }
      if (!closed) { failed = true; return { code: '', next: n }; }
    }

    if (failed) return { code: '', next: n };
    loweredAny = true;

    let tagExpr;
    if (isFragment) {
      usedFragment = true;
      tagExpr = '_Fragment';
    } else if (isNamespacedTag || (!tagName.includes('.') && tagName[0] >= 'a' && tagName[0] <= 'z')) {
      tagExpr = JSON.stringify(tagName);
    } else {
      tagExpr = tagName;
    }

    let fnName = '_jsx';
    const hasSpreadChild = children.some(c => c.startsWith('...'));
    if (children.length === 1 && !hasSpreadChild) {
      usedJsx = true;
      props.push(`children: ${children[0]}`);
    } else if (children.length > 1 || hasSpreadChild) {
      usedJsxs = true;
      fnName = '_jsxs';
      props.push(`children: [${children.join(', ')}]`);
    } else {
      usedJsx = true;
    }

    const propsObj = props.length > 0 ? `{ ${props.join(', ')} }` : '{}';
    const call = keyExpr !== null ? `${fnName}(${tagExpr}, ${propsObj}, ${keyExpr})` : `${fnName}(${tagExpr}, ${propsObj})`;
    return { code: call, next: i };
  }

  // Top-level scan
  let out = '';
  let i = 0;
  let prev = '';
  let sawNewline = true;
  while (i < n && !failed) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (ch === '\r' || ch === '\n') sawNewline = true;
      out += ch; i++; continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      const end = nl < 0 ? n : nl;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return null;
      if (source.slice(i, end + 2).includes('\n')) sawNewline = true;
      out += source.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && source[j] !== ch) { if (source[j] === '\\') j += 2; else j++; }
      if (j >= n) return null;
      out += source.slice(i, j + 1);
      i = j + 1;
      prev = 'lit';
      sawNewline = false;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      out += '`';
      while (j < n && source[j] !== '`') {
        if (source[j] === '\\') { out += source.slice(j, j + 2); j += 2; continue; }
        if (source[j] === '$' && source[j + 1] === '{') {
          out += '${';
          const sub = parseEmbeddedExpr(j + 1);
          if (failed) return null;
          out += sub.expr + '}';
          j = sub.next;
          continue;
        }
        out += source[j++];
      }
      if (j >= n) return null;
      out += '`';
      i = j + 1;
      prev = 'lit';
      sawNewline = false;
      continue;
    }
    if (ch === '<' && (EXPR_PREFIX.has(prev) || sawNewline) && looksLikeJsxStart(i)) {
      const el = parseJsxElement(i);
      if (failed) return null;
      // Avoid ASI hazard when a lowered `_jsx(...)` call is followed on a new line by `(`, `[`, `/`, `` ` ``, `+`, or `-` without `;`.
      const afterEl = skipWs(el.next);
      if (afterEl < n && (source[afterEl] === '(' || source[afterEl] === '[' || source[afterEl] === '/' ||
          source[afterEl] === '`' || source[afterEl] === '+' || source[afterEl] === '-') &&
          /[\r\n]/.test(source.slice(el.next, afterEl))) {
        return null;
      }
      out += el.code;
      i = el.next;
      prev = ')';
      sawNewline = false;
      continue;
    }
    if (ch === '=' && source[i + 1] === '>') { out += '=>'; prev = '=>'; sawNewline = false; i += 2; continue; }
    if ((ch === '&' && source[i + 1] === '&') || (ch === '|' && source[i + 1] === '|') || (ch === '?' && source[i + 1] === '?')) {
      out += ch + ch; prev = ch + ch; sawNewline = false; i += 2; continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      out += word;
      prev = prev === '.' ? 'prop' : word;
      sawNewline = false;
      i = j;
      continue;
    }
    out += ch;
    prev = ch;
    sawNewline = false;
    i++;
  }

  if (failed || !loweredAny) return null;

  const specs = [];
  if (usedJsx) specs.push('jsx as _jsx');
  if (usedJsxs) specs.push('jsxs as _jsxs');
  if (usedFragment) specs.push('Fragment as _Fragment');
  const importLine = `import { ${specs.join(', ')} } from ${JSON.stringify(importSource + '/jsx-runtime')};\n`;
  return importLine + out;
}

module.exports = { lowerJsxToAutomatic };
