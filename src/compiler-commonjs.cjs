'use strict';
// Writes a module that the native routes emitted as ECMAScript module text as the CommonJS text that
// TypeScript writes for it. The module is read once more by the certified parser, which reports where each
// statement starts, which statements are imports and exports, the names the module declares, and every name
// that is read as an expression. Whatever is not known for certain is declined (null), and the caller hands
// the file to TypeScript.

// TypeScript's helpers, in the text it writes them, and the order in which it writes them.
const helperText = require('./compiler-commonjs-helpers.json');
// Those the others rest on come first, then `__importStar` and `__exportStar` in the order of their first use.
// The helpers of legacy decorators stand at the head of the module text and are moved among these.
const helperRank = { __createBinding: 0, __setModuleDefault: 1, __decorate: 2, __importStar: 3, __exportStar: 3, __metadata: 4, __param: 5, __importDefault: 6 };

const word = '[A-Za-z_$][\\w$]*';
const quoted = '(?:"[^"\\\\\\n]*"|\'[^\'\\\\\\n]*\')';
const forms = {
  bare: new RegExp(`^import\\s*(${quoted})\\s*;?$`),
  imported: new RegExp(`^import\\s*(?:(${word})\\s*,?\\s*)?(?:\\*\\s*as\\s+(${word})\\s*|\\{([^{}]*)\\}\\s*)?from\\s*(${quoted})\\s*;?$`),
  star: new RegExp(`^export\\s*\\*\\s*from\\s*(${quoted})\\s*;?$`),
  starAs: new RegExp(`^export\\s*\\*\\s*as\\s+(${word})\\s*from\\s*(${quoted})\\s*;?$`),
  from: new RegExp(`^export\\s*\\{([^{}]*)\\}\\s*from\\s*(${quoted})\\s*;?$`),
  list: new RegExp(`^export\\s*\\{([^{}]*)\\}\\s*;?$`),
  item: new RegExp(`^(${word})(?:\\s+as\\s+(${word}))?$`),
  functionHead: new RegExp(`^(?:async\\s+)?function\\s*\\*?\\s*(${word})?\\s*\\(`),
  classHead: new RegExp(`^class(?:\\s+(?!extends\\b)(${word}))?\\s*(?:\\{|extends\\b)`),
  variableHead: new RegExp(`^(const|let|var)\\s+(${word})\\s*(=(?![=>])|;|$)`),
};
// Words whose meaning in CommonJS differs from a module's (checked in real code or raw text).
const reserved = /(?<![\w$.])(?:default_1|__importStar|__importDefault|__exportStar|__createBinding|__setModuleDefault)(?![\w$])/;

const regexAfter = new Set(['', '(', '[', '{', '${', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~', '<', '>', '+', '-', '*', '%', '/', '=>', ')ctrl',
  'return', 'throw', 'case', 'yield', 'await', 'typeof', 'void', 'delete', 'in', 'instanceof', 'new', 'else', 'do']);

