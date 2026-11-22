import { isUtf8 } from 'node:buffer';
import { existsSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { basename } from 'node:path';
import { types } from 'node:util';
import { normalize } from './source-text.mjs';

const require = createRequire(import.meta.url);
const addonUrl = new URL('../build/compiler.node', import.meta.url);
const native = existsSync(addonUrl) ? require('../build/compiler.node') : null;
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
  return { backend: 'typescript', code, sourceMap: map, diagnostics };
}

function strip(source, file) {
  try {
    return { backend: 'node-strip', code: stripTypeScriptTypes(source), sourceMap: null, diagnostics: [] };
  } catch (error) {
    if (error.code !== 'ERR_INVALID_TYPESCRIPT_SYNTAX' && error.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw error;
    return fail('node-strip', [{ file, code: error.code, severity: 'error', message: error.message, start: 0, end: 0 }]);
  }
}

function snapshot(input) {
  if (types.isSharedArrayBuffer(input)) return Buffer.from(new Uint8Array(input));
  if (ArrayBuffer.isView(input) && types.isSharedArrayBuffer(input.buffer)) {
    return Buffer.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  }
  return input;
}

export function compile(input, options = {}) {
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
  if (native && target === 'esnext' && module !== 'cjs' && !sourceMap && /\.m?ts$/i.test(file)) {
    const source = Buffer.isBuffer(stableInput) ? stableInput :
      typeof stableInput === 'string' && stableInput.isWellFormed() ? Buffer.from(stableInput) : null;
    if (source && isUtf8(source) && (mode === 'strip' || !source.includes('///'))) {
      const code = native.compile(source);
      if (code !== null) return { backend: 'pulse', code, sourceMap: null, diagnostics: [] };
    }
  }
  const source = normalize(stableInput);
  if (source === null) return inputError(file, 'INVALID_ENCODING', 'Expected well-formed UTF-8');
  if (mode === 'strip') return strip(source, file);
  return transform(source, { file, target, module, jsx, sourceMap });
}
