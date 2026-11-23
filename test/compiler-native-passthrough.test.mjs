import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-native-passthrough.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [marker, dialect, input] = row.split('\t');
  test('unchanged typed module ' + row.replaceAll('\t', ' '), () => {
    const prefix = '// retains the original bytes: 日本語\r\n';
    const body = {
      ExportBinding: 'export const out = JSON.stringify(42);\r\n',
      NamedExport: 'const local = 42;\r\nexport { local };\r\n',
      ImportExport: 'import { value } from "./dependency.js";\r\nexport { value };\r\n',
    }[marker];
    const source = prefix + body;
    const result = compile(input === 'Buffer' ? Buffer.from(source) : source, { file: 'unchanged.' + dialect.toLowerCase() });
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code, source);
  });
}

test('a projected module still needs a runtime export binding and an unambiguous grammar', () => {
  const unresolved = compile('export { missing };');
  assert.equal(unresolved.code, null);
  assert.equal(unresolved.diagnostics[0].code, 'UNBOUND_RUNTIME_EXPORT');
  const comparison = compile('const a = 1, b = 2, c = 0; export const answer = a<b>c;');
  assert.notEqual(comparison.backend, 'pulse');
  assert.match(comparison.code, /a\s*<\s*b\s*>\s*c/);
});