// Walks `text` lexically, invoking `visit(name, at, prevToken)` for every identifier in code (skipping
// comments, strings, template literal text and regular expressions). Returns false on ambiguous syntax or
// when `visit` returns false.
function scanCodeIdentifiers(text, visit) {
  const braces = [], parens = [];
  let prev = '', at = 0;
  const skipTemplate = pos => {
    while (pos < text.length) {
      const c = text[pos];
      if (c === '\\') { pos += 2; continue; }
      if (c === '`') { prev = 'lit'; return pos + 1; }
      if (c === '$' && text[pos + 1] === '{') { braces.push('template'); prev = '${'; return pos + 2; }
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
      if (end < 0) return false;
      at = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      at++;
      while (at < text.length && text[at] !== c) {
        if (text[at] === '\\') at += 2;
        else if (text[at] === '\n') return false;
        else at++;
      }
      if (at >= text.length) return false;
      at++;
      prev = 'lit';
      continue;
    }
    if (c === '`') {
      at = skipTemplate(at + 1);
      if (at < 0) return false;
      continue;
    }
    if (c === '}') {
      if (braces.length > 0 && braces[braces.length - 1] === 'template') {
        braces.pop();
        at = skipTemplate(at + 1);
        if (at < 0) return false;
        continue;
      }
      if (braces.length > 0) braces.pop();
      prev = '}';
      at++;
      continue;
    }
    if (c === '{') { braces.push('{'); prev = '{'; at++; continue; }
    if (c === '(') {
      parens.push(prev === 'if' || prev === 'while' || prev === 'for' || prev === 'with' || prev === 'await-for');
      prev = '(';
      at++;
      continue;
    }
    if (c === ')') {
      prev = parens.pop() ? ')ctrl' : ')';
      at++;
      continue;
    }
    if (c === '/') {
      if (prev === '}' || prev === '++' || prev === '--' || prev === 'of' || prev === 'debugger' || prev === 'break' || prev === 'continue') return false;
      if (regexAfter.has(prev)) {
        at++;
        let inClass = false;
        while (at < text.length) {
          const rc = text[at];
          if (rc === '\\') { at += 2; continue; }
          if (rc === '\n') return false;
          if (inClass) { if (rc === ']') inClass = false; }
          else if (rc === '[') inClass = true;
          else if (rc === '/') { at++; break; }
          at++;
        }
        while (at < text.length && /[a-z]/i.test(text[at])) at++;
        prev = 'lit';
        continue;
      }
      at += text[at + 1] === '=' ? 2 : 1;
      prev = '/';
      continue;
    }
    const code = text.charCodeAt(at);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36) {
      let end = at + 1;
      while (end < text.length) {
        const u = text.charCodeAt(end);
        if ((u >= 65 && u <= 90) || (u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u === 95 || u === 36) end++;
        else break;
      }
      const name = text.slice(at, end);
      if (visit(name, at, prev) === false) return false;
      prev = prev === '.' ? 'id' : (prev === 'for' && name === 'await') ? 'await-for' : name;
      at = end;
      continue;
    }
    if (code >= 48 && code <= 57) {
      const radixPrefix = c === '0' && (text[at + 1] === 'x' || text[at + 1] === 'X' || text[at + 1] === 'b' || text[at + 1] === 'B' || text[at + 1] === 'o' || text[at + 1] === 'O');
      at++;
      while (at < text.length) {
        const u = text.charCodeAt(at);
        if ((u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || u === 95 || u === 46) {
          if (!radixPrefix && (u === 69 || u === 101) && (text[at + 1] === '+' || text[at + 1] === '-')) at += 2;
          else at++;
        } else break;
      }
      prev = 'lit';
      continue;
    }
    if (c === '.' && text[at + 1] === '.' && text[at + 2] === '.') { prev = '...'; at += 3; continue; }
    if (c === '?' && text[at + 1] === '.' && !(text.charCodeAt(at + 2) >= 48 && text.charCodeAt(at + 2) <= 57)) { prev = '.'; at += 2; continue; }
    if (c === '=' && text[at + 1] === '>') { prev = '=>'; at += 2; continue; }
    if ((c === '+' && text[at + 1] === '+') || (c === '-' && text[at + 1] === '-')) { prev = c + c; at += 2; continue; }
    if (c === '*') { prev = prev === 'function' ? 'function*' : '*'; at++; continue; }
    prev = c;
    at++;
  }
  return true;
}

// An object that is assigned to, in parentheses, and a loop whose head takes a value apart.
const objectTarget = /\(\s*\{[\s\S]{0,2000}?\}\s*=(?![=>])/;
const loopTarget = /\bfor\s*(?:await\s*)?\(\s*[\[{]/;

// Skips white space and comments starting at `at`. Returns -1 on an unterminated block comment.
function skipTrivia(text, at) {
  while (at < text.length) {
    const ch = text[at];
    if (ch === ' ' || ch === '\n' || ch === '\t') { at++; continue; }
    if (ch === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at + 2);
      at = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      if (end < 0) return -1;
      at = end + 2;
      continue;
    }
    break;
  }
  return at;
}

// The first three characters behind a name that are not white space or comments.
function followers(text, at) {
  // Erased type arguments leave a run of blanks of any length behind a name.
  at = skipTrivia(text, at);
  if (at < 0) return ['', '', ''];
  return [text[at] ?? '', text[at + 1] ?? '', text[at + 2] ?? '', at];
}

// Skips white space and block comments backwards from `at`, returning the index right after the preceding
// non-trivia character, or -1 if a comment boundary is ambiguous.
function skipTriviaBack(text, at, includeOpenParen = false) {
  let pos = at;
  while (pos > 0) {
    const ch = text[pos - 1];
    if (ch === ' ' || ch === '\t' || (includeOpenParen && ch === '(')) { pos--; continue; }
    if (ch === '\n') {
      const lineStart = text.lastIndexOf('\n', pos - 2) + 1;
      const line = text.slice(lineStart, pos - 1);
      const slash = line.indexOf('//');
      if (slash >= 0) {
        const before = line.slice(0, slash);
        if (/['"`]|\/\*/.test(before)) return -1;
        pos = lineStart + slash;
        continue;
      }
      pos--;
      continue;
    }
    if (ch === '/' && pos >= 2 && text[pos - 2] === '*') {
      const start = text.lastIndexOf('/*', pos - 3);
      if (start < 0) return -1;
      pos = start;
      continue;
    }
    break;
  }
  return pos;
}

// Whether a name is the target of an assignment or of an update, by the signs around it.
function writes(text, at, one, two, three, prevToken) {
  if (one === ')') {
    // A name in parentheses is written through them: the signs behind the closing ones count.
    let end = at;
    while (end < text.length && /[\w$]/.test(text[end])) end++;
    for (;;) {
      end = skipTrivia(text, end);
      if (end < 0) return true;
      if (text[end] === ')') { end++; continue; }
      break;
    }
    [one, two, three] = [text[end] ?? '', text[end + 1] ?? '', text[end + 2] ?? ''];
  }
  const pair = one + two;
  if (one === '=' && two !== '=' && two !== '>') return true;
  if (pair === '++' || pair === '--') return true;
  if (two === '=' && /[-+*/%&|^]/.test(one)) return true;
  if (three === '=' && ['**', '<<', '>>', '&&', '||', '??'].includes(pair)) return true;
  if (pair === '>>' && three === '>') return true;
  if (prevToken === '++' || prevToken === '--') return true;
  if (prevToken !== '(') return false;
  const before = skipTriviaBack(text, at, true);
  if (before < 0) return true;
  const leading = text.slice(Math.max(0, before - 2), before);
  return leading === '++' || leading === '--';
}

// Whether a non-reference occurrence of a name is immediately preceded by a declaration keyword.
function precededByDecl(prevToken) {
  return prevToken === 'const' || prevToken === 'let' || prevToken === 'var' || prevToken === 'class' ||
    prevToken === 'function' || prevToken === 'function*' || prevToken === 'catch';
}

// The members of a braced list: [local, exported] pairs, or null for a member that is not two plain names.
function members(text) {
  const pairs = [];
  for (const part of text.split(',')) {
    const member = part.trim();
    if (member === '') continue;
    const match = forms.item.exec(member);
    if (match === null) return null;
    pairs.push([match[1], match[2] ?? match[1]]);
  }
  return pairs;
}

// The name TypeScript derives from a module specifier, before the number that makes it unique.
function specifierName(specifier) {
  return specifier.slice(specifier.lastIndexOf('/') + 1).replace(/^(\d)/, '_$1').replace(/\W/g, '_');
}

// A name as it may stand in the source in front of a non-null mark, with white space or comments between.
// A single dot in front is a property access, while three dots (`...f!()`) are a spread before the name.
const marked = name => new RegExp(`(?<![\\w$])(?<!(?<!\\.\\.)\\.)${name.replace(/\$/g, '\\$')}(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\n]*\\n)*!(?!=)`);

// `source` is the text the module was compiled from, as a string of bytes.
function toCommonJs(addon, code, source, experimentalDecorators = false, spans = null) {
  const bytes = Buffer.from(code);
  if (bytes.length > 1048576) return null;
  // One byte per character, so that the parser's offsets index the text.
  const text = bytes.latin1Slice();
  if (reserved.test(text) || /(?<![\w$.])default_1(?![\w$])/.test(source) || text.includes('\r') ||
      text.includes('\xe2\x80\xa8') || text.includes('\xe2\x80\xa9')) return null;
  // The CommonJS dialect of TypeScript (`export =`, `import x = require()`) is written without the module's head.
  if (/\bexport\s*=|\bimport\s+[\w$]+\s*=/.test(source) || /(?<![\w$.])module\s*\.\s*exports\b/.test(text)) return null;
  const records = addon.moduleRecords?.(bytes);
  if (!records) return null;

  const starts = new Set(), listed = new Set(), targets = [], moduleEnds = new Map(), defaults = new Map(), direct = new Set();
  const declared = [], references = [], shorthand = new Set();
  for (let index = 0; index < records.length; index += 5) {
    const kind = records[index], first = records[index + 1], last = records[index + 2];
    if (kind === 72) starts.add(first);
    else if (kind === 76) listed.add(first);
    else if (kind === 74) targets.push([first, last]);
    else if (kind === 9) moduleEnds.set(first, last);
    else if (kind === 66) defaults.set(first, last);
    else if (kind === 67) direct.add(first);
    else if (kind === 61) declared.push({ name: text.slice(first, last), first, last, kind: records[index + 3], isFunction: records[index + 4] === 1 });
    else if (kind === 43 || kind === 62) {
      references.push({ first, last, shorthand: kind === 62 });
    } else if (kind === 33 || kind === 40 || kind === 41) return null;
  }
  const order = [...starts].sort((a, b) => a - b);
  // Without an import or export the text is a script, which TypeScript writes without the module's head.
  if (order.length === 0 || moduleEnds.size + defaults.size + direct.size === 0) return null;
  const statementOf = position => {
    let low = 0, high = order.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if (order[middle] <= position) low = middle; else high = middle - 1; }
    return order[low] <= position ? low : -1;
  };
  const endOf = index => index + 1 < order.length ? order[index + 1] : text.length;
  const declarations = new Map();
  for (const entry of declared) {
    if (declarations.has(entry.name)) return null;
    declarations.set(entry.name, entry);
  }

  // Edits of the text: [first, last, replacement], applied together at the end. `after` holds the statements
  // that TypeScript writes behind a statement.
  const edits = [], after = new Map(), hoisted = [], cleared = [], helpers = new Map();
  const renamed = new Map(), kept = new Map(), moduleNames = new Map(), taken = new Set();
  const behind = (index, line) => after.set(index, (after.get(index) ?? '') + line + '\n');
  const moduleName = specifier => {
    const base = specifierName(specifier.slice(1, -1));
    if (/[^\x20-\x7e]/.test(specifier)) return null;
    // A specifier without an ASCII letter or digit in its last part is named in a way that is not reproduced here.
    if (!/[A-Za-z0-9]/.test(specifier.slice(specifier.lastIndexOf('/') + 1))) return null;
    for (let number = 1; ; number++) {
      const name = `${base}_${number}`;
      if (taken.has(name)) continue;
      // A word of the source (including erased types) with this spelling would make TypeScript choose another number.
      const clash = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
      if (clash.test(text) || clash.test(source)) return null;
      taken.add(name);
      return name;
    }
  };
  // Track each helper's earliest source position; dependencies are sorted first, ties by first use in source.
  const need = (pos, ...names) => {
    for (const name of names) if (!helpers.has(name) || pos < helpers.get(name)) helpers.set(name, pos);
  };
  const exportsOfLists = [];
  let front = '';

  // Helpers that the lowering of legacy decorators wrote in front of the module.
  const ownHelpers = {};
  let lead = 0;
  if (experimentalDecorators) {
    for (; lead < order.length; lead++) {
      const statement = text.slice(order[lead], endOf(lead));
      const found = /^var (__decorate|__metadata|__param) = \(this && this\.\1\) \|\| /.exec(statement);
      if (found === null) break;
      if (new RegExp(`(?<![\\w$.])${found[1]}(?![\\w$])`).test(source)) return null;
      ownHelpers[found[1]] = statement.trimEnd() + '\n';
      helpers.set(found[1], order[lead]);
      edits.push([order[lead], endOf(lead), '']);
    }
  }
  // The temporaries of decorator metadata are declared behind those helpers, and stay in front of the head.
  let temporaries = '';
  if (lead !== 0 && lead < order.length && /^var _[a-z0-9]+(?:, _[a-z0-9]+)*;\s*$/.test(text.slice(order[lead], endOf(lead)))) {
    temporaries = text.slice(order[lead], endOf(lead)).trimEnd() + '\n';
    edits.push([order[lead], endOf(lead), '']);
    lead++;
  }
  for (let index = lead; index < order.length; index++) {
    const first = order[index], end = endOf(index);
    if (moduleEnds.has(first)) {
      const last = moduleEnds.get(first);
      const rawStatement = text.slice(first, last).trim();
      if (/[^\s;]/.test(text.slice(last, end).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))) return null;
      if (/["'][^"'\n]*(?:\/\*|\/\/)/.test(rawStatement)) return null;
      const statement = rawStatement.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').trim();
      let match;
      const editWithSpec = (replacement, spec) => {
        const specAt = text.lastIndexOf(spec, last - spec.length);
        const repAt = replacement.indexOf(spec);
        edits.push(specAt >= first && specAt + spec.length <= last && repAt >= 0 ?
          [first, last, replacement, [repAt, specAt, spec.length]] : [first, last, replacement]);
      };
      if ((match = forms.bare.exec(statement))) editWithSpec(`require(${match[1]});`, match[1]);
      else if ((match = forms.imported.exec(statement))) {
        const [, defaultName, namespaceName, list, specifier] = match;
        if (defaultName === undefined && namespaceName === undefined && list === undefined) return null;
        if (defaultName !== undefined && namespaceName !== undefined) return null;
        const pairs = list === undefined ? [] : members(list);
        if (pairs === null || pairs.some(([, local]) => local === 'default')) return null;
        if (namespaceName !== undefined) {
          need(first, '__createBinding', '__setModuleDefault', '__importStar');
          kept.set(namespaceName, { statement: index, kind: 'namespace' });
          editWithSpec(`const ${namespaceName} = __importStar(require(${specifier}));`, specifier);
        } else {
          const name = moduleName(specifier);
          if (name === null) return null;
          const hasDefaultPair = pairs.some(([imported]) => imported === 'default');
          const hasNamedPair = pairs.some(([imported]) => imported !== 'default');
          let value = `require(${specifier})`;
          if ((defaultName !== undefined || hasDefaultPair) && hasNamedPair) { need(first, '__createBinding', '__setModuleDefault', '__importStar'); value = `__importStar(${value})`; }
          else if (defaultName !== undefined || hasDefaultPair) { need(first, '__importDefault'); value = `__importDefault(${value})`; }
          if (defaultName !== undefined) renamed.set(defaultName, { text: `${name}.default`, statement: index, kind: 'default' });
          let pairOrder = 0;
          for (const [imported, local] of pairs) {
            if (renamed.has(local)) return null;
            renamed.set(local, { text: `${name}.${imported}`, statement: index, kind: imported === 'default' ? 'default' : 'import', order: pairOrder++ });
          }
          // The import of the JSX runtime is written by the emitter where the module's first import or export
          // stands, which may be behind code that uses it. Imports are in force before any code, so the
          // order is free there; here the call of require has to come first, where TypeScript writes it.
          // (TypeScript orders the import of createElement differently; such a module is left to it.)
          const generatedJsxImport = pairs.length !== 0 && pairs.every(([imported, local]) =>
            local.startsWith('_tmt') && !source.includes(local) &&
            (imported === 'jsx' || imported === 'jsxs' || imported === 'Fragment' || imported === 'jsxDEV' || imported === 'createElement'));
          if (generatedJsxImport && pairs.some(([imported]) => imported === 'createElement')) return null;
          if (generatedJsxImport && index !== 0) {
            if (front !== '') return null;
            front = `const ${name} = ${value};\n`;
            edits.push([first, last, ';']);
          } else editWithSpec(`const ${name} = ${value};`, specifier);
        }
      } else if ((match = forms.star.exec(statement))) {
        need(first, '__createBinding', '__exportStar');
        editWithSpec(`__exportStar(require(${match[1]}), exports);`, match[1]);
      } else if ((match = forms.starAs.exec(statement))) {
        need(first, '__createBinding', '__setModuleDefault', '__importStar');
        cleared.push(match[1]);
        editWithSpec(`exports.${match[1]} = __importStar(require(${match[2]}));`, match[2]);
      } else if ((match = forms.from.exec(statement))) {
        const pairs = members(match[1]);
        if (pairs === null || pairs.length === 0) return null;
        const name = moduleName(match[2]);
        if (name === null) return null;
        let lines = `var ${name} = require(${match[2]});`;
        for (const [sourceName, exported] of pairs) {
          cleared.push(exported);
          if (sourceName === 'default') {
            need(first, '__importDefault');
            lines += `\nObject.defineProperty(exports, "${exported}", { enumerable: true, get: function () { return __importDefault(${name}).default; } });`;
          } else {
            lines += `\nObject.defineProperty(exports, "${exported}", { enumerable: true, get: function () { return ${name}.${sourceName}; } });`;
          }
        }
        editWithSpec(lines, match[2]);
      } else if ((match = forms.list.exec(statement))) {
        const pairs = members(match[1]);
        if (pairs === null) return null;
        exportsOfLists.push(...pairs.map(([local, exported], item) => ({ local, exported, at: first + item / 1024 })));
        for (const [, exported] of pairs) cleared.push(exported);
        // The statement leaves a semicolon, so that the statements around it stay apart.
        edits.push([first, last, ';']);
      } else return null;
      continue;
    }
    const head = text.slice(first, Math.min(end, first + 400));
    if (defaults.has(first)) {
      const valueAt = defaults.get(first);
      const value = text.slice(valueAt, Math.min(end, valueAt + 400));
      let match;
      if ((match = forms.functionHead.exec(value))) {
        const name = match[1] ?? 'default_1';
        if (match[1] === undefined) edits.push([valueAt + match[0].length - 1, valueAt + match[0].length - 1, ' default_1']);
        edits.push([first, valueAt, '']);
        hoisted.push([first, `exports.default = ${name};`]);
        if (match[1] !== undefined) kept.set(name, { statement: index, kind: 'function' });
      } else if ((match = forms.classHead.exec(value))) {
        const name = match[1] ?? 'default_1';
        if (match[1] === undefined) edits.push([valueAt + 5, valueAt + 5, ' default_1']);
        edits.push([first, valueAt, '']);
        behind(index, `exports.default = ${name};`);
        if (match[1] !== undefined) kept.set(name, { statement: index, kind: 'class' });
      } else if (/^(?:async\s+function|function|class)\b/.test(value)) return null;
      else edits.push([first, valueAt, 'exports.default = ']);
      continue;
    }
    if (direct.has(first)) {
      const gap = /^export\s+/.exec(head);
      if (gap === null) return null;
      const at = first + gap[0].length, rest = text.slice(at, Math.min(end, at + 400));
      let match;
      if ((match = forms.functionHead.exec(rest)) && match[1] !== undefined) {
        edits.push([first, at, '']);
        hoisted.push([first, `exports.${match[1]} = ${match[1]};`]);
        kept.set(match[1], { statement: index, kind: 'function' });
      } else if ((match = forms.classHead.exec(rest)) && match[1] !== undefined) {
        edits.push([first, at, '']);
        cleared.push(match[1]);
        behind(index, `exports.${match[1]} = ${match[1]};`);
        kept.set(match[1], { statement: index, kind: 'class' });
      } else if ((match = forms.variableHead.exec(rest))) {
        const [, keyword, name, next] = match;
        const names = declared.filter(entry => entry.first >= first && entry.first < end);
        if (names.length !== 1 || names[0].name !== name || names[0].first !== at + match[0].indexOf(name, keyword.length)) return null;
        cleared.push(name);
        if (next !== '=') {
          // A declaration without a value. The lowering of an enum or a namespace writes one in front of the
          // function that fills the object; TypeScript then keeps the variable and exports it where it is made.
          const filled = index + 1 < order.length ? text.slice(end, endOf(index + 1)) : '';
          let filledEnd = filled !== '' ? skipTriviaBack(filled, filled.length, true) : -1;
          while (filledEnd > 0 && filled[filledEnd - 1] === ';') {
            const prev = skipTriviaBack(filled, filledEnd - 1, true);
            if (prev < 0) { filledEnd = -1; break; }
            filledEnd = prev;
          }
          const filledHead = filledEnd > 0 ? filled.slice(0, filledEnd) : '';
          const tail = new RegExp(`\\}\\)\\(${name.replace(/\$/g, '\\$')}\\s*\\|\\|\\s*\\(${name.replace(/\$/g, '\\$')}\\s*=\\s*\\{\\}\\)\\)$`);
          const spelled = name.replace(/\$/g, '\\$');
          const lowered = new RegExp(`(?<![\\w$.])(?:enum|namespace|module)\\s+${spelled}(?![\\w$])`).test(source) && !new RegExp(`(?<![\\w$.])(?:var|let|const)\\s+${spelled}(?![\\w$])`).test(source);
          if (keyword === 'var' && lowered && filledHead.startsWith(`(function (${name})`) && tail.test(filledHead)) {
            edits.push([first, at, '']);
            const found = tail.exec(filledHead);
            const semi = filled[filledEnd] === ';' ? '' : ';';
            edits.push([end + found.index, end + found.index + found[0].length, `})(${name} || (exports.${name} = ${name} = {}))${semi}`]);
            kept.set(name, { statement: index, kind: 'filled' });
          } else {
            if (/[^\s;]/.test(text.slice(names[0].last, end))) return null;
            edits.push([first, end, ';\n']);
            renamed.set(name, { text: `exports.${name}`, statement: index, kind: 'variable' });
          }
          continue;
        }
        const equals = at + match[0].length;
        const value = text.slice(equals, end);
        const shape = valueShape(addon, value);
        if (shape === null) return null;
        if (shape === 'function') {
          if (keyword !== 'const') return null;
          // Blanks behind the value (including before a newline or semicolon) or in front of a function are
          // where an assertion was erased; TypeScript does not take a value under an assertion for a function.
          const headAt = skipTrivia(value, 0);
          if (headAt < 0 || /\/\/|\/\*/.test(value.slice(0, headAt))) return null;
          const tailEnd = skipTriviaBack(value, value.length, true);
          if (tailEnd < 0) return null;
          const hasSemi = tailEnd > 0 && value[tailEnd - 1] === ';';
          if (!hasSemi && /\/\/|\/\*/.test(value.slice(tailEnd))) return null;
          const beforeEnd = hasSemi ? value.slice(0, tailEnd - 1) : value.replace(/\n[ \t]*$/, '').replace(/\n+$/, '');
          const leading = /^([ \t]*)([\s\S]*)$/.exec(beforeEnd);
          if (skipTriviaBack(beforeEnd, beforeEnd.length, true) !== beforeEnd.length ||
              ((leading[1].length > 1 || leading[2].startsWith('\n')) && /^(?:async|function|class)(?![\w$])/.test(leading[2].trimStart()))) return null;
          edits.push([first, at, '']);
          behind(index, `exports.${name} = ${name};`);
        } else edits.push([first, names[0].last, `exports.${name}`]);
        renamed.set(name, { text: `exports.${name}`, statement: index, kind: 'variable', declaration: names[0].first });
      } else return null;
      continue;
    }
    // Any other statement that begins with one of the two words is a form that is not written here.
    if (/^(?:import\b(?!\s*[.(])|export\b)/.test(head) || head.startsWith('@')) return null;
  }

  // The names of a braced export list. A function is exported at the top (grouped at its first export);
  // any other name behind the statement that declares it; an imported name through a getter behind its import
  // in the order of the import's specifiers.
  const hoistedAt = new Map();
  for (const [at, line] of hoisted) {
    const match = /^exports\.[\w$]+ = ([\w$]+);$/.exec(line);
    if (match && !hoistedAt.has(match[1])) hoistedAt.set(match[1], at);
  }
  const gettersByStatement = new Map();
  let listSeq = 0;
  for (const { local, exported, at: listed } of exportsOfLists) {
    const seq = listSeq++;
    const source = renamed.get(local);
    if (source !== undefined) {
      if (source.kind !== 'import') return null;
      let list = gettersByStatement.get(source.statement);
      if (list === undefined) { list = []; gettersByStatement.set(source.statement, list); }
      list.push([source.order, seq, `Object.defineProperty(exports, "${exported}", { enumerable: true, get: function () { return ${source.text}; } });`]);
      continue;
    }
    const declaration = declarations.get(local);
    if (declaration === undefined || kept.get(local)?.kind === 'namespace' || kept.get(local)?.kind === 'filled') return null;
    const statement = statementOf(declaration.first);
    if (statement < 0 || direct.has(order[statement]) || defaults.has(order[statement]) || moduleEnds.has(order[statement])) return null;
    const head = text.slice(order[statement], declaration.first);
    if (declaration.isFunction && /^(?:async\s+)?function\s*\*?\s*$/.test(head)) {
      if (!hoistedAt.has(local)) hoistedAt.set(local, listed);
      hoisted.push([hoistedAt.get(local), `exports.${exported} = ${local};`, listed]);
      cleared.splice(cleared.indexOf(exported), 1);
      kept.set(local, { statement, kind: 'function' });
    } else if (/^const\s+$/.test(head) || /^class\s+$/.test(head)) {
      behind(statement, `exports.${exported} = ${local};`);
      if (!kept.has(local)) kept.set(local, { statement, kind: head.startsWith('class') ? 'class' : 'constant' });
    } else if (/^(?:let|var)\s+$/.test(head) && declared.filter(entry => entry.first >= order[statement] && entry.first < endOf(statement)).length === 1) {
      // A variable that may be assigned again, as the class of a legacy decorator is: its export follows the
      // declaration when it has an initializer, and every assignment writes the export too.
      const [initOne, initTwo] = followers(text, declaration.last);
      if (initOne === '=' && initTwo !== '=') behind(statement, `exports.${exported} = ${local};`);
      if (!kept.has(local)) kept.set(local, { statement, kind: 'mutable', exported: [] });
      if (kept.get(local).kind !== 'mutable') return null;
      kept.get(local).exported.push(exported);
    } else return null;
  }
  for (const [statement, list] of gettersByStatement) {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, , line] of list) behind(statement, line);
  }

  const targeted = position => targets.some(([first, last]) => position >= first && position < last);
  // Every occurrence of a renamed name in code has to be one that the parser read as an expression, a
  // property behind a dot, a property key/label/method name, or the declaration itself. A local name that
  // stays is exported by value, so nothing may write or shadow it.
  const inEdit = position => edits.some(([first, last, replacement]) => position >= first && position < last && replacement !== undefined);
  const referenceAt = new Map(references.map(reference => [reference.first, reference]));
  const scanned = scanCodeIdentifiers(text, (name, at, prevToken) => {
    if (name === 'exports' && prevToken !== '.') {
      const [one] = followers(text, at + name.length);
      if (one !== ':') return false;
    }
    if (name === 'import' && prevToken !== '.' && prevToken !== '#' && text[at - 1] !== '#' && !inEdit(at)) {
      const [one, , , nextAt] = followers(text, at + 6);
      if (one === '.') return false;
      if (one === '(') {
        const dyn = new RegExp(`^\\((${quoted})\\)`).exec(text.slice(nextAt, nextAt + 300));
        if (dyn === null) return false;
        need(at, '__createBinding', '__setModuleDefault', '__importStar');
        const spec = dyn[1];
        const rep = `Promise.resolve().then(() => __importStar(require(${spec})))`;
        const specAt = text.indexOf(spec, nextAt);
        const repAt = rep.indexOf(spec);
        edits.push([at, nextAt + dyn[0].length, rep, [repAt, specAt, spec.length]]);
        return;
      }
    }
    const target = renamed.get(name), local = target === undefined ? kept.get(name) : undefined;
    if (target === undefined && local === undefined) return;
    if (prevToken === '.') return;
    const before = text[at - 1], reference = referenceAt.get(at);
    if (target !== undefined) {
      if (target.declaration === at || inEdit(at)) return;
      if (prevToken === '@' || before === '@') return false;
      if (reference === undefined || reference.last !== at + name.length) {
        // Non-reference identifier in code: safe when it is a property key/label (`name:`), a method or
        // accessor definition (`name(` not after `function`/`function*`), a label jump, or a static member.
        if (reference === undefined) {
          const [one] = followers(text, at + name.length);
          if (one === ':' || prevToken === 'break' || prevToken === 'continue' || prevToken === 'static' ||
              (one === '(' && prevToken !== 'function' && prevToken !== 'function*')) return;
        }
        return false;
      }
      const [one, two, three, nextAt] = followers(text, at + name.length);
      if (/[\x80-\xff\\]/.test(one)) return false;
      if (target.kind !== 'variable' && (writes(text, at, one, two, three, prevToken) || targeted(at))) return false;
      // An optional call is written by TypeScript with parentheses that end the chain; it is left to it.
      if (one === '?' && two === '.') {
        const afterOpt = skipTrivia(text, nextAt + 2);
        if (afterOpt < 0 || text[afterOpt] === '(' || text[afterOpt] === '`') return false;
      }
      const called = (one === '(' || one === '`') && prevToken !== 'new';
      let value = called ? `(0, ${target.text})` : target.text;
      if (called) {
        // The parenthesis would continue a statement in front that ends without a semicolon. Where a
        // statement of a list starts, a semicolon is written; elsewhere the call has to follow, on its
        // line, something that cannot be the end of a statement.
        if (starts.has(at) || listed.has(at)) value = ';' + value;
        else {
          const prev = skipTriviaBack(text, at, false);
          if (prev < 0) {
            if (prevToken !== '' && !'([{,;:?=!&|^~<>+-*%/'.includes(prevToken[0]) && prevToken !== '=>') return false;
          } else if (text.slice(prev, at).includes('\n') && prev > 0 && /[\w$)\]}'"`\x80-\xff]/.test(text[prev - 1])) return false;
        }
      }
      edits.push([at, at + name.length, reference.shorthand ? `${name}: ${target.text}` : value]);
    } else if (reference === undefined && (local.kind === 'function' || local.kind === 'class' || local.kind === 'mutable' || local.kind === 'constant')) {
      // A name in an object that is assigned to, a loop variable, or a shadowing declaration in a block
      // is not among the references. Only its own declaration (and the self-name of a lowered decorated
      // class expression), a property key, label, or method name are harmless.
      const decl = declarations.get(name);
      const isSelfClassName = local.kind === 'mutable' && decl !== undefined && at > decl.first && at < endOf(local.statement) &&
        /^\s*=\s*class\s+$/.test(text.slice(decl.last, at));
      if (at !== decl?.first && !isSelfClassName && !inEdit(at)) {
        if (prevToken === '@' || before === '@') return false;
        const [one, , , nextAt] = followers(text, at + name.length);
        if (one === ':' || prevToken === 'break' || prevToken === 'continue' || prevToken === 'static' ||
            (one === '(' && prevToken !== 'function' && prevToken !== 'function*')) return;
        if (one === '}' || one === ',' || one === '=' || one === ']' || one === ')' || one === ';' || one === '{' || one === '(') return false;
        if (precededByDecl(prevToken)) return false;
        if (nextAt !== undefined && /^(?:of|in)(?![\w$])/.test(text.slice(nextAt))) return false;
      }
    } else if (reference !== undefined && local.kind === 'mutable') {
      const [one, two, three, nextAt] = followers(text, at + name.length);
      if (loopTarget.test(text) || (nextAt !== undefined && /^(?:of|in)(?![\w$])/.test(text.slice(nextAt)))) return false;
      if (targets.some(([first, last]) => first === at && last === at + name.length) && one === '=' && two !== '=' && two !== '>') {
        edits.push([at, at, local.exported.slice().reverse().map(exported => `exports.${exported} = `).join('')]);
      } else if (writes(text, at, one, two, three, prevToken) || targeted(at)) return false;
    } else if (reference !== undefined && local.kind === 'filled') {
      // The variable of a lowered enum or namespace is written only by the function that fills it.
      const [one, two, three] = followers(text, at + name.length);
      if (statementOf(at) !== local.statement + 1 && (writes(text, at, one, two, three, prevToken) || targeted(at))) return false;
    } else if (reference !== undefined && (local.kind === 'function' || local.kind === 'class')) {
      // A function or a class is exported by value: an assignment to it would have to write the export too.
      const [one, two, three, nextAt] = followers(text, at + name.length);
      if (writes(text, at, one, two, three, prevToken) || targeted(at)) return false;
      // The head of a loop and a parenthesized object are the targets that the parser does not report.
      if ((nextAt !== undefined && /^(?:of|in)(?![\w$])/.test(text.slice(nextAt))) || loopTarget.test(text)) return false;
      if (objectTarget.test(text) && (one === ',' || one === '}')) return false;
    }
  });
  if (!scanned) return null;

  // A non-null mark on a name keeps TypeScript from writing a call of it as `(0, f)()`, and the mark is gone
  // from the text that is read here.
  for (const name of renamed.keys()) if (source.includes('!') && marked(name).test(source)) return null;
  if (new Set(cleared).size !== cleared.length) return null;
  edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const bodySpans = spans === null ? null : [];
  let body = '', position = order[0], next = 0;
  for (let index = 0; index < order.length; index++) {
    const end = endOf(index);
    while (next < edits.length && edits[next][0] < end) {
      const [first, last, replacement, specCopy] = edits[next++];
      if (first < position) return null;
      if (bodySpans !== null) {
        if (first > position) bodySpans.push([first - position, position]);
        if (specCopy !== undefined) {
          const [repAt, specAt, specLen] = specCopy;
          if (repAt > 0) bodySpans.push([repAt, -1]);
          bodySpans.push([specLen, specAt]);
          if (replacement.length > repAt + specLen) bodySpans.push([replacement.length - repAt - specLen, -1]);
        } else if (replacement.length > 0) bodySpans.push([replacement.length, -1]);
      }
      body += text.slice(position, first) + replacement;
      position = last;
    }
    if (position > end) return null;
    if (bodySpans !== null && end > position) bodySpans.push([end - position, position]);
    body += text.slice(position, end);
    position = end;
    if (after.has(index)) {
      const added = (/[;}\s]$/.test(body.trimEnd().slice(-1)) || body.trim() === '' ? '\n' : ';\n') + after.get(index);
      if (bodySpans !== null) bodySpans.push([added.length, -1]);
      body += added;
    }
  }
  const prelude = text.slice(0, order[0]);
  const hashbang = prelude.startsWith('#!') ? prelude.slice(0, prelude.indexOf('\n') + 1 || prelude.length) : '';
  // The directives of the module stay in front of everything that is written here.
  // A directive is a string alone in its statement; behind it only comments may stand.
  let directives = 0, strict = false, prologueEnd = order[0];
  for (; directives < order.length; directives++) {
    const found = /^(["'])[^"'\\\n]*\1[ \t]*;?/.exec(text.slice(order[directives], endOf(directives)));
    if (found === null || !/^\s*(?:$|\/[/*])/.test(text.slice(order[directives] + found[0].length, endOf(directives)))) break;
    if (after.has(directives) || edits.some(([first, last]) => first < order[directives] + found[0].length && last > order[directives])) return null;
    strict ||= /^(["'])use strict\1/.test(found[0]);
    prologueEnd = order[directives] + found[0].length;
  }
  const prologue = text.slice(order[0], prologueEnd);
  if (prologue !== '') {
    body = body.slice(prologue.length);
    if (bodySpans !== null) {
      let drop = prologue.length;
      while (drop > 0 && bodySpans.length > 0) {
        const [len, at] = bodySpans[0];
        if (len <= drop) { drop -= len; bodySpans.shift(); }
        else { bodySpans[0] = [len - drop, at < 0 ? -1 : at + drop]; drop = 0; }
      }
    }
  }
  const strictLine = strict ? '' : '"use strict";\n';
  const prologueText = prologue === '' ? '' : prologue.trimEnd().replace(/;?$/, ';') + '\n';
  let headAfterPrologue = '';
  for (const name of [...helpers.keys()].sort((a, b) => helperRank[a] - helperRank[b] || helpers.get(a) - helpers.get(b))) headAfterPrologue += ownHelpers[name] ?? helperText[name];
  headAfterPrologue += temporaries + 'Object.defineProperty(exports, "__esModule", { value: true });\n';
  if (cleared.length !== 0) {
    for (let i = 0; i < cleared.length; i += 50) {
      headAfterPrologue += cleared.slice(i, i + 50).reverse().map(name => `exports.${name}`).join(' = ') + ' = void 0;\n';
    }
  }
  // Functions are exported in the order of the statements that first export them, keeping aliases together.
  for (const [, line] of hoisted.sort((a, b) => a[0] - b[0] || (a[2] ?? a[0]) - (b[2] ?? b[0]))) headAfterPrologue += line + '\n';
  const head = hashbang + strictLine + prologueText + headAfterPrologue;
  const preludeRest = prelude.slice(hashbang.length);
  const result = Buffer.from(head + front + preludeRest + body, 'latin1').toString();
  // The text is read once more by the parser and checked against Node's CommonJS wrapper grammar
  // (catching top-level await or wrapper-parameter clashes) before it is returned.
  if (addon.moduleRecords(Buffer.from(result)) === null) return null;
  try {
    new Function('exports', 'require', 'module', '__filename', '__dirname', result.startsWith('#!') ? '//' + result : result);
  } catch { return null; }
  if (spans !== null) {
    if (hashbang.length > 0) spans.push([hashbang.length, 0]);
    if (strictLine.length > 0) spans.push([strictLine.length, -1]);
    if (prologueText.length > 0) {
      const prologueTrimmed = prologue.trimEnd();
      spans.push([prologueTrimmed.length, order[0]]);
      if (prologueText.length > prologueTrimmed.length) spans.push([prologueText.length - prologueTrimmed.length, -1]);
    }
    if (headAfterPrologue.length > 0) spans.push([headAfterPrologue.length, -1]);
    if (front.length > 0) spans.push([front.length, -1]);
    if (preludeRest.length > 0) spans.push([preludeRest.length, hashbang.length]);
    for (const entry of bodySpans) spans.push(entry);
  }
  return result;
}

// Whether the value of an exported variable is a function, an arrow function or a class and nothing more:
// TypeScript keeps the declaration of such a variable, so that the value takes the variable's name. The
// parser is asked through small texts built around the value. Null when the answer is not certain.
function valueShape(addon, value) {
  const headAt = skipTrivia(value, 0);
  if (headAt < 0) return null;
  const head = value.slice(headAt).replace(/;?\s*$/, '');
  const reads = text => addon.moduleRecords(Buffer.from(text));
  const afterAsync = /^async(?![\w$])/.test(head) ? skipTrivia(head, 5) : -1;
  const isAsyncFn = afterAsync >= 0 && /^function(?![\w$])/.test(head.slice(afterAsync));
  if (isAsyncFn || /^(?:function|class)(?![\w$])/.test(head)) {
    // As the value of `export default`, a function or class is a declaration that ends at its brace; what
    // follows it begins another statement or is an error.
    const records = reads(`export default ${head}\n;`);
    if (records === null) return 'other';
    let statements = 0;
    for (let index = 0; index < records.length; index += 5) statements += records[index] === 72;
    return statements === 1 ? 'function' : 'other';
  }
  if (afterAsync >= 0) {
    if (head.slice(afterAsync, afterAsync + 2) === '=>') return 'function';
    const param = new RegExp(`^${word}`).exec(head.slice(afterAsync));
    if (param !== null) {
      const [one, two] = followers(head, afterAsync + param[0].length);
      if (one === '=' && two === '>') return 'function';
    }
    if (head[afterAsync] !== '(') return 'other';
  } else if (head[0] !== '(') {
    const param = new RegExp(`^${word}`).exec(head);
    if (param !== null) {
      const [one, two] = followers(head, param[0].length);
      if (one === '=' && two === '>') return 'function';
    }
    return 'other';
  }
  // An arrow function cannot be the operand of a sum; a parenthesized value or a call can.
  if (reads(`1 + ${head}\n;`) !== null) return 'other';
  // What is left is an arrow function or an assignment to a parenthesized target, which `async` cannot lead.
  return reads(afterAsync >= 0 ? `${head}\n;` : `async ${head}\n;`) !== null ? 'function' : null;
}

module.exports = { toCommonJs };
