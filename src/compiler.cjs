'use strict';

const { isUtf8 } = require('node:buffer');
const { types } = require('node:util');
function optionalAddon(specifier) {
  let filename;
  try {
    filename = require.resolve(specifier);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return null;
  }
  return require(filename);
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

function invalidModuleSyntax(ts, file, diagnostics) {
  return () => (tree) => {
    for (const statement of tree.statements) {
      const assignment = ts.isExportAssignment(statement) && statement.isExportEquals;
      const requireImport = ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly &&
        ts.isExternalModuleReference(statement.moduleReference);
      if (!assignment && !requireImport) continue;
      diagnostics.push({
        file, code: 'INCOMPATIBLE_MODULE_SYNTAX', severity: 'error',
        message: 'An ECMAScript module cannot emit a TypeScript import = require() or export = declaration',
        start: statement.getStart(tree), end: statement.end,
      });
    }
    return tree;
  };
}

function commonJsError(code, file) {
  try {
    require('node:vm').compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file });
    return null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { file, code: 'INVALID_COMMONJS_OUTPUT', severity: 'error', message: error.message, start: 0, end: 0 };
  }
}

function transform(source, { file, target, module, jsx, sourceMap }) {
  const ts = require('typescript');
  const outputModule = outputFormat(file, module);
  const extraDiagnostics = [];
  const compilerFile = file.replace(/\.[cm]([jt]s)$/i, '.$1');
  const result = ts.transpileModule(source, {
    fileName: compilerFile,
    reportDiagnostics: true,
    transformers: outputModule === 'esm' ? { before: [invalidModuleSyntax(ts, file, extraDiagnostics)] } : undefined,
    compilerOptions: {
      target: target === 'esnext' ? ts.ScriptTarget.ESNext : ts.ScriptTarget[target === 'es6' ? 'ES2015' : target.toUpperCase()],
      module: { preserve: ts.ModuleKind.Preserve, esm: ts.ModuleKind.ESNext, cjs: ts.ModuleKind.CommonJS }[outputModule],
      jsx: { automatic: ts.JsxEmit.ReactJSX, classic: ts.JsxEmit.React, preserve: ts.JsxEmit.Preserve }[jsx],
      verbatimModuleSyntax: true,
      sourceMap,
      inlineSources: sourceMap,
    },
  });
  const diagnostics = result.diagnostics.map(diagnostic => ({
    file,
    code: diagnostic.code,
    severity: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    start: diagnostic.start ?? 0,
    end: (diagnostic.start ?? 0) + (diagnostic.length ?? 0),
  }));
  diagnostics.push(...extraDiagnostics);
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) return fail('typescript', diagnostics);
  const map = result.sourceMapText ? JSON.parse(result.sourceMapText) : null;
  if (map) {
    const { basename } = require('node:path');
    map.sources = [basename(file)];
    map.file = basename(file).replace(extensions, jsx === 'preserve' && /x$/i.test(file) ? '.jsx' :
      outputModule === 'cjs' && /\.c[jt]s$/i.test(file) ? '.cjs' :
        /\.m[jt]s$/i.test(file) && outputModule !== 'cjs' ? '.mjs' : '.js');
  }
  const code = map ? result.outputText.replace(/\/\/# sourceMappingURL=[^\r\n]*$/, '') : result.outputText;
  if (outputModule === 'cjs' && !(jsx === 'preserve' && /x$/i.test(file))) {
    const error = commonJsError(code, file);
    if (error) return fail('typescript', [...diagnostics, error]);
  }
  const output = { backend: 'typescript', code, sourceMap: map, diagnostics };
  return outputModule === 'cjs' ? output : verifyRuntimeExports(output, file);
}

