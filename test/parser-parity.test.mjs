import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function rows(name) {
  return readFileSync(new URL(`../verification/pict/${name}.tsv`, import.meta.url), 'utf8')
    .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
}

function compare(source, diagnostic) {
  const result = extract(source, { requireNative: true, file: 'subject.ts' });
  const reference = (result.path === 'fast' ? extractYuku : extractFallback)(source, { file: 'subject.ts' });
  assert.equal(reference.path === 'diagnostic', diagnostic, source);
  assert.equal(result.path === 'diagnostic', diagnostic, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  return result;
}

for (const [assertion, grouping, update] of rows('assertion-update-parity')) {
  test(`assertion/update syntax: ${assertion} ${grouping} ${update}`, () => {
    const left = `ready ${assertion.toLowerCase()} boolean`;
    const expression = { Inc: '++count', Dec: '--count', Unary: '+count' }[update] + ' < limit';
    const condition = grouping === 'Assertion' ? `(${left})` : left;
    const consequent = grouping === 'Consequent' ? `(${expression})` : expression;
    const source = `const before = a >= b; const ok = ${condition} ? /* trivia */ ${consequent} : false;`;
    const diagnostic = grouping === 'None' && update !== 'Unary';
    const result = compare(source, diagnostic);
    if (!diagnostic) assert.equal(result.path, 'fast', source);
  });
}

for (const [kind, field, spelling] of rows('ambient-prototype-parity')) {
  test(`static prototype syntax: ${kind} ${field} ${spelling}`, () => {
    const key = { Identifier: 'prototype', Quoted: '"prototype"', Computed: '["prototype"]' }[spelling];
    const source = (kind === 'Ambient' ? 'declare ' : '') + 'class Holder { ' +
      (field === 'Static' ? 'static ' : '') + key + ': unknown; } const ok = a < b;';
    compare(source, field === 'Static' && spelling !== 'Computed');
  });
}

test('reserved and contextual type index names retain reference syntax', () => {
  for (const name of ['await', 'in', 'const', 'this', 'true', 'void', 'let', 'yield', 'type', 'eval']) {
    const source = `interface Holder { [${name}: string]: number; } const ok = a < b;`;
    compare(source, ['await', 'in', 'const', 'this', 'true', 'void'].includes(name));
  }
});

test('ambient and runtime static prototype member definitions defer to reference diagnostics', () => {
  for (const source of [
    'declare class Holder { static prototype(): void; } const ok = a < b;',
    'declare class Holder { static get prototype(): unknown; } const ok = a < b;',
    'declare class Holder { static accessor "prototype": unknown; } const ok = a < b;',
    'class Holder { static accessor prototype = 1; } const ok = a < b;',
  ]) compare(source, true);
  compare('class Holder { static ["prototype"]() {} } const ok = a < b;', false);
});
