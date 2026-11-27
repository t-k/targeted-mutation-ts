'use strict';

let validUtf8;
let types;
function optionalAddon(specifier, allowIncompatible = false) {
  const addon = { exports: {} };
  try {
    process.dlopen(addon, __dirname + '/' + specifier);
    return addon.exports;
  } catch (error) {
    if (error.code !== 'ERR_DLOPEN_FAILED') throw error;
  }
  try {
    return require(specifier);
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' || (allowIncompatible && error.code === 'ERR_DLOPEN_FAILED')) return null;
    throw error;
  }
}

let directAddon;
function loadDirectAddon() {
  if (directAddon === undefined) directAddon = optionalAddon('../build/compiler.node');
  return directAddon;
}

let fullAddon;
function loadModuleAddon() {
  if (fullAddon === undefined) fullAddon = optionalAddon('../build/compiler-module.node');
  return fullAddon;
}
let javascriptAddon;
function javascriptValidators() {
  if (javascriptAddon === undefined) javascriptAddon = optionalAddon('../build/compiler-js.node', true) ?? {};
  return javascriptAddon;
}
function javascriptTextValidator() {
  return javascriptValidators().validModule ?? null;
}
const extensions = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const declarations = /\.d\.[cm]?ts$/i;
const targets = new Set(['es6', 'esnext', ...Array.from({ length: 11 }, (_, index) => 'es' + (2015 + index))]);
const modules = new Set(['preserve', 'esm', 'cjs']);
const jsxModes = new Set(['automatic', 'classic', 'preserve']);

function fail(backend, diagnostics) {
  return { backend, code: null, sourceMap: null, diagnostics };
}

function inputError(file, code, message) {
  return fail('input', [{ file, code, severity: 'error', message, start: 0, end: 0 }]);
}

function outputFormat(file, module) {
  if (module !== 'preserve') return module;
  if (/\.c[jt]s$/i.test(file)) return 'cjs';
  if (/\.m[jt]s$/i.test(file)) return 'esm';
  return 'preserve';
}

function hasSplitDeclare(source, code) {
  return source.includes('declare') && require('./compiler-compat.cjs').hasSplitDeclare(source, code);
}

function transformCompatibility(source, options) {
  return require('./compiler-compat.cjs').transform(source, options, verifyRuntimeExports, fail);
}

// Node's erasure blanks a type in place, so the erased text shows what now stands behind each blanked assertion.
const lineBreak = /[\r\n\u2028\u2029]/;
function afterTrivia(code, at) {
  let newline = false;
  for (;;) {
    const unit = code.charCodeAt(at);
    if (unit === 10 || unit === 13 || unit === 0x2028 || unit === 0x2029) { newline = true; at++; }
    else if (unit === 32 || unit === 9 || unit === 11 || unit === 12 || unit === 0xa0 || unit === 0xfeff) at++;
    else if (unit === 47 && code.charCodeAt(at + 1) === 47) {
      while (at < code.length && !lineBreak.test(code[at])) at++;
    } else if (unit === 47 && code.charCodeAt(at + 1) === 42) {
      const end = code.indexOf('*/', at + 2);
      if (end < 0) return { at: code.length, newline };
      if (lineBreak.test(code.slice(at, end))) newline = true;
      at = end + 2;
    } else return { at, newline };
  }
}

// `a + b as T * c` is `((a + b) as T) * c`. Blanking the assertion leaves `a + b * c`, which groups differently.
// An erased assertion with an arithmetic or shift operator behind it is therefore not accepted; the reference
// compiler writes the parentheses.
function regroupingAssertion(source, code) {
  const assertion = /\b(?:as|satisfies)\b/g;
  for (let match; (match = assertion.exec(source)) !== null;) {
    // Inside a string or a comment the word is still there.
    if (code.charCodeAt(match.index) !== 32) continue;
    const next = afterTrivia(code, match.index);
    const unit = code.charCodeAt(next.at);
    const following = code.charCodeAt(next.at + 1);
    if (unit === 42 || unit === 37 || unit === 47) return true;
    // A sum binds tighter than a shift only: `a << b as T + c` regroups, `a * b as T + c` and `x as T - y` do not.
    // A doubled sign after a line break starts the next statement.
    if ((unit === 43 || unit === 45) && !(following === unit && next.newline)) {
      const start = Math.max(...[';', '=', '(', ',', '{'].map(mark => source.lastIndexOf(mark, match.index))) + 1;
      const operand = source.slice(start, match.index);
      if (operand.includes('<<') || operand.includes('>>')) return true;
    }
    if ((unit === 60 || unit === 62) && following === unit) return true;
    // An assertion without parentheses is no assignment target: TypeScript ends the statement in front of the
    // operator and reports it, while the erased text would assign.
    if (/^(?:=(?![=>])|(?:[-+^]|&&|\|\||\?\?)=(?!=))/.test(code.slice(next.at, next.at + 4))) return true;
  }
  return false;
}

// `a?.b!\`x\`` is `(a?.b)\`x\``; without the mark the template would tag an optional chain, which is an error.
function markedOptionalTag(source, code) {
  for (let at = source.indexOf('!'); at >= 0; at = source.indexOf('!', at + 1)) {
    if (code.charCodeAt(at) !== 32 || code.charCodeAt(afterTrivia(code, at).at) !== 96) continue;
    const start = Math.max(source.lastIndexOf('\n', at), source.lastIndexOf(';', at), source.lastIndexOf('=', at)) + 1;
    if (source.slice(start, at).includes('?.')) return true;
  }
  return false;
}

// Behind a decorator Node's erasure blanks the export keyword of `export abstract class` and keeps `abstract`,
// which leaves a class that is neither exported nor valid JavaScript. In a comment or a string nothing is
// blanked, so a blanked export in front of a kept abstract is that case.
function misplacedAbstractErasure(source, code) {
  const declaration = /\bexport(?:\s+default)?\s+abstract\s+class\b/g;
  for (let match; (match = declaration.exec(source)) !== null;) {
    const modifier = source.indexOf('abstract', match.index);
    if (code.charCodeAt(match.index) === 32 && code.startsWith('abstract', modifier)) return true;
  }
  return false;
}

// The certified parser reads ASCII names only. A module with other names is read through a copy in which every
// word that holds a byte outside ASCII is spelled with capital letters of the same length. The spelling is
// refused unless it renames injectively: two words never share a spelling, and no spelling is a word of the
// source already. The copy then has the syntax and the bindings of the source, whatever the letters are.
// A copy that the parser only erases from (same length, each byte kept or blanked) gives the result with the
// names put back; that needs every renamed word to be a well-formed identifier. Otherwise Node erases the
// source itself, and its parser checks the names.
const unusualSpace = /[\u0085\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/;
const identifierWord = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;
// Letters of Unicode 16 and 17. The engine's tables hold them and those of the TypeScript this compiler is
// measured against do not, so TypeScript reports a name that uses one. Such a source is left to TypeScript.
// The pattern is built at its first use: few sources reach it.
let newerLetterPattern = null;
const newerLetter = text => (newerLetterPattern ??= new RegExp('[\u{88f}\u{897}\u{c5c}\u{cdc}\u{1acf}-\u{1add}\u{1ae0}-\u{1aeb}\u{1c89}-\u{1c8a}\u{a7cb}-\u{a7cf}\u{a7d2}\u{a7d4}\u{a7da}-\u{a7dc}\u{a7f1}\u{105c0}-\u{105f3}\u{10940}-\u{10959}\u{10d40}-\u{10d65}\u{10d69}-\u{10d6d}\u{10d6f}-\u{10d85}\u{10ec2}-\u{10ec7}\u{10efa}-\u{10efc}\u{11380}-\u{11389}\u{1138b}\u{1138e}\u{11390}-\u{113b5}\u{113b7}-\u{113c0}\u{113c2}\u{113c5}\u{113c7}-\u{113ca}\u{113cc}-\u{113d3}\u{113e1}-\u{113e2}\u{116d0}-\u{116e3}\u{11b60}-\u{11b67}\u{11bc0}-\u{11be0}\u{11bf0}-\u{11bf9}\u{11db0}-\u{11ddb}\u{11de0}-\u{11de9}\u{11f5a}\u{13460}-\u{143fa}\u{16100}-\u{16139}\u{16d40}-\u{16d6c}\u{16d70}-\u{16d79}\u{16ea0}-\u{16eb8}\u{16ebb}-\u{16ed3}\u{16ff2}-\u{16ff6}\u{187f8}-\u{187ff}\u{18cff}\u{18d09}-\u{18d1e}\u{18d80}-\u{18df2}\u{1ccf0}-\u{1ccf9}\u{1e5d0}-\u{1e5fa}\u{1e6c0}-\u{1e6de}\u{1e6e0}-\u{1e6f5}\u{1e6fe}-\u{1e6ff}\u{2b73a}-\u{2b73f}\u{2cea2}-\u{2cead}\u{323b0}-\u{33479}]', 'u')).test(text);
// The copy of a source in which every word with a byte outside ASCII is spelled in capital letters, with the
// spellings by word. Null when the source has no such byte or the renaming is not sound.
function asciiSpelling(source, text) {
  let high = false;
  for (let at = 0; at < source.length; at++) if (source[at] >= 128) { high = true; break; }
  // An escape may spell the same name a second way, and a space outside ASCII is no part of a word.
  if (!high || text.includes('\\u') || unusualSpace.test(text) || newerLetter(text)) return null;
  const renamed = Buffer.from(source);
  const spellings = new Map();
  const taken = new Set();
  const plain = new Set();
  let wellFormed = true;
  const wordByte = unit => unit >= 128 || (unit >= 48 && unit <= 57) || (unit >= 65 && unit <= 90) || unit === 95 ||
    (unit >= 97 && unit <= 122) || unit === 36;
  for (let at = 0; at < source.length;) {
    if (!wordByte(source[at])) { at++; continue; }
    let end = at, mixed = false;
    while (end < source.length && wordByte(source[end])) { if (source[end] >= 128) mixed = true; end++; }
    const word = source.latin1Slice(at, end);
    // A word behind a backslash is part of an escape, and one that begins with a digit is part of a number:
    // spelled in letters either could become well formed where the source is not ("\xA" before a letter
    // outside ASCII is no escape, before a capital A to F it is).
    if (mixed && ((source[at] >= 48 && source[at] <= 57) || (at > 0 && source[at - 1] === 92))) return null;
    if (!mixed) plain.add(word);
    else {
      let spelling = spellings.get(word);
      if (spelling === undefined) {
        // A word that is no identifier (a dash, a bullet, a quotation mark from a string or a comment) is
        // spelled with a digit in front and letters from G to Z behind it: in a string, a comment, a template
        // or a regular expression that is text like any other, and where code stands it is no number and no
        // name, so the copy is refused exactly where the source is.
        const identifier = identifierWord.test(source.utf8Slice(at, end));
        spelling = identifier ? '' : '9';
        for (let index = at + spelling.length; index < end; index++) {
          spelling += source[index] < 128 ? String.fromCharCode(source[index]) :
            identifier ? String.fromCharCode(65 + source[index] % 26) : String.fromCharCode(71 + source[index] % 20);
        }
        if (taken.has(spelling)) return null;
        taken.add(spelling);
        spellings.set(word, spelling);
      }
      renamed.latin1Write(spelling, at);
    }
    at = end;
  }
  for (const spelling of taken) if (plain.has(spelling)) return null;
  if (highByteInPattern(source)) return null;
  return { renamed, spellings, wellFormed, plain };
}

// Whether a byte outside ASCII may stand in the body of a regular expression literal. What such a body
// means, and whether it is well formed, depends on its characters (a range in a class, a character beyond
// the Basic Multilingual Plane), so a copy with other letters there proves nothing about the source.
// A literal begins with a slash that is followed by neither a slash nor an asterisk and does not follow a
// slash, and runs on its line to the next slash outside a class and not behind a backslash. Every such
// slash is taken for a beginning, wherever it stands; a string or a comment with two slashes around such
// text is declined with it.
function highByteInPattern(source) {
  for (let at = source.indexOf(47); at >= 0; at = source.indexOf(47, at + 1)) {
    const next = source[at + 1];
    if (next === 47 || next === 42 || (at > 0 && source[at - 1] === 47)) continue;
    // A body of plain characters means the same whatever they are. A class, an escape and a group name do not.
    let high = false, inClass = false, structured = false;
    for (let index = at + 1; index < source.length; index++) {
      const unit = source[index];
      if (unit === 10 || unit === 13) break;
      if (unit >= 128) high = true;
      else if (unit === 92) { structured = true; index++; }
      else if (inClass) { if (unit === 93) inClass = false; }
      else if (unit === 91) { structured = true; inClass = true; }
      else if (unit === 60) structured = true;
      else if (unit === 47) { if (high && structured) return true; break; }
    }
  }
  return false;
}

// Puts the names back in a text that was produced from the copy. The text holds no byte outside ASCII.
// With `derived`, the second name that the decorator lowering gives a class that names itself is put back as
// well; the caller has made sure that the source holds no word of that spelling.
function restoreNames(code, spellings, derived = false) {
  const originals = new Map();
  for (const [word, spelling] of spellings) {
    const original = Buffer.from(word, 'latin1').toString();
    originals.set(spelling, original);
    if (derived) originals.set(spelling + '_1', original + '_1');
  }
  return code.replace(/[A-Za-z0-9_$]+/g, word => originals.get(word) ?? word);
}

const escapedKeywords = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield', 'from', 'of', 'as', 'using', 'abstract', 'declare', 'override', 'readonly', 'satisfies',
]);

const contextualModifierEscapes = new Set(['static', 'async', 'get', 'set', 'let', 'private', 'accessor']);

const regexKeywords = new Set(['return', 'throw', 'case', 'default', 'yield', 'await', 'typeof', 'void', 'delete', 'in', 'instanceof', 'new', 'else', 'do']);

