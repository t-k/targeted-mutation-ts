import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Node 24 aborts while decorating some syntax errors thrown by vm.Script. The compiler must report
// them like any other invalid script.
const invalid = [
  'async function f() {\n  await using x = null, [] = null;\n}\n',
  'async function f() {\n  await using x = null, {} = null;\n}\n',
  'function f() {\n  using x = null, [] = null;\n}\n',
];

test('an invalid script is declined without aborting the process', () => {
  const program = `
    import assert from 'node:assert/strict';
    const { compile } = await import('./src/compiler.mjs');
    for (const source of ${JSON.stringify(invalid)}) {
      for (const file of ['invalid.js', 'invalid.ts', 'invalid.mjs', 'invalid.jsx']) {
        for (const input of [Buffer.from(source), source]) {
          // V8 rejects the declaration, so neither native route may publish the source.
          const result = compile(input, { file });
          assert.ok(result.backend !== 'javascript' && result.backend !== 'pulse', file);
          assert.ok(result.code === null ? result.diagnostics.length > 0 : typeof result.code === 'string', file);
        }
      }
    }
    assert.equal(compile(Buffer.from('const n = 42;'), { file: 'valid.js' }).code, '"use strict";\\nconst n = 42;');
    assert.equal(compile(Buffer.from('with (n) {}'), { file: 'sloppy.js' }).backend, 'typescript');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr.slice(-2000));
});
