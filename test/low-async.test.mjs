import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const result = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const wrap = {
  Module: body => body,
  Named: body => `export async function check(value: Task) { ${body} }`,
  BlockArrow: body => `const check = async (value: Task): Promise<boolean> => { ${body} };`,
  BareArrow: () => 'const check = async value => await value.read() >= limit;',
  Script: body => `const f = async () => { ${body} };`,
};
const rows = readFileSync(new URL('../verification/pict/low-async.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [entry, use, suffix] = row.split('\t');
  test(`Low* async: ${entry} ${use} ${suffix}`, () => {
    const body = use === 'Operand' ? 'if (await value.read() >= limit) run();'
      : 'for await (const value of source) { if (value < limit) break; }';
    const source = wrap[entry](body) +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic',
      entry === 'Script' ? { mode: 'script' } : {});
  });
}

test('await permission stops at ordinary functions and restores after callbacks', () => {
  for (const source of [
    'function check() { return await read() < limit; }',
    'const f = async () => { const g = () => await value < limit; return false; };',
    'const f = async => await read() < limit;',
    'function f() { for await (const item of rows) { if (item < max) return; } }',
    'for await (const item in rows) { if (item < max) continue; }',
    'const check = async/*\n*/(value) => value < limit;',
    'const check = async (value)/*\n*/=> value < limit;',
  ]) compare(source, 'diagnostic');
  for (const source of [
    'const f = async () => { const g = x => x < 0; return await read() < limit; };',
    'function check() { const f = async value => await value < limit; return a >= b; }',
    'const check = async(value) < limit;',
    'const check = async => async < limit;',
    'for\nawait (const item of rows) { if (item < max) continue; }',
    'const f = async () => await\nread() < limit;',
  ]) compare(source, 'fast');
  compare('const check = (n: number) => <Tag hi={await n < limit} />;', 'diagnostic', { dialect: 'tsx' });
});
