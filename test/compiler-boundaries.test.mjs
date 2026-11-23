import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

function evaluate(code) {
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

const rows = readFileSync(new URL('../verification/pict/compiler-boundaries.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [placement, lineEnding, dialect, context] = row.split('\t');
  test('generic arrow restricted line break ' + row.replaceAll('\t', ' '), async () => {
    const newline = lineEnding === 'LF' ? '\n' : '\r\n';
    const start = placement === 'InsideHead' ? '<T,' + newline + '>' : '<T,>' + newline;
    const generator = context === 'Yield';
    const source = `export function${generator ? '*' : ''} make() { ${generator ? 'yield' : 'return'} ` +
      start + '(value: T) => value; }';
    const result = compile(source, { file: dialect === 'TS' ? 'arrow.ts' : 'arrow.tsx' });
    assert.equal(result.backend, 'pulse');
    assert.equal(result.code, stripTypeScriptTypes(source));
    const { make } = await evaluate(result.code);
    const arrow = generator ? make().next().value : make();
    assert.equal(arrow(42), 42);
  });
}

test('an empty statement can instantiate a TypeScript namespace', async () => {
  const source = 'export namespace E { interface T {}; } export const value: number = 1;';
  const result = compile(source);
  const instance = await evaluate(result.code);
  assert.deepEqual(instance.E, {});
  assert.equal(instance.value, 1);

  const local = compile('namespace E {;} export const value: string = typeof E;');
  assert.equal((await evaluate(local.code)).value, 'object');
  const ambient = compile('declare namespace E {;} export const value: string = typeof E;');
  assert.equal((await evaluate(ambient.code)).value, 'undefined');
});