// Checks in code (skipping strings, comments, template text, and regular expressions) for:
// - `\u` escapes spelling a JS/TS keyword or Unicode 16/17 letter (`TS1260` / Unicode version divergence)
// - unescaped Unicode 16/17 identifier letters (`newerLetter`)
// - `>` followed by `(`, `` ` ``, or `/` (TypeScript generic-call vs JS relational-expression ambiguity)
function hasEscapedKeyword(text, checkGenericCall = true) {
  if (!text.includes('\\u') && !/[^\x00-\x7f]/.test(text) && (!checkGenericCall || !text.includes('>'))) return false;
  const braces = [];
  let prev = '';
  let badEsc = false;
  const isValidUnicodeEsc = pos => {
    if (text[pos + 2] === '{') {
      let e = pos + 3;
      while (e < text.length && /[0-9a-fA-F]/.test(text[e])) e++;
      if (e === pos + 3 || text[e] !== '}') return false;
      const cp = parseInt(text.slice(pos + 3, e), 16);
      return Number.isFinite(cp) && cp <= 0x10ffff;
    }
    return /^[0-9a-fA-F]{4}/.test(text.slice(pos + 2, pos + 6));
  };
  const skipTpl = pos => {
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === '\\') {
        if (text[pos + 1] === 'u' && !isValidUnicodeEsc(pos)) { badEsc = true; return text.length; }
        pos += 2;
        continue;
      }
      if (ch === '`') { prev = 'lit'; return pos; }
      if (ch === '$' && text[pos + 1] === '{') { braces.push('tpl'); prev = '{'; return pos + 1; }
      pos++;
    }
    return text.length;
  };
  for (let at = 0; at < text.length; at++) {
    const c = text[at];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (c === '/' && text[at + 1] === '/') {
      at += 2;
      while (at < text.length) {
        const u = text.charCodeAt(at);
        if (u === 10 || u === 13 || u === 0x2028 || u === 0x2029) break;
        at++;
      }
      continue;
    }
    if (c === '/' && text[at + 1] === '*') { const e = text.indexOf('*/', at + 2); if (e < 0) return true; at = e + 1; continue; }
    if (c === '"' || c === "'") {
      at++;
      while (at < text.length && text[at] !== c) {
        if (text[at] === '\\') {
          if (text[at + 1] === 'u' && !isValidUnicodeEsc(at)) return true;
          at += 2;
        } else at++;
      }
      prev = 'lit';
      continue;
    }
    if (c === '`') { at = skipTpl(at + 1); if (badEsc) return true; continue; }
    if (c === '{') { braces.push('{'); prev = '{'; continue; }
    if (c === '}') {
      if (braces.length > 0 && braces[braces.length - 1] === 'tpl') { braces.pop(); at = skipTpl(at + 1); if (badEsc) return true; continue; }
      if (braces.length > 0) braces.pop();
      prev = '}';
      continue;
    }
    if (c === '=' && text[at + 1] === '>') { prev = '=>'; at++; continue; }
    if (checkGenericCall && c === '>') {
      let next = at + 1;
      while (next < text.length) {
        const ch = text[next];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { next++; continue; }
        if (ch === '/' && text[next + 1] === '/') { next += 2; while (next < text.length && text[next] !== '\n' && text[next] !== '\r') next++; continue; }
        if (ch === '/' && text[next + 1] === '*') { const e = text.indexOf('*/', next + 2); if (e < 0) return true; next = e + 2; continue; }
        break;
      }
      const follower = text[next];
      if (follower === '(' || follower === '`' || follower === '/') return true;
      prev = '>';
      continue;
    }
    if (c === '/' && (prev === '' || '([{,;:?=!&|^~<>+-*%'.includes(prev) || prev === '=>' || prev === '...' || regexKeywords.has(prev))) {
      at++;
      let inClass = false, closed = false;
      while (at < text.length) {
        const rc = text[at];
        if (rc === '\\') { at += 2; continue; }
        if (rc === '\n' || rc === '\r') return true;
        if (inClass) { if (rc === ']') inClass = false; }
        else if (rc === '[') inClass = true;
        else if (rc === '/') { closed = true; break; }
        at++;
      }
      if (!closed) return true;
      prev = 'lit';
      continue;
    }
    if (c === '.' && text[at + 1] === '.' && text[at + 2] === '.') { prev = '...'; at += 2; continue; }
    const u0 = c.charCodeAt(0);
    if ((u0 >= 65 && u0 <= 90) || (u0 >= 97 && u0 <= 122) || u0 === 95 || u0 === 36 || u0 >= 128 || (c === '\\' && text[at + 1] === 'u')) {
      const start = at;
      let hasEsc = false, hasHigh = u0 >= 128;
      while (at < text.length) {
        const ch = text[at], u = ch.charCodeAt(0);
        if ((u >= 65 && u <= 90) || (u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u === 95 || u === 36 || u >= 128) {
          if (u >= 128) hasHigh = true;
          at++;
          continue;
        }
        if (ch === '\\' && text[at + 1] === 'u') {
          hasEsc = true;
          if (text[at + 2] === '{') { const end = text.indexOf('}', at + 3); if (end < 0) return true; at = end + 1; }
          else at += 6;
          continue;
        }
        break;
      }
      const raw = text.slice(start, at);
      if (hasEsc) {
        let invalid = false;
        const decoded = raw.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g, (_, a, b) => {
          const cp = parseInt(a ?? b, 16);
          if (!Number.isFinite(cp) || cp > 0x10ffff) { invalid = true; return ''; }
          return String.fromCodePoint(cp);
        });
        if (invalid || newerLetter(decoded) || /^[\u200c\u200d]/.test(decoded)) return true;
        if (escapedKeywords.has(decoded)) {
          let next = at;
          while (next < text.length && (text[next] === ' ' || text[next] === '\t' || text[next] === '\n' || text[next] === '\r')) next++;
          const follower = text[next];
          const isProp = prev === '.' ||
            (follower === ':' && (prev === ',' || (prev === '{' && decoded !== 'await' && decoded !== 'yield'))) ||
            (follower === '(' && (prev === '{' || prev === ',' || prev === ';' || prev === '}' || prev === 'static' || prev === 'get' || prev === 'set' || prev === 'async' || prev === '*'));
          const isEscapedBinding = (decoded === 'await' || decoded === 'yield') &&
            (prev === 'var' || prev === 'let' || prev === 'const' || prev === 'class' || prev === 'function') &&
            (follower === ';' || follower === ',' || follower === '=' || follower === '{' || follower === ')' || follower === '}' || !follower);
          const isEscapedYieldLabel = decoded === 'yield' && follower === ':' &&
            (prev === '' || prev === ';' || prev === '{' || prev === '}') &&
            !/\*/.test(text.replace(/\/\*[\s\S]*?\*\//g, ''));
          if (!isProp && !isEscapedBinding && !isEscapedYieldLabel) return true;
        } else if (contextualModifierEscapes.has(decoded)) {
          let next = at;
          let sawNewline = false;
          while (next < text.length) {
            const nc = text[next];
            if (nc === ' ' || nc === '\t') { next++; continue; }
            if (nc === '\n' || nc === '\r') { sawNewline = true; next++; continue; }
            if (nc === '/' && text[next + 1] === '/') {
              const nl = text.indexOf('\n', next + 2);
              sawNewline = true;
              next = nl < 0 ? text.length : nl + 1;
              continue;
            }
            if (nc === '/' && text[next + 1] === '*') {
              const end = text.indexOf('*/', next + 2);
              if (end < 0) return true;
              if (text.slice(next + 2, end).includes('\n') || text.slice(next + 2, end).includes('\r')) sawNewline = true;
              next = end + 2;
              continue;
            }
            break;
          }
          const follower = text[next] || '';
          const fc = follower.charCodeAt(0);
          const followerIsMemberOrDecl = (fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122) || (fc >= 48 && fc <= 57) || fc === 95 || fc === 36 || fc >= 128 ||
            follower === '[' || follower === '*' || follower === '#' || follower === '"' || follower === "'" || follower === '\\' ||
            (decoded === 'async' && follower === '(') || (decoded === 'let' && follower === '{' && prev !== 'class');
          const isForAsyncOf = decoded === 'async' && prev === '(' && /^of\b/.test(text.slice(next, next + 4));
          const isAsiModifierField = sawNewline && (decoded === 'accessor' || decoded === 'async' || ((decoded === 'get' || decoded === 'set') && follower === '*'));
          if (followerIsMemberOrDecl && prev !== '.' && !isForAsyncOf && !isAsiModifierField) return true;
        }
        prev = 'id';
      } else {
        if (hasHigh && newerLetter(raw)) return true;
        prev = prev === '.' ? 'id' : raw;
      }
      at--;
      continue;
    }
    prev = c;
  }
  return false;
}

// A .ts/.mts file that contains no TypeScript syntax and passes V8's parser (or Node's strict-identity
// strip check with TS 6.0.3 compatibility guards) can be published natively when it avoids the few
// ES2025/Unicode/legacy forms that V8/SWC accept and TypeScript 6.0.3 rejects.
const tsRejectsInStripIdentity = /\b0\d*_|0[bBoOxX]_|\._|\bfor\s*\([^;()]*;[^;()]*\)|\bfor\s*\(\s*let\s*[;=]|\{\s*(?:while|for|if|return|class|function|var|const|default|extends|this|false|true|null)\s*[,}]|\bstatic(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\r\n]*)*\bstatic\b|(?:^|[;\r\n{])[ \t]*await[ \t]*[:=;]|@\(\s*await\s*\)|\bvoid[ \t]+await[ \t]*[;,}]|\bawait[ \t]*=>|\bnew[ \t]+await\b|\basync\b[^;\n]*=[ \t]*(?:\([ \t]*await[ \t]*\)[ \t]*=>|await[ \t]*[),])|\basync[ \t]*[\r\n]+[ \t]*[A-Za-z_$][\w$]*\s*\(|\bvar\s+this\b|#\s|<!--|-->|\bexport\s*\{[^}]*\}[ \t]*(?![\r\n;]|$|\/\/|\/\*|from\b)|\bimplements\s*\{/;

function hasTsAwaitYieldHazard(noComments) {
  const hasYieldShorthand = /\{\s*yield\s*[,}]/.test(noComments);
  const hasAwaitShorthand = /\{\s*await\s*[,}]/.test(noComments);
  const hasVarAwait = /(?:^|[\r\n;])[ \t]*var[ \t]+await\b/.test(noComments);
  if (!hasYieldShorthand && !hasAwaitShorthand && !hasVarAwait) return false;
  const toks = require('./compiler-ts-lower.cjs').tokenize(noComments);
  if (!toks) return true;
  if (hasYieldShorthand && toks.some(t => t.text === '*')) return true;
  if (!hasAwaitShorthand && !hasVarAwait) return false;
  // Walk tokens tracking enclosing non-async function/method/constructor/arrow scopes.
  // Top-level (and directly inside `static { ... }` blocks, even nested in `if`/`{}`) has `fnStack.length === 0`.
  const scopeStack = []; // 'block' | 'fn' | 'async-fn'
  let inStaticBlock = false;
  let staticDepth = 0;
  let pendingFn = null; // 'fn' | 'async-fn' | null
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = i > 0 ? toks[i - 1] : null;
    const next = toks[i + 1];
    if (t.type === 'id' && t.text === 'static' && next?.text === '{') {
      inStaticBlock = true;
      staticDepth = scopeStack.length + 1;
    } else if (t.type === 'id' && t.text === 'function' && prev?.text !== '.') {
      pendingFn = (prev?.text === 'async') ? 'async-fn' : 'fn';
    } else if (t.text === '=>') {
      // Arrow function: treat concise arrow `=> expr` as a non-async fn scope for its immediate expression
      let isAsync = false;
      for (let b = i - 1; b >= Math.max(0, i - 12); b--) {
        if (toks[b].text === ';' || toks[b].text === '{' || toks[b].text === '}') break;
        if (toks[b].type === 'id' && toks[b].text === 'async') { isAsync = true; break; }
      }
      if (next?.text === '{') {
        pendingFn = isAsync ? 'async-fn' : 'fn';
      } else if (!isAsync) {
        // Concise arrow `() => ({ await })`: skip to matching `)` or `;`
        let dP = 0, dB = 0, dBr = 0, k = i + 1;
        while (k < toks.length) {
          const kt = toks[k].text;
          if (kt === '(') dP++; else if (kt === ')') { if (dP === 0) break; dP--; }
          else if (kt === '[') dB++; else if (kt === ']') { if (dB === 0) break; dB--; }
          else if (kt === '{') dBr++; else if (kt === '}') { if (dBr === 0) break; dBr--; }
          else if (dP === 0 && dB === 0 && dBr === 0 && (kt === ';' || kt === ',')) break;
          k++;
        }
        i = k - 1;
        continue;
      }
    } else if (t.text === '(' && prev && (prev.type === 'id' || prev.text === ']') &&
        !['if', 'for', 'while', 'switch', 'with', 'catch', 'function'].includes(prev.text)) {
      // Method/constructor/accessor definition: `foo(...) {`
      let dP = 1, k = i + 1;
      while (k < toks.length && dP > 0) {
        if (toks[k].text === '(') dP++;
        else if (toks[k].text === ')') dP--;
        k++;
      }
      if (dP === 0 && toks[k]?.text === '{') {
        const isAsyncMethod = toks[i - 2]?.text === 'async' || (toks[i - 2]?.text === '*' && toks[i - 3]?.text === 'async');
        // Parameters of a non-async method/constructor can reference `await`!
        if (!isAsyncMethod) { i = k - 1; pendingFn = 'fn'; continue; }
        pendingFn = 'async-fn';
      }
    } else if (t.text === '{') {
      scopeStack.push(pendingFn || 'block');
      pendingFn = null;
      continue;
    } else if (t.text === '}') {
      if (scopeStack.length === staticDepth) inStaticBlock = false;
      scopeStack.pop();
      continue;
    }

    if (t.type === 'id' && t.text === 'await' && prev?.text !== '.') {
      // Determine innermost enclosing function scope (if any)
      let inNonAsyncFn = false;
      for (let s = scopeStack.length - 1; s >= 0; s--) {
        if (scopeStack[s] === 'fn') { inNonAsyncFn = true; break; }
        if (scopeStack[s] === 'async-fn') { inNonAsyncFn = false; break; }
      }
      if (hasAwaitShorthand && prev?.text === '{' && (next?.text === '}' || next?.text === ',')) {
        const beforeBrace = i >= 2 ? toks[i - 2] : null;
        const isVarDestr = beforeBrace && (beforeBrace.text === 'var' || beforeBrace.text === 'let' || beforeBrace.text === 'const');
        if (!isVarDestr && inStaticBlock && !inNonAsyncFn) return true;
      }
      if (hasVarAwait) {
        const isVarDecl = prev?.text === 'var';
        if (!isVarDecl && !inNonAsyncFn) {
          // Top-level or async-fn use of `await` when `var await` is declared (e.g. `f(await, 0)`, `[await]`, `await = 1`)
          return true;
        }
        if (next?.text === '=' && toks[i + 2]?.text !== '=' && !isVarDecl) {
          // `await = 1` inside a nested function under `async function`
          if (scopeStack.includes('async-fn')) return true;
        }
      }
    }
  }
  return false;
}

