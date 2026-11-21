import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const keys = { Identifier: 'token', Chain: 'Library.tokens.current', String: '"海"', Number: '0' };
const contexts = {
  Alias: member => `type View<T> = { ${member} };`,
  Interface: member => `interface View<T> { ${member} }`,
  Inline: member => `const view: { ${member} } = value;`,
};
const members = {
  Property: key => `[${key}]: Ready;`,
  Optional: key => `readonly [${key}]?: Ready;`,
  Method: key => `[${key}]<U>(arg: U): Ready;`,
  ReadonlyMethod: key => `readonly [${key}](): Ready;`,
};
const rows = readFileSync(new URL('../verification/pict/low-computed-type-members.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [key, context, member] = row.split('\t');
  test(`Low* computed type member: ${key} ${context} ${member}`, () => {
    const source = `const before = x < y; ${contexts[context](members[member](keys[key]))} const after = y >= x;`;
    compare(source, member === 'ReadonlyMethod' ? 'diagnostic' : 'fast');
  });
}

test('computed type members distinguish index signatures and keep comparison expressions visible', () => {
  compare('type View = { readonly [index: string]: Ready; [this.key]?: Ready; [keys.default]: Ready; }; const r = x < y;', 'fast');
  compare('type View = { [keys[x < y]]: Ready; }; const r = x >= y;', 'fallback');
  compare('type View = { [x < y]: Ready; }; const r = x >= y;', 'fallback');
  for (const key of ['default', 'index:', 'keys.']) {
    compare(`const before = x < y; type View = { [${key}]: Ready; };`, 'diagnostic');
  }
});
