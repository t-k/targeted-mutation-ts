import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  if (path) assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const members = {
  Plain: '{ score(n: number): boolean { return this.score < n; } }',
  Derived: 'extends OriginalHeaders { constructor(init?: HeaderOptions) { count += 1; super(init); record(count > max); } }',
  Static: 'extends core.Parent<Init> { static async load(n: number) { return await super.check(n > limit); } }',
  Field: '<T> implements Contracts.Entry<T>, HasCount { count?: number; value: T; score() { return this.count <= max; } }',
};
const placement = {
  Module: body => `export class Check ${body}\nconst done = value < max;`,
  Function: body => `function wrapper() { class Check ${body} return run() >= limit; }`,
  Default: body => `export default class Check ${body}\nconst done = value < max;`,
};
const rows = readFileSync(new URL('../verification/pict/low-classes.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [member, place, suffix] = row.split('\t');
  test(`Low* class: ${member} ${place} ${suffix}`, () => {
    const source = placement[place](members[member]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('class bodies separate constructor and super contexts across functions', () => {
  for (const source of [
    'export default class { score() { return super.count < limit; } }',
    'export default class extends Parent { "constructor"(n) { super(n > limit); } }',
    'class Check extends Parent { constructor() { const f = () => super(n >= limit); f(); } }',
    'class Check { static constructor() { return a < b; } constructor() {} }',
    'class Check { static() { return a < b; } async() { return b < c; } "read"() { return c < d; } }',
  ]) compare(source, 'fast');

  for (const source of [
    'class Check { constructor() { super(a < b); } }',
    'class Check extends Parent { go() { super(a < b); } }',
    'class Check extends Parent { constructor<T>() { super(a < b); } }',
    'class Check extends Parent { constructor() { function nested() { super(a < b); } } }',
    'class Check extends Parent { method() { function nested(value = super.x) { return a < b; } } }',
    'class Check { "constructor"() {} constructor() { record(a < b); } }',
    'class Check { static "prototype"() { return a < b; } }',
    'class Check { static constructor; } const ok = a < b;',
    'class Check { static "constructor": string; } const ok = a < b;',
    'class Check { value:; go() { return a < b; } }',
    'class Check { go() { return a < b; } } const Check = value;',
    'export default class Check {} export default class { go() { return a < b; } }',
  ]) compare(source, 'diagnostic');
});