function hasOctalStringEscape(text) {
  if (!text.includes('\\')) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') {
          const n = text[i + 1];
          if ((n >= '1' && n <= '9') || (n === '0' && text[i + 2] >= '0' && text[i + 2] <= '9')) return true;
          i += 2;
        } else i++;
      }
    }
  }
  return false;
}

function hasInvalidRegexLiteral(text) {
  if (!text.includes('/')) return false;
  const toks = require('./compiler-ts-lower.cjs').tokenize(text);
  if (!toks) return false;
  for (const t of toks) {
    if (t.type !== 'regex') continue;
    const last = t.text.lastIndexOf('/');
    try { new RegExp(t.text.slice(1, last), t.text.slice(last + 1)); }
    catch { return true; }
  }
  return false;
}

function hasDuplicateTopLevelLexical(text) {
  const seen = new Set();
  for (const m of text.matchAll(/(?:^|[\r\n;])[ \t]*export[ \t]+(?:const|let)[ \t]+([\p{ID_Start}$_][\p{ID_Continue}$_]*)/gu)) {
    if (seen.has(m[1])) return true;
    seen.add(m[1]);
  }
  return false;
}

function validJavaScriptTsModule(addon, source, text, file, format, directive = false, sourceMap = false) {
  const noComments = (text.includes('/*') || text.includes('//'))
    ? text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\r\n\u2028\u2029]*/g, (m, str) => str || ' ')
    : text;
  const noCommentsOrStrings = (noComments.includes('"') || noComments.includes("'"))
    ? noComments.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    : noComments;
  if (hasEscapedKeyword(text, false) ||
      /\bnew\s+import\b|\bimport\s+(?:source\b|defer\b(?![ \t]*\*))|\?\.[^\n;]*#/.test(noCommentsOrStrings) ||
      require('./compiler-ts-lower.cjs').hasForBracketIn(noComments)) {
    return null;
  }
  const validators = javascriptValidators();
  if (!validators.validModule || !validators.validScript) return null;
  let code = null;
  const genericCallSafe = !hasEscapedKeyword(text, true);
  if (genericCallSafe && validators.validModule(text) && !validators.validScript(text) && /\b(?:import|export)\b/.test(text)) {
    code = text;
  } else if (genericCallSafe && !sourceMap && format === 'preserve' && !/\b(?:import|export)\b/.test(text) && validators.validScript(text)) {
    code = strictScript(text, file, directive);
  } else if (!sourceMap && format === 'preserve' && !directive && /\b(?:import|export)\b/.test(text) &&
      !text.includes('<!--') && !text.includes('-->') && !hasOctalStringEscape(noComments) &&
      !tsRejectsInStripIdentity.test(noComments) && !hasTsAwaitYieldHazard(noComments) &&
      !(/\([ \t]*await[ \t]*\)(?![ \t]*\{)/.test(noComments) && !/\bfunction\b|\basync[ \t]*\([ \t]*await[ \t]*\)[ \t]*=>/.test(noComments))) {
    // 1. Sloppy-mode pure-JS body with trailing `export {};` (common in Test262 module harnesses):
    //    V8's script parser validates the body when it has no octal/await/HTML-comment module hazards.
    const trail = /^([\s\S]*)\nexport \{\};\n?$/.exec(text);
    if (genericCallSafe && trail !== null && !/\b(?:import|export|await)\b|\b0[0-9]|\\[1-7]|\\0[0-9]/.test(trail[1]) && validators.validScript(trail[1])) {
      code = text;
    } else if (!/[\u2028\u2029]/.test(text) && !hasDuplicateTopLevelLexical(text) &&
        !(/[^\x00-\x7f]/.test(text) && /\bexport\s*\{\s*[^}\s]/.test(text)) &&
        !/\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\b/.test(text) &&
        (text.includes('export {};') || text.includes('---*/') || !hasInvalidRegexLiteral(text))) {
      // 2. Pure-JS module that passes Node's stripTypeScriptTypes verbatim (identity output) while
      //    avoiding all SWC/TS 6.0.3 syntax divergences checked above (hasEscapedKeyword already ran).
      const stripped = strip(text, file);
      if (stripped.code === text && verifyRuntimeExports(stripped, file, addon, source).code !== null) {
        code = text;
      } else if (stripped.code === null && stripped.diagnostics[0]?.message &&
          require('./compiler-ts-lower.cjs').validPureJsWithSwcRelaxations(text, stripped.diagnostics[0].message) &&
          verifyRuntimeExports({ backend: 'javascript', code: text, sourceMap: null, diagnostics: [] }, file, addon, source).code !== null) {
        code = text;
      }
    }
  }
  if (code === null) return null;
  if (!sourceMap) return { backend: 'javascript', code, sourceMap: null, diagnostics: [] };
  if (file.includes('\\') || source[0] === 0xEF || text.startsWith('#!')) return null;
  const mappings = addon.projectionMappings?.(source, source);
  if (typeof mappings !== 'string') return null;
  return { backend: 'javascript', code, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, mappings, text), diagnostics: [] };
}

function highByteNames(addon, source, text, file, format, sourceMap = false) {
  const copy = asciiSpelling(source, text);
  if (copy === null) return null;
  const { renamed, spellings, wellFormed } = copy;
  const emitted = addon.emitAnnotatedModule(renamed, undefined, format === 'esm', false);
  if (emitted === null) return null;
  if (typeof emitted === 'string' && wellFormed && emitted.length === renamed.length) {
    const restored = Buffer.from(emitted, 'latin1');
    let erasureOnly = true;
    for (let at = 0; at < restored.length && erasureOnly; at++) {
      // Every byte that the copy changed is put back: those outside ASCII, and the first byte of a word
      // that is no identifier, which the copy spells as a digit. An erased multibyte scalar receives the
      // same UTF-16-preserving blank that the native emitter writes, so projection source maps align.
      if (restored[at] === renamed[at]) { if (source[at] !== renamed[at]) restored[at] = source[at]; }
      else if (restored[at] === 32) {
        if (source[at] >= 0xC2) {
          const width = source[at] < 0xE0 ? 2 : source[at] < 0xF0 ? 3 : 4;
          if (at + width <= restored.length && restored[at + 1] === 32 && (width < 3 || restored[at + 2] === 32) && (width < 4 || restored[at + 3] === 32)) {
            if (width === 2) { restored[at] = 0xC2; restored[at + 1] = 0xA0; }
            else if (width === 3) { restored[at] = 0xE2; restored[at + 1] = 0x80; restored[at + 2] = 0x82; }
            else { restored[at] = 0x20; restored[at + 1] = 0xEF; restored[at + 2] = 0xBB; restored[at + 3] = 0xBF; }
            at += width - 1;
          }
        }
      } else if ((restored[at] === 59 || restored[at] === 40 || restored[at] === 41) && source[at] < 0x80) {
        // Separator or parenthesis written over erased ASCII syntax is a valid projection edit.
      } else erasureOnly = false;
    }
    if (erasureOnly) {
      if (!sourceMap) return { backend: 'pulse', code: restored.toString(), sourceMap: null, diagnostics: [] };
      if (file.includes('\\') || source[0] === 0xEF) return null;
      const mappings = addon.projectionMappings?.(source, restored);
      if (typeof mappings !== 'string') return null;
      return { backend: 'pulse', code: restored.toString(), sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, mappings, text), diagnostics: [] };
    }
  }
  if (sourceMap) return null;
  // A copy that the emitter lowered: the text it wrote is the lowering of the copy, and the names are put back
  // word by word. A spelling holds two capital letters side by side for every character it stands for, which
  // no word the emitter writes of its own does, and the copy holds no byte outside ASCII, so neither does
  // the text.
  if (typeof emitted === 'string' && wellFormed && !/[^\x00-\x7f]/.test(emitted)) {
    return { backend: 'pulse', code: restoreNames(emitted, spellings), sourceMap: null, diagnostics: [] };
  }
  if (emitted !== true && typeof emitted !== 'string' && emitted.parameterProperty !== true) return null;
  return eraseModule(addon, text, file, format, emitted.parameterProperty === true);
}

// TypeScript writes the interpreter line with a line feed. A carriage return left on it becomes part of the
// interpreter's name when the file is run directly.
function unixHashbang(result) {
  const code = result.code;
  // JavaScript that needs no change is returned as the same text.
  if (result.backend === 'javascript' || typeof code !== 'string' || code.charCodeAt(0) !== 35 || code.charCodeAt(1) !== 33) return result;
  const end = code.search(lineBreak);
  const unit = end < 0 ? 10 : code.charCodeAt(end);
  if (unit === 10) return result;
  // A line or paragraph separator ends the line for the compiler as well.
  if (unit !== 13) return { ...result, code: code.slice(0, end) + '\n' + code.slice(end + 1) };
  // A carriage return alone ends the line for the compiler but not for the reader of the interpreter line.
  return { ...result, code: code.slice(0, end) + (code.charCodeAt(end + 1) === 10 ? '' : '\n') + code.slice(end + 1) };
}