function strip(source, file) {
  try {
    return { backend: 'node-strip', code: require('node:module').stripTypeScriptTypes(source), sourceMap: null, diagnostics: [] };
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

function modernJavaScript(source, file, format) {
  const script = format === 'preserve' ? strictScript(source, file) : null;
  if (script !== null) return script;
  const addon = loadModuleAddon();
  if (!addon) return null;
  const bytes = Buffer.from(source);
  if (source.includes('///') && loadDirectAddon()?.leadingDirective(bytes) !== false) return null;
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

function eraseModule(addon, source, file, format) {
  let result = strip(source, file);
  const diagnostic = result.diagnostics[0];
  if (result.code === null && diagnostic?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' &&
      /^(?:\s*x\s*)?TypeScript parameter property is not supported/.test(diagnostic.message) &&
      !/\benum\b|\bnamespace\b(?![ \t]*:)/.test(source)) {
    try {
      const code = require('node:module').stripTypeScriptTypes(source, { mode: 'transform' });
      result = { backend: 'node-transform', code, sourceMap: null, diagnostics: [] };
    } catch (error) {
      if (!['ERR_INVALID_ARG_VALUE', 'ERR_INVALID_TYPESCRIPT_SYNTAX', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'].includes(error.code)) throw error;
    }
  }
  if (result.code === null) return null;
  const emitted = Buffer.from(result.code);
  if (hasModuleMarker(addon, result.code, emitted)) return verifyRuntimeExports(result, file, addon, emitted);
  if (!addon.triviaOnly(emitted)) return null;
  if (format === 'esm') result.code += '\nexport {};\n';
  return result;
}

function snapshot(input) {
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
  const stableInput = snapshot(input);
  const format = outputFormat(file, module);
  const typed = /\.(?:m?ts|tsx)$/i.test(file);
  const jsxFile = /\.[jt]sx$/i.test(file);
  if ((typed || jsxFile) && target === 'esnext' && format !== 'cjs' && !sourceMap) {
    const source = Buffer.isBuffer(stableInput) ? stableInput :
      typeof stableInput === 'string' && stableInput.isWellFormed() ? Buffer.from(stableInput) : null;
    // The direct grammar starts at an export after trivia. Imports and interfaces cannot use it.
    const skipsDirectAddon = typed && mode === 'transform' && source?.[0] === 105;
    const native = source && !skipsDirectAddon ? loadDirectAddon() : null;
    if (source && (skipsDirectAddon || native) && isUtf8(source) &&
        (skipsDirectAddon || mode === 'strip' || !source.includes('///') || !native.leadingDirective(source))) {
      const simple = native && typed && !jsxFile ? native.compile(source) : null;
      if (simple !== null) return { backend: 'pulse', code: simple, sourceMap: null, diagnostics: [] };
      const runtime = mode === 'transform' && (jsxFile ? jsx !== 'preserve' &&
        (!source.includes('@') || !/@jsx/i.test(source.toString('latin1'))) && !source.includes('_tmt') :
        typed && source.includes('enum') && /\benum\b/.test(typeof stableInput === 'string' ? stableInput : source.toString()));
      if (runtime && native) {
        const code = native.lower(source, jsxFile, typed, jsx === 'classic', false);
        if (code !== null) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
      }
      if (mode === 'transform' && (typed || runtime)) {
        const addon = loadModuleAddon();
        if (addon) {
          const hasAngles = typed && source.includes('<');
          const moduleProjection = typed && (!jsxFile || !hasAngles);
          const empty = moduleProjection ? addon.eraseTypeModule(source, format === 'esm') : null;
          if (empty !== null) return { backend: 'pulse', code: empty, sourceMap: null, diagnostics: [] };
          const annotated = moduleProjection && (runtime || source.includes(':') || hasAngles || source.includes('type') ||
            source.includes(' as ') || source.includes(' satisfies ')) ?
            addon.emitAnnotatedModule(source, runtime, format === 'esm') : null;
          if (typeof annotated === 'string') {
            return { backend: 'pulse', code: annotated, sourceMap: null, diagnostics: [] };
          }
          if (annotated?.code !== undefined) {
            const result = eraseLoweredModule(addon, annotated.code, file, format);
            if (result) return result;
          }
          if (runtime && (!jsxFile || !source.includes('\\u'))) {
            const mixed = addon.lower(source, jsxFile, typed, jsx === 'classic', true);
            if (mixed !== null) {
              if (typeof mixed !== 'string') {
                return { backend: 'pulse', code: mixed.code, sourceMap: null, diagnostics: [] };
              }
              if (typed) {
                const result = eraseLoweredModule(addon, mixed, file, format);
                if (result) return result;
              }
            }
          }
          if (typed && !jsxFile) {
            const text = typeof stableInput === 'string' ? stableInput : source.toString();
            const result = (annotated === true || addon.moduleMarker(source, true)) ? eraseModule(addon, text, file, format) :
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
  return transform(source, { file, target, module, jsx, sourceMap });
}

exports.compile = compile;
