'use strict';

// Native isolatedDeclarations `.d.ts` emitter with automatic fallback to TypeScript's `transpileDeclaration`.
// Handles explicitly-typed top-level declarations (`export interface`, `export type`, `export const/let/var x: T = ...`,
// `export [async] function f(a: T): R { ... }`, `export [const] enum E { ... }`, `export { ... }`, `export * from ...`,
// and `import [type] ...`) while declining conservatively to TypeScript whenever inference, class/namespace emission,
// or complex import pruning is required.

let tsModule;
function loadTypeScript() {
  return (tsModule ??= require('typescript'));
}

function skipTrivia(text, pos) {
  while (pos < text.length) {
    const c = text[pos];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { pos++; continue; }
    if (c === '/' && text[pos + 1] === '/') {
      pos += 2;
      while (pos < text.length && text[pos] !== '\n' && text[pos] !== '\r') pos++;
      continue;
    }
    if (c === '/' && text[pos + 1] === '*') {
      const end = text.indexOf('*/', pos + 2);
      if (end < 0) return -1;
      pos = end + 2;
      continue;
    }
    break;
  }
  return pos;
}

function skipBalanced(text, pos, open, close) {
  if (text[pos] !== open) return -1;
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === '\n' || text[i] === '\r') return -1;
        else i++;
      }
      if (i >= text.length) return -1;
      continue;
    }
    if (c === '`') {
      i++;
      let tplDepth = 0;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '`' && tplDepth === 0) break;
        if (text[i] === '$' && text[i + 1] === '{') { tplDepth++; i += 2; continue; }
        if (text[i] === '}' && tplDepth > 0) { tplDepth--; i++; continue; }
        i++;
      }
      if (i >= text.length) return -1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Scans a type expression starting at `pos` until a top-level delimiter in `stops`.
function scanTypeEnd(text, pos, stops) {
  let paren = 0, brace = 0, bracket = 0, angle = 0;
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === '\n' || text[i] === '\r') return -1;
        else i++;
      }
      if (i >= text.length) return -1;
      continue;
    }
    if (c === '`') return -1;
    if (c === '=' && text[i + 1] === '>') { i++; continue; }
    if (paren === 0 && brace === 0 && bracket === 0 && angle === 0 && stops.has(c)) return i;
    if (c === '(') paren++;
    else if (c === ')') { if (paren === 0) return -1; paren--; }
    else if (c === '{') brace++;
    else if (c === '}') { if (brace === 0) return -1; brace--; }
    else if (c === '[') bracket++;
    else if (c === ']') { if (bracket === 0) return -1; bracket--; }
    else if (c === '<') angle++;
    else if (c === '>') { if (angle > 0) angle--; }
  }
  return paren === 0 && brace === 0 && bracket === 0 && angle === 0 ? text.length : -1;
}

// Scans to the end of a top-level statement (ending at `;` at depth 0, or closing `}` for blocks).
function scanStmtEnd(text, pos) {
  let paren = 0, brace = 0, bracket = 0;
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === '\n' || text[i] === '\r') return -1;
        else i++;
      }
      if (i >= text.length) return -1;
      continue;
    }
    if (c === '`') {
      i++;
      let tplDepth = 0;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '`' && tplDepth === 0) break;
        if (text[i] === '$' && text[i + 1] === '{') { tplDepth++; i += 2; continue; }
        if (text[i] === '}' && tplDepth > 0) { tplDepth--; i++; continue; }
        i++;
      }
      if (i >= text.length) return -1;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') { if (paren === 0) return -1; paren--; }
    else if (c === '{') brace++;
    else if (c === '}') { if (brace === 0) return -1; brace--; }
    else if (c === '[') bracket++;
    else if (c === ']') { if (bracket === 0) return -1; bracket--; }
    else if (c === ';' && paren === 0 && brace === 0 && bracket === 0) return i + 1;
  }
  return -1;
}

// Formats a function parameter list for `.d.ts`: requires explicit types on every parameter,
// rejects destructuring or `this` or decorators, and converts `a: T = default` to `a?: T`.
function formatParams(paramText) {
  const trimmed = paramText.trim();
  if (trimmed === '') return '';
  const parts = [];
  let start = 0, paren = 0, brace = 0, bracket = 0, angle = 0;
  for (let i = 0; i <= trimmed.length; i++) {
    const c = trimmed[i];
    if (i < trimmed.length) {
      if (c === '"' || c === "'" || c === '`') return null;
      if (c === '=' && trimmed[i + 1] === '>') { i++; continue; }
      if (c === '(') { paren++; continue; }
      if (c === ')') { paren--; continue; }
      if (c === '{') { brace++; continue; }
      if (c === '}') { brace--; continue; }
      if (c === '[') { bracket++; continue; }
      if (c === ']') { bracket--; continue; }
      if (c === '<') { angle++; continue; }
      if (c === '>') { if (angle > 0) angle--; continue; }
    }
    if (i === trimmed.length || (c === ',' && paren === 0 && brace === 0 && bracket === 0 && angle === 0)) {
      const seg = trimmed.slice(start, i).trim();
      start = i + 1;
      if (seg === '') continue;
      const m = /^(\.\.\.)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(seg);
      if (!m) return null;
      const [, rest, name, opt, typeAndDefault] = m;
      if (name === 'this') return null;
      const eqPos = scanTypeEnd(typeAndDefault, 0, new Set(['=']));
      if (eqPos < 0) return null;
      const hasDefault = eqPos < typeAndDefault.length && typeAndDefault[eqPos] === '=';
      if (rest && hasDefault) return null;
      const typeStr = (hasDefault ? typeAndDefault.slice(0, eqPos) : typeAndDefault).trim();
      if (!typeStr) return null;
      parts.push(`${rest || ''}${name}${opt || (hasDefault ? '?' : '')}: ${typeStr}`);
    }
  }
  return parts.join(', ');
}

