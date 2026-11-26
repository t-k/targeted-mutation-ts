'use strict';

// Native Stage 3 standard ES decorator lowering (`__esDecorate` / `__runInitializers`) for ES2022–ES2023
// targets on already-erased JS modules. Covers top-level decorated class declarations (`@Dec export class C`,
// `@Dec export default class C`, `@Dec class C`) with optional `extends Base`, declining conservatively
// (returning null) on member decorators, anonymous classes, or reserved-name collisions.

const esDecorateHelper =
  'var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {\n' +
  '    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }\n' +
  '    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";\n' +
  '    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;\n' +
  '    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});\n' +
  '    var _, done = false;\n' +
  '    for (var i = decorators.length - 1; i >= 0; i--) {\n' +
  '        var context = {};\n' +
  '        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];\n' +
  '        for (var p in contextIn.access) context.access[p] = contextIn.access[p];\n' +
  '        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };\n' +
  '        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);\n' +
  '        if (kind === "accessor") {\n' +
  '            if (result === void 0) continue;\n' +
  '            if (result === null || typeof result !== "object") throw new TypeError("Object expected");\n' +
  '            if (_ = accept(result.get)) descriptor.get = _;\n' +
  '            if (_ = accept(result.set)) descriptor.set = _;\n' +
  '            if (_ = accept(result.init)) initializers.unshift(_);\n' +
  '        }\n' +
  '        else if (_ = accept(result)) {\n' +
  '            if (kind === "field") initializers.unshift(_);\n' +
  '            else descriptor[key] = _;\n' +
  '        }\n' +
  '    }\n' +
  '    if (target) Object.defineProperty(target, contextIn.name, descriptor);\n' +
  '    done = true;\n' +
  '};\n';

const runInitializersHelper =
  'var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {\n' +
  '    var useValue = arguments.length > 2;\n' +
  '    for (var i = 0; i < initializers.length; i++) {\n' +
  '        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);\n' +
  '    }\n' +
  '    return useValue ? value : void 0;\n' +
  '};\n';

const reservedNames = /(?<![\w$.])(?:__esDecorate|__runInitializers|_classDecorators|_classDescriptor|_classExtraInitializers|_classThis|_classSuper|_metadata|__setFunctionName)(?![\w$])/;

function skipTrivia(code, pos) {
  while (pos < code.length) {
    const c = code[pos];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { pos++; continue; }
    if (c === '/' && code[pos + 1] === '/') {
      pos += 2;
      while (pos < code.length && code[pos] !== '\n' && code[pos] !== '\r') pos++;
      continue;
    }
    if (c === '/' && code[pos + 1] === '*') {
      const end = code.indexOf('*/', pos + 2);
      if (end < 0) return -1;
      pos = end + 2;
      continue;
    }
    break;
  }
  return pos;
}

function skipBalanced(code, pos, open, close) {
  if (code[pos] !== open) return -1;
  let depth = 0;
  for (let i = pos; i < code.length; i++) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      i += 2;
      while (i < code.length && code[i] !== '\n' && code[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < code.length && code[i] !== c) {
        if (code[i] === '\\') i += 2;
        else if (code[i] === '\n' || code[i] === '\r') return -1;
        else i++;
      }
      if (i >= code.length) return -1;
      continue;
    }
    if (c === '`') {
      i++;
      let tplDepth = 0;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '`' && tplDepth === 0) break;
        if (code[i] === '$' && code[i + 1] === '{') { tplDepth++; i += 2; continue; }
        if (code[i] === '}' && tplDepth > 0) { tplDepth--; i++; continue; }
        i++;
      }
      if (i >= code.length) return -1;
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

// Parses a decorator expression starting after `@`: `ident(.ident)* (args)?` or `(expr)`.
function parseDecoratorExpr(code, at) {
  let pos = skipTrivia(code, at);
  if (pos < 0 || pos >= code.length) return null;
  const start = pos;
  if (code[pos] === '(') {
    pos = skipBalanced(code, pos, '(', ')');
    if (pos < 0) return null;
  } else {
    const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    while (pos < code.length) {
      const next = skipTrivia(code, pos);
      if (next < 0) return null;
      if (code[next] === '.') {
        const m2 = /^[A-Za-z_$][\w$]*/.exec(code.slice(skipTrivia(code, next + 1)));
        if (!m2) return null;
        pos = skipTrivia(code, next + 1) + m2[0].length;
      } else break;
    }
    const afterId = skipTrivia(code, pos);
    if (afterId >= 0 && code[afterId] === '(') {
      pos = skipBalanced(code, afterId, '(', ')');
      if (pos < 0) return null;
    }
  }
  return { expr: code.slice(start, pos), end: pos };
}