function strip(source, file) {
  try {
    // A hashbang behind a byte order mark is not at the start of the file.
    if (source.startsWith('\ufeff#!')) {
      return fail('node-strip', [{
        file, code: 'MISPLACED_HASHBANG', severity: 'error',
        message: "'#!' can only be used at the start of a file", start: 1, end: 3,
      }]);
    }
    const code = require('node:module').stripTypeScriptTypes(source);
    if (source.includes('`') && source.includes('!') && markedOptionalTag(source, code)) {
      return fail('node-strip', [{
        file, code: 'AMBIGUOUS_TYPE_ERASURE', severity: 'error',
        message: 'Position-preserving erasure of a non-null mark would leave an optional chain as a template tag', start: 0, end: 0,
      }]);
    }
    if (source.includes('abstract') && misplacedAbstractErasure(source, code)) {
      return fail('node-strip', [{
        file, code: 'AMBIGUOUS_TYPE_ERASURE', severity: 'error',
        message: 'Position-preserving erasure would remove the export of a decorated abstract class', start: 0, end: 0,
      }]);
    }
    if ((source.includes('as') || source.includes('satisfies')) && regroupingAssertion(source, code)) {
      return fail('node-strip', [{
        file, code: 'AMBIGUOUS_TYPE_ERASURE', severity: 'error',
        message: 'Position-preserving erasure of an assertion would regroup the operators around it', start: 0, end: 0,
      }]);
    }
    if (hasSplitDeclare(source, code)) {
      return fail('node-strip', [{
        file, code: 'AMBIGUOUS_TYPE_ERASURE', severity: 'error',
        message: 'Position-preserving erasure would remove a declaration after a line break', start: 0, end: 0,
      }]);
    }
    return { backend: 'node-strip', code, sourceMap: null, diagnostics: [] };
  } catch (error) {
    if (error.code !== 'ERR_INVALID_TYPESCRIPT_SYNTAX' && error.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' && error.code !== 'ERR_INTERNAL_ASSERTION') throw error;
    return fail('node-strip', [{ file, code: error.code, severity: 'error', message: error.message, start: 0, end: 0 }]);
  }
}

function verifyRuntimeExports(result, file, addon, bytes) {
  if (!/\bexport(?:\s|\/\*[^]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*\{/.test(result.code)) return result;
  const checker = addon ?? loadModuleAddon();
  if (!checker?.unboundExport?.(bytes ?? Buffer.from(result.code))) return result;
  return fail(result.backend, [...result.diagnostics, {
    file, code: 'UNBOUND_RUNTIME_EXPORT', severity: 'error',
    message: 'A local export has no runtime binding after type erasure', start: 0, end: 0,
  }]);
}

function hasModuleMarker(addon, code, bytes = Buffer.from(code)) {
  return addon.moduleMarker(bytes, false) ||
    (code.includes('\u2002') && addon.moduleMarker(Buffer.from(code.replaceAll('\u2002', ' ')), false));
}

function isUseStrictDirective(source, at) {
  const m = /(["'])use strict\1[ \t]*/y;
  m.lastIndex = at;
  if (!m.test(source)) return false;
  const end = m.lastIndex;
  if (end >= source.length || source[end] === ';') return true;
  if (source[end] !== '\r' && source[end] !== '\n' && source[end] !== '\u2028' && source[end] !== '\u2029') return false;
  // Without `;`, a line break only terminates the directive via ASI when the next token does NOT continue an expression.
  const nextTrivia = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*/y;
  nextTrivia.lastIndex = end;
  nextTrivia.exec(source);
  const next = source[nextTrivia.lastIndex];
  if (next === undefined) return true;
  if ('[(`+-/.?&|*^=<>,'.includes(next)) return false;
  if (/^(?:in|instanceof)\b/.test(source.slice(nextTrivia.lastIndex, nextTrivia.lastIndex + 12))) return false;
  return true;
}

// wellFormedDirectives: the caller has seen that leading triple-slash comments are notes or well-formed
// references. TypeScript writes the strict directive in front of them as in front of any comment.
function strictScript(source, file, wellFormedDirectives = false) {
  if (source.includes('<!--') || (source.includes('-->') && /(?:^|\*\/)[^\S\r\n\u2028\u2029]*-->/m.test(source))) return null;
  // The interpreter line ends with its whole line break, so that a carriage return does not stay on it.
  const hashbang = source.startsWith('#!') ? (match => match === null ? source.length : match.index + match[0].length)(/\r\n|[\r\n\u2028\u2029]/.exec(source)) : 0;
  const trivia = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*/y;
  trivia.lastIndex = hashbang;
  trivia.exec(source);
  if (!wellFormedDirectives && source.slice(0, trivia.lastIndex).includes('///')) return null;
  const first = source[trivia.lastIndex];
  const strict = isUseStrictDirective(source, trivia.lastIndex);
  if ((first === '"' || first === "'") && !strict) return null;
  const code = strict ? source : source.slice(0, hashbang) + '"use strict";\n' + source.slice(hashbang);
  // Node can abort while decorating a syntax error from vm.Script. The addon asks V8 directly.
  const valid = javascriptValidators().validScript;
  if (valid) return valid(code) ? code : decoratedScript(code);
  try {
    new (require('node:vm').Script)(code, { filename: file });
    return code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return decoratedScript(code);
  }
}

// V8 does not parse decorators and accessor fields yet, so it refuses a script that holds one. The certified parse reads
// modules. A strict script is a module without the syntax that only a module has, so the script is given to
// that parse with an empty export behind it: what it accepts there, and what holds no import, is a script.
function decoratedScript(code) {
  if ((!code.includes('@') && !/\baccessor\b/.test(code)) || /\bimport\b/.test(code) || /\bexport\b/.test(code)) return null;
  const emit = loadModuleAddon()?.emitJavaScriptModule;
  return emit !== undefined && emit(Buffer.from(code + '\nexport {};'), true) !== undefined ? code : null;
}

const tsRejectsInNodeStrip = /\\u003[0-9]|\\u\{0*3[0-9]\}|\?\.[^\n;]*#|\bfor\s*\(\s*let\s*[;=]|\bstatic(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\r\n]*)*\bstatic\b|=(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*\bawait\b(?![ \t]*[\w$([{'"`!~+-])|@[A-Za-z_$][\w$]*(?:\([^)]*\))?(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*(?:\bthis\b|static\s*\{|\b(?:constructor|enum|function|interface|type|var|let|const|namespace|module|import)\b)|(?<!\bexport\s*)(?<!\)\s*)\{\s*(?:while|for|if|return|class|function|var|let|const|extends)\s*[,}]|\?\.(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*[A-Za-z_$][\w$]*\s*<[^<>()\n;]*>\s*\(|\bnew(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\r\n]*)*import\b|\bimport(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\r\n]*)*(?:\.(?:\s|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\r\n]*)*source|type\s+(?:defer|source)|source)\b|<[^<>\n;]+>\s*\.[A-Za-z_$]|\btype[ \t]+(?:void|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|import|in|instanceof|new|null|return|super|switch|this|throw|true|try|typeof|var|while|with)[ \t]*=|<[^>]*\b(?:in\s+in|out\s+out)\b|\bexport\s+as\s+namespace\b|\bimplements\s*\{|\bdeclare[ \t]+module[ \t]*[\r\n]|\bdeclare[ \t]+(?:module|namespace)[ \t]+(?:break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|import|in|instanceof|new|null|return|super|switch|this|throw|true|try|typeof|var|while|with)\b|\(\s*(?:<[^>]+>\s*)?[A-Za-z_$][\w$]*(?:\s+(?:as|satisfies)\b[^)]*)?\)\s*(?:&&|\|\||\?\?)?=(?![=>])/;

function hasTsRejectsInNodeStrip(source) {
  const noComments = (source.includes('/*') || source.includes('//'))
    ? source.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|\/\/[^\r\n\u2028\u2029]*/g, (m, str) => str || ' ')
    : source;
  if (tsRejectsInNodeStrip.test(noComments) || require('./compiler-ts-lower.cjs').hasForBracketIn(noComments)) return true;
  if (/\([ \t]*await[ \t]*\)(?![ \t]*\{)/.test(noComments) && !/\bfunction\b/.test(noComments) && !/\basync[ \t]*\([ \t]*await[ \t]*\)[ \t]*(?::[^\n]*?)?=>/.test(noComments)) return true;
  // TypeScript rejects multiple `/// <amd-module` directives in one file.
  if (source.includes('<amd-module')) {
    const m = source.match(/\/\/\/[ \t\f\v]*<amd-module\b/gi);
    if (m && m.length > 1) return true;
  }
  return false;
}

// Token-based rewrite of top-level `declare module Name {` / `declare module "str" {` outside strings/templates/comments.
function normalizeAmbientModules(source) {
  return require('./compiler-ts-lower.cjs').normalizeAmbientModules(source);
}

function sloppyStrictScript(source, file, directive = false) {
  const code = strictScript(source, file, directive);
  if (code !== null) return code;
  if (source.includes('<!--') || (source.includes('-->') && /(?:^|\*\/)[^\S\r\n\u2028\u2029]*-->/m.test(source))) return null;
  const hashbang = source.startsWith('#!') ? (match => match === null ? source.length : match.index + match[0].length)(/\r\n|[\r\n\u2028\u2029]/.exec(source)) : 0;
  const trivia = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*/y;
  trivia.lastIndex = hashbang;
  trivia.exec(source);
  if (!directive && source.slice(0, trivia.lastIndex).includes('///') && !/\/\/\/[ \t]*<reference\b/i.test(source.slice(0, trivia.lastIndex))) return null;
  const first = source[trivia.lastIndex];
  const strict = isUseStrictDirective(source, trivia.lastIndex);
  if ((first === '"' || first === "'") && !strict) return null;
  if (/(?<![\w$.])0[0-9]/.test(source) || /\bimport\s*\.\s*meta\b/.test(source)) return null;
  // Node's stripTypeScriptTypes (SWC) already validated the script syntax. V8's validScript rejects
  // valid ESNext/TS scripts that use Stage 3 decorators, `accessor`, multi-file `// @filename:` duplicate
  // bindings, or semantic checks (`super`, `#private`) that TypeScript's syntax-only transpileModule accepts.
  return strict ? source : source.slice(0, hashbang) + '"use strict";\n' + source.slice(hashbang);
}

function eraseScript(addon, source, bytes, file, directive = false, allowTriviaOnly = false) {
  if (hasEscapedKeyword(source, false) || hasTsRejectsInNodeStrip(source)) return null;
  const plain = !/\b(?:import|export)\b/.test(source) && addon.plainScript(bytes);
  const work = plain ? source : normalizeAmbientModules(source);
  const result = strip(work, file);
  if (result.code === null) return null;
  const emitted = Buffer.from(result.code);
  if (hasModuleMarker(addon, result.code, emitted)) return null;
  if (!plain && require('./compiler-ts-lower.cjs').hasTopLevelModuleSyntax(work)) return null;
  if (!allowTriviaOnly && addon.triviaOnly(emitted) && result.code === work) return null;
  const effDirective = directive || (result.code.includes('///') && loadDirectAddon()?.leadingTripleSlash(emitted) === 1);
  const code = sloppyStrictScript(result.code, file, effDirective);
  return code === null ? null : { ...result, code };
}

const moduleTrivia = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/y;

function moduleTriviaEnd(source, at) {
  moduleTrivia.lastIndex = at;
  moduleTrivia.test(source);
  return moduleTrivia.lastIndex;
}

function javascriptModuleStart(source) {
  const hashbang = source.startsWith('#!') ? /^#![^\r\n\u2028\u2029]*/.exec(source)[0].length : 0;
  return moduleTriviaEnd(source, hashbang);
}

function startsStaticModule(source, start) {
  const after = start + 6;
  const follower = source[after] ?? '';
  if (source.startsWith('export', start)) return /^[\s{/*]$/.test(follower);
  if (!source.startsWith('import', start) || !/^[\s/'"{*]$/.test(follower)) return false;
  const specifier = source[moduleTriviaEnd(source, after)] ?? '';
  return /^[A-Za-z_$'"{*]$/.test(specifier);
}

// V8 does not parse decorators yet. The certified parse does, and the entry asks it first, so a module
// that V8 refuses is published when that parse accepts it unchanged.
function certifiedModule(source, bytes) {
  const emit = loadModuleAddon()?.emitJavaScriptModule;
  return emit !== undefined && emit(bytes ?? Buffer.from(source), true) !== undefined ? source : null;
}

function modernJavaScript(source, file, format) {
  const moduleFile = format === 'esm' && /\.mjs$/i.test(file);
  const start = moduleFile ? undefined : javascriptModuleStart(source);
  const staticHead = start !== undefined && startsStaticModule(source, start);
  const script = format === 'preserve' && !staticHead ? strictScript(source, file) : null;
  if (script !== null) return script;
  let bytes;
  const directive = source.indexOf('///');
  if (directive !== -1) {
    if (directive < (start ?? javascriptModuleStart(source))) return null;
    bytes = Buffer.from(source);
    if (loadDirectAddon()?.leadingDirective(bytes) !== false) return null;
  }
  if (moduleFile || staticHead) {
    const validate = javascriptTextValidator();
    if (validate) {
      const valid = validate(source);
      if (valid) return source;
      if (moduleFile) return certifiedModule(source, bytes);
    }
  }
  const addon = loadModuleAddon();
  if (!addon) return null;
  bytes ??= Buffer.from(source);
  if (moduleFile && addon.validModule) {
    return addon.validModule(bytes) ? source : certifiedModule(source, bytes);
  }
  if (!moduleFile && !staticHead) {
    const validate = javascriptTextValidator();
    if (validate && addon.moduleMarker(bytes, false) && validate(source)) return source;
  }
  return addon.moduleMarker(bytes, true) && strip(source, file).code === source ? source : null;
}

function eraseLoweredModule(addon, source, file, format, directive = false) {
  let result = strip(source, file);
  const diagnostic = result.diagnostics[0];
  if (diagnostic?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' &&
      /^(?:\s*x\s*)?TypeScript enum is not supported/.test(diagnostic.message)) {
    const code = addon.lower(Buffer.from(source), false, true, false, true);
    if (code !== null) result = strip(code, file);
  }
  if (result.code === null) return null;
  let code = result.code;
  if (!hasModuleMarker(addon, code)) {
    if (format !== 'preserve' || /\b(?:import|export)\b/.test(source)) return null;
    code = strictScript(code, file, directive);
    if (code === null) return null;
  }
  return verifyRuntimeExports({ ...result, code, backend: 'pulse+node-strip' }, file, addon);
}

function eraseModule(addon, source, file, format, parameterProperty) {
  if (hasEscapedKeyword(source, false) || source.includes('\u00a0') || hasTsRejectsInNodeStrip(source) || /(?:^|[;\r\n{])[ \t]*await[ \t]*;/.test(source)) return null;
  const work = normalizeAmbientModules(source);
  const transformAllowed = () => !/\benum\b|\bnamespace\b(?![ \t]*:)/.test(work);
  const directTransform = parameterProperty && transformAllowed();
  let result = directTransform ? null : strip(work, file);
  const diagnostic = result?.diagnostics[0];
  if (directTransform || (diagnostic?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' &&
      /^(?:\s*x\s*)?TypeScript parameter property is not supported/.test(diagnostic.message) && transformAllowed())) {
    if (hasSplitDeclare(work)) return null;
    try {
      const code = require('node:module').stripTypeScriptTypes(work, { mode: 'transform' });
      result = { backend: 'node-transform', code, sourceMap: null, diagnostics: [] };
    } catch (error) {
      if (!['ERR_INVALID_ARG_VALUE', 'ERR_INVALID_TYPESCRIPT_SYNTAX', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', 'ERR_INTERNAL_ASSERTION'].includes(error.code)) throw error;
    }
  }
  if (result?.code == null) return null;
  if (result.code === work && hasEscapedKeyword(work, true)) return null;
  const emitted = Buffer.from(result.code);
  if (hasModuleMarker(addon, result.code, emitted)) return verifyRuntimeExports(result, file, addon, emitted);
  const isWorkModule = addon.moduleMarker(Buffer.from(work), true) ||
    require('./compiler-ts-lower.cjs').hasTopLevelModuleSyntax(work) ||
    /\bimport\s*\.\s*meta\b/.test(work);
  if (!isWorkModule) return null;
  if (addon.triviaOnly(emitted)) {
    if (format === 'esm') result.code += '\nexport {};\n';
    return result;
  }
  if (format === 'preserve') {
    const valid = javascriptTextValidator();
    if (valid && valid(result.code)) return result;
    if (/\bimport\s*\.\s*meta\b/.test(result.code) && !hasInvalidRegexLiteral(result.code)) return result;
  }
  return null;
}

function snapshot(input) {
  types ??= require('node:util').types;
  if (types.isSharedArrayBuffer(input)) return Buffer.from(new Uint8Array(input));
  if (ArrayBuffer.isView(input) && types.isSharedArrayBuffer(input.buffer)) {
    return Buffer.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  }
  return input;
}

let sourceDecoder;
function compilerSource(input) {
  if (typeof input === 'string') return input.isWellFormed() ? input : null;
  try {
    sourceDecoder ??= new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return sourceDecoder.decode(input);
  } catch {
    return null;
  }
}

// A script is published as a strict-mode directive followed by a projection of the source.
// Its map is the projection's map moved down by the directive's line.
function mappedScript(input, options) {
  const { file = 'input.ts' } = options;
  if (!/\.ts$/.test(file) || file.includes('\\')) return undefined;
  const source = Buffer.isBuffer(input) ? input : typeof input === 'string' && input.isWellFormed() ? Buffer.from(input) : null;
  const addon = source === null || source[0] === 0xEF ? null : loadModuleAddon();
  if (!addon?.projectionMappings || addon.moduleMarker(source, false)) return undefined;
  const plain = compile(input, { ...options, sourceMap: false });
  const directive = '"use strict";\n';
  if (plain.backend !== 'pulse' || !plain.code.startsWith(directive)) return undefined;
  const mappings = addon.projectionMappings(source, Buffer.from(plain.code.slice(directive.length)));
  if (mappings === undefined) return undefined;
  return { ...plain, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, ';' + mappings, source.toString()) };
}

// TypeScript writes the same text for the targets from ES2022 on as for ESNext, except for three forms that
// it lowers (decorators, `using` declarations and accessor fields) and one that it rewrites: inside a private
// member that is not static, the name of its class is replaced by a variable that is set behind the class.
// Measured on 33,572 files of sixteen code bases and of TypeScript's own cases, every difference between its
// ES2022 and ESNext outputs was one of these, and no diagnostic differed.
//
// The same holds further back, measured the same way for every target down to ES2015: its output differs
// from ESNext only where the source holds a form that is newer than the target. Those forms are found by
// their words and signs, wherever they stand (a comment or a string that holds one sends the file to
// TypeScript):
//   below ES2022  a class (fields, private names and static blocks all need one) and any private name
//   below ES2021  `||=`, `&&=`, `??=` (numeric separators are lowered natively by `lowerOlderTarget`)
//   below ES2020  `?.` and `??` (`export * as` is kept/lowered identically across all targets)
//   below ES2019  optional `catch` bindings are lowered natively by `lowerOlderTarget` when unambiguous
//   below ES2018  `...` (an object may spread or collect), `for await`, an async generator, JSX (whose
//                 attributes become an object that may spread), and a template next to a doubtful escape
//   below ES2017  `async` and `await`
//   below ES2016  `**`
const targetYears = new Map([['es6', 2015], ['es2015', 2015], ['es2016', 2016], ['es2017', 2017], ['es2018', 2018], ['es2019', 2019],
  ['es2020', 2020], ['es2021', 2021], ['es2022', 2022], ['es2023', 2023], ['es2024', 2024], ['es2025', 2025]]);
// A comment may stand between the words of a form, so each pattern asks for what must follow directly and
// takes everything else for the form: an `export` that is followed by neither a brace, a word nor `* from`;
// a `catch` or a `for` without its parenthesis; an `async` (with or without `function`) in front of a star
// or a comment. Two stars are an operator unless they open a comment at the start of a line: behind other
// text the slash in front of them may close a regular expression.
const newerForms = [
  [2022, /\.\s*#/],
  [2018, /\.\.\.|\bfor\b(?!\s*\()|\basync\b(?:\s*function\b)?\s*[*\/]/],
  [2017, /\basync\b|\bawait\b/],
];

// Lowers ES2021 numeric separators (`1_000`, `0xff_ff`, `0b10_10`, `1_000.5_5e1_0`, `1_000n`) for targets
// below ES2021 and ES2019 optional catch bindings (`catch { ... }` -> `catch (_a) { ... }`) for targets
// below ES2019 in compiled JS while skipping strings, comments, template text, regexes, and shebangs.
function lowerOlderTarget(code, year, spans = null) {
  if (spans !== null && /[^\x00-\x7f]/.test(code)) return null;
  const regexAfter = new Set(['', '(', '[', '{', '${', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~', '<', '>', '+', '-', '*', '%', '/', '=>', ')ctrl', '...',
    'return', 'throw', 'case', 'default', 'typeof', 'void', 'delete', 'in', 'instanceof', 'new', 'else', 'do']);
  const numLit = /0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?n?|\.\d[\d_]*(?:[eE][+-]?[\d_]+)?/y;
  const lowerCatch = year < 2019 && /\bcatch\b(?!\s*\()/.test(code);
  let catchName = null;
  if (lowerCatch) {
    if (code.includes('\\u') || /\b(?:eval|with)\b/.test(code)) return null;
    for (let i = 0; i < 26; i++) {
      const cand = '_' + String.fromCharCode(97 + i);
      if (!new RegExp(`(?<![\\w$])${cand}(?![\\w$])`).test(code)) { catchName = cand; break; }
    }
    if (catchName === null) return null;
  }
  const braces = [], parens = [];
  let prev = '', at = 0, out = '', last = 0, catchCount = 0;
  if (code.startsWith('#!')) {
    while (at < code.length && code[at] !== '\n' && code[at] !== '\r') at++;
  }
  const skipTrivia = pos => {
    while (pos < code.length) {
      const ch = code[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { pos++; continue; }
      if (ch === '/' && code[pos + 1] === '/') {
        pos += 2;
        while (pos < code.length && code[pos] !== '\n' && code[pos] !== '\r') pos++;
        continue;
      }
      if (ch === '/' && code[pos + 1] === '*') {
        const end = code.indexOf('*/', pos + 2);
        if (end < 0) return -1;
        pos = end + 2;
        continue;
      }
      break;
    }
    return pos;
  };
  const skipTpl = pos => {
    while (pos < code.length) {
      const c = code[pos];
      if (c === '\\') { pos += 2; continue; }
      if (c === '`') { prev = 'lit'; return pos + 1; }
      if (c === '$' && code[pos + 1] === '{') { braces.push('tpl'); prev = '${'; return pos + 2; }
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
      at++;
      while (at < code.length && code[at] !== c) {
        if (code[at] === '\\') at += 2;
        else if (code[at] === '\n' || code[at] === '\r') return null;
        else at++;
      }
      if (at >= code.length) return null;
      at++;
      prev = 'lit';
      continue;
    }
    if (c === '`') { at = skipTpl(at + 1); if (at < 0) return null; continue; }
    if (c === '}') {
      if (braces.length > 0 && braces[braces.length - 1] === 'tpl') {
        braces.pop();
        at = skipTpl(at + 1);
        if (at < 0) return null;
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
    if (c === ')') { prev = parens.pop() ? ')ctrl' : ')'; at++; continue; }
    if (c === '/') {
      if (prev === '}' || prev === '++' || prev === '--' || prev === 'of' || prev === 'debugger' || prev === 'break' || prev === 'continue' || prev === 'await' || prev === 'yield') return null;
      if (regexAfter.has(prev)) {
        at++;
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
        prev = 'lit';
        continue;
      }
      at += code[at + 1] === '=' ? 2 : 1;
      prev = '/';
      continue;
    }
    const ch = code.charCodeAt(at);
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36 || ch >= 128) {
      const start = at;
      at++;
      while (at < code.length) {
        const u = code.charCodeAt(at);
        if ((u >= 65 && u <= 90) || (u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u === 95 || u === 36 || u >= 128) at++;
        else break;
      }
      const word = code.slice(start, at);
      if (lowerCatch && word === 'catch' && prev !== '.' && prev !== '#' && code[start - 1] !== '#') {
        const nextAt = skipTrivia(at);
        if (nextAt < 0) return null;
        if (code[nextAt] === '{') {
          if (++catchCount > 1) return null;
          const pad = nextAt > at && /[\s]/.test(code[nextAt - 1]) ? '' : ' ';
          const inserted = pad + `(${catchName}) `;
          if (spans !== null) {
            if (nextAt > last) spans.push([nextAt - last, last]);
            spans.push([inserted.length, -1]);
          }
          out += code.slice(last, nextAt) + inserted;
          last = nextAt;
        }
      }
      prev = prev === '.' ? 'id' : (prev === 'for' && word === 'await') ? 'await-for' : word;
      continue;
    }
    if ((ch >= 48 && ch <= 57) || (c === '.' && code.charCodeAt(at + 1) >= 48 && code.charCodeAt(at + 1) <= 57)) {
      numLit.lastIndex = at;
      const m = numLit.exec(code);
      if (m === null) return null;
      const lit = m[0];
      if (lit.endsWith('n') && year < 2020) return null;
      if (lit.includes('_')) {
        const rep = lit.replace(/_/g, '');
        if (spans !== null) {
          if (at > last) spans.push([at - last, last]);
          spans.push([rep.length, at]);
        }
        out += code.slice(last, at) + rep;
        last = numLit.lastIndex;
      }
      at = numLit.lastIndex;
      prev = 'lit';
      continue;
    }
    if (c === '.' && code[at + 1] === '.' && code[at + 2] === '.') { prev = '...'; at += 3; continue; }
    if (c === '?' && code[at + 1] === '.' && !(code.charCodeAt(at + 2) >= 48 && code.charCodeAt(at + 2) <= 57)) { prev = '.'; at += 2; continue; }
    if (c === '=' && code[at + 1] === '>') { prev = '=>'; at += 2; continue; }
    if ((c === '+' && code[at + 1] === '+') || (c === '-' && code[at + 1] === '-')) { prev = c + c; at += 2; continue; }
    prev = c;
    at++;
  }
  if (last === 0) {
    if (spans !== null && code.length > 0) spans.push([code.length, 0]);
    return code;
  }
  if (spans !== null && code.length > last) spans.push([code.length - last, last]);
  return out + code.slice(last);
}
const comment = '(?:[ \\t]|/\\*(?:[^*]|\\*(?!/))*\\*/)';
// `using name =`, `using name:` and the head of a loop. English text with these words in this order is
// taken for a declaration too, and such a file goes to TypeScript.
// A name as the patterns read it: the text is a byte string, so the bytes of a character outside ASCII
// count as letters, and so do the signs of a unicode escape.
const wordStart = '[A-Za-z_$\\\\\\x80-\\xff]', wordRest = '[\\w$\\\\{}\\x80-\\xff]*';
const usingDeclaration = new RegExp('(?<![\\w$.])using' + comment + '+' + wordStart + wordRest + '(?:\\s|' + comment + ')*(?:[=:,;\\/]|of\\b)|\\bfor\\b[^\\n]{0,60}?\\(\\s*(?:await\\s+)?using\\b');
// `accessor name` with what can stand behind the name of a field (in English text another word follows).
const accessorField = new RegExp('(?<![\\w$.])accessor' + comment + '*(?:[\\[\\"\\\'0-9#]|(?<![\\w$])' + wordStart + wordRest + comment + '*(?:[;=:!?}\\r\\n\\/]|$))');
// A private name that is not read through a dot: a member being declared (or `#name in value`). It stands
// behind white space, a brace, a semicolon, the star of a generator, the end of a comment, or a modifier
// that touches it (`static#name`). A line comment such as `// #region` is not one. Whether a member's body names its class is not looked at. One character
// before the name decides, so the search takes time in proportion to the source.
const privateMember = /(?<!\/\/[ \t]{0,8})(?<=[\s{;}*\/]|\b(?:static|get|set|async|readonly|declare|override|public|private|protected|accessor))#[A-Za-z_$\\\u0080-\uffff]/;

// The patterns know the white space of ASCII as spaces, tabs and line ends. Any other white space or line end
// (a vertical tab, a form feed, and the bytes of the spaces and separators outside ASCII, from the no-break
// space to the byte order mark) could stand where a pattern expects one of those, so a source that holds
// one is left to TypeScript for every target but ESNext.
const otherSpace = /[\x0b\x0c]|\xc2[\x85\xa0]|\xe1\x9a\x80|\xe2\x80[\x80-\x8a\xa8\xa9\xaf]|\xe2\x81\x9f|\xe3\x80\x80|\xef\xbb\xbf/;

// A backslash in front of a digit, of an `x` without two hexadecimal digits, or of a `u` without four.
const doubtfulEscape = /\\(?:[0-9]|x(?![0-9a-fA-F]{2})|u(?![0-9a-fA-F]{4}))/;

const commonJsDeclined = Symbol('commonJsDeclined');

// Whether a source holds none of the forms that TypeScript writes differently for a target of that year.
function writtenAsNewest(input, jsxFile, year, allowStage3 = false) {
  const bytes = Buffer.isBuffer(input) ? input : typeof input === 'string' ? Buffer.from(input) : null;
  if (bytes === null) return false;
  const using = bytes.includes('using'), accessor = bytes.includes('accessor'), at = bytes.includes(64), hash = bytes.includes(35);
  if (year >= 2022 && !using && !accessor && !at && !hash) return true;
  const text = bytes.latin1Slice();
  if (otherSpace.test(text)) return false;
  if ((using && usingDeclaration.test(text)) || (accessor && accessorField.test(text)) || (hash && privateMember.test(text))) return false;
  if (year < 2018 && jsxFile && bytes.includes(60)) return false;
  // Below ES2018 a tagged template may not hold an escape that is no escape; TypeScript then writes the
  // strings through a helper. Any such escape in a file with a template sends it there.
  if (year < 2018 && bytes.includes(96) && doubtfulEscape.test(text)) return false;
  for (const [since, form] of newerForms) if (year < since && form.test(text)) return false;
  if (at && !allowStage3) {
    // An at sign may stand in a comment or a string: the parser says whether one of them is a decorator.
    const addon = bytes.length <= 1048576 ? loadModuleAddon() : null;
    const records = addon?.legacyDecoratorRecords?.(bytes, false, jsxFile);
    if (!records) return false;
    for (let index = 0; index < records.length; index += 5) if (records[index] === 50) return false;
  }
  return true;
}

function compile(input, options = {}) {
  const { file = 'input.ts', mode = 'transform', target = 'esnext', module = 'preserve', jsx = 'automatic',
    sourceMap = false, experimentalDecorators = false, emitDecoratorMetadata = false } = options;
  if (typeof file !== 'string' || !extensions.test(file)) throw new TypeError('Expected a JS, TS, JSX or TSX filename');
  // Bytes in a plain Uint8Array are read in place like those of a Buffer, so both take the same routes.
  if (input instanceof Uint8Array && !Buffer.isBuffer(input) && !(types ??= require('node:util').types).isSharedArrayBuffer(input.buffer)) {
    return compile(Buffer.from(input.buffer, input.byteOffset, input.byteLength), options);
  }
  if (typeof experimentalDecorators !== 'boolean' || typeof emitDecoratorMetadata !== 'boolean' ||
      (emitDecoratorMetadata && !experimentalDecorators)) {
    throw new TypeError('Expected boolean decorator options, and emitDecoratorMetadata only with experimentalDecorators');
  }
  if (!targets.has(target) || !modules.has(module) || !jsxModes.has(jsx) || typeof sourceMap !== 'boolean') {
    throw new TypeError('Invalid compiler target, module, JSX or source-map option');
  }
  if (mode !== 'transform' && mode !== 'strip') throw new TypeError('Expected transform or strip compilation mode');
  if (mode === 'strip' && (target !== 'esnext' || module !== 'preserve' || sourceMap || options.jsx !== undefined || experimentalDecorators)) {
    throw new TypeError('strip mode only supports position-preserving type erasure');
  }
  if (declarations.test(file)) return inputError(file, 'DECLARATION_INPUT', 'A declaration file cannot emit JavaScript');
  if (mode === 'strip' && !/\.[cm]?ts$/i.test(file)) {
    return inputError(file, 'STRIP_DIALECT', 'strip mode requires a non-JSX TypeScript filename');
  }
  const format = outputFormat(file, module);
  const typed = /\.(?:m?ts|tsx)$/i.test(file);
  const jsxFile = /\.[jt]sx$/i.test(file);
  // CommonJS output of a module: the module is compiled as such, and its imports and exports are then
  // written the way TypeScript writes them.
  if (format === 'cjs' && mode === 'transform' && (!sourceMap || !file.includes('\\')) && !options[commonJsDeclined]) {
    const stable = snapshot(input);
    const innerFile = file.replace(/\.[cm]([jt]s)$/i, '.$1');
    const written = compile(stable, { ...options, file: innerFile, module: 'preserve' });
    // An exported ambient value declaration leaves no text, yet TypeScript reads its name through `exports`.
    // Type-only `export declare interface/type` or unreferenced single-name ambient declarations do not change CJS output.
    const rawOrigin = Buffer.isBuffer(stable) ? stable.latin1Slice() : typeof stable === 'string' ? stable : '';
    let ambient = false;
    if (written.code !== null && rawOrigin.includes('declare')) {
      const ambRe = /\bexport\b(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*declare\b/g;
      let m;
      while ((m = ambRe.exec(rawOrigin)) !== null) {
        const start = m.index + m[0].length;
        const head = /^\s+(?:(interface|type)\b|(const|let|var|const\s+enum|abstract\s+class|async\s+function\*?|function\*?|class|enum|namespace|module)\s+([A-Za-z_$][\w$]*))/.exec(rawOrigin.slice(start, start + 120));
        if (head === null) { ambient = true; break; }
        if (head[1] !== undefined) continue; // `export declare interface` / `export declare type`
        const kind = head[2], name = head[3];
        if (kind === 'const' || kind === 'let' || kind === 'var') {
          // Scan the entire variable declaration to `;` at nesting depth 0 to conservatively reject multi-declarator lists.
          let pos = start + head[0].length, depth = 0, closed = false;
          while (pos < rawOrigin.length) {
            const c = rawOrigin.charCodeAt(pos);
            if (c === 47 && rawOrigin.charCodeAt(pos + 1) === 47) {
              const nl = rawOrigin.indexOf('\n', pos + 2);
              pos = nl < 0 ? rawOrigin.length : nl + 1;
              continue;
            }
            if (c === 47 && rawOrigin.charCodeAt(pos + 1) === 42) {
              const endC = rawOrigin.indexOf('*/', pos + 2);
              if (endC < 0) break;
              pos = endC + 2;
              continue;
            }
            if (c === 34 || c === 39 || c === 96) {
              pos++;
              while (pos < rawOrigin.length && rawOrigin.charCodeAt(pos) !== c) {
                pos += rawOrigin.charCodeAt(pos) === 92 ? 2 : 1;
              }
              if (pos >= rawOrigin.length) break;
              pos++;
              continue;
            }
            if (c === 40 || c === 91 || c === 123 || c === 60) depth++;
            else if (c === 41 || c === 93 || c === 125 || c === 62) { if (depth > 0) depth--; }
            else if (depth === 0 && c === 44) { ambient = true; break; } // top-level `,` => multi-declarator
            else if (depth === 0 && c === 59) { closed = true; break; } // `;`
            pos++;
          }
          if (ambient || !closed) { ambient = true; break; }
        }
        if (written.code.includes(name) && new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(written.code)) {
          // Verify whether `name` actually appears as a code identifier (not merely inside comments/strings).
          const toks = require('./compiler-commonjs-scope.cjs').tokenizeJs(written.code);
          if (toks === null || toks.some(t => t.type === 'id' && !t.afterDot && t.value === name)) {
            ambient = true;
            break;
          }
        }
      }
    }
    if (!ambient && written.code !== null && (written.backend === 'pulse' || written.backend === 'javascript') && written.diagnostics.length === 0 &&
        (!sourceMap || written.sourceMap)) {
      const addon = loadModuleAddon();
      const origin = Buffer.isBuffer(stable) ? stable.latin1Slice() : typeof stable === 'string' ? Buffer.from(stable).latin1Slice() : null;
      const spans = sourceMap ? [] : null;
      const toCjs = require('./compiler-commonjs.cjs').toCommonJs;
      let code = addon && origin !== null ? toCjs(addon, written.code, origin, experimentalDecorators, spans) : null;
      if (code === null && !sourceMap && addon && origin !== null && /[^\x00-\x7f]/.test(written.code) &&
          !/[^\x00-\x7f][\w$\x80-\xff]*(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*!(?!=)/.test(origin) && !/\b(?:from|import)\s*["'][^"'\n]*[^\x00-\x7f]/.test(written.code)) {
        const writtenBytes = Buffer.from(written.code);
        const copy = asciiSpelling(writtenBytes, written.code);
        if (copy !== null && copy.wellFormed) {
          const asciiCjs = toCjs(addon, copy.renamed.toString(), origin, experimentalDecorators, null);
          if (asciiCjs !== null && !/[^\x00-\x7f]/.test(asciiCjs)) code = restoreNames(asciiCjs, copy.spellings);
        }
      }
      if (code === null && !experimentalDecorators && addon && origin !== null &&
          /\bexport\s*=/.test(origin) && /\bmodule\.exports\s*=/.test(written.code) &&
          !/\b(?:import|export)\b/.test(written.code) && written.backend === 'pulse') {
        const strict = strictScript(written.code, file, false);
        if (strict !== null) {
          try {
            new Function('exports', 'require', 'module', '__filename', '__dirname', strict.startsWith('#!') ? '//' + strict : strict);
            if (!sourceMap) return { ...written, code: strict };
            if (!written.code.startsWith('#!') && (strict === written.code || strict === '"use strict";\n' + written.code)) {
              const shifted = (strict === written.code ? '' : ';') + written.sourceMap.mappings;
              return { ...written, code: strict, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, shifted, written.sourceMap.sourcesContent[0], jsx === 'preserve', 'cjs') };
            }
          } catch {}
        }
      }
      if (code === null && !experimentalDecorators && origin !== null && !/\.m[jt]s$/i.test(file) &&
          written.code.startsWith('"use strict";\n') && !/\b(?:import|export)\b/.test(origin) && !/\b(?:import|export)\b/.test(written.code)) {
        try {
          new Function('exports', 'require', 'module', '__filename', '__dirname', written.code);
          if (!sourceMap) return written;
          return { ...written, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, written.sourceMap.mappings, written.sourceMap.sourcesContent[0], jsx === 'preserve', 'cjs') };
        } catch {}
      }
      if (code === null && !experimentalDecorators && written.backend === 'pulse' && !written.code.startsWith('#!') &&
          !/\b(?:import|export)\b/.test(written.code)) {
        const onlyTrivia = written.code.replace(/(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, '').trim() === '';
        const hasComments = written.code.trim() !== '';
        if (onlyTrivia ? (!sourceMap || !hasComments) : !/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*["']/.test(written.code)) {
          const esm = compile(stable, { ...options, file: innerFile, module: 'esm', sourceMap: false });
          if (esm.backend === 'pulse' && esm.code !== null && esm.code.trimEnd().endsWith('export {};')) {
            const head = '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n';
            const out = onlyTrivia ? head + (hasComments ? written.code.trim() + '\n' : '') : head + written.code;
            if (onlyTrivia) {
              if (!sourceMap) return { ...written, code: out };
              return { ...written, code: out, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, '', written.sourceMap.sourcesContent[0], jsx === 'preserve', 'cjs') };
            }
            try {
              new Function('exports', 'require', 'module', '__filename', '__dirname', out);
              if (!sourceMap) return { ...written, code: out };
              return { ...written, code: out, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, ';;' + written.sourceMap.mappings, written.sourceMap.sourcesContent[0], jsx === 'preserve', 'cjs') };
            } catch {}
          }
        }
      }
      if (code !== null) {
        if (!sourceMap) return { ...written, code };
        const mappings = require('./compiler-legacy-maps.cjs').composeCommonJsMappings(Buffer.from(written.code), Buffer.from(code), spans, written.sourceMap.mappings, code);
        if (mappings !== null) {
          return { ...written, code, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, mappings, written.sourceMap.sourcesContent[0], jsx === 'preserve', 'cjs') };
        }
      }
    }
    return compile(stable, { ...options, [commonJsDeclined]: true });
  }
  if (targetYears.has(target) && mode === 'transform' && !experimentalDecorators) {
    const year = targetYears.get(target);
    const stable = snapshot(input);
    const allowStage3 = year >= 2022 && year < 2024 && !sourceMap && jsx !== 'preserve';
    if (writtenAsNewest(stable, jsxFile, year, allowStage3)) {
      const raw = year < 2024 ? (Buffer.isBuffer(stable) ? stable.latin1Slice() : String(stable)) : '';
      const needsStage3 = year >= 2022 && year < 2024 && raw.includes('@');
      const needsOlder = year < 2021 && (/(?<![\w$])(?:\d[\w.]*_|\.\d[\d_]*_)/.test(raw) || (year < 2019 && /\bcatch\b(?!\s*\()/.test(raw)));
      const needsDown = year < 2022 && (
        /\bclass\b/.test(raw) ||
        (year < 2021 && /\|\|=|&&=|\?\?=/.test(raw)) ||
        (year < 2020 && /\?\.|\?\?/.test(raw)) ||
        (year < 2016 && /(?<!^[ \t]*\/\**)\*\*/m.test(raw))
      );
      if (!needsStage3 && !needsOlder && !needsDown) return compile(stable, { ...options, target: 'esnext' });
      if (jsx !== 'preserve' && (!needsDown || !sourceMap) && (!needsStage3 || !sourceMap)) {
        const result = compile(stable, { ...options, target: 'esnext' });
        if ((result.backend === 'pulse' || result.backend === 'javascript') && result.code !== null && result.diagnostics.length === 0 &&
            (!sourceMap || result.sourceMap)) {
          const spans = sourceMap ? [] : null;
          let lowered = needsOlder ? lowerOlderTarget(result.code, year, spans) : result.code;
          if (lowered !== null && needsDown) {
            lowered = require('./compiler-downlevel.cjs').lowerDownlevel(lowered, year);
          }
          if (lowered !== null && needsStage3) {
            const addon = loadModuleAddon();
            lowered = addon ? require('./compiler-stage3-decorators.cjs').lowerStage3Decorators(addon, lowered) : null;
          }
          if (lowered !== null) {
            if (!sourceMap) return { ...result, code: lowered };
            const mappings = require('./compiler-legacy-maps.cjs').composeCommonJsMappings(Buffer.from(result.code), Buffer.from(lowered), spans, result.sourceMap.mappings, lowered);
            if (mappings !== null) {
              return { ...result, code: lowered, sourceMap: { ...result.sourceMap, mappings } };
            }
          }
        }
      }
    }
  }
  // Decorators of TypeScript's earlier design are lowered to helper calls. A source without an at sign holds
  // none, and compiles as without the option; any other is lowered by TypeScript.
  if (experimentalDecorators && typed) {
    const text = compilerSource(snapshot(input));
    if (text === null) return inputError(file, 'INVALID_ENCODING', 'Expected well-formed UTF-8');
    if (text.includes('@')) {
      // Without metadata and without a map the decorators are lowered here: the source is rewritten into
      // TypeScript without decorators, which the ordinary routes compile.
      if (!sourceMap && mode === 'transform' && format !== 'cjs' && target === 'esnext') {
        const bytes = Buffer.from(text);
        const addon = bytes.length <= 1048576 ? loadModuleAddon() : null;
        const lower = source => require('./compiler-legacy-decorators.cjs').lowerLegacyDecorators(addon, source, emitDecoratorMetadata, jsxFile);
        const rewritten = addon ? lower(bytes) : null;
        if (rewritten !== null) {
          const result = compile(rewritten, { ...options, experimentalDecorators: false, emitDecoratorMetadata: false });
          if (rewritten === bytes || (result.code !== null && result.backend !== 'typescript')) return result;
        } else if (addon && !jsxFile) {
          // Names outside ASCII: the decorators are lowered on the copy spelled in ASCII, the copy is compiled,
          // and the names are put back in the result. Not for JSX: the emitter writes escapes into the text of
          // an element, and an escape next to a spelled word reads as one word with it.
          let copy = asciiSpelling(bytes, text);
          // The lowering derives a second name from a class's name. A word of that spelling in the source
          // could not be told from it when the names are put back.
          if (copy !== null) {
            const spelled = new Set(copy.spellings.values());
            for (const spelling of spelled) if (copy.plain.has(spelling + '_1') || spelled.has(spelling + '_1')) { copy = null; break; }
          }
          const lowered = copy !== null && copy.wellFormed ? lower(copy.renamed) : null;
          if (lowered !== null && lowered === copy.renamed) {
            return compile(bytes, { ...options, experimentalDecorators: false, emitDecoratorMetadata: false });
          }
          if (lowered !== null) {
            const result = compile(lowered, { ...options, experimentalDecorators: false, emitDecoratorMetadata: false });
            if (result.code !== null && result.backend === 'pulse' && !/[^\x00-\x7f]/.test(result.code)) {
              return { ...result, code: restoreNames(result.code, copy.spellings, true) };
            }
          }
        }
      }
      // With a map: the rewritten text is compiled with a map of its own, which is led on to the source. Text
      // that the rewriting wrote is marked as generated.
      if (sourceMap && mode === 'transform' && format !== 'cjs' && target === 'esnext' && jsx !== 'preserve') {
        const bytes = Buffer.from(text);
        const addon = bytes.length <= 1048576 ? loadModuleAddon() : null;
        const spans = [];
        const rewritten = addon ? require('./compiler-legacy-decorators.cjs').lowerLegacyDecorators(addon, bytes, emitDecoratorMetadata, jsxFile, spans) : null;
        if (rewritten === bytes) return compile(bytes, { ...options, experimentalDecorators: false, emitDecoratorMetadata: false });
        if (rewritten !== null) {
          const result = compile(rewritten, { ...options, experimentalDecorators: false, emitDecoratorMetadata: false });
          if (result.code !== null && result.backend === 'pulse' && result.sourceMap) {
            const mappings = require('./compiler-legacy-maps.cjs').composeLegacyMappings(bytes, rewritten, spans, result.sourceMap.mappings, result.code);
            if (mappings !== null) return { ...result, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, mappings, text) };
          }
        }
      }
      return transformCompatibility(text, { file, target, outputModule: format, jsx, sourceMap, experimentalDecorators, emitDecoratorMetadata });
    }
  }
  // TypeScript drops a byte order mark, and the rest compiles as the same source without one. A result with
  // diagnostics or from TypeScript itself is produced again from the unchanged input, so that positions hold.
  if (!sourceMap && mode === 'transform' && typed) {
    const marked = Buffer.isBuffer(input) ? input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf :
      typeof input === 'string' && input.charCodeAt(0) === 0xfeff;
    // A hashbang behind the mark is not at the start of the file, and TypeScript reports it.
    const hashbang = marked && (Buffer.isBuffer(input) ? input[3] === 0x23 && input[4] === 0x21 : input.startsWith('#!', 1));
    if (marked && !hashbang) {
      const result = compile(Buffer.isBuffer(input) ? input.subarray(3) : input.slice(1), options);
      if (result.code !== null && result.backend !== 'typescript') return result;
    }
  }
  if (sourceMap && (typed || (jsxFile && jsx === 'preserve')) && target === 'esnext' && format !== 'cjs') {
    const mapper = loadModuleAddon();
    if (jsx === 'preserve' && jsxFile && !file.includes('\\')) {
      const stable = snapshot(input);
      const source = Buffer.isBuffer(stable) ? stable : typeof stable === 'string' && stable.isWellFormed() ? Buffer.from(stable) : null;
      if (mapper && source !== null && source[0] !== 0xEF && (validUtf8 ??= require('node:buffer').isUtf8)(source) &&
          loadDirectAddon()?.leadingTripleSlash(source) === 0) {
        if (source.includes('<')) {
          const kept = mapper.lower(source, true, typed, 2, true);
          if (kept !== null && typeof kept !== 'string') {
            const mappings = mapper.projectionMappings?.(source, Buffer.from(kept.code));
            if (typeof mappings === 'string') {
              return { backend: 'pulse', code: kept.code, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, mappings, source.toString(), true), diagnostics: [] };
            }
          }
        } else if (typed) {
          const result = require('./compiler-maps.cjs').mappedTypeScript(source, file, (format === 'esm' ? 2 : 0) | 1, mapper);
          if (result !== undefined) {
            return { ...result, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, result.sourceMap.mappings, result.sourceMap.sourcesContent[0], true) };
          }
        } else {
          const mapped = mappedJavaScript(typeof stable === 'string' ? stable : source.toString(), file, format);
          if (mapped !== null) {
            return { ...mapped, sourceMap: require('./compiler-maps.cjs').sourceMapObject(file, mapped.sourceMap.mappings, mapped.sourceMap.sourcesContent[0], true) };
          }
        }
      }
    } else if (jsx !== 'preserve') {
      // The entry calls the same function, so both callers publish the same result.
      const result = mapper ? require('./compiler-maps.cjs').mappedTypeScript(input, file,
        (format === 'esm' ? 2 : 0) | (jsxFile ? 1 : 0) | (jsxFile && jsx === 'classic' ? 4 : 0), mapper) : undefined;
      if (result !== undefined) return result;
      const script = mappedScript(input, options);
      if (script !== undefined) return script;
      if (mapper && !jsxFile && !file.includes('\\')) {
        const stable = snapshot(input);
        const source = Buffer.isBuffer(stable) ? stable : typeof stable === 'string' && stable.isWellFormed() ? Buffer.from(stable) : null;
        if (source !== null && source.length <= 1048576 && source[0] !== 0xEF && (validUtf8 ??= require('node:buffer').isUtf8)(source) &&
            loadDirectAddon()?.leadingTripleSlash(source) === 0) {
          const named = highByteNames(mapper, source, typeof stable === 'string' ? stable : source.toString(), file, format, true);
          if (named !== null) return named;
          const plainJs = validJavaScriptTsModule(mapper, source, typeof stable === 'string' ? stable : source.toString(), file, format, false, true);
          if (plainJs !== null) return plainJs;
        }
      }
    }
  }
  let direct;
  if (typed && !jsxFile && target === 'esnext' && format !== 'cjs' && !sourceMap &&
      Buffer.isBuffer(input) && input.length > 0 && input.length <= 512) {
    direct = loadDirectAddon()?.compileAscii?.(input);
    if (typeof direct === 'string') return { backend: 'pulse', code: direct, sourceMap: null, diagnostics: [] };
  }
  const stableInput = snapshot(input);
  if ((typed || jsxFile) && target === 'esnext' && format !== 'cjs' && !sourceMap) {
    const source = Buffer.isBuffer(stableInput) ? stableInput :
      typeof stableInput === 'string' && stableInput.isWellFormed() ? Buffer.from(stableInput) : null;
    // The direct grammar starts at an export after trivia. Imports and interfaces cannot use it.
    const skipsDirectAddon = typed && mode === 'transform' && source?.[0] === 105;
    const native = source && !skipsDirectAddon ? loadDirectAddon() : null;
    const wellFormed = source && (skipsDirectAddon || native) && (validUtf8 ??= require('node:buffer').isUtf8)(source);
    // 0 without a leading triple-slash comment, 1 for notes and well-formed references, 2 for anything else.
    const slashes = wellFormed && !skipsDirectAddon && mode !== 'strip' ? native.leadingTripleSlash(source) : 0;
    // A file of comments and white space alone is a script with nothing in it. TypeScript writes the strict
    // directive in front of its text.
    if (wellFormed && slashes !== 2 && typed && mode === 'transform' && format === 'preserve' &&
        source[0] !== 0x23 && source[0] !== 0xef && source.length <= 1048576 && loadModuleAddon()?.triviaOnly?.(source) === true) {
      return { backend: 'pulse', code: '"use strict";\n' + source.toString(), sourceMap: null, diagnostics: [] };
    }
    if (wellFormed && slashes !== 2) {
      // Behind a well-formed directive only the module emitters run. They keep it as a comment.
      // TypeScript reports a malformed one, so that case skips the native routes.
      const directive = slashes === 1;
      const simple = native && !directive && typed && !jsxFile && direct !== null ? native.compile(source) : null;
      if (simple !== null) return { backend: 'pulse', code: simple, sourceMap: null, diagnostics: [] };
      // Whole-source scans are deferred. The native emitters find enum declarations themselves.
      let scanned;
      const runtime = () => scanned ??= mode === 'transform' && (jsxFile ? jsx !== 'preserve' &&
        // A source with @jsx text is native only for one import-source pragma, which the addon recognizes.
        // TypeScript test-harness directive comments (`// @jsx: ...`, `// @jsxFactory: ...`) use `:` and are not pragmas.
        (!source.includes('@') || !/@jsx(?:[ \t]+|Frag[ \t]+|ImportSource[ \t]+|Runtime[ \t]+|$)/i.test(source.toString('latin1')) ||
          loadModuleAddon()?.jsxPragmaSupported?.(source, jsx === 'classic') === true) && !source.includes('_tmt') :
        typed && source.includes('enum') && /\benum\b/.test(typeof stableInput === 'string' ? stableInput : source.toString()));
      // The single-declaration emitter accepts a TypeScript file only when it starts with an enum.
      if (mode === 'transform' && native && !directive && (jsxFile ? runtime() : typed)) {
        const code = native.lower(source, jsxFile, typed, jsx === 'classic', false);
        if (code !== null) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
      }
      if (mode === 'transform' && (typed || runtime() || (jsxFile && jsx === 'preserve'))) {
        const addon = loadModuleAddon();
        if (addon) {
          // JSX that is to be kept: the module emitter erases the types (for .tsx) and copies each element as written.
          if (jsxFile && jsx === 'preserve' && !directive && source.includes('<')) {
            const kept = addon.lower(source, true, typed, 2, true);
            if (kept !== null && typeof kept !== 'string') return { backend: 'pulse', code: kept.code, sourceMap: null, diagnostics: [] };
          }
          if (jsxFile && !typed && jsx === 'preserve' && !source.includes('<')) {
            const code = modernJavaScript(typeof stableInput === 'string' ? stableInput : source.toString(), file, format);
            if (code !== null) return { backend: 'javascript', code, sourceMap: null, diagnostics: [] };
          }
          const moduleProjection = typed && (!jsxFile || !source.includes('<'));
          const empty = moduleProjection ? addon.eraseTypeModule(source, format === 'esm') : null;
          if (empty !== null) return { backend: 'pulse', code: empty, sourceMap: null, diagnostics: [] };
          const annotated = moduleProjection ?
            addon.emitAnnotatedModule(source, jsxFile ? runtime() : undefined, format === 'esm', format === 'preserve' && !jsxFile) : null;
          if (typeof annotated === 'string') {
            return { backend: 'pulse', code: annotated, sourceMap: null, diagnostics: [] };
          }
          if (typeof annotated?.script === 'string') {
            const code = strictScript(annotated.script, file, directive);
            if (code !== null) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
          }
          if (!directive && annotated?.reference === true) {
            const text = typeof stableInput === 'string' ? stableInput : source.toString();
            const plainJs = typed && !jsxFile ? validJavaScriptTsModule(addon, source, text, file, format, directive, false) : null;
            if (plainJs) return plainJs;
            return transformCompatibility(text, { file, target, outputModule: format, jsx, sourceMap });
          }
          if (!directive && annotated?.code !== undefined) {
            const result = eraseLoweredModule(addon, annotated.code, file, format);
            if (result) return result;
          }
          // A unicode escape could spell a helper name without the text _tmt: only the escapes of its letters
          // and the braced form, which can pad them, keep a JSX file off this route.
          if (runtime() && (!jsxFile || !source.includes('\\u') || !/\\u(?:\{|00(?:5f|74|6d))/i.test(source.toString('latin1')))) {
            const mixed = addon.lower(source, jsxFile, typed, jsx === 'classic', true);
            if (mixed !== null) {
              if (typeof mixed !== 'string') {
                const backend = !typed && !source.includes('<') ? 'javascript' : 'pulse';
                return { backend, code: mixed.code, sourceMap: null, diagnostics: [] };
              }
              if (typed) {
                const result = eraseLoweredModule(addon, mixed, file, format, directive);
                if (result) return result;
              }
            }
          }
          if (typed && jsxFile && format === 'preserve' && jsx !== 'preserve' && (runtime() || jsx === 'automatic') &&
              (!source.includes('\\u') || !/\\u(?:\{|00(?:5f|74|6d))/i.test(source.toString('latin1')))) {
            const text = typeof stableInput === 'string' ? stableInput : source.toString();
            const tsLower = require('./compiler-ts-lower.cjs');
            const cjsPre = tsLower.preprocessPreserveCjs(text, true);
            if (cjsPre !== null) {
              const ambPre = tsLower.eraseValidatedAmbientBlocks(cjsPre.code, true);
              if (ambPre !== null) {
                const nsPre = /\b(?:namespace|module|enum)\b/.test(ambPre) ? tsLower.lowerNamespacesAndEnums(ambPre, true) : { code: ambPre, changed: false };
                let work = nsPre ? nsPre.code : ambPre;
                // Mask only leading/top-level line-comment TS harness directives (`// @jsx: ...`), never strings/templates.
                let maskedWork = work;
                if (/\/\/[ \t]*@jsx[A-Za-z]*[ \t]*:/i.test(work)) {
                  let out = '', at = 0;
                  while (at < work.length) {
                    const ch = work[at];
                    if (ch === '/' && work[at + 1] === '/') {
                      const nl = work.indexOf('\n', at + 2);
                      const end = nl < 0 ? work.length : nl;
                      out += work.slice(at, end).replace(/^(\/\/[ \t]*)@jsx([A-Za-z]*[ \t]*:)/i, '$1~jsx$2');
                      at = end;
                      continue;
                    }
                    if (ch === '/' && work[at + 1] === '*') {
                      const end = work.indexOf('*/', at + 2);
                      const next = end < 0 ? work.length : end + 2;
                      out += work.slice(at, next);
                      at = next;
                      continue;
                    }
                    if (ch === '"' || ch === "'" || ch === '`') {
                      let j = at + 1;
                      while (j < work.length && work[j] !== ch) {
                        if (work[j] === '\\') j += 2;
                        else j++;
                      }
                      const next = j < work.length ? j + 1 : work.length;
                      out += work.slice(at, next);
                      at = next;
                      continue;
                    }
                    out += ch;
                    at++;
                  }
                  maskedWork = out;
                }
                if (runtime() && (cjsPre.changed || ambPre !== text || (nsPre && nsPre.changed) || maskedWork !== work)) {
                  work = maskedWork;
                  // If erasing an ambient block exposed a leading string directive (e.g. "use client";),
                  // leave directive/helper-import placement to TypeScript.
                  const leadTrivia = /(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*/y;
                  leadTrivia.exec(work);
                  const leadChar = work[leadTrivia.lastIndex];
                  if (ambPre !== cjsPre.code && (leadChar === '"' || leadChar === "'")) {
                    // skip native .tsx pre-pass
                  } else {
                  const lowered = addon.lower(Buffer.from(work), true, true, jsx === 'classic', true);
                  if (lowered !== null) {
                    let result = typeof lowered !== 'string'
                      ? { backend: 'pulse', code: lowered.code, sourceMap: null, diagnostics: [] }
                      : eraseLoweredModule(addon, lowered, file, format, directive);
                    if (result && result.code !== null) {
                      const hadModBeforeAmb = ambPre !== cjsPre.code && tsLower.hasTopLevelModuleSyntax(cjsPre.code);
                      if (hadModBeforeAmb && !tsLower.hasTopLevelModuleSyntax(work)) {
                        const modCheck = strip(result.code + '\nexport {};', file);
                        if (modCheck.code === null || /(?:^|[;\r\n{])[ \t]*await[ \t]*;/.test(result.code)) result = null;
                      }
                      if (result && (cjsPre.hasCjsModule || hadModBeforeAmb) && result.code.startsWith('"use strict";\n') && !/^\s*["']use strict["']/.test(text)) {
                        result = { ...result, code: result.code.slice('"use strict";\n'.length) };
                      }
                      if (result) return result;
                    }
                  }
                  }
                }
                // Fallback JS JSX-to-automatic-runtime lowerer when the native C++ lowerer declines `.tsx`.
                if (jsx === 'automatic') {
                  const unmaskedWork = nsPre ? nsPre.code : ambPre;
                  const dupAmbientConst = !unmaskedWork.includes('@filename') &&
                    /\bdeclare[ \t]+(?:const|let|var|enum|class|function)[ \t]+([A-Za-z_$][\w$]*)\b[\s\S]*\b(?:const|let|var|enum|class|function)[ \t]+\1\b/.test(unmaskedWork);
                  let jsxLowered = dupAmbientConst ? null : require('./compiler-jsx-lower.cjs').lowerJsxToAutomatic(unmaskedWork);
                  if (jsxLowered !== null) {
                    if (/\b(?:module|namespace|enum)\b/.test(jsxLowered)) {
                      const nsPost = tsLower.lowerNamespacesAndEnums(jsxLowered);
                      if (nsPost !== null) jsxLowered = nsPost.code;
                    }
                    if (!hasEscapedKeyword(jsxLowered, false) && !hasTsRejectsInNodeStrip(jsxLowered)) {
                      const hadModBeforeAmb = ambPre !== cjsPre.code && tsLower.hasTopLevelModuleSyntax(cjsPre.code);
                      const isMod = cjsPre.hasCjsModule || tsLower.hasTopLevelModuleSyntax(jsxLowered);
                      if (hadModBeforeAmb && !isMod) {
                        const modStripped = strip(jsxLowered + '\nexport {};', file);
                        if (modStripped.code !== null && !/(?:^|[;\r\n{])[ \t]*await[ \t]*;/.test(modStripped.code) && modStripped.code.endsWith('\nexport {};')) {
                          return { ...modStripped, code: modStripped.code.slice(0, -'\nexport {};'.length) };
                        }
                      }
                      const jsRes = isMod
                        ? eraseModule(addon, jsxLowered, file, format, false)
                        : (!hadModBeforeAmb ? eraseScript(addon, jsxLowered, Buffer.from(jsxLowered), file, directive, true) : null);
                      if (jsRes && jsRes.code !== null && jsRes.backend !== 'node-transform') return jsRes;
                      const probe = strip(jsxLowered, file);
                      const msg = probe.diagnostics[0]?.message ?? '';
                      if (msg) {
                        const relaxed = tsLower.stripWithSwcRelaxations(jsxLowered, msg);
                        if (relaxed !== null) {
                          const workBuf = Buffer.from(relaxed);
                          if (hadModBeforeAmb && !isMod) {
                            const modCheck = strip(relaxed + '\nexport {};', file);
                            if (modCheck.code !== null && !/(?:^|[;\r\n{])[ \t]*await[ \t]*;/.test(relaxed)) return { backend: 'node-strip', code: relaxed, sourceMap: null, diagnostics: [] };
                          }
                          if (isMod) {
                            if (hasModuleMarker(addon, relaxed, workBuf) || tsLower.hasTopLevelModuleSyntax(relaxed)) {
                              const verified = verifyRuntimeExports({ backend: 'node-strip', code: relaxed, sourceMap: null, diagnostics: [] }, file, addon, workBuf);
                              if (verified.code !== null) return verified;
                            }
                          } else {
                            const code = sloppyStrictScript(relaxed, file, directive);
                            if (code !== null) return { backend: 'node-strip', code, sourceMap: null, diagnostics: [] };
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          if (typed && !jsxFile) {
            const text = typeof stableInput === 'string' ? stableInput : source.toString();
            const property = annotated?.parameterProperty === true;
            // Original fast paths first: strict eraseModule/eraseScript -> highByteNames (pulse) -> validJavaScriptTsModule (javascript)
            if (!directive) {
              const origResult = (property || annotated === true || addon.moduleMarker(source, true))
                ? eraseModule(addon, text, file, format, property)
                : (format === 'preserve' && !/\b(?:import|export)\b/.test(text) && addon.plainScript(source))
                  ? eraseScript(addon, text, source, file, false)
                  : null;
              if (origResult) return origResult;
              // Names outside ASCII: the certified parser reads a copy in which they are spelled in ASCII. The
              // copy also serves where the parser read the source but the emitter declined it for such a byte
              // (a namespace body is searched byte by byte).
              if (source.length <= 1048576) {
                const named = highByteNames(addon, source, text, file, format);
                if (named) return named;
              }
            }
            if (!property) {
              const plainJs = validJavaScriptTsModule(addon, source, text, file, format, directive, false);
              if (plainJs) return plainJs;
            }
            // Extended erasure and TS-to-JS lowering routes for remaining TypeScript files.
            const triedOrigMod = !directive && (property || annotated === true || addon.moduleMarker(source, true));
            const noBom = text.charCodeAt(0) === 0xFEFF && !text.startsWith('\uFEFF#!') ? text.slice(1) : text;
            const hasTsDirectiveComment = noBom.includes('// @') || noBom.includes('//@');
            const extMod = directive || hasTsDirectiveComment || noBom.includes('declare module') || noBom.includes('declare global') || /\bexport[ \t]+(?:default|declare)\b/.test(noBom);
            let result = (!triedOrigMod && extMod && !/[^\x00-\x7f]/.test(noBom) && /\b(?:import|export)\b/.test(noBom))
              ? eraseModule(addon, noBom, file, format, property) : null;
            if (!result && !triedOrigMod && !noBom.includes('\u00a0') && format === 'preserve') result = eraseScript(addon, noBom, Buffer.from(noBom), file, directive);
            if (result) return result;
            if (format === 'preserve' &&
                !hasEscapedKeyword(noBom, false) && !noBom.includes('\u00a0') &&
                (!/[^\x00-\x7f]/.test(noBom) || !/\bexport[ \t]+(?:(?:default|const|let|var|function|class|enum|namespace|module|async|abstract)[ \t]+)?[^\x00-\x7f]|\bexport[ \t]*\{[^}]*[^\x00-\x7f]/.test(noBom))) {
              const tsLower = require('./compiler-ts-lower.cjs');
              const decPre = tsLower.eraseNonEsDecorators(noBom);
              const cjsPre = decPre !== null ? tsLower.preprocessPreserveCjs(decPre.code) : null;
              if (cjsPre !== null) {
                const ambPre = tsLower.eraseValidatedAmbientBlocks(cjsPre.code);
                if (ambPre !== null && !hasTsRejectsInNodeStrip(ambPre)) {
                  const nsPre = tsLower.lowerNamespacesAndEnums(ambPre);
                  if (nsPre !== null) {
                    const ppPre = tsLower.lowerParameterProperties(nsPre.code);
                    if (ppPre !== null) {
                      let work = ppPre.code;
                      let changed = decPre.changed || cjsPre.changed || ambPre !== cjsPre.code || nsPre.changed || ppPre.changed;
                      const hadModBeforeAmb = ambPre !== cjsPre.code && tsLower.hasTopLevelModuleSyntax(cjsPre.code);
                      if (changed) {
                        const workBuf = Buffer.from(work);
                        const workDir = directive || (ambPre !== cjsPre.code && loadDirectAddon()?.leadingTripleSlash(workBuf) === 1);
                        const isMod = cjsPre.hasCjsModule || tsLower.hasTopLevelModuleSyntax(work);
                        if (hadModBeforeAmb && !isMod) {
                          const modStripped = strip(work + '\nexport {};', file);
                          if (modStripped.code !== null && !/(?:^|[;\r\n{])[ \t]*await[ \t]*;/.test(modStripped.code) && modStripped.code.endsWith('\nexport {};')) {
                            return { ...modStripped, code: modStripped.code.slice(0, -'\nexport {};'.length) };
                          }
                        }
                        const loweredRes = isMod
                          ? eraseModule(addon, work, file, format, property)
                          : (!hadModBeforeAmb ? eraseScript(addon, work, workBuf, file, workDir, true) : null);
                        if (loweredRes) return loweredRes;
                        if (cjsPre.hasCjsModule && !tsLower.hasTopLevelModuleSyntax(work)) {
                          const stripped = strip(work, file);
                          if (stripped.code !== null) return stripped;
                        }
                      }
                      const probe = strip(work, file);
                      if (probe.code !== null && !(hadModBeforeAmb && !tsLower.hasTopLevelModuleSyntax(work)) &&
                          probe.code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '').trim() === '' &&
                          (cjsPre.hasCjsModule || tsLower.hasTopLevelModuleSyntax(work))) {
                        return probe;
                      }
                      const msg = probe.diagnostics[0]?.message ?? '';
                      if (msg.includes('angle-bracket') && work.includes('<')) {
                        const ang = tsLower.eraseAngleBracketAssertions(work);
                        if (ang !== null) {
                          const angBuf = Buffer.from(ang);
                          const isMod = cjsPre.hasCjsModule || tsLower.hasTopLevelModuleSyntax(ang);
                          const angRes = isMod
                            ? eraseModule(addon, ang, file, format, property)
                            : (hadModBeforeAmb ? strip(ang, file) : eraseScript(addon, ang, angBuf, file, directive));
                          if (angRes && angRes.code !== null) return angRes;
                        }
                      } else if (msg) {
                        const relaxed = tsLower.stripWithSwcRelaxations(work, msg);
                        if (relaxed !== null) {
                          const workBuf = Buffer.from(relaxed);
                          const isMod = cjsPre.hasCjsModule || tsLower.hasTopLevelModuleSyntax(work);
                          if (hadModBeforeAmb && !isMod) {
                            const modCheck = strip(relaxed + '\nexport {};', file);
                            if (modCheck.code !== null && !/(?:^|[;\r\n{])[ \t]*await[ \t]*;/.test(relaxed)) return { backend: 'node-strip', code: relaxed, sourceMap: null, diagnostics: [] };
                          }
                          if (isMod) {
                            const isEmptyMod = relaxed.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '').trim() === '';
                            if (isEmptyMod) return { backend: 'node-strip', code: relaxed, sourceMap: null, diagnostics: [] };
                            if (!/(?:^|[;\r\n{])[ \t]*await[ \t]*;/.test(work) && (hasModuleMarker(addon, relaxed, workBuf) || tsLower.hasTopLevelModuleSyntax(relaxed))) {
                              const verified = verifyRuntimeExports({ backend: 'node-strip', code: relaxed, sourceMap: null, diagnostics: [] }, file, addon, workBuf);
                              if (verified.code !== null) return verified;
                            }
                          } else {
                            const effDir = directive || (relaxed.includes('///') && loadDirectAddon()?.leadingTripleSlash(workBuf) === 1);
                            const code = sloppyStrictScript(relaxed, file, effDir);
                            if (code !== null) return { backend: 'node-strip', code, sourceMap: null, diagnostics: [] };
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else if (wellFormed && slashes === 2 && typed && !jsxFile && mode === 'transform') {
      const addon = loadModuleAddon();
      if (addon) {
        const text = typeof stableInput === 'string' ? stableInput : source.toString();
        if (!/\/\/\/[ \t\f\v]*</.test(source.latin1Slice())) {
          const plainJs = validJavaScriptTsModule(addon, source, text, file, format, false, false);
          if (plainJs) return plainJs;
        }
        // Leading triple-slash comments like `/// <amd-dependency .../>`, `/// <amd-module .../>` (in preserve mode),
        // or `/// <reference lib="..." preserve="true" />` that are well-formed closed tags.
        if ((format === 'preserve' || !/\/\/\/[ \t\f\v]*<amd-module\b/i.test(text)) &&
            !/\/\/\/[ \t\f\v]*<reference\b(?![ \t]+(?:path|types|lib|no-default-lib)[ \t]*=(?:"[^"\r\n]*"|'[^'\r\n]*')(?:[ \t]+[a-z-]+[ \t]*=(?:"[^"\r\n]*"|'[^'\r\n]*'))*[ \t]*\/>)/.test(text)) {
          let result = /\b(?:import|export)\b/.test(text) ? eraseModule(addon, text, file, format, false) : null;
          if (!result && format === 'preserve') result = eraseScript(addon, text, source, file, true, true);
          if (result) return result;
          if (format === 'preserve' && !hasEscapedKeyword(text, false) && /\b(?:namespace|module|enum|require|export|constructor)\b/.test(text)) {
            const tsLower = require('./compiler-ts-lower.cjs');
            const cjsPre = tsLower.preprocessPreserveCjs(text);
            if (cjsPre !== null && !hasTsRejectsInNodeStrip(cjsPre.code)) {
              const ambPre = tsLower.eraseValidatedAmbientBlocks(cjsPre.code);
              if (ambPre !== null) {
                const nsPre = tsLower.lowerNamespacesAndEnums(ambPre);
                if (nsPre !== null) {
                  const ppPre = tsLower.lowerParameterProperties(nsPre.code);
                  if (ppPre !== null && (cjsPre.changed || ambPre !== text || nsPre.changed || ppPre.changed)) {
                    const work = ppPre.code;
                    const hadModBeforeAmb = ambPre !== cjsPre.code && tsLower.hasTopLevelModuleSyntax(cjsPre.code);
                    const isMod = cjsPre.hasCjsModule || tsLower.hasTopLevelModuleSyntax(work);
                    if (hadModBeforeAmb && !isMod) {
                      const modStripped = strip(work + '\nexport {};', file);
                      if (modStripped.code !== null && !/(?:^|[;\r\n{])[ \t]*await[ \t]*;/.test(modStripped.code) && modStripped.code.endsWith('\nexport {};')) {
                        return { ...modStripped, code: modStripped.code.slice(0, -'\nexport {};'.length) };
                      }
                    }
                    const loweredRes = isMod
                      ? eraseModule(addon, work, file, format, false)
                      : (!hadModBeforeAmb ? eraseScript(addon, work, Buffer.from(work), file, true, true) : null);
                    if (loweredRes) return loweredRes;
                    if (cjsPre.hasCjsModule && !tsLower.hasTopLevelModuleSyntax(work)) {
                      const stripped = strip(work, file);
                      if (stripped.code !== null) return stripped;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  const source = compilerSource(stableInput);
  if (source === null) return inputError(file, 'INVALID_ENCODING', 'Expected well-formed UTF-8');
  if (mode === 'strip') return strip(source, file);
  if (target === 'esnext' && format !== 'cjs' && !sourceMap && /\.m?js$/i.test(file)) {
    const code = modernJavaScript(source, file, format);
    if (code !== null) return { backend: 'javascript', code, sourceMap: null, diagnostics: [] };
  }
  if (target === 'esnext' && format !== 'cjs' && sourceMap && /\.m?js$/i.test(file) && !file.includes('\\')) {
    const mapped = mappedJavaScript(source, file, format);
    if (mapped !== null) return mapped;
  }
  return transformCompatibility(source, { file, target, outputModule: format, jsx, sourceMap });
}

// JavaScript that is published as written, possibly behind a strict directive, with a map that leads every
// token to itself. The lines in front of the source text move the map down.
function mappedJavaScript(source, file, format) {
  if (source.charCodeAt(0) === 0xFEFF || source.startsWith('#!')) return null;
  const code = modernJavaScript(source, file, format);
  if (code === null || !code.endsWith(source)) return null;
  const head = code.slice(0, code.length - source.length);
  if (head !== '' && !head.endsWith('\n')) return null;
  const bytes = Buffer.from(source);
  const addon = bytes.length <= 1048576 ? loadModuleAddon() : null;
  const mappings = addon?.projectionMappings?.(bytes, bytes);
  if (typeof mappings !== 'string') return null;
  const name = file.slice(file.lastIndexOf('/') + 1);
  return { backend: 'javascript', code, diagnostics: [], sourceMap: { version: 3, file: name, sourceRoot: '', sources: [name], names: [],
    mappings: ';'.repeat(head.split('\n').length - 1) + mappings, sourcesContent: [source] } };
}

// Strip mode keeps every position of its input, the carriage return included.
exports.compile = (input, options) => options?.mode === 'strip' ? compile(input, options) : unixHashbang(compile(input, options));
exports.unixHashbang = unixHashbang;
