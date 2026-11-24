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

function strip(source, file) {
  try {
    const code = require('node:module').stripTypeScriptTypes(source);
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

function strictScript(source, file) {
  if (source.includes('<!--') || (source.includes('-->') && /(?:^|\*\/)[^\S\r\n\u2028\u2029]*-->/m.test(source))) return null;
  const hashbang = source.startsWith('#!') ? source.search(/[\r\n]/) + 1 : 0;
  const trivia = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\/)*/y;
  trivia.lastIndex = hashbang;
  trivia.exec(source);
  if (source.slice(0, trivia.lastIndex).includes('///')) return null;
  const first = source[trivia.lastIndex];
  const directive = /(["'])use strict\1[ \t]*;/y;
  directive.lastIndex = trivia.lastIndex;
  const strict = directive.test(source);
  if ((first === '"' || first === "'") && !strict) return null;
  const code = strict ? source : source.slice(0, hashbang) + '"use strict";\n' + source.slice(hashbang);
  // Node can abort while decorating a syntax error from vm.Script. The addon asks V8 directly.
  const valid = javascriptValidators().validScript;
  if (valid) return valid(code) ? code : null;
  try {
    new (require('node:vm').Script)(code, { filename: file });
    return code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
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
      if (valid || moduleFile) return valid ? source : null;
    }
  }
  const addon = loadModuleAddon();
  if (!addon) return null;
  bytes ??= Buffer.from(source);
  if (moduleFile && addon.validModule) {
    return addon.validModule(bytes) ? source : null;
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
    sourceMap = false } = options;
  if (typeof file !== 'string' || !extensions.test(file)) throw new TypeError('Expected a JS, TS, JSX or TSX filename');
  if (!targets.has(target) || !modules.has(module) || !jsxModes.has(jsx) || typeof sourceMap !== 'boolean') {
    throw new TypeError('Invalid compiler target, module, JSX or source-map option');
  }
  if (mode !== 'transform' && mode !== 'strip') throw new TypeError('Expected transform or strip compilation mode');
  if (mode === 'strip' && (target !== 'esnext' || module !== 'preserve' || sourceMap || options.jsx !== undefined)) {
    throw new TypeError('strip mode only supports position-preserving type erasure');
  }
  if (declarations.test(file)) return inputError(file, 'DECLARATION_INPUT', 'A declaration file cannot emit JavaScript');
  if (mode === 'strip' && !/\.[cm]?ts$/i.test(file)) {
    return inputError(file, 'STRIP_DIALECT', 'strip mode requires a non-JSX TypeScript filename');
  }
  const format = outputFormat(file, module);
  const typed = /\.(?:m?ts|tsx)$/i.test(file);
  const jsxFile = /\.[jt]sx$/i.test(file);
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
    if (source && (skipsDirectAddon || native) && (validUtf8 ??= require('node:buffer').isUtf8)(source) &&
        (skipsDirectAddon || mode === 'strip' || !native.leadingTripleSlash(source))) {
      const simple = native && typed && !jsxFile && direct !== null ? native.compile(source) : null;
      if (simple !== null) return { backend: 'pulse', code: simple, sourceMap: null, diagnostics: [] };
      // Whole-source scans are deferred. The native emitters find enum declarations themselves.
      let scanned;
      const runtime = () => scanned ??= mode === 'transform' && (jsxFile ? jsx !== 'preserve' &&
        // A source with @jsx text is native only for one import-source pragma, which the addon recognizes.
        (!source.includes('@') || !/@jsx/i.test(source.toString('latin1')) ||
          loadModuleAddon()?.jsxPragmaSupported?.(source, jsx === 'classic') === true) && !source.includes('_tmt') :
        typed && source.includes('enum') && /\benum\b/.test(typeof stableInput === 'string' ? stableInput : source.toString()));
      // The single-declaration emitter accepts a TypeScript file only when it starts with an enum.
      if (mode === 'transform' && native && (jsxFile ? runtime() : typed)) {
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
            const code = strictScript(annotated.script, file);
            if (code !== null) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
          }
          if (annotated?.reference === true) {
            const text = typeof stableInput === 'string' ? stableInput : source.toString();
            return transformCompatibility(text, { file, target, outputModule: format, jsx, sourceMap });
          }
          if (annotated?.code !== undefined) {
            const result = eraseLoweredModule(addon, annotated.code, file, format);
            if (result) return result;
          }
          if (runtime() && (!jsxFile || !source.includes('\\u'))) {
            const mixed = addon.lower(source, jsxFile, typed, jsx === 'classic', true);
            if (mixed !== null) {
              if (typeof mixed !== 'string') {
                const backend = !typed && !source.includes('<') ? 'javascript' : 'pulse';
                return { backend, code: mixed.code, sourceMap: null, diagnostics: [] };
              }
              if (typed) {
                const result = eraseLoweredModule(addon, mixed, file, format);
                if (result) return result;
              }
            }
          }
          if (typed && !jsxFile) {
            const text = typeof stableInput === 'string' ? stableInput : source.toString();
            const property = annotated?.parameterProperty === true;
            const result = (property || annotated === true || addon.moduleMarker(source, true)) ? eraseModule(addon, text, file, format, property) :
              format === 'preserve' ? eraseScript(addon, text, source, file) : null;
            if (result) return result;
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

exports.compile = compile;