function emitNativeDts(source) {
  if (/[^\x00-\x7f]/.test(source) || source.includes('@') || source.includes('\\u')) return null;
  const imports = []; // { raw, names: string[], spec }
  const decls = [];
  const localNames = new Set();
  const exportedNames = new Set();
  let hasExport = false;
  let pos = 0;

  while (pos < source.length) {
    pos = skipTrivia(source, pos);
    if (pos < 0) return null;
    if (pos >= source.length) break;

    // 1. import statement
    if (source.startsWith('import', pos) && !/[\w$]/.test(source[pos + 6] || '')) {
      const end = scanStmtEnd(source, pos);
      if (end < 0) return null;
      const raw = source.slice(pos, end).trim();
      const named = /^import\s+(type\s+)?\{([^{}]+)\}\s*from\s*(["'][^"'\n]+["'])\s*;$/.exec(raw);
      if (!named) return null;
      const isType = !!named[1];
      const spec = named[3];
      const items = [];
      for (const part of named[2].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const m = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(t);
        if (!m) return null;
        items.push({ raw: t, local: m[3] || m[2] });
      }
      imports.push({ isType, items, spec });
      pos = end;
      continue;
    }

    // 2. export statement
    if (source.startsWith('export', pos) && !/[\w$]/.test(source[pos + 6] || '')) {
      hasExport = true;
      let p = skipTrivia(source, pos + 6);
      if (p < 0 || p >= source.length) return null;

      // export { ... } [from "..."]; or export * [as X] from "...";
      if (source[p] === '{' || source[p] === '*') {
        const end = scanStmtEnd(source, pos);
        if (end < 0) return null;
        decls.push(source.slice(pos, end).trim());
        pos = end;
        continue;
      }

      // export type { ... } [from "..."]; or export type Name<...> = ...;
      if (source.startsWith('type', p) && !/[\w$]/.test(source[p + 4] || '')) {
        const end = scanStmtEnd(source, pos);
        if (end < 0) return null;
        const stmt = source.slice(pos, end).trim();
        const tm = /^export\s+type\s+([A-Za-z_$][\w$]*)/.exec(stmt);
        if (tm) exportedNames.add(tm[1]);
        decls.push(stmt);
        pos = end;
        continue;
      }

      // export interface Name<...> { ... }
      if (source.startsWith('interface', p) && !/[\w$]/.test(source[p + 9] || '')) {
        const nm = /^interface\s+([A-Za-z_$][\w$]*)/.exec(source.slice(p));
        if (!nm) return null;
        exportedNames.add(nm[1]);
        const braceAt = source.indexOf('{', p);
        if (braceAt < 0) return null;
        const bodyEnd = skipBalanced(source, braceAt, '{', '}');
        if (bodyEnd < 0) return null;
        decls.push(source.slice(pos, bodyEnd).trim());
        pos = bodyEnd;
        continue;
      }

      // export const/let/var name: Type = expr;
      const vm = /^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*/.exec(source.slice(p));
      if (vm && !(vm[1] === 'const' && vm[2] === 'enum')) {
        const [, kw, name] = vm;
        const typeStart = p + vm[0].length;
        const eqAt = scanTypeEnd(source, typeStart, new Set(['=', ';']));
        if (eqAt < 0 || source[eqAt] !== '=') return null;
        const typeStr = source.slice(typeStart, eqAt).trim();
        if (!typeStr) return null;
        const end = scanStmtEnd(source, eqAt + 1);
        if (end < 0) return null;
        // Reject comma-separated multi-declarators.
        if (/,/.test(source.slice(eqAt + 1, end).replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|"[^"]*"|'[^']*'/g, ''))) return null;
        exportedNames.add(name);
        decls.push(`export declare ${kw} ${name}: ${typeStr};`);
        pos = end;
        continue;
      }

      // export [const] enum Name { ... }
      const em = /^(const\s+)?enum\s+([A-Za-z_$][\w$]*)\s*\{/.exec(source.slice(p));
      if (em) {
        const braceAt = p + em[0].length - 1;
        const bodyEnd = skipBalanced(source, braceAt, '{', '}');
        if (bodyEnd < 0) return null;
        const body = source.slice(braceAt + 1, bodyEnd - 1);
        // Only handle simple literal or auto-incremented enum members.
        for (const member of body.split(',')) {
          const mt = member.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
          if (!mt) continue;
          if (!/^[A-Za-z_$][\w$]*(?:\s*=\s*(?:-?\d+|"[^"\\\n]*"|'[^'\\\n]*'))?$/.test(mt)) return null;
        }
        exportedNames.add(em[2]);
        decls.push(`export declare ${em[1] ? 'const ' : ''}enum ${em[2]} ${source.slice(braceAt, bodyEnd)}`);
        pos = bodyEnd;
        continue;
      }

      // export [async] function name<...>(params): Ret { ... }
      const fm = /^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*/.exec(source.slice(p));
      if (fm) {
        let fp = p + fm[0].length;
        let typeParams = '';
        if (source[fp] === '<') {
          const tpEnd = skipBalanced(source, fp, '<', '>');
          if (tpEnd < 0) return null;
          typeParams = source.slice(fp, tpEnd);
          fp = skipTrivia(source, tpEnd);
        }
        if (fp < 0 || source[fp] !== '(') return null;
        const parenEnd = skipBalanced(source, fp, '(', ')');
        if (parenEnd < 0) return null;
        const formattedParams = formatParams(source.slice(fp + 1, parenEnd - 1));
        if (formattedParams === null) return null;
        let rp = skipTrivia(source, parenEnd);
        if (rp < 0 || source[rp] !== ':') return null;
        const retStart = skipTrivia(source, rp + 1);
        if (retStart < 0) return null;
        const braceAt = scanTypeEnd(source, retStart, new Set(['{', ';']));
        if (braceAt < 0 || source[braceAt] !== '{') return null;
        const retType = source.slice(retStart, braceAt).trim();
        if (!retType) return null;
        const bodyEnd = skipBalanced(source, braceAt, '{', '}');
        if (bodyEnd < 0) return null;
        exportedNames.add(fm[2]);
        decls.push(`export declare function ${fm[2]}${typeParams}(${formattedParams}): ${retType};`);
        pos = bodyEnd;
        continue;
      }

      // Anything else (`export default`, `export class`, `export namespace`, etc.) declines to TypeScript.
      return null;
    }

    // 3. Non-exported top-level declarations (const/let/var/function): skip if unreferenced in emitted decls.
    const lvm = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(source.slice(pos));
    if (lvm) {
      const end = scanStmtEnd(source, pos);
      if (end < 0) return null;
      localNames.add(lvm[1]);
      pos = end;
      continue;
    }
    const lfm = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*/.exec(source.slice(pos));
    if (lfm) {
      const braceAt = source.indexOf('{', pos);
      if (braceAt < 0) return null;
      const bodyEnd = skipBalanced(source, braceAt, '{', '}');
      if (bodyEnd < 0) return null;
      localNames.add(lfm[1]);
      pos = bodyEnd;
      continue;
    }

    return null;
  }

  if (!hasExport) return null;
  const body = decls.join('\n');
  // If any skipped local name is referenced in emitted declarations, decline to TypeScript.
  for (const name of localNames) {
    if (!exportedNames.has(name) && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)) {
      return null;
    }
  }

  // Keep only imports whose bindings are referenced in the emitted declarations.
  const keptImports = [];
  for (const imp of imports) {
    const used = imp.items.filter(it => new RegExp(`(?<![\\w$.])${it.local.replace(/\$/g, '\\$')}(?![\\w$])`).test(body));
    if (used.length === 0) continue;
    keptImports.push(`import ${imp.isType ? 'type ' : ''}{ ${used.map(u => u.raw).join(', ')} } from ${imp.spec};`);
  }

  const parts = keptImports.length > 0 ? [keptImports.join('\n'), body] : [body];
  return parts.join('\n') + '\n';
}

function emitDeclaration(input, options = {}) {
  const file = options.file ?? 'input.ts';
  if (typeof file !== 'string' || !/\.[cm]?tsx?$/i.test(file) || /\.d\.[cm]?ts$/i.test(file)) {
    throw new TypeError('emitDeclaration requires a non-declaration TypeScript filename');
  }
  const source = Buffer.isBuffer(input) ? input.toString('utf8') : typeof input === 'string' ? input : null;
  if (source === null) throw new TypeError('Expected a string or Buffer');

  const native = emitNativeDts(source);
  if (native !== null) {
    return { backend: 'native', code: native, diagnostics: [] };
  }

  const ts = loadTypeScript();
  const out = ts.transpileDeclaration(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { isolatedDeclarations: true, declaration: true },
  });
  const diagnostics = (out.diagnostics || []).map(d => ({
    file,
    code: `TS${d.code}`,
    severity: 'error',
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    start: d.start ?? 0,
    end: (d.start ?? 0) + (d.length ?? 0),
  }));
  return {
    backend: 'typescript',
    code: diagnostics.length === 0 ? out.outputText : null,
    diagnostics,
  };
}

module.exports = { emitDeclaration };
