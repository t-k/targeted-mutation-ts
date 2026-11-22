import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractTypeScript } from '../src/typescript-extraction.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

const options = { file: 'overload.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-class-overloads.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [modifier, group, tail] = row.split('\t');
  test(`Pulse overload: ${modifier} ${group} ${tail}`, () => {
    const prefix = { Plain: '', Static: 'static ', PublicAsync: 'public async ' }[modifier];
    const type = modifier === 'PublicAsync' ? 'Promise<boolean>' : 'boolean';
    const same = `${prefix}check(value: number): ${type} { return value > cutoff; }`;
    const body = {
      Matching: same, Missing: '', WrongName: same.replace('check', 'other'),
      WrongModifier: prefix ? same.slice(prefix.length) : `static ${same}`, Interleaved: `value: number; ${same}`,
    }[group];
    const input = `/* 海 🧪 */ class Model { ${prefix}check<T extends number>(value: T): ${type}\n${body} }` +
      (tail === 'Broken' ? '\nconst =' : '');
    const result = extract(input, options);
    if (group === 'Matching' && tail === 'Complete') {
      assert.equal(result.path, 'fast', input);
      assert.equal(result.candidates.length, 1);
      for (const reference of [extractTypeScript(input, options), extractYuku(input, options)]) {
        assert.deepEqual(result.candidates, reference.candidates, input);
      }
    } else {
      assert.notEqual(result.path, 'fast', input);
      if (tail === 'Broken') assert.equal(result.candidates.length, 0);
    }
  });
}

test('an overload requires consecutive declarations ending in one implementation', () => {
  const body = 'f(x: number): boolean; f(x: string): boolean; f(x: unknown) { return a > b; }';
  const result = extract(`class Model { ${body} }`, options);
  assert.equal(result.path, 'fast');
  assert.equal(result.candidates.length, 1);
  for (const invalid of ['f(x = 1): boolean;', 'f(x: number);', 'f(x: number): boolean; ;', 'private f(x: number): boolean;']) {
    assert.notEqual(extract(`class Model { ${invalid} f(x: number) { return a > b; } }`, options).path, 'fast');
  }
});
