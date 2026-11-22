import { createRequire, stripTypeScriptTypes } from 'node:module';
import { basename } from 'node:path';
import { normalize } from './source-text.mjs';

const require = createRequire(import.meta.url);
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

function transform(source, { file, target, module, jsx, sourceMap }) {
  const ts = require('typescript');
  const outputModule = module === 'preserve' && /\.c[jt]s$/i.test(file) ? 'cjs' : module;
  const compilerFile = file.replace(/\.[cm]([jt]s)$/i, '.$1');
  const result = ts.transpileModule(source, {
    fileName: compilerFile,
    reportDiagnostics: true,
    compilerOptions: {
      target: target === 'esnext' ? ts.ScriptTarget.ESNext : ts.ScriptTarget[target.toUpperCase()],
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
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) return fail('typescript', diagnostics);
  const map = result.sourceMapText ? JSON.parse(result.sourceMapText) : null;
  if (map) {
    map.sources = [basename(file)];
    map.file = basename(file).replace(extensions, jsx === 'preserve' && /x$/i.test(file) ? '.jsx' :
      outputModule === 'cjs' && /\.c[jt]s$/i.test(file) ? '.cjs' :
        /\.m[jt]s$/i.test(file) && outputModule !== 'cjs' ? '.mjs' : '.js');
  }
  const code = map ? result.outputText.replace(/\/\/# sourceMappingURL=[^\r\n]*$/, '') : result.outputText;
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
  const source = normalize(input);
  if (source === null) return inputError(file, 'INVALID_ENCODING', 'Expected well-formed UTF-8');
  if (declarations.test(file)) return inputError(file, 'DECLARATION_INPUT', 'A declaration file cannot emit JavaScript');
  if (mode === 'strip') return strip(source, file);
  return transform(source, { file, target, module, jsx, sourceMap });
}
