import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'assignment.ts', requireNative: true };

function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-object-assignment.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [target, rhs, tail] = row.split('\t');
  test(`Pulse object assignment: ${target} ${rhs} ${tail}`, () => {
    const pattern = {
      Shorthand: 'entry', Rename: 'value: entry, "other": second',
      Repeated: 'value: entry, other: entry', Invalid: 'value: eval',
    }[target] + (tail === 'TrailingKeyComma' ? ',' : '');
    const value = { Reference: 'source', Call: 'read(n < m)', Comparison: '(n >= m ? a : b)' }[rhs];
    const source = `/* 🧪 海 */ ({ ${pattern} } = ${value})` +
      (tail === 'OuterComparison' ? ' >= limit;' : tail === 'Broken' ? '; const =' : ';');
    compare(source, target !== 'Invalid' && tail !== 'Broken');
  });
}

test('ordinary object literals and equality use the ordinary expression path', () => {
  compare('const item = ({ name: a < b, other: c <= d });', true);
  compare('const changed = ({ name } === (a < b));', true);
  compare('({} = value);', true);
});

test('restricted assignment targets and operators stay on the compatibility path', () => {
  for (const source of [
    '({ name = eval } += data);', '({ eval = fallback } = data);',
    '({ name: arguments = fallback } = data);', '({ ...eval } = data);',
    '({ name } += data);', '({ name } = data) = x;',
    '({ name } = a < b, c > (d));', '({ name } = );',
  ]) compare(source, false);
});

test('a member, a nested target and a computed key are targets of an object pattern', () => {
  for (const source of ['({ name: record[key] } = data);', '({ name: record.field, other: [first, { inner }] } = data);', '({ [key]: value, ...record.rest } = data);']) {
    compare(source, true);
  }
});

test('assignment patterns with defaults or a rest name are read natively', () => {
  for (const source of ['({ name = fallback } = data);', '({ ...rest } = data);', '({ name = a < b ? 1 : 2, other: last = 3, ...rest } = data);']) {
    compare(source, true);
  }
});
