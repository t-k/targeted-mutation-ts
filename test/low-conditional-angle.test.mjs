import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast) {
  const options = { file: 'angle.ts', logical: true };
  const native = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(native.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(native.candidates, reference.candidates, source);
  assert.deepEqual(native.diagnostics, reference.diagnostics, source);
}

const forms = {
  Object: value => `const result = { selected: ${value}, ...more };`,
  Array: value => `const result = [${value}, next];`,
  Call: value => `read(${value}, next);`,
  Declaration: value => `const result = ${value}, next = ready;`,
};
const rows = readFileSync(new URL('../verification/pict/low-conditional-angle.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [angle, placement, suffix] = row.split('\t');
  test(`Low* conditional angle: ${angle} ${placement} ${suffix}`, () => {
    const condition = angle === 'Condition' ? 'left < right' : 'left >= right';
    const yes = angle === 'Consequent' ? 'first < limit' : 'ok';
    const no = angle === 'Alternate' ? 'last < max' : 'other';
    const value = `${condition} ? ${yes} : ${no}`;
    const wrapped = forms[placement](suffix === 'Nested' ? `confirm ? ${value} : final` : value);
    const source = `/* 海 */${wrapped}\nconst probe = low > high;` + (suffix === 'Invalid' ? '\nconst =' : '');
    const fast = suffix !== 'Invalid' && (angle !== 'Alternate' || suffix === 'Nested');
    compare(source, fast);
  });
}

test('actual conditional type arguments and alternate-angle ambiguity retain their boundaries', () => {
  compare('const result = choose<T extends Ready ? Ok : Err, Other>(value), last = x > y;', true);
  compare('const result = choose < T extends Ready ? Ok : Err, Other>(value); const last = x > y;', false);
  compare('use(ready ? success : pick < A, B>(key)); const last = x > y;', false);
  compare('const result = { refName: i < 0 ? id : id.slice(i + 1), ...(bound ? {} : { bound }) };', true);
  compare('const result = (x = a < b ? c : d, z) => z >= x;', true);
  compare('const result = (x = a ? c : d < e, z) => z >= x;', false);
});
