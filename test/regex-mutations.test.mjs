import assert from 'node:assert/strict';
import test from 'node:test';
import * as weaponRegex from 'weapon-regex';
import { mutatePattern } from '../src/regex-mutations.mjs';

// The reference is the library StrykerJS uses, at the level StrykerJS selects.
function reference(pattern, flags) {
  try {
    return weaponRegex.mutate(pattern, flags, { mutationLevels: [1] }).map(mutant => mutant.pattern);
  } catch {
    return [];
  }
}

const patterns = [
  ['^abc$'], ['abc'], ['^\\d+$'], ['\\D\\s\\S\\w\\W'], ['[abc]'], ['[^abc]+'], ['[a-z0-9_]*x?'], ['a{2}b{2,}c{2,5}'],
  ['a+?b*?c??d{1,2}?'], ['(?=a)(?!b)(?<=c)(?<!d)e'], ['(?:ab)+|(c)\\1'], ['(?<year>\\d{4})-\\k<year>'], ['\\bfoo\\B'],
  ['^(?:\\r\\n|[\\n\\r\\u2028\\u2029])'], ['[\\]\\\\^-]'], ['[\\d\\s]'], ['a\\.b\\*c\\+'], ['\\/\\*[\\s\\S]*?\\*\\/'],
  ['^-?\\s*\\d+$'], ['^(.*):(\\d+)(?:-(\\d+))?$'], ['\\x41\\u0042\\cA'], ['.*'], ['^$'], ['a|b|^c$'], ['[[]'], ['[]a]'], ['x{,3}'], ['{'],
  ['\\p{Lu}+\\P{L}', 'u'], ['\\p{Lu}', ''], ['\\u{1F600}+', 'u'], ['[\\p{L}--\\p{Lu}]', 'v'], ['^a', 'gim'], ['a$', 'm'], ['\\$\\^'],
  ['\\/\\*[^]*?@(?:no)?flow\\b[^]*?\\*\\/'], ['[]|a+'], ['[^]+x?'], ['\\s+|\\/\\/[^\\r\\n\\u2028\\u2029]*|<=|>=', 'gy'],
];

for (const [pattern, flags] of patterns) {
  test(`regex mutations of /${pattern}/${flags ?? ''} match the reference`, () => {
    assert.deepEqual(mutatePattern(pattern, flags).toSorted(), [...new Set(reference(pattern, flags))].toSorted());
  });
}

test('every mutation compiles, differs from the original, and unparsable patterns yield none', () => {
  for (const [pattern, flags] of patterns) {
    for (const mutated of mutatePattern(pattern, flags)) {
      assert.notEqual(mutated, pattern);
      assert.doesNotThrow(() => new RegExp(mutated, flags));
    }
  }
  assert.deepEqual(mutatePattern('', 'g'), []);
  assert.deepEqual(mutatePattern('(', ''), []);
  assert.deepEqual(mutatePattern('[a', ''), []);
  assert.deepEqual(mutatePattern('a', 'zz'), []);
});
