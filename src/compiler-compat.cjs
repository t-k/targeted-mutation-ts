'use strict';

const extensions = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

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

function transform(source, { file, target, outputModule, jsx, sourceMap, experimentalDecorators = false, emitDecoratorMetadata = false }, verifyRuntimeExports, fail) {
  const ts = require('typescript');
  const extraDiagnostics = [];
  const compilerFile = file.replace(/\.[cm]([jt]s)$/i, '.$1');
  let result;
  try {
    result = ts.transpileModule(source, {
    fileName: compilerFile,
    reportDiagnostics: true,
    transformers: outputModule === 'esm' ? { before: [invalidModuleSyntax(ts, file, extraDiagnostics)] } : undefined,
    compilerOptions: {
      target: target === 'esnext' ? ts.ScriptTarget.ESNext : ts.ScriptTarget[target === 'es6' ? 'ES2015' : target.toUpperCase()],
      module: { preserve: ts.ModuleKind.Preserve, esm: ts.ModuleKind.ESNext, cjs: ts.ModuleKind.CommonJS }[outputModule],
      jsx: { automatic: ts.JsxEmit.ReactJSX, classic: ts.JsxEmit.React, preserve: ts.JsxEmit.Preserve }[jsx],
      verbatimModuleSyntax: true,
      // The file is handed over under a plain extension, so a module extension has to be stated: an .mts file
      // without imports or exports is still a module and receives no "use strict".
      ...(/\.m[jt]s$/i.test(file) ? { moduleDetection: ts.ModuleDetectionKind.Force } : {}),
      ...(experimentalDecorators ? { experimentalDecorators: true, emitDecoratorMetadata } : {}),
      sourceMap,
      inlineSources: sourceMap,
    },
    });
  } catch (error) {
    // TypeScript's printer fails on some inputs it should reject, such as `return o?.c.#f`. That is an error
    // in the source for this compiler, not an exception for its caller.
    // Its recursive parser can also run out of stack on very long lists, and with CommonJS output it fails
    // inside its own code on an import declaration that it means to report (a TypeError from typescript.js).
    const internal = error instanceof TypeError && /[\\/]typescript[\\/]lib[\\/]/.test(String(error.stack).split('\n')[1] ?? '');
    if (!(error instanceof Error) || !(error instanceof RangeError || /^Debug Failure/.test(error.message) || internal)) throw error;
    return fail('typescript', [{ file, code: 'TYPESCRIPT_FAILURE', severity: 'error',
      message: `TypeScript could not print this source: ${error.message.split('\n')[0]}`, start: 0, end: 0 }]);
  }
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

function hasSplitDeclare(source, code) {
  const leading = /\bdeclare(?=[^\S\r\n\u2028\u2029]*(?:[\r\n\u2028\u2029]|\/[/*]))/g;
  const trivia = /(?:\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[^]*?\*\/)*/y;
  const declaration = /(?:const|let|var|class|function|enum|namespace|module|type|interface|abstract|global)\b/y;
  const offsets = new Set();
  for (const { index } of source.matchAll(leading)) {
    if (code?.startsWith('declare', index)) continue;
    trivia.lastIndex = index + 'declare'.length;
    if (!/[\r\n\u2028\u2029]/.test(trivia.exec(source)[0])) continue;
    declaration.lastIndex = trivia.lastIndex;
    if (declaration.test(source)) offsets.add(index);
  }
  if (!offsets.size) return false;

  // Raw matches can be inside erased comments or template-literal types.
  let ts;
  try {
    ts = require('typescript');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return true;
  }
  const tree = ts.createSourceFile('context.ts', source, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
  function check(node) {
    if (ts.isExpressionStatement(node) && ts.isIdentifier(node.expression) &&
        node.expression.escapedText === 'declare' && offsets.has(node.expression.getStart(tree))) return true;
    return ts.forEachChild(node, check);
  }
  return !!check(tree);
}

exports.transform = transform;
exports.hasSplitDeclare = hasSplitDeclare;
