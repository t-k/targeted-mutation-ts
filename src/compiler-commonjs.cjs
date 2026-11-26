'use strict';
// Writes a module that the native routes emitted as ECMAScript module text as the CommonJS text that
// TypeScript writes for it. The module is read once more by the certified parser, which reports where each
// statement starts, which statements are imports and exports, the names the module declares, and every name
// that is read as an expression. Whatever is not known for certain is declined (null), and the caller hands
// the file to TypeScript.

// TypeScript's helpers, in the text it writes them, and the order in which it writes them.
const helperText = require('./compiler-commonjs-helpers.json');
const { collectShadowedSpans } = require('./compiler-commonjs-scope.cjs');
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

// Precomputed ASCII character-class tables for hot-loop lexical scanning (zero string allocations).
const ID_START = new Uint8Array(256);
const ID_CONT = new Uint8Array(256);
const IS_WS = new Uint8Array(256);
for (let u = 65; u <= 90; u++) { ID_START[u] = 1; ID_CONT[u] = 1; }
for (let u = 97; u <= 122; u++) { ID_START[u] = 1; ID_CONT[u] = 1; }
for (let u = 48; u <= 57; u++) { ID_CONT[u] = 1; }
ID_START[95] = 1; ID_CONT[95] = 1; // _
ID_START[36] = 1; ID_CONT[36] = 1; // $
IS_WS[32] = 1; IS_WS[9] = 1; IS_WS[10] = 1; IS_WS[11] = 1; IS_WS[12] = 1;

// Walks `text` lexically, invoking `visit(name, at, prevToken, depth, inTopClass, inAsyncFn)` for every
// identifier in code (skipping comments, strings, template literal text and regular expressions).
// Returns false on ambiguous syntax or when `visit` returns false.
function scanCodeIdentifiers(text, visit) {
  const len = text.length;
  const braces = [], parens = [];
  let prev = '', at = 0, expectClassBody = false, asyncParenDepth = -1, asyncDepth = 0;
  const skipTemplate = pos => {
    while (pos < len) {
      const u = text.charCodeAt(pos);
      if (u === 92) { pos += 2; continue; } // '\'
      if (u === 96) { prev = 'lit'; return pos + 1; } // '`'
      if (u === 36 && text.charCodeAt(pos + 1) === 123) { braces.push('template'); prev = '${'; return pos + 2; } // '${'
      pos++;
    }
    return -1;
  };
  while (at < len) {
    let u = text.charCodeAt(at);
    if (IS_WS[u]) {
      at++;
      while (at < len && IS_WS[text.charCodeAt(at)]) at++;
      continue;
    }
    if (ID_START[u]) {
      let end = at + 1;
      while (end < len && ID_CONT[text.charCodeAt(end)]) end++;
      if (prev === '.') {
        prev = 'id';
        asyncParenDepth = -1;
        at = end;
        continue;
      }
      const name = text.slice(at, end);
      const inTopClass = braces.length === 1 && braces[0] === 'class' && parens.length === 0;
      const inAsyncFn = asyncDepth > 0 || (asyncParenDepth === parens.length && prev === '=>');
      if (visit(name, at, prev, braces.length, inTopClass, inAsyncFn) === false) return false;
      if (name === 'class' && prev !== '.') { expectClassBody = true; asyncParenDepth = -1; }
      else if (name === 'async' && prev !== '.') asyncParenDepth = parens.length;
      else if (name === 'if' || name === 'while' || name === 'for' || name === 'switch' || name === 'try' || name === 'catch' || name === 'finally' || name === 'else' || name === 'do' || name === 'static') asyncParenDepth = -1;
      prev = prev === '.' ? 'id' : (prev === 'for' && name === 'await') ? 'await-for' : name;
      at = end;
      continue;
    }
    if (u === 47) { // '/'
      const u1 = text.charCodeAt(at + 1);
      if (u1 === 47) { // '//'
        const end = text.indexOf('\n', at + 2);
        at = end < 0 ? len : end + 1;
        continue;
      }
      if (u1 === 42) { // '/*'
        const end = text.indexOf('*/', at + 2);
        if (end < 0) return false;
        at = end + 2;
        continue;
      }
      if (prev === '}' || prev === '++' || prev === '--' || prev === 'of' || prev === 'debugger' || prev === 'break' || prev === 'continue') return false;
      if (regexAfter.has(prev)) {
        at++;
        let inClass = false;
        while (at < len) {
          const rc = text.charCodeAt(at);
          if (rc === 92) { at += 2; continue; } // '\'
          if (rc === 10) return false; // '\n'
          if (inClass) { if (rc === 93) inClass = false; } // ']'
          else if (rc === 91) inClass = true; // '['
          else if (rc === 47) { at++; break; } // '/'
          at++;
        }
        while (at < len) {
          const fc = text.charCodeAt(at);
          if ((fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122)) at++;
          else break;
        }
        prev = 'lit';
        continue;
      }
      at += u1 === 61 ? 2 : 1; // '/=' vs '/'
      prev = '/';
      continue;
    }
    if (u === 34 || u === 39) { // '"' or "'"
      at++;
      while (at < len) {
        const sc = text.charCodeAt(at);
        if (sc === u) break;
        if (sc === 92) at += 2;
        else if (sc === 10) return false;
        else at++;
      }
      if (at >= len) return false;
      at++;
      prev = 'lit';
      continue;
    }
    if (u === 96) { // '`'
      at = skipTemplate(at + 1);
      if (at < 0) return false;
      continue;
    }
    if (u === 125) { // '}'
      if (braces.length > 0 && braces[braces.length - 1] === 'template') {
        braces.pop();
        at = skipTemplate(at + 1);
        if (at < 0) return false;
        continue;
      }
      if (braces.length > 0 && braces.pop() === 'async') asyncDepth--;
      prev = '}';
      at++;
      continue;
    }
    if (u === 123) { // '{'
      const isAsyncBody = asyncParenDepth === parens.length && (prev === ')' || prev === '=>');
      if (expectClassBody) braces.push('class');
      else if (isAsyncBody) { braces.push('async'); asyncDepth++; }
      else braces.push('{');
      expectClassBody = false;
      if (isAsyncBody) asyncParenDepth = -1;
      prev = '{';
      at++;
      continue;
    }
    if (u === 40) { // '('
      parens.push(prev === 'if' || prev === 'while' || prev === 'for' || prev === 'with' || prev === 'await-for');
      prev = '(';
      at++;
      continue;
    }
    if (u === 41) { // ')'
      prev = parens.pop() ? ')ctrl' : ')';
      if (parens.length < asyncParenDepth) asyncParenDepth = -1;
      at++;
      continue;
    }
    if (u >= 48 && u <= 57) { // '0'..'9'
      const u1 = text.charCodeAt(at + 1);
      const radixPrefix = u === 48 && (u1 === 120 || u1 === 88 || u1 === 98 || u1 === 66 || u1 === 111 || u1 === 79);
      at++;
      while (at < len) {
        const nc = text.charCodeAt(at);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || nc === 95 || nc === 46) {
          if (!radixPrefix && (nc === 69 || nc === 101)) {
            const sign = text.charCodeAt(at + 1);
            if (sign === 43 || sign === 45) { at += 2; continue; }
          }
          at++;
        } else break;
      }
      prev = 'lit';
      continue;
    }
    if (u === 46 && text.charCodeAt(at + 1) === 46 && text.charCodeAt(at + 2) === 46) { prev = '...'; at += 3; continue; }
    if (u === 63 && text.charCodeAt(at + 1) === 46) {
      const u2 = text.charCodeAt(at + 2);
      if (!(u2 >= 48 && u2 <= 57)) { prev = '.'; at += 2; continue; }
    }
    if (u === 61 && text.charCodeAt(at + 1) === 62) { prev = '=>'; at += 2; continue; }
    if ((u === 43 && text.charCodeAt(at + 1) === 43) || (u === 45 && text.charCodeAt(at + 1) === 45)) { prev = u === 43 ? '++' : '--'; at += 2; continue; }
    if (u === 42) { prev = prev === 'function' ? 'function*' : '*'; at++; continue; }
    if (u === 59) asyncParenDepth = -1;
    prev = text[at];
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
  if (/^[a-zA-Z]+:\/\/[^/]*\/?$/.test(specifier)) return '';
  const trimmed = specifier.replace(/\/$/, '');
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return seg.replace(/^(\d)/, '_$1').replace(/\W/g, '_');
}

