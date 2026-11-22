import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'non-null.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-non-null-assignment.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [target, assertion, operator] = row.split('\t');
  test(`Pulse non-null assignment: ${target} ${assertion} ${operator}`, () => {
    const base = {
      Identifier: 'item', Member: 'job.flags', Index: 'items[index >= first]',
      Call: 'get()', Chain: 'job?.flags', Restricted: 'eval',
    }[target];
    const left = {
      Single: `${base}!`, Repeated: `${base}!!`, Grouped: `(${base}!)`, Newline: `${base}\n!`,
    }[assertion];
    const tail = { Plain: '= limit < max', Add: '+= limit < max', BitOr: '|= other! = limit < max', Incomplete: '=' }[operator];
    const source = `/* 海 🧪 */ const before = n > m; ${left} ${tail}; const after = a <= b;`;
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    const fast = ['Identifier', 'Member', 'Index'].includes(target) && assertion !== 'Newline' && operator !== 'Incomplete';
    assert.equal(result.path === 'fast', fast, source);
  });
}

test('the assertion remains part of a comparison operand and does not make calls assignable', () => {
  for (const source of [
    'const check = job.flags! >= previous;',
    'const check = (job.flags! |= other!) >= previous;',
    'job.get()! |= fallback;',
    'job?.flags!.value |= fallback;',
  ]) {
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    assert.equal(result.path === 'fast', source.startsWith('const'), source);
  }
});
