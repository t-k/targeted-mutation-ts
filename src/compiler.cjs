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
let fastEmit;
let fastEmitTs;
let fastEmitTsx;
let fastEmitLoaded = false;

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

let routes;
let maps;
function compile(input, options) {
  let file = 'input.ts';
  let flags = 0;
  let defaults = options === undefined;
  if (!defaults && options !== null && typeof options === 'object') {
    if ((options.mode === undefined || options.mode === 'transform') &&
        (options.target === undefined || options.target === 'esnext') &&
        (options.module === undefined || options.module === 'preserve') &&
        (options.sourceMap === undefined || options.sourceMap === false) &&
        options.experimentalDecorators === undefined && options.emitDecoratorMetadata === undefined) {
      const name = options.file;
      const jsx = options.jsx;
      if ((name === undefined || typeof name === 'string') && (jsx === undefined || jsx === 'automatic' || jsx === 'classic')) {
        defaults = true;
        if (name !== undefined) file = name;
        if (jsx === 'classic') flags = classic;
      }
    } else {
      // Spelled-out options are rarer. Their handling lives in a file that a default compile never loads.
      const result = (maps ??= require('./compiler-maps.cjs')).compileExplicit(input, options, compile, sourceKind,
        () => pulse ??= nativeAddon('compiler-module.node'));
      if (result === null) {
        return (routes ??= require('./compiler-routes.cjs').compile)(input, options, true);
      }
      if (result !== undefined) {
        return options.mode !== 'strip' && typeof result.code === 'string' && result.code.charCodeAt(0) === 35 ?
          require('./compiler-routes.cjs').unixHashbang(result) : result;
      }
    }
  }
  if (defaults) {
    const kind = sourceKind(file);
    if (kind >= script) {
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
      if (kind === esm || kind === 0 || (kind === tsx && flags === 0)) {
        if (!fastEmitLoaded) {
          const js = v8 ??= nativeAddon('compiler-js.node');
          fastEmit = js.emitFastModule;
          fastEmitTs = js.emitFastTs;
          fastEmitTsx = js.emitFastTsx;
          fastEmitLoaded = true;
        }
        if (kind === esm) {
          if (fastEmit !== undefined) {
            const code = fastEmit(input);
            if (code !== undefined) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
          }
        } else if (kind === tsx) {
          if (fastEmitTsx !== undefined) {
            const code = fastEmitTsx(input);
            if (code !== undefined) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
          }
        } else if (fastEmitTs !== undefined) {
          const code = fastEmitTs(input);
          if (code !== undefined) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
        }
      }
      const source = Buffer.isBuffer(input) || typeof input === 'string' ? input : null;
      const emit = source === null ? undefined : (pulse ??= nativeAddon('compiler-module.node')).emitTypeScript;
      if (emit !== undefined) {
        const code = emit(source, kind | flags);
        if (typeof code === 'string') {
          const result = { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
          // An interpreter line is rare; its line break is normalized where the other routes live.
          return code.charCodeAt(0) === 35 ? require('./compiler-routes.cjs').unixHashbang(result) : result;
        }
        if (code === null) {
          return (routes ??= require('./compiler-routes.cjs').compile)(input, options, true);
        }
      }
    }
  }
  return (routes ??= require('./compiler-routes.cjs').compile)(input, options);
}

function emitDeclaration(input, options) {
  return require('./compiler-dts.cjs').emitDeclaration(input, options);
}

exports.compile = compile;
exports.emitDeclaration = emitDeclaration;
