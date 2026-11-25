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
function highByteNames(addon, source, text, file, format) {
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
    if (!mixed) plain.add(word);
    else {
      let spelling = spellings.get(word);
      if (spelling === undefined) {
        spelling = '';
        for (let index = at; index < end; index++) {
          spelling += source[index] >= 128 ? String.fromCharCode(65 + source[index] % 26) : String.fromCharCode(source[index]);
        }
        if (taken.has(spelling)) return null;
        taken.add(spelling);
        spellings.set(word, spelling);
        if (wellFormed && !identifierWord.test(source.utf8Slice(at, end))) wellFormed = false;
      }
      renamed.latin1Write(spelling, at);
    }
    at = end;
  }
  for (const spelling of taken) if (plain.has(spelling)) return null;
  const emitted = addon.emitAnnotatedModule(renamed, undefined, format === 'esm', false);
  if (emitted === null) return null;
  if (typeof emitted === 'string' && wellFormed && emitted.length === renamed.length) {
    const restored = Buffer.from(emitted, 'latin1');
    let erasureOnly = true;
    for (let at = 0; at < restored.length && erasureOnly; at++) {
      if (restored[at] === renamed[at]) { if (source[at] >= 128) restored[at] = source[at]; }
      else if (restored[at] !== 32) erasureOnly = false;
    }
    if (erasureOnly) return { backend: 'pulse', code: restored.toString(), sourceMap: null, diagnostics: [] };
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
    if (error.code !== 'ERR_INVALID_TYPESCRIPT_SYNTAX' && error.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw error;
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

// wellFormedDirectives: the caller has seen that leading triple-slash comments are notes or well-formed
// references. TypeScript writes the strict directive in front of them as in front of any comment.
function strictScript(source, file, wellFormedDirectives = false) {
  if (source.includes('<!--') || (source.includes('-->') && /(?:^|\*\/)[^\S\r\n\u2028\u2029]*-->/m.test(source))) return null;
  // The interpreter line ends with its whole line break, so that a carriage return does not stay on it.
  const hashbang = source.startsWith('#!') ? (match => match === null ? source.length : match.index + match[0].length)(/\r\n|[\r\n\u2028\u2029]/.exec(source)) : 0;
  const trivia = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/y;
  trivia.lastIndex = hashbang;
  trivia.exec(source);
  if (!wellFormedDirectives && source.slice(0, trivia.lastIndex).includes('///')) return null;
  const first = source[trivia.lastIndex];
  const directive = /(["'])use strict\1[ \t]*;/y;
  directive.lastIndex = trivia.lastIndex;
  const strict = directive.test(source);
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

function eraseScript(addon, source, bytes, file) {
  if (/\b(?:import|export)\b/.test(source) || !addon.plainScript(bytes)) return null;
  const result = strip(source, file);
  if (result.code === null || addon.triviaOnly(Buffer.from(result.code))) return null;
  const code = strictScript(result.code, file);
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

function eraseLoweredModule(addon, source, file, format) {
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
    code = strictScript(code, file);
    if (code === null) return null;
  }
  return verifyRuntimeExports({ ...result, code, backend: 'pulse+node-strip' }, file, addon);
}

function eraseModule(addon, source, file, format, parameterProperty) {
  const transformAllowed = () => !/\benum\b|\bnamespace\b(?![ \t]*:)/.test(source);
  const directTransform = parameterProperty && transformAllowed();
  let result = directTransform ? null : strip(source, file);
  const diagnostic = result?.diagnostics[0];
  if (directTransform || (diagnostic?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' &&
      /^(?:\s*x\s*)?TypeScript parameter property is not supported/.test(diagnostic.message) && transformAllowed())) {
    if (hasSplitDeclare(source)) return null;
    try {
      const code = require('node:module').stripTypeScriptTypes(source, { mode: 'transform' });
      result = { backend: 'node-transform', code, sourceMap: null, diagnostics: [] };
    } catch (error) {
      if (!['ERR_INVALID_ARG_VALUE', 'ERR_INVALID_TYPESCRIPT_SYNTAX', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'].includes(error.code)) throw error;
    }
  }
  if (result?.code == null) return null;
  const emitted = Buffer.from(result.code);
  if (hasModuleMarker(addon, result.code, emitted)) return verifyRuntimeExports(result, file, addon, emitted);
  if (!addon.triviaOnly(emitted)) return null;
  if (format === 'esm') result.code += '\nexport {};\n';
  return result;
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

function compile(input, options = {}) {
  const { file = 'input.ts', mode = 'transform', target = 'esnext', module = 'preserve', jsx = 'automatic',
    sourceMap = false, experimentalDecorators = false, emitDecoratorMetadata = false } = options;
  if (typeof file !== 'string' || !extensions.test(file)) throw new TypeError('Expected a JS, TS, JSX or TSX filename');
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
  // Decorators of TypeScript's earlier design are lowered to helper calls. A source without an at sign holds
  // none, and compiles as without the option; any other is lowered by TypeScript.
  if (experimentalDecorators && typed) {
    const text = compilerSource(snapshot(input));
    if (text === null) return inputError(file, 'INVALID_ENCODING', 'Expected well-formed UTF-8');
    if (text.includes('@')) {
      // Without metadata and without a map the decorators are lowered here: the source is rewritten into
      // TypeScript without decorators, which the ordinary routes compile.
      if (!sourceMap && mode === 'transform' && !jsxFile && format !== 'cjs' && target === 'esnext') {
        const bytes = Buffer.from(text);
        const addon = bytes.length <= 1048576 ? loadModuleAddon() : null;
        const rewritten = addon ? require('./compiler-legacy-decorators.cjs').lowerLegacyDecorators(addon, bytes, emitDecoratorMetadata) : null;
        if (rewritten !== null) {
          const result = compile(rewritten, { ...options, experimentalDecorators: false, emitDecoratorMetadata: false });
          if (rewritten === bytes || (result.code !== null && result.backend !== 'typescript')) return result;
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
  if (sourceMap && typed && jsx !== 'preserve' && target === 'esnext' && format !== 'cjs') {
    // The entry calls the same function, so both callers publish the same result.
    const mapper = loadModuleAddon();
    const result = mapper ? require('./compiler-maps.cjs').mappedTypeScript(input, file,
      (format === 'esm' ? 2 : 0) | (jsxFile ? 1 : 0) | (jsxFile && jsx === 'classic' ? 4 : 0), mapper) : undefined;
    if (result !== undefined) return result;
    const script = mappedScript(input, options);
    if (script !== undefined) return script;
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
        (!source.includes('@') || !/@jsx/i.test(source.toString('latin1')) ||
          loadModuleAddon()?.jsxPragmaSupported?.(source, jsx === 'classic') === true) && !source.includes('_tmt') :
        typed && source.includes('enum') && /\benum\b/.test(typeof stableInput === 'string' ? stableInput : source.toString()));
      // The single-declaration emitter accepts a TypeScript file only when it starts with an enum.
      if (mode === 'transform' && native && !directive && (jsxFile ? runtime() : typed)) {
        const code = native.lower(source, jsxFile, typed, jsx === 'classic', false);
        if (code !== null) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
      }
      if (mode === 'transform' && (typed || runtime())) {
        const addon = loadModuleAddon();
        if (addon) {
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
              if (typed && !directive) {
                const result = eraseLoweredModule(addon, mixed, file, format);
                if (result) return result;
              }
            }
          }
          if (typed && !jsxFile && !directive) {
            const text = typeof stableInput === 'string' ? stableInput : source.toString();
            const property = annotated?.parameterProperty === true;
            const result = (property || annotated === true || addon.moduleMarker(source, true)) ? eraseModule(addon, text, file, format, property) :
              format === 'preserve' ? eraseScript(addon, text, source, file) : null;
            if (result) return result;
            // Names outside ASCII: the certified parser reads a copy in which they are spelled in ASCII.
            if (annotated === null && source.length <= 1048576) {
              const named = highByteNames(addon, source, text, file, format);
              if (named) return named;
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
  return transformCompatibility(source, { file, target, outputModule: format, jsx, sourceMap });
}

// Strip mode keeps every position of its input, the carriage return included.
exports.compile = (input, options) => options?.mode === 'strip' ? compile(input, options) : unixHashbang(compile(input, options));
exports.unixHashbang = unixHashbang;