function lowerStage3Decorators(addon, code) {
  if (!code.includes('@')) return code;
  if (reservedNames.test(code) || code.includes('\\u') || /\b(?:eval|with)\b/.test(code)) return null;
  const bytes = Buffer.from(code);
  const records = addon.moduleRecords?.(bytes);
  if (!records) return null;

  const starts = [];
  const declared = new Set();
  for (let i = 0; i < records.length; i += 5) {
    const kind = records[i], first = records[i + 1], last = records[i + 2];
    if (kind === 72) starts.push(first);
    else if (kind === 61) declared.add(bytes.latin1Slice(first, last));
  }
  starts.sort((a, b) => a - b);
  if (starts.length === 0) return null;

  // Require ASCII-only for safe byte-offset slicing.
  if (/[^\x00-\x7f]/.test(code)) return null;

  const edits = [];
  let loweredAny = false;
  let isModule = false;

  for (let idx = 0; idx < starts.length; idx++) {
    const first = starts[idx];
    const end = idx + 1 < starts.length ? starts[idx + 1] : code.length;
    const stmt = code.slice(first, end);
    if (/^(?:import|export)\b/.test(stmt)) isModule = true;
    if (!stmt.startsWith('@')) {
      // Any `@` inside a non-class-decorated statement (e.g. member decorators) declines to TypeScript.
      if (stmt.includes('@')) {
        // Check if `@` appears outside strings/comments by declining conservatively when `@` is in a class.
        if (/\bclass\b/.test(stmt)) return null;
      }
      continue;
    }

    // Parse leading `@dec` list.
    const decorators = [];
    let pos = first;
    while (pos < end) {
      pos = skipTrivia(code, pos);
      if (pos < 0 || pos >= end || code[pos] !== '@') break;
      const dec = parseDecoratorExpr(code, pos + 1);
      if (!dec || dec.end > end) return null;
      decorators.push(dec.expr);
      pos = dec.end;
    }
    if (decorators.length === 0) return null;
    pos = skipTrivia(code, pos);
    if (pos < 0 || pos >= end) return null;

    let exportKind = 'none'; // 'none' | 'named' | 'default'
    if (code.startsWith('export', pos) && !/[\w$]/.test(code[pos + 6] || '')) {
      isModule = true;
      pos = skipTrivia(code, pos + 6);
      if (pos < 0 || pos >= end) return null;
      if (code.startsWith('default', pos) && !/[\w$]/.test(code[pos + 7] || '')) {
        exportKind = 'default';
        pos = skipTrivia(code, pos + 7);
      } else {
        exportKind = 'named';
      }
      if (pos < 0 || pos >= end) return null;
    }

    if (!code.startsWith('class', pos) || /[\w$]/.test(code[pos + 5] || '')) return null;
    pos = skipTrivia(code, pos + 5);
    if (pos < 0 || pos >= end) return null;

    const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(code.slice(pos, end));
    if (!nameMatch || nameMatch[1] === 'extends') return null;
    const className = nameMatch[1];
    pos = skipTrivia(code, pos + className.length);
    if (pos < 0 || pos >= end) return null;

    let superExpr = null;
    if (code.startsWith('extends', pos) && !/[\w$]/.test(code[pos + 7] || '')) {
      pos = skipTrivia(code, pos + 7);
      if (pos < 0 || pos >= end) return null;
      const superStart = pos;
      // Scan simple heritage expression up to `{` at depth 0.
      let depth = 0;
      while (pos < end) {
        const c = code[pos];
        if (c === '{' && depth === 0) break;
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === '"' || c === "'" || c === '`' || c === '/') return null;
        pos++;
      }
      if (pos >= end || code[pos] !== '{') return null;
      superExpr = code.slice(superStart, pos).trim();
      if (!superExpr) return null;
    }

    if (code[pos] !== '{') return null;
    const bodyEnd = skipBalanced(code, pos, '{', '}');
    if (bodyEnd < 0 || bodyEnd > end) return null;
    const bodyInner = code.slice(pos + 1, bodyEnd - 1);
    // Decline member decorators or any `static` members/blocks (static field / static block / addInitializer ordering).
    if (bodyInner.includes('@') || /\bstatic\b/.test(bodyInner)) return null;
    // Ensure nothing follows the class closing brace besides trivia/semicolons.
    const trailing = code.slice(bodyEnd, end).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
    if (trailing !== '' && trailing !== ';') return null;

    const superDecl = superExpr ? `    let _classSuper = ${superExpr};\n` : '';
    const extendsClause = superExpr ? ' extends _classSuper' : '';
    const metaProto = superExpr ? '_classSuper[Symbol.metadata] ?? null' : 'null';
    const exportTail = exportKind === 'named' ? `\nexport { ${className} };` :
      exportKind === 'default' ? `\nexport default ${className};` : '';

    const lowered =
      `let ${className} = (() => {\n` +
      `    let _classDecorators = [${decorators.join(', ')}];\n` +
      `    let _classDescriptor;\n` +
      `    let _classExtraInitializers = [];\n` +
      `    let _classThis;\n` +
      superDecl +
      `    var ${className} = class${extendsClause} {\n` +
      `        static { _classThis = this; }\n` +
      `        static {\n` +
      `            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(${metaProto}) : void 0;\n` +
      `            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);\n` +
      `            ${className} = _classThis = _classDescriptor.value;\n` +
      `            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });\n` +
      `            __runInitializers(_classThis, _classExtraInitializers);\n` +
      `        }${bodyInner}` +
      `    };\n` +
      `    return ${className} = _classThis;\n` +
      `})();${exportTail}`;

    edits.push([first, bodyEnd, lowered]);
    loweredAny = true;
  }

  if (!loweredAny) return code;
  // Scripts without imports/exports get `"use strict";\n` from TypeScript when lowering decorators; decline scripts for now.
  if (!isModule) return null;

  let shebang = '';
  let last = 0;
  if (code.startsWith('#!')) {
    const nl = code.indexOf('\n');
    last = nl < 0 ? code.length : nl + 1;
    shebang = code.slice(0, last);
  }
  let out = shebang + esDecorateHelper + runInitializersHelper;
  for (const [start, end, rep] of edits) {
    out += code.slice(last, start) + rep;
    last = end;
  }
  out += code.slice(last);
  return out;
}

module.exports = { lowerStage3Decorators };
