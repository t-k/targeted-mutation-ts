import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const require = createRequire(import.meta.url);
const { emitAnnotatedModule } = require('../build/compiler-module.node');
const cases = readFileSync(new URL('../verification/pict/compiler-runtime-export.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [binding, order, syntax] = row.split('\t');
  test('compiler export binding ' + row.replaceAll('\t', ' '), () => {
    const declaration = {
      Alias: 'type Item = number;',
      Interface: 'interface Item { value: number }',
      NamedImport: 'import type { Item } from "./dependency";',
      DefaultImport: 'import type Item from "./dependency";',
      NamespaceImport: 'import type * as Item from "./dependency";',
      InlineImport: 'import { type Item, value } from "./dependency";',
      Runtime: 'const Item: number = 42;',
    }[binding];
    const statement = { Plain: 'export { Item };', TypeStatement: 'export type { Item };',
      InlineType: 'export { type Item };' }[syntax];
    const lines = order === 'Before' ? [declaration, statement] : [statement, declaration];
    const source = 'export const marker: number = 42;\n' + lines.join('\n');
    const direct = emitAnnotatedModule(Buffer.from(source), false, false);
    if (binding !== 'Runtime' && syntax === 'Plain') {
      assert.equal(direct, null, source);
      const result = compile(source);
      assert.equal(result.code, null);
      assert.equal(result.diagnostics[0].code, 'UNBOUND_RUNTIME_EXPORT');
    } else {
      assert.equal(typeof direct, 'string', source);
    }
  });
}

test('a value sharing a type name satisfies an export and a re-export uses the external binding', () => {
  const source = 'type Item = number;\nexport { Item };\nconst Item = 42;';
  const native = emitAnnotatedModule(Buffer.from(source), false, false);
  assert.equal(typeof native, 'string');
  assert.match(native, /export \{ Item \}/);
  const external = 'export { Item } from "./dependency";';
  assert.equal(emitAnnotatedModule(Buffer.from(external), false, false), external);
});

test('export assignment requires the CommonJS transpilation route', () => {
  const source = 'const value: number = 42;\nexport = value;';
  assert.equal(emitAnnotatedModule(Buffer.from(source), false, false), null);
  const commonjs = compile(source, { module: 'cjs' });
  assert.match(commonjs.code, /module\.exports = value/);
  const esm = compile(source, { module: 'esm' });
  assert.equal(esm.code, null);
  assert.equal(esm.diagnostics[0].code, 'INCOMPATIBLE_MODULE_SYNTAX');
});