const marked = name => new RegExp(`(?<![\\w$])(?<!(?<!\\.\\.)\\.)${name.replace(/\$/g, '\\$')}(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\n]*\\n)*!(?!=)`);

// Checks whether any name in `renamed` stands in `source` immediately before a non-null `!` (skipping
// whitespace and comments, and ignoring property access behind a single `.` while keeping `...f!()`).
function hasMarkedRenamed(source, renamed) {
  if (renamed.size === 0 || !source.includes('!')) return false;
  for (let bang = source.indexOf('!'); bang >= 0; bang = source.indexOf('!', bang + 1)) {
    if (source[bang + 1] === '=') continue;
    const end = skipTriviaBack(source, bang, false);
    if (end < 0 || source.slice(end, bang).includes('*/')) {
      for (const name of renamed.keys()) if (marked(name).test(source)) return true;
      return false;
    }
    let start = end;
    while (start > 0) {
      const u = source.charCodeAt(start - 1);
      if ((u >= 65 && u <= 90) || (u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u === 95 || u === 36) start--;
      else break;
    }
    if (start === end) continue;
    const id = source.slice(start, end);
    if (!renamed.has(id)) continue;
    if (start > 0 && source[start - 1] === '.' && !(start >= 3 && source[start - 2] === '.' && source[start - 3] === '.')) continue;
    return true;
  }
  return false;
}

// `source` is the text the module was compiled from, as a string of bytes.
function toCommonJs(addon, code, source, experimentalDecorators = false, spans = null) {
  const bytes = Buffer.from(code);
  if (bytes.length > 1048576) return null;
  // One byte per character, so that the parser's offsets index the text.
  const text = bytes.latin1Slice();
  if (((text.includes('__') || text.includes('default_1')) && reserved.test(text)) ||
      (source.includes('default_1') && /(?<![\w$.])default_1(?![\w$])/.test(source)) ||
      text.includes('\r') || text.includes('\xe2\x80\xa8') || text.includes('\xe2\x80\xa9')) return null;
  // The CommonJS dialect of TypeScript (`export =`, `import x = require()`) is written without the module's head.
  if (source.includes('=') && /\bexport\s*=|\bimport\s+[\w$]+\s*=/.test(source)) return null;
  let records = addon.moduleRecords?.(bytes);
  if (!records) return null;
  let hasStart = false;
  for (let i = 0; i < records.length; i += 5) if (records[i] === 72) { hasStart = true; break; }
  if (!hasStart && text.includes('export')) {
    // Single-declaration modules taking the parser's direct-module shortcut omit statement-start records;
    // appending an empty statement forces full module-record emission without altering source offsets.
    records = addon.moduleRecords?.(Buffer.from(code + '\n;'));
    if (!records) return null;
  }

  const starts = new Set(), listed = new Set(), targets = [], moduleEnds = new Map(), defaults = new Map(), direct = new Set();
  const declared = [], referenceAt = new Map(), classBodies = [];
  for (let index = 0; index < records.length; index += 5) {
    const kind = records[index], first = records[index + 1], last = records[index + 2];
    if (first >= bytes.length || last > bytes.length) continue;
    if (kind === 72) starts.add(first);
    else if (kind === 76) listed.add(first);
    else if (kind === 74) targets.push([first, last]);
    else if (kind === 24) classBodies.push([first, last]);
    else if (kind === 9) moduleEnds.set(first, last);
    else if (kind === 66) defaults.set(first, last);
    else if (kind === 67) direct.add(first);
    else if (kind === 61) declared.push({ name: text.slice(first, last), first, last, kind: records[index + 3], isFunction: records[index + 4] === 1 });
    else if (kind === 43 || kind === 62) {
      referenceAt.set(first, last * 2 + (kind === 62 ? 1 : 0));
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
    for (let number = 1; ; number++) {
      const name = base.endsWith('_') ? `${base}${number}` : `${base}_${number}`;
      if (taken.has(name)) continue;
      // A word of the source (including erased types) with this spelling would make TypeScript choose another number.
      if (text.includes(name) || source.includes(name)) {
        const clash = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
        if (clash.test(text) || clash.test(source)) return null;
      }
      taken.add(name);
      return name;
    }
  };
  // Track each helper's earliest source position; dependencies are sorted first, ties by first use in source.
  const need = (pos, ...names) => {
    for (const name of names) if (!helpers.has(name) || pos < helpers.get(name)) helpers.set(name, pos);
  };
  const exportsOfLists = [];
  let front = '', hasStage3Decorator = false, hasAwaitOutsideMethod = false, hasDynamicImport = false;

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
  function findMatchingParen(pos) {
    let depth = 0, i = pos;
    while (i < text.length) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i + 2); i = e < 0 ? text.length : e + 1; continue; }
      if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 2; continue; }
      if (c === '"' || c === "'") {
        i++;
        while (i < text.length && text[i] !== c) { if (text[i] === '\\') i += 2; else if (text[i] === '\n') return -1; else i++; }
        if (i >= text.length) return -1;
        i++;
        continue;
      }
      if (c === '`') return -1;
      if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
      if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) return c === ')' ? i : -1;
        if (depth < 0) return -1;
        i++;
        continue;
      }
      if (c === ',' && depth === 1) return -1;
      i++;
    }
    return -1;
  }

  let tempIndex = 0;
  const freshTemp = () => {
    if (/\b(?:eval|with)\b/.test(text)) return null;
    while (tempIndex < 26) {
      const cand = '_' + String.fromCharCode(97 + tempIndex++);
      if (!new RegExp(`(?<![\\w$])${cand}(?![\\w$])`).test(text) && !new RegExp(`(?<![\\w$])${cand}(?![\\w$])`).test(source)) {
        temporaries += `var ${cand};\n`;
        return cand;
      }
    }
    return null;
  };

  for (let index = lead; index < order.length; index++) {
    const first = order[index], end = endOf(index);
    if (moduleEnds.has(first)) {
      const last = moduleEnds.get(first);
      const rawStatement = text.slice(first, last).trim();
      if (/[^\s;]/.test(text.slice(last, end).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))) return null;
      const statement = rawStatement.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m[0] === '"' || m[0] === "'" ? m : ' ').trim();
      let match;
      const editWithSpec = (replacement, spec) => {
        let specOff = -1;
        const scan = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
        const slice = text.slice(first, last);
        for (let m; (m = scan.exec(slice)) !== null; ) if (m[0] === spec) specOff = m.index;
        const specAt = specOff >= 0 ? first + specOff : -1;
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
      const at = first + gap[0].length, rest = text.slice(at, Math.min(end, at + 16384));
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
        if (names.length === 0 || names[0].name !== name || names[0].first !== at + match[0].indexOf(name, keyword.length)) return null;
        if (names.length > 1) {
          const declEdits = [];
          for (let i = 0; i < names.length; i++) {
            const entry = names[i];
            if (i > 0) {
              const beforeName = skipTriviaBack(text, entry.first, true);
              if (beforeName <= 0 || text[beforeName - 1] !== ',') return null;
            }
            const [eq1, eq2, , eqAt] = followers(text, entry.last);
            if (eq1 !== '=' || eq2 === '=' || eq2 === '>') return null;
            const initEnd = i + 1 < names.length ? skipTriviaBack(text, names[i + 1].first, true) - 1 : end;
            if (initEnd <= eqAt + 1) return null;
            const initText = text.slice(eqAt + 1, initEnd);
            if (valueShape(addon, initText) !== 'other') return null;
            // Verify each initializer is a single AssignmentExpression (rejecting trailing empty destructuring `, {} = ...`).
            let trimEnd = skipTriviaBack(initText, initText.length, true);
            if (trimEnd > 0 && initText[trimEnd - 1] === ';') trimEnd--;
            const checkRecs = trimEnd > 0 ? addon.moduleRecords(Buffer.from(`export default ${initText.slice(0, trimEnd)}\n;`)) : null;
            if (checkRecs === null) return null;
            let checkStmts = 0;
            for (let j = 0; j < checkRecs.length; j += 5) checkStmts += checkRecs[j] === 72;
            if (checkStmts !== 1) return null;
            declEdits.push([i === 0 ? first : entry.first, entry.last, `exports.${entry.name}`]);
          }
          for (const edit of declEdits) edits.push(edit);
          for (const entry of names) {
            cleared.push(entry.name);
            renamed.set(entry.name, { text: `exports.${entry.name}`, statement: index, kind: 'variable', declaration: entry.first });
          }
          continue;
        }
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
            if (/[^\s;]/.test(text.slice(names[0].last, end).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))) return null;
            const afterName = skipTrivia(text, names[0].last);
            const declEnd = afterName >= 0 && afterName < end && text[afterName] === ';' ? afterName + 1 : names[0].last;
            edits.push([first, declEnd, ';']);
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
          let tailEnd = skipTriviaBack(value, value.length, true);
          if (tailEnd < 0) return null;
          let trailingErasedSemi = false;
          // Strip trailing empty statements (`;` left behind by erased `interface`/`type` declarations).
          while (tailEnd > 0 && value[tailEnd - 1] === ';') {
            const prevEnd = skipTriviaBack(value, tailEnd - 1, true);
            if (prevEnd < 0) return null;
            if (prevEnd > 0 && value[prevEnd - 1] === ';') { tailEnd = prevEnd; continue; }
            if (prevEnd > 0 && value[prevEnd] === '\n') { tailEnd = prevEnd; trailingErasedSemi = true; continue; }
            break;
          }
          const hasSemi = !trailingErasedSemi && tailEnd > 0 && value[tailEnd - 1] === ';';
          const trailingComment = !hasSemi && !trailingErasedSemi && /\/\/|\/\*/.test(value.slice(tailEnd));
          if (trailingComment && value[tailEnd] !== '\n') return null;
          const beforeEnd = hasSemi ? value.slice(0, tailEnd - 1) : (trailingComment || trailingErasedSemi) ? value.slice(0, tailEnd) : value.replace(/\n[ \t]*$/, '').replace(/\n+$/, '');
          const leading = /^([ \t]*)([\s\S]*)$/.exec(beforeEnd);
          if (skipTriviaBack(beforeEnd, beforeEnd.length, true) !== beforeEnd.length ||
              ((leading[1].length > 1 || (leading[2].startsWith('\n') && source.includes('<') && /=(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*</.test(source))) &&
               /^(?:async(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)+function|function|class)(?![\w$])/.test(leading[2].trimStart()))) return null;
          edits.push([first, at, '']);
          if (trailingComment || trailingErasedSemi) edits.push([equals + tailEnd, equals + tailEnd, `;\nexports.${name} = ${name};`]);
          else behind(index, `exports.${name} = ${name};`);
        } else edits.push([first, names[0].last, `exports.${name}`]);
        renamed.set(name, { text: `exports.${name}`, statement: index, kind: 'variable', declaration: names[0].first });
      } else if (/^(?:const|let|var)\s*[\[{]/.test(rest)) {
        // Flat destructuring export: `export const { a, b: c } = expr;` or `export const [a, , b] = expr;`.
        const patMatch = /^(const|let|var)\s*([\[{])/.exec(rest);
        const openAt = at + patMatch[0].length - 1;
        const closeChar = patMatch[2] === '{' ? '}' : ']';
        let closeAt = -1;
        for (let i = openAt + 1; i < end; i++) {
          const ch = text[i];
          if (ch === '{' || ch === '[' || ch === '=' || ch === '.' || ch === '"' || ch === "'" || ch === '`') { closeAt = -1; break; }
          if (ch === closeChar) { closeAt = i; break; }
        }
        if (closeAt < 0) return null;
        const [eq1, eq2, , eqAt] = followers(text, closeAt + 1);
        if (eq1 !== '=' || eq2 === '=' || eq2 === '>') return null;
        const innerPat = text.slice(openAt + 1, closeAt).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
        const bindings = [];
        if (patMatch[2] === '{') {
          for (const part of innerPat.split(',')) {
            const m = part.trim();
            if (m === '') continue;
            const pair = new RegExp(`^(${word})(?:\\s*:\\s*(${word}))?$`).exec(m);
            if (pair === null) return null;
            bindings.push({ prop: pair[1], local: pair[2] ?? pair[1] });
          }
        } else {
          let idx = 0;
          const parts = innerPat.split(',');
          for (let i = 0; i < parts.length; i++) {
            const m = parts[i].trim();
            if (m === '') { idx++; continue; }
            if (!new RegExp(`^${word}$`).test(m)) return null;
            bindings.push({ index: idx++, local: m });
          }
        }
        const names = declared.filter(entry => entry.first >= first && entry.first < end);
        if (bindings.length === 0 || names.length !== bindings.length) return null;
        const rhsRaw = text.slice(eqAt + 1, end);
        let rhsEnd = skipTriviaBack(rhsRaw, rhsRaw.length, true);
        if (rhsEnd <= 0) return null;
        const hasSemi = rhsRaw[rhsEnd - 1] === ';';
        if (hasSemi) rhsEnd = skipTriviaBack(rhsRaw, rhsEnd - 1, true);
        if (rhsEnd <= 0) return null;
        const rhsExpr = rhsRaw.slice(0, rhsEnd).trim();
        if (/\/\/[^\n]*$/.test(rhsExpr)) return null;
        const rhsCheck = addon.moduleRecords(Buffer.from(`export default ${rhsExpr}\n;`));
        if (rhsCheck === null) return null;
        let rhsStmts = 0;
        for (let j = 0; j < rhsCheck.length; j += 5) rhsStmts += rhsCheck[j] === 72;
        if (rhsStmts !== 1) return null;
        const isIdentRhs = new RegExp(`^${word}$`).test(rhsExpr);
        if (isIdentRhs) {
          if (bindings.some(b => b.local === rhsExpr) || renamed.has(rhsExpr) || kept.has(rhsExpr)) return null;
          const esc = rhsExpr.replace(/\$/g, '\\$');
          if (new RegExp(`(?<![\\w$.])(?:export\\s+(?:var|let|const|function|class|async\\s+function)\\s+(?:\\*\\s*)?${esc}|import\\b[^;\\n]*\\b${esc})(?![\\w$])`).test(text)) return null;
        }
        const plainId = isIdentRhs && !['this', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(rhsExpr);
        if (plainId) {
          if (spans !== null) return null;
          const assigns = bindings.map(b => b.prop !== undefined ? `exports.${b.local} = ${rhsExpr}.${b.prop}` : `exports.${b.local} = ${rhsExpr}[${b.index}]`).join(', ');
          edits.push([first, eqAt + 1 + rhsEnd, assigns]);
        } else {
          const tmp = freshTemp();
          if (tmp === null) return null;
          const assigns = bindings.map(b => b.prop !== undefined ? `exports.${b.local} = ${tmp}.${b.prop}` : `exports.${b.local} = ${tmp}[${b.index}]`).join(', ');
          edits.push([first, eqAt + 1, `${tmp} =`]);
          edits.push([eqAt + 1 + rhsEnd, eqAt + 1 + rhsEnd, `, ${assigns}`]);
        }
        for (let i = 0; i < bindings.length; i++) {
          const local = bindings[i].local;
          cleared.push(local);
          renamed.set(local, { text: `exports.${local}`, statement: index, kind: 'variable', declaration: names[i].first });
        }
      } else return null;
      continue;
    }
    // Stage 3 decorated class statements (`@Dec export class C {}`, `@Dec export default class C {}`, `@Dec class C {}`).
    if (head.startsWith('@')) {
      hasStage3Decorator = true;
      let handled = false;
      for (const expPos of direct) {
        if (expPos > first && expPos < end) {
          const expHead = text.slice(expPos, Math.min(end, expPos + 400));
          const gap = /^export\s+/.exec(expHead);
          if (gap === null) return null;
          const at = expPos + gap[0].length, rest = text.slice(at, Math.min(end, at + 400));
          const match = forms.classHead.exec(rest);
          if (match === null || match[1] === undefined) return null;
          edits.push([expPos, at, '']);
          cleared.push(match[1]);
          behind(index, `exports.${match[1]} = ${match[1]};`);
          kept.set(match[1], { statement: index, kind: 'class' });
          handled = true;
          break;
        }
      }
      if (handled) continue;
      for (const [expPos, valueAt] of defaults) {
        if (expPos > first && expPos < end) {
          const value = text.slice(valueAt, Math.min(end, valueAt + 400));
          const match = forms.classHead.exec(value);
          if (match === null) return null;
          const name = match[1] ?? 'default_1';
          if (match[1] === undefined) edits.push([valueAt + 5, valueAt + 5, ' default_1']);
          edits.push([expPos, valueAt, '']);
          behind(index, `exports.default = ${name};`);
          if (match[1] !== undefined) kept.set(name, { statement: index, kind: 'class' });
          handled = true;
          break;
        }
      }
      if (handled) continue;
      continue;
    }
    // Any other statement that begins with one of the two words is a form that is not written here.
    if (/^(?:import\b(?!\s*[.(])|export\b)/.test(head)) return null;
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
    } else if (/^const\s+$/.test(head) || /^class\s+$/.test(head) || (head.startsWith('@') && /\bclass\s+$/.test(head))) {
      behind(statement, `exports.${exported} = ${local};`);
      if (!kept.has(local)) kept.set(local, { statement, kind: (head.startsWith('class') || head.startsWith('@')) ? 'class' : 'constant' });
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

  targets.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let targetCursor = 0;
  const targeted = position => {
    while (targetCursor < targets.length && targets[targetCursor][1] <= position) targetCursor++;
    return targetCursor < targets.length && position >= targets[targetCursor][0] && position < targets[targetCursor][1];
  };
  // An identifier followed by `.`, `(`, or `[` inside an assignment LHS (`browser.rootEl = 1`, `configs[dirname(p)] = 1`)
  // or used as a computed property index (`entity[SIGNAL] = 1`, `(getter)[SIGNAL] = 1`) is evaluated as an expression
  // rather than assigned as a binding.
  const nonExprKeywords = new Set(['return', 'yield', 'await', 'case', 'throw', 'delete', 'typeof', 'void', 'in', 'of', 'instanceof', 'new', 'else', 'do']);
  const isComputedIndex = (position, prevToken, nextChar) => {
    if (prevToken !== '[' || nextChar !== ']') return false;
    const brEnd = skipTriviaBack(text, position, false);
    if (brEnd <= 0 || text[brEnd - 1] !== '[') return false;
    const beforeBr = skipTriviaBack(text, brEnd - 1, false);
    if (beforeBr <= 0) return false;
    const ch = text.charCodeAt(beforeBr - 1);
    if (ch === 41 || ch === 93) return true; // `)[key] =` or `][key] =`
    if (ID_CONT[ch]) {
      let s = beforeBr - 1;
      while (s > 0 && ID_CONT[text.charCodeAt(s - 1)]) s--;
      return !nonExprKeywords.has(text.slice(s, beforeBr));
    }
    return false;
  };
  const isBindingTarget = (position, nextChar, prevToken) =>
    nextChar !== '.' && nextChar !== '(' && nextChar !== '[' && !isComputedIndex(position, prevToken, nextChar) && targeted(position);
  // Every occurrence of a renamed name in code has to be one that the parser read as an expression, a
  // property behind a dot, a property key/label/method name, or the declaration itself. A local name that
  // stays is exported by value, so nothing may write or shadow it.
  const preEdits = edits.filter(e => e[2] !== undefined).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let editCursor = 0, dynEditEnd = -1;
  const inEdit = position => {
    if (position < dynEditEnd) return true;
    while (editCursor < preEdits.length && preEdits[editCursor][1] <= position) editCursor++;
    return editCursor < preEdits.length && position >= preEdits[editCursor][0] && position < preEdits[editCursor][1];
  };
  let hasLoopTarget, hasObjectTarget, bodyNoImports;
  const shadowedCache = new Map();
  const isShadowedLocal = name => {
    let cached = shadowedCache.get(name);
    if (cached !== undefined) return cached;
    if (bodyNoImports === undefined) {
      // Remove top-level import/export-from statements so imported names themselves are not mistaken for local bindings.
      bodyNoImports = text;
      for (const [mStart, mEnd] of moduleEnds) {
        bodyNoImports = bodyNoImports.slice(0, mStart) + ' '.repeat(mEnd - mStart) + bodyNoImports.slice(mEnd);
      }
    }
    const esc = name.replace(/\$/g, '\\$');
    const shadowed =
      new RegExp(`\\b(?:const|let|var|function|class|catch)\\b[^;\\n=(){]{0,200}?(?<![\\w$.])${esc}(?![\\w$])`).test(bodyNoImports) ||
      new RegExp(`\\b(?:const|let|var|catch)\\s*[\\[{][^;\\n=]{0,200}?(?<![\\w$.])${esc}(?![\\w$])`).test(bodyNoImports) ||
      new RegExp(`[\\(,]\\s*(?:\\.\\.\\.)?${esc}(?![\\w$])\\s*[,)=]`).test(bodyNoImports) ||
      new RegExp(`\\([^)]{0,400}?(?<![\\w$.])${esc}(?![\\w$])[^)]{0,400}?\\)\\s*(?:=>|\\{)`).test(bodyNoImports) ||
      new RegExp(`(?<![\\w$.])${esc}\\s*=>`).test(bodyNoImports);
    shadowedCache.set(name, shadowed);
    return shadowed;
  };
  const checkLoopTarget = () => (hasLoopTarget ??= loopTarget.test(text));
  const checkObjectTarget = () => (hasObjectTarget ??= objectTarget.test(text));
  const isInShadowedSpan = (spansMap, name, pos) => {
    const list = spansMap.get(name);
    if (list === undefined) return false;
    for (let k = 0; k < list.length; k++) {
      if (pos >= list[k][0] && pos < list[k][1]) return true;
    }
    return false;
  };
  const preScanEditsLen = edits.length;
  const preScanHelpers = new Map(helpers);
  const preScanStage3 = hasStage3Decorator;
  let shadowCandidates = null;
  const runScan = shadowedSpans => {
    targetCursor = 0;
    editCursor = 0;
    dynEditEnd = -1;
    return scanCodeIdentifiers(text, (name, at, prevToken, depth, inTopClass, inAsyncFn) => {
      if (name === 'await' && !inAsyncFn && prevToken !== '.') hasAwaitOutsideMethod = true;
      if (prevToken === '@' || text[at - 1] === '@') hasStage3Decorator = true;
      if (name === 'exports' && prevToken !== '.') {
        const [one] = followers(text, at + name.length);
        if (one !== ':') return false;
      }
      if (name === 'import' && prevToken !== '.' && prevToken !== '#' && text[at - 1] !== '#' && !inEdit(at)) {
        const [one, , , nextAt] = followers(text, at + 6);
        if (one === '.') return false;
        if (one === '(') {
          hasDynamicImport = true;
          const dyn = new RegExp(`^\\((${quoted})\\)`).exec(text.slice(nextAt, nextAt + 300));
          if (dyn !== null) {
            need(at, '__createBinding', '__setModuleDefault', '__importStar');
            const spec = dyn[1];
            const rep = `Promise.resolve().then(() => __importStar(require(${spec})))`;
            const specAt = text.indexOf(spec, nextAt);
            const repAt = rep.indexOf(spec);
            edits.push([at, nextAt + dyn[0].length, rep, [repAt, specAt, spec.length]]);
            if (nextAt + dyn[0].length > dynEditEnd) dynEditEnd = nextAt + dyn[0].length;
            return;
          }
          const closeParen = findMatchingParen(nextAt);
          if (closeParen < 0) return false;
          const inner = text.slice(nextAt + 1, closeParen);
          const innerStripped = inner.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m[0] === '"' || m[0] === "'" ? m : ' ').trim();
          if (innerStripped === '') return false;
          if (new RegExp(`^${quoted}$`).test(innerStripped)) {
            // A commented string literal like `import(/* webpackChunkName: "x" */ "./x")` is a plain literal
            // unless erased assertion blanks stand around it.
            const specMatch = new RegExp(`^(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\n]*\\n)*(${quoted})(?:\\n[ \\t]*)*$`).exec(inner);
            if (specMatch === null) return false;
            // Ensure no erased prefix assertion (more than 1 space before the quote on the same line, including after a comment).
            const beforeSpec = inner.slice(0, inner.indexOf(specMatch[1]));
            const afterLastLine = beforeSpec.slice(beforeSpec.lastIndexOf('\n') + 1);
            const afterLastComment = afterLastLine.includes('*/') ? afterLastLine.slice(afterLastLine.lastIndexOf('*/') + 2) : afterLastLine;
            if (afterLastLine.includes('*/') ? afterLastComment.length > 1 : (!beforeSpec.includes('\n') && afterLastLine.length > 1)) return false;
            need(at, '__createBinding', '__setModuleDefault', '__importStar');
            edits.push([at, nextAt + 1, 'Promise.resolve().then(() => __importStar(require(']);
            edits.push([closeParen, closeParen + 1, ')))']);
            return;
          }
          need(at, '__createBinding', '__setModuleDefault', '__importStar');
          edits.push([at, nextAt + 1, 'Promise.resolve(`${']);
          edits.push([closeParen, closeParen + 1, '}`).then(s => __importStar(require(s)))']);
          return;
        }
      }
      const target = renamed.get(name), local = target === undefined ? kept.get(name) : undefined;
      if (target === undefined && local === undefined) return;
      if (prevToken === '.') return;
      const before = text[at - 1], reference = referenceAt.get(at);
      if (target !== undefined) {
        if (target.declaration === at || inEdit(at)) return;
        if (shadowedSpans !== null && isInShadowedSpan(shadowedSpans, name, at)) return;
        const isDecoratorHead = prevToken === '@' || before === '@';
        if (isDecoratorHead) {
          if (!(depth === 0 || inTopClass || !isShadowedLocal(name))) return false;
        } else if (reference === undefined || Math.floor(reference / 2) !== at + name.length) {
          // Non-reference identifier in code: safe when it is a property key/label (`name:`), a method or
          // accessor definition (`name(` not after `function`/`function*`), a label jump, or a static member.
          if (reference === undefined) {
            const [one] = followers(text, at + name.length);
            if (one === ':' || prevToken === 'break' || prevToken === 'continue' || prevToken === 'static' ||
                (inTopClass && (one === '=' || one === ';')) ||
                (one === '(' && prevToken !== 'function' && prevToken !== 'function*')) return;
            if (shadowedSpans === null) {
              if (shadowCandidates === null) shadowCandidates = new Set();
              shadowCandidates.add(name);
              return;
            }
          }
          return false;
        }
        const [one, two, three, nextAt] = followers(text, at + name.length);
        if (/[\x80-\xff\\]/.test(one)) return false;
        if (target.kind !== 'variable' && (writes(text, at, one, two, three, prevToken) || isBindingTarget(at, one, prevToken))) return false;
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
              if (prevToken !== '' && !'([{,;:?=!&|^~<>+-*%/@'.includes(prevToken[0]) && prevToken !== '=>') return false;
            } else if (text.slice(prev, at).includes('\n') && prev > 0 && /[\w$)\]}'"`\x80-\xff]/.test(text[prev - 1]) &&
                !['else', 'await', 'typeof', 'void', 'delete', 'in', 'instanceof', 'case', ')ctrl'].includes(prevToken)) return false;
          }
        }
        edits.push([at, at + name.length, reference !== undefined && (reference & 1) === 1 ? `${name}: ${target.text}` : value]);
      } else if (shadowedSpans !== null && (local.kind === 'function' || local.kind === 'class') &&
          direct.has(order[local.statement]) && isInShadowedSpan(shadowedSpans, name, at)) {
        return;
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
          if (shadowedSpans === null && (local.kind === 'function' || local.kind === 'class') && direct.has(order[local.statement])) {
            if (shadowCandidates === null) shadowCandidates = new Set();
            shadowCandidates.add(name);
            return;
          }
          if (one === '}' || one === ',' || one === '=' || one === ']' || one === ')' || one === ';' || one === '{' || one === '(') return false;
          if (precededByDecl(prevToken)) return false;
          if (nextAt !== undefined && /^(?:of|in)(?![\w$])/.test(text.slice(nextAt))) return false;
        }
      } else if (reference !== undefined && local.kind === 'mutable') {
        const [one, two, three, nextAt] = followers(text, at + name.length);
        if (checkLoopTarget() || (nextAt !== undefined && /^(?:of|in)(?![\w$])/.test(text.slice(nextAt)))) return false;
        if (targets.some(([first, last]) => first === at && last === at + name.length) && one === '=' && two !== '=' && two !== '>') {
          edits.push([at, at, local.exported.slice().reverse().map(exported => `exports.${exported} = `).join('')]);
        } else if (writes(text, at, one, two, three, prevToken) || isBindingTarget(at, one, prevToken)) return false;
      } else if (reference !== undefined && local.kind === 'filled') {
        // The variable of a lowered enum or namespace is written only by the function that fills it.
        const [one, two, three] = followers(text, at + name.length);
        if (statementOf(at) !== local.statement + 1 && (writes(text, at, one, two, three, prevToken) || isBindingTarget(at, one, prevToken))) return false;
      } else if (reference !== undefined && (local.kind === 'function' || local.kind === 'class')) {
        // A function or a class is exported by value: an assignment to it would have to write the export too.
        const [one, two, three, nextAt] = followers(text, at + name.length);
        if (writes(text, at, one, two, three, prevToken) || isBindingTarget(at, one, prevToken)) return false;
        // The head of a loop and a parenthesized object are the targets that the parser does not report.
        if ((nextAt !== undefined && /^(?:of|in)(?![\w$])/.test(text.slice(nextAt))) || checkLoopTarget()) return false;
        if (checkObjectTarget() && (one === ',' || one === '}')) return false;
      }
    });
  };
  let scanned = runScan(null);
  if (scanned && shadowCandidates !== null) {
    const shadowedSpans = collectShadowedSpans(text, shadowCandidates);
    if (shadowedSpans === null || shadowedSpans.size === 0) return null;
    edits.length = preScanEditsLen;
    helpers.clear();
    for (const [k, v] of preScanHelpers) helpers.set(k, v);
    hasStage3Decorator = preScanStage3;
    hasAwaitOutsideMethod = false;
    hasDynamicImport = false;
    scanned = runScan(shadowedSpans);
  }
  if (!scanned) return null;

  // A non-null mark on a name keeps TypeScript from writing a call of it as `(0, f)()`, and the mark is gone
  // from the text that is read here.
  if (hasMarkedRenamed(source, renamed)) return null;
  if (new Set(cleared).size !== cleared.length) return null;
  edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const bodySpans = spans === null ? null : [];
  let body = '', position = order[0], next = 0;
  for (let index = 0; index < order.length; index++) {
    const end = endOf(index);
    while (next < edits.length && (edits[next][0] < end || (index + 1 === order.length && edits[next][0] === end))) {
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
  const verifyText = hasStage3Decorator ? result.replace(/@\(0, ([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\)/g, '@$1') : result;
  if (addon.moduleRecords(Buffer.from(verifyText)) === null) return null;
  if (hasStage3Decorator) {
    if (hasAwaitOutsideMethod || hasDynamicImport) return null;
    if (/\bawait\b/.test(result) && /\bstatic\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n|\s)*\{/.test(result)) return null;
    for (const w of ['exports', 'require', 'module', '__filename', '__dirname']) {
      if (declarations.has(w)) return null;
    }
  } else {
    try {
      new Function('exports', 'require', 'module', '__filename', '__dirname', result.startsWith('#!') ? '//' + result : result);
    } catch { return null; }
  }
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
