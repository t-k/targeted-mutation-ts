import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast, mode = 'module') {
  const options = { file: 'subject.cts', mode, requireNative: true };
  const actual = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
  assert.equal(actual.path === 'fast', fast, source);
}

const declarations = {
  Abstract: ['export default abstract class Shape { abstract area(): number; check(n: number) { return n >= 18; } }',
    'export default abstract class Shape { abstract area(): number { return n >= 18; } }'],
  ConstructorDefault: ['class Shape { constructor(private visible = (a < b)) {} }',
    'class Shape { constructor(private visible? = (a < b)) {} }'],
  ThisAssignment: ['({ value: this.entry.current, next: this.next } = c > d);',
    '({ value: this } = c > d);'],
  IndexedNew: ['const instance = new table[a < b](c > d);',
    'const instance = new table[a < b]?.(c > d);'],
  PrivateOverload: ['class Shape { private ready(n: number): boolean; private ready(n: number) { return n < 0; } }',
    'class Shape { private ready(n: number): boolean; protected ready(n: number) { return n < 0; } }'],
  ExportEquals: ['const api = a < b; export = api;', 'export const named = a < b; export = named;'],
};
const rows = readFileSync(new URL('../verification/pict/pulse-build-tool-shapes.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [shape, input, mode] = row.split('\t');
  test(`Pulse build tooling: ${shape} ${input} ${mode}`, () => {
    const source = '/* 海 🧪 */ ' + declarations[shape][Number(input === 'Bad')];
    const requiresModule = ['Abstract', 'ExportEquals'].includes(shape);
    compare(source, input === 'Good' && (!requiresModule || mode === 'Module'), mode.toLowerCase());
  });
}
test('constructor member and type-only syntax keeps comparisons and rejects incomplete declarations', () => {
  compare('class Shape { protected run(x: number): boolean; protected run(x: number) { return x < limit; } }', true);
  compare('class Shape { private public ready(x: number) { return x < y; } }', false);
  compare('class Shape { private ready(x: number): boolean; public ready(x: number) { return x < y; } }', false);
  compare('class Shape { constructor(readonly value = fn(a < b)) {} }', true);
  compare('class Shape { constructor(declare private value: number) {} }', false);
  compare('const api = a > b; export = api; const after = c < d;', false);
  compare('export = a < b; export = c > d;', false);
  compare('export = a < b; /* trailing trivia */', true);
  compare('export = a < b; const =', false);
  compare(declarations.IndexedNew[0] + ' const =', false);
});
