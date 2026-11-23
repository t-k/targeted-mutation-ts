'use strict';

// Loading and first execution of JavaScript dominate a cold compile, so the default TypeScript and
// JavaScript routes are one native call each. Every other option, input and outcome takes the
// complete router, which decides each case again from the start.
const unavailable = {};
function nativeAddon(name) {
  try {
    const addon = { exports: {} };
    process.dlopen(addon, __dirname + '/../build/' + name);
    return addon.exports;
  } catch {
    // The router reports a missing or incompatible addon.
    return unavailable;
  }
}

let pulse;
let v8;

const tsx = 1;
const esm = 2;
const classic = 4;
const script = 8;

// Returns the native flags for .ts, .mts, .tsx, .js and .mjs names, and -1 for declarations and
// other dialects. JavaScript names carry the script bit, and .mjs also the module bit.
function sourceKind(file) {
  const size = file.length;
  if (size < 3) return -1;
  const last = file.charCodeAt(size - 1) | 32;
  const middle = file.charCodeAt(size - 2) | 32;
  // Folding case would also map the control character 0x0e to a dot, so the dot is compared as is.
  const third = file.charCodeAt(size - 3);
  const first = third | 32;
  if (third === 46 && last === 115) {
    if (middle === 106) return script;
    if (middle !== 116) return -1;
    return size >= 5 && file.charCodeAt(size - 5) === 46 && (file.charCodeAt(size - 4) | 32) === 100 ? -1 : 0;
  }
  if (size < 4 || file.charCodeAt(size - 4) !== 46) return -1;
  if (first === 116 && middle === 115 && last === 120) return tsx;
  if (first === 109 && last === 115) {
    if (middle === 106) return script | esm;
    if (middle !== 116) return -1;
    return size >= 6 && file.charCodeAt(size - 6) === 46 && (file.charCodeAt(size - 5) | 32) === 100 ? -1 : esm;
  }
  return -1;
}

// A type-erased output keeps every byte position, so its map comes from one native scan.
// Lowered output, a byte order mark and unusual names take the router, which asks TypeScript.
function mappedTypeScript(input, file, flags) {
  const slash = file.lastIndexOf('/');
  const name = slash < 0 ? file : file.slice(slash + 1);
  if (!name.endsWith('.mts') && !name.endsWith('.ts') && !name.endsWith('.tsx') || name.includes('\\')) return undefined;
  const text = typeof input === 'string' ? input : Buffer.isBuffer(input) ? undefined : null;
  if (text === null || text !== undefined && (!text.isWellFormed() || text.charCodeAt(0) === 0xFEFF)) return undefined;
  const source = text === undefined ? input : Buffer.from(text);
  if (source[0] === 0xEF) return undefined;
  const emit = (pulse ??= nativeAddon('compiler-module.node')).emitTypeScript;
  const result = emit === undefined ? undefined : emit(source, flags | 16);
  if (result === undefined) return undefined;
  return { backend: 'pulse', code: result[0], sourceMap: sourceMapObject(file, result[1], text ?? source.toString()), diagnostics: [] };
}

// The fields other than the mappings follow the map TypeScript writes for the same name.
function sourceMapObject(file, mappings, text) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const module = name.endsWith('.mts');
  const width = module || name.endsWith('.tsx') ? 4 : 3;
  return { version: 3, file: name.slice(0, -width) + (module ? '.mjs' : '.js'), sourceRoot: '', sources: [name], names: [],
    mappings, sourcesContent: [text] };
}

let routes;
function compile(input, options) {
  let file = 'input.ts';
  let flags = 0;
  let defaults = options === undefined;
  let explicitModule = false;
  let mapped = false;
  // An option spelled out with its default value selects the same route as an omitted one.
  if (!defaults && options !== null && typeof options === 'object' &&
      (options.mode === undefined || options.mode === 'transform') &&
      (options.target === undefined || options.target === 'esnext') &&
      (options.sourceMap === undefined || typeof options.sourceMap === 'boolean')) {
    const name = options.file;
    const jsx = options.jsx;
    const format = options.module;
    if ((name === undefined || typeof name === 'string') && (jsx === undefined || jsx === 'automatic' || jsx === 'classic') &&
        (format === undefined || format === 'preserve' || format === 'esm')) {
      defaults = true;
      if (name !== undefined) file = name;
      if (jsx === 'classic') flags = classic;
      if (format === 'esm') explicitModule = true;
      if (options.sourceMap === true) mapped = true;
    }
  }
  if (defaults) {
    const kind = sourceKind(file);
    if (mapped) {
      const result = kind >= 0 && kind < script ? mappedTypeScript(input, file, kind | flags | (explicitModule ? esm : 0)) : undefined;
      if (result !== undefined) return result;
    } else if (kind === script && explicitModule) {
      // An explicit module format for a .js name disables the script route, which the router decides.
    } else if (kind >= script) {
      if (Buffer.isBuffer(input)) {
        // A module that the certified parse leaves unedited needs no second parse. V8 decides the rest.
        const module = (pulse ??= nativeAddon('compiler-module.node')).emitJavaScriptModule;
        let code = module === undefined ? undefined : module(input, kind !== script);
        if (code === undefined) {
          const emit = (v8 ??= nativeAddon('compiler-js.node')).emitJavaScript;
          if (emit !== undefined) code = emit(input, kind >> 1 & 1);
        }
        if (code !== undefined) return { backend: 'javascript', code, sourceMap: null, diagnostics: [] };
      }
    } else if (kind >= 0) {
      const source = Buffer.isBuffer(input) ? input :
        typeof input === 'string' && input.isWellFormed() ? Buffer.from(input) : null;
      const emit = source === null ? undefined : (pulse ??= nativeAddon('compiler-module.node')).emitTypeScript;
      if (emit !== undefined) {
        const code = emit(source, kind | flags | (explicitModule ? esm : 0));
        if (code !== undefined) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
      }
    }
  }
  return (routes ??= require('./compiler-routes.cjs').compile)(input, options);
}

exports.compile = compile;
exports.mappedTypeScript = mappedTypeScript;
exports.sourceMapObject = sourceMapObject;
