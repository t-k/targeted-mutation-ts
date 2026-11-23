'use strict';

// Loading and first execution of JavaScript dominate a cold compile, so the default TypeScript route
// is one native call. Every other option, input and outcome takes the complete router, which
// decides each case again from the start.
let native;
function emitter() {
  if (native === undefined) {
    native = null;
    try {
      const addon = { exports: {} };
      process.dlopen(addon, __dirname + '/../build/compiler-module.node');
      if (typeof addon.exports.emitTypeScript === 'function') native = addon.exports.emitTypeScript;
    } catch {
      // The router reports a missing or incompatible addon.
    }
  }
  return native;
}

const tsx = 1;
const esm = 2;
const classic = 4;

// Returns the native flags for .ts, .mts and .tsx names, and -1 for declarations and other dialects.
function sourceKind(file) {
  const size = file.length;
  if (size < 3) return -1;
  const last = file.charCodeAt(size - 1) | 32;
  const middle = file.charCodeAt(size - 2) | 32;
  const first = file.charCodeAt(size - 3) | 32;
  if (first === 46 && middle === 116 && last === 115) {
    return size >= 5 && file.charCodeAt(size - 5) === 46 && (file.charCodeAt(size - 4) | 32) === 100 ? -1 : 0;
  }
  if (size < 4 || file.charCodeAt(size - 4) !== 46) return -1;
  if (first === 116 && middle === 115 && last === 120) return tsx;
  if (first === 109 && middle === 116 && last === 115) {
    return size >= 6 && file.charCodeAt(size - 6) === 46 && (file.charCodeAt(size - 5) | 32) === 100 ? -1 : esm;
  }
  return -1;
}

let routes;
function compile(input, options) {
  let file = 'input.ts';
  let flags = 0;
  let defaults = options === undefined;
  if (!defaults && options !== null && typeof options === 'object' && options.mode === undefined &&
      options.target === undefined && options.module === undefined && options.sourceMap === undefined) {
    const name = options.file;
    const jsx = options.jsx;
    if ((name === undefined || typeof name === 'string') && (jsx === undefined || jsx === 'automatic' || jsx === 'classic')) {
      defaults = true;
      if (name !== undefined) file = name;
      if (jsx === 'classic') flags = classic;
    }
  }
  if (defaults) {
    const kind = sourceKind(file);
    if (kind >= 0) {
      const source = Buffer.isBuffer(input) ? input :
        typeof input === 'string' && input.isWellFormed() ? Buffer.from(input) : null;
      const emit = source === null ? null : emitter();
      if (emit !== null) {
        const code = emit(source, kind | flags);
        if (code !== undefined) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
      }
    }
  }
  return (routes ??= require('./compiler-routes.cjs').compile)(input, options);
}

exports.compile = compile;
