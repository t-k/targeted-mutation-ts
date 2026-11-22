import assert from 'node:assert/strict';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractTypeScript } from '../src/typescript-extraction.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

const options = { file: 'tuple.ts', requireNative: true };
for (const [source, accepted] of [
  ['type Tail<T> = T extends [...string[], infer Last extends string] ? Last : never;', true],
  ['type Head<T> = [T extends [infer First extends string, number] ? First : never];', true],
  ['type Tail<T> = T extends [...string[], infer Last extends ] ? Last : never;', false],
  ['type Bad = [infer Last extends string];', false],
]) {
  for (const prefix of ['', '/* 海 🧪 */ const keep = a >= b; ']) {
    test(`Pulse conditional tuple (${Boolean(prefix)}): ${source}`, () => {
      const result = extract(prefix + source, options);
      if (accepted) {
        assert.equal(result.path, 'fast');
        assert.equal(result.candidates.length, prefix ? 1 : 0);
        for (const reference of [extractTypeScript(prefix + source, options), extractYuku(prefix + source, options)]) {
          assert.deepEqual(result.candidates, reference.candidates);
        }
      } else assert.notEqual(result.path, 'fast');
    });
  }
}
