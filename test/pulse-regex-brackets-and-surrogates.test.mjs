import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'boundaries.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-regex-brackets-and-surrogates.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [pattern, flags, tail] = row.split('\t');
  test(`Pulse regex brackets and surrogates: ${pattern} ${flags} ${tail}`, () => {
    const regex = {
      ClosingBracket: String.raw`^\[\.\.\.(.+)]$`, QuantifiedBracket: String.raw`a]+$`,
      Escape: String.raw`[\uD800]`, Range: String.raw`[\uD800-\uDFFF]`,
      Reversed: String.raw`[\uDFFF-\uD800]`, Paired: String.raw`[\uD800\uDC00]`,
      BrokenDigit: String.raw`[\uD800-\uDFFG]`,
    }[pattern];
    const flagsText = { Legacy: 'g', Unicode: 'u', UnicodeSets: 'v' }[flags];
    const source = `/* 海 🧪 */ const before = a < b; const check = /${regex}/${flagsText}.test(name) && c >= d;` +
      (tail === 'Broken' ? ' const =;' : '');
    const reference = extractFallback(source, options);
    const result = extract(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    const compatible =
      flags === 'Legacy' && ['ClosingBracket', 'QuantifiedBracket', 'Escape', 'Range'].includes(pattern) ||
      flags === 'Unicode' && ['Escape', 'Range'].includes(pattern);
    const fast = tail === 'Complete' && compatible;
    assert.equal(result.path === 'fast', fast, source);
    if (fast) assert.doesNotThrow(() => new RegExp(regex, flagsText), source);
  });
}
