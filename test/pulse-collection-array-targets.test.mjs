import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'array-target.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-collection-array-targets.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [head, target, tail] = row.split('\t');
  test(`Pulse collection array target: ${head} ${target} ${tail}`, () => {
    const items = {
      Hole: '[,entry]', Member: '[other, record[score >= bound]]', Invalid: '[a >= b]', Spread: '[...rest]',
    }[target];
    const keyword = head === 'In' ? 'in' : 'of';
    const prefix = head === 'AwaitOf' ? 'await ' : '';
    const source = `/* 海 🧪 */ async function walk() {
      let entry;
      for ${prefix}(${items} ${keyword} source) { if (entry < limit) consume(entry); }
    }${tail === 'Broken' ? ' const =' : ''}`;
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    // A rest element at the end is a target as well.
    assert.equal(result.path === 'fast', tail === 'Complete' && ['Hole', 'Member', 'Spread'].includes(target), source);
  });
}
