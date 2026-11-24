import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const entry = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const typescriptPath = /(?:^|[/\\])typescript(?:$|[/\\-])|typescript-syntax\.[cm]?js/;

async function guardedEmit(cases) {
  const guard = registerHooks({ resolve(specifier, context, next) {
    if (typescriptPath.test(specifier)) throw Object.assign(new Error(specifier), { code: 'AUDIT_TYPESCRIPT_LOAD' });
    const resolution = next(specifier, context);
    if (typescriptPath.test(resolution.url)) throw Object.assign(new Error(resolution.url), { code: 'AUDIT_TYPESCRIPT_LOAD' });
    return resolution;
  } });
  try {
    const { compile } = await import('../src/compiler.mjs');
    return cases.map(({ file, source, options }) => {
      try {
        return compile(Buffer.from(source, 'base64'), { file, ...options });
      } catch (error) {
        if (error.code !== 'AUDIT_TYPESCRIPT_LOAD') throw error;
        return { backend: 'typescript-required', code: null, diagnostics: [] };
      }
    });
  } finally {
    guard.deregister();
  }
}

function loadCorpus(path) {
  const raw = readFileSync(path);
  const ext = path.endsWith('.tsx.json') ? /\.tsx$/i : /\.m?ts$/i;
  const cases = JSON.parse(raw).filter(test => test.mode === 'module' && ext.test(test.file) && !/\.d\.m?ts$/i.test(test.file));
  assert.ok(cases.length > 0, 'No compiler cases in ' + path);
  return { name: basename(path), hash: hash(raw), cases, requireComplete: true };
}

function readBlob(repo, revision, path) {
  const result = spawnSync('git', ['--no-replace-objects', '-C', repo, 'cat-file', 'blob', revision + ':' + path], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

function loadUpstream(repo) {
  const manifest = JSON.parse(readFileSync(new URL('../verification/compiler-conformance/typescript.json', import.meta.url)));
  const cases = manifest.cases.map(({ path, baseline, options }) => {
    const input = readBlob(repo, manifest.revision, 'tests/cases/' + path);
    const expected = readBlob(repo, manifest.revision, 'tests/baselines/reference/' + baseline);
    // A TypeScript JS baseline contains both the source and the emitted file.
    const emitted = [...expected.matchAll(/^\/\/\/\/ \[[^\]\n]+\.js\]\r?$/gm)];
    assert.equal(emitted.length, 1, baseline);
    const code = expected.slice(emitted[0].index + emitted[0][0].length).split(/^\/\/\/\/ \[/m)[0].trim();
    const source = input.replace(/^\uFEFF/, '')
      .replace(/^[ \t]*\/\/[ \t]*@(?:filename|jsx|strict|target|module|esModuleInterop|skipLibCheck|verbatimModuleSyntax):[^\r\n]*[\r\n]*/gim, '')
      .replace(/^[ \t]*\/\/\/[ \t]*<reference path="\/\.lib\/[^"]+"\s*\/>[^\r\n]*[\r\n]*/gm, '');
    const file = basename(path);
    return { file, expected: code, source: Buffer.from(source).toString('base64'), options };
  });
  return { name: 'typescript-upstream', revision: manifest.revision, cases, requireComplete: false };
}

export function inspect(ts, code, file) {
  const tree = ts.createSourceFile(file.replace(/\.[mc]?tsx?$/i, '.js'), code, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  const aliases = new Map();
  const dependencies = [];
  function implicitRuntime(node) {
    if (!ts.isImportDeclaration(node)) return false;
    const name = node.moduleSpecifier.text;
    if (name === 'react' || name === 'react/jsx-runtime') return true;
    // A helper import of the automatic runtime, from react or from the package that a pragma names.
    const named = node.importClause?.namedBindings;
    return !node.importClause?.name && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 &&
      named.elements.every(entry => entry.propertyName && entry.name.text.startsWith('_') &&
        ['jsx', 'jsxs', 'Fragment', 'createElement'].includes(entry.propertyName.text));
  }
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    if (typeof node.moduleSpecifier?.text !== 'string') continue;
    dependencies.push(node.moduleSpecifier.text);
    if (!implicitRuntime(node)) continue;
    const named = node.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const entry of named.elements) {
      if (entry.propertyName && ['jsx', 'jsxs', 'Fragment', 'createElement'].includes(entry.propertyName.text)) {
        aliases.set(entry.name.text, node.moduleSpecifier.text + ':' + entry.propertyName.text);
      }
    }
  }
  function shape(node, parent) {
    if (ts.isParenthesizedExpression(node)) {
      const breaksChain = node.expression.flags & ts.NodeFlags.OptionalChain && parent?.expression === node &&
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) ||
          ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isNonNullExpression(parent));
      if (!breaksChain) return shape(node.expression, parent);
    }
    if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
      return ['property', node.name.text, shape(node.initializer, node)];
    }
    if (implicitRuntime(node)) {
      const names = node.importClause?.namedBindings;
      if (names && ts.isNamedImports(names) && names.elements.every(element => aliases.has(element.name.text))) {
        return ['runtime-import', node.moduleSpecifier.text, names.elements.map(element => aliases.get(element.name.text)).sort()];
      }
    }
    const children = [];
    ts.forEachChild(node, child => { if (!ts.isEmptyStatement(child) && !ts.isSemicolonClassElement(child)) children.push(shape(child, node)); });
    if (ts.isSourceFile(node)) {
      const runtime = children.filter(item => item[0] === 'runtime-import');
      const statements = children.filter(item => item[0] !== 'runtime-import');
      return [node.kind, ...runtime, ...statements];
    }
    const modes = ts.isVariableDeclarationList(node) ? node.flags & ts.NodeFlags.BlockScoped : 0;
    const value = ts.isIdentifier(node) ? aliases.get(node.text) ?? node.text : node.text ?? '';
    return [node.kind, value, typeof node.operator === 'number' ? node.operator : 0, modes, ...children];
  }
  return { diagnostics: tree.parseDiagnostics.map(diagnostic => diagnostic.code), dependencies, shape: shape(tree) };
}

