import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'codepoints.ts', requireNative: true };
function compare(pattern, flags, fast) {
  const source = `/* 🧪 海 */ const filter = /${pattern}/${flags}; const pass = a < b;`;
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
  if (fast) assert.doesNotThrow(() => new RegExp(pattern, flags), source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-regex-codepoints.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [name, place, flags] = row.split('\t');
  test(`Pulse regex code point: ${name} ${place} ${flags}`, () => {
    const escape = {
      Upper: String.raw`\p{Lu}`, IdentifierStart: String.raw`\p{ID_Start}`, IdentifierContinue: String.raw`\p{ID_Continue}`,
      Astral: String.raw`\u{1F680}`, TooLarge: String.raw`\u{110000}`,
    }[name];
    const pattern = { Atom: escape, Class: `[${escape}]`, Range: `[a-${escape}]` }[place];
    const mode = { Unicode: 'u', Legacy: '', UnicodeSets: 'v' }[flags];
    const fast = mode === 'u' && name !== 'TooLarge' && (place !== 'Range' || name === 'Astral');
    compare(pattern, mode, fast);
  });
}

test('class ranges and property spellings retain the strict mode boundaries', () => {
  compare(String.raw`[\u{FDD0}-\u{FDEF}\u{10FFFF}]`, 'u', true);
  compare(String.raw`[\u{1F680}-a]`, 'u', false);
  compare(String.raw`[\p{ID_Start}-a]`, 'u', false);
  compare(String.raw`[\w-$]+`, 'g', true);
  compare(String.raw`[\w-$]+`, 'gu', false);
  compare(String.raw`\p{id_start}`, 'u', false);
});
