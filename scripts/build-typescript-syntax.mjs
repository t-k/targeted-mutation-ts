import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { transform } from 'esbuild';
import { createTypeScriptExtractor } from '../src/typescript-extraction.mjs';

const require = createRequire(import.meta.url);
const sourcePath = require.resolve('typescript');
const source = readFileSync(sourcePath, 'utf8');
// The emitted compiler's initialization order and internal declarations are versioned together.
assert.equal(createHash('sha256').update(source).digest('hex'),
  '569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39',
  'The upstream TypeScript compiler changed. Audit the syntax projection for the new compiler before rebuilding.');
const ts = require('typescript');
const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
const wrapper = tree.statements[1].expression.expression.expression;
assert.ok(ts.isArrowFunction(wrapper) && ts.isBlock(wrapper.body));
const statements = wrapper.body.statements;
const text = node => node.getText(tree);
const exportsEnd = statements.findIndex(statement => text(statement) === 'module.exports = __toCommonJS(typescript_exports);');
const syntaxEnd = source.indexOf('// src/compiler/commandLineParser.ts');
const allocator = statements.find(statement => text(statement) === 'setObjectAllocator(getServicesObjectAllocator());');
assert.ok(exportsEnd > 0 && syntaxEnd > 0 && allocator);

function compilerExports() {
  const names = new Set(['version']);
  for (const file of ['extraction', 'grammar', 'bindings']) {
    const code = readFileSync(new URL(`../src/typescript-${file}.mjs`, import.meta.url), 'utf8');
    const module = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const factory = module.statements.find(statement => ts.isFunctionDeclaration(statement) && /^createTypeScript/.test(statement.name?.text));
    assert.ok(factory);
    const [declaration] = factory.body.statements[0].declarationList.declarations;
    assert.equal(declaration.initializer.text, 'ts');
    for (const element of declaration.name.elements) {
      const name = element.propertyName ?? element.name;
      assert.ok(ts.isIdentifier(name) && Object.hasOwn(ts, name.text));
      names.add(name.text);
    }
  }
  for (const file of ['probe', 'prototype']) {
    const code = readFileSync(new URL(`../src/${file}.mjs`, import.meta.url), 'utf8');
    const module = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    visit(module, undefined, node => {
      if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'ts') return;
      assert.ok(Object.hasOwn(ts, node.name.text), `Unknown TypeScript syntax helper ${node.name.text}`);
      names.add(node.name.text);
    });
  }
  return [...names];
}

const names = compilerExports();
const declarations = new Map();
const retained = new Set([allocator]);
function declare(name, statement) {
  if (!declarations.has(name)) declarations.set(name, []);
  declarations.get(name).push(statement);
}
for (const [index, statement] of statements.entries()) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declare(declaration.name.text, statement);
      else if (index > exportsEnd && statement.end <= syntaxEnd) retained.add(statement);
    }
  } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
    declare(statement.name.text, statement);
  } else if (index > exportsEnd && statement.end <= syntaxEnd) {
    retained.add(statement);
  }
}

function retain(name) {
  for (const statement of declarations.get(name) ?? []) retained.add(statement);
}
function visit(node, parent, callback) {
  callback(node, parent);
  ts.forEachChild(node, child => { visit(child, node, callback); });
}
for (const name of names) {
  assert.ok(declarations.has(name), `Missing compiler export ${name}`);
  retain(name);
}
// Keep the transitive closure. Treat local identifiers as possible references to
// top-level names too, so shadowing can only retain extra declarations.
for (const statement of retained) visit(statement, undefined, (node, parent) => {
  if (!ts.isIdentifier(node)) return;
  const propertyName = parent?.name === node && (ts.isPropertyAccessExpression(parent) ||
    ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent));
  if (!propertyName) retain(node.text);
});

const diagnosticKeys = new Set();
let dynamicDiagnostics = false;
for (const statement of retained) visit(statement, undefined, (node, parent) => {
  if (!ts.isIdentifier(node) || node.text !== 'Diagnostics') return;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) diagnosticKeys.add(parent.name.text);
  else if (!ts.isVariableDeclaration(parent) || parent.name !== node) dynamicDiagnostics = true;
});
function emit(statement) {
  const diagnostic = statement.declarationList?.declarations[0];
  if (dynamicDiagnostics || diagnostic?.name.text !== 'Diagnostics') return text(statement);
  const entries = diagnostic.initializer.properties.filter(entry => diagnosticKeys.has(entry.name.text));
  assert.equal(entries.length, diagnosticKeys.size);
  return `var Diagnostics = {\n${entries.map(text).join(',\n')}\n};`;
}
const projected = '"use strict";\n' + [...retained].sort((left, right) => left.pos - right.pos).map(emit).join('\n') +
  `\nexport {${names.join(', ')}};`;
const originalNotice = source.slice(0, source.indexOf('var ts = {};')).trimEnd();
const notice = `${originalNotice}\n/* Modified by Targeted Mutation TS to retain the TypeScript syntax parser. */`;
const { code } = await transform(projected, {
  format: 'cjs', platform: 'node', target: 'node24', minify: true, legalComments: 'none', banner: notice,
});

const output = resolve(process.argv[2] ?? 'build/typescript-syntax');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(output, '.syntax-'));
try {
  const name = 'typescript-syntax.cjs';
  const pending = join(scratch, name);
  writeFileSync(pending, code);
  const small = createTypeScriptExtractor(require(pending));
  const full = createTypeScriptExtractor(ts);
  for (const [file, source] of [
    ['check.ts', 'const result = (n: number) => n >= 0;'],
    ['check.ts', 'const earlier = ;\nlet later = a > b;'],
    ['check.tsx', 'const cmp = <T>(n: T) => <input disabled={n < high || wait} />;'],
  ]) {
    const options = { file, mode: 'module', logical: true };
    assert.deepEqual(small(source, options), full(source, options), file);
  }
  const licenceDirectory = dirname(require.resolve('typescript/package.json'));
  for (const noticeFile of ['LICENSE.txt', 'ThirdPartyNoticeText.txt']) {
    copyFileSync(join(licenceDirectory, noticeFile), join(output, noticeFile));
  }
  renameSync(pending, join(output, name));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