export function reference(ts, test) {
  if (test.expected !== undefined) return test.expected;
  const source = Buffer.from(test.source, 'base64').toString();
  const result = ts.transpileModule(source, { fileName: test.file, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true,
  } });
  assert.ok(!result.diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), test.file);
  return result.outputText;
}

if (!import.meta.main) {
  // Imported for its syntax comparison helpers.
} else if (process.argv[2] === '--guarded-worker') {
  console.log(JSON.stringify(await guardedEmit(JSON.parse(readFileSync(0, 'utf8')))));
} else {
  const paths = process.argv.slice(2);
  const upstream = paths.indexOf('--upstream-ts');
  const suites = [];
  if (upstream !== -1) suites.push(loadUpstream(paths.splice(upstream, 2)[1]));
  suites.unshift(...paths.map(loadCorpus));
  assert.ok(suites.length, 'Pass corpus JSON files and optionally --upstream-ts PATH');
  const ts = require('typescript');
  const known = JSON.parse(readFileSync(new URL('../verification/compiler-conformance/known-differences.json', import.meta.url)));
  const reports = suites.map(({ cases, requireComplete, ...metadata }) => {
    const child = spawnSync(process.execPath, [entry, '--guarded-worker'], {
      encoding: 'utf8', input: JSON.stringify(cases), timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const emitted = JSON.parse(child.stdout);
    const report = { ...metadata, files: cases.length, backends: {}, equivalent: 0, declined: [], differences: [] };
    for (const [index, test] of cases.entries()) {
      const result = emitted[index];
      report.backends[result.backend] = (report.backends[result.backend] ?? 0) + 1;
      if (result.code === null) {
        report.declined.push({ file: test.file, backend: result.backend });
        continue;
      }
      if (test.options?.module === 'cjs') new vm.Script(result.code);
      else new vm.SourceTextModule(result.code);
      const actual = inspect(ts, result.code, test.file);
      const expected = inspect(ts, reference(ts, test), test.file);
      const actualText = JSON.stringify(actual);
      const expectedText = JSON.stringify(expected);
      if (actualText === expectedText) {
        report.equivalent++;
      } else {
        const dependencies = JSON.stringify(actual.dependencies) === JSON.stringify(expected.dependencies);
        const signature = { source: hash(test.source), actual: hash(actualText), expected: hash(expectedText) };
        const allowed = dependencies && known.some(entry => entry.file === test.file &&
          Object.entries(signature).every(([key, value]) => entry[key] === value));
        report.differences.push({ file: test.file, backend: result.backend, dependencies, allowed, ...signature });
      }
    }
    if (requireComplete && (report.declined.length || report.differences.some(entry => !entry.allowed))) process.exitCode = 1;
    return report;
  });
  console.log(JSON.stringify({ node: process.version, reports }, null, 2));
}
