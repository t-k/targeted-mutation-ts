import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-mjs.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const sources = {
  ImportExport: '#!/usr/bin/env node\nimport { name } from "./unused.js";\nexport const value = `π:${name}`;',
  TopLevelAwait: 'await Promise.resolve();\nconsole.log(import.meta.url);',
  Directive: '/// <reference path="./unused.d.ts" />\nexport const value = 42;',
  Invalid: 'export const value = ;',
};

for (const row of rows) {
  test('ESNext .mjs ' + row.replaceAll('\t', ' '), () => {
    const [kind, representation, output] = row.split('\t');
    const source = sources[kind];
    const input = representation === 'Bytes' ? Buffer.from(source) : source;
    const options = { file: 'entry.MJS' };
    if (output === 'CommonJS') options.module = 'cjs';
    if (output === 'Map') options.sourceMap = true;
    const result = compile(input, options);
    if (output === 'ESM' && (kind === 'ImportExport' || kind === 'TopLevelAwait')) {
      assert.deepEqual(result, { backend: 'javascript', code: source, sourceMap: null, diagnostics: [] });
    } else {
      assert.equal(result.backend, 'typescript');
      if (kind === 'Invalid') {
        assert.equal(result.code, null);
        assert.ok(result.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
      } else if (output === 'Map') {
        assert.ok(result.sourceMap);
      } else if (output === 'CommonJS' && kind === 'ImportExport') {
        assert.match(result.code, /require\(["']\.\/unused\.js/);
      }
    }
  });
}

test('invalid encoding and unbound runtime exports still receive diagnostics', () => {
  const encoding = compile(Buffer.from([0xc0, 0x80]), { file: 'entry.mjs' });
  assert.equal(encoding.code, null);
  assert.equal(encoding.diagnostics[0].code, 'INVALID_ENCODING');
  const binding = compile('export { missing };', { file: 'entry.mjs' });
  assert.equal(binding.code, null);
  assert.equal(binding.diagnostics[0].code, 'UNBOUND_RUNTIME_EXPORT');
});
