import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'abstract.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-abstract-classes.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [declaration, member, boundary] = row.split('\t');
  test(`Pulse abstract class: ${declaration} ${member} ${boundary}`, () => {
    const prefix = { Abstract: 'abstract ', Exported: 'export abstract ', Concrete: '' }[declaration];
    const element = {
      Property: 'abstract entry: Response', Readonly: 'abstract readonly entry: Response',
      Method: 'abstract handle(input: Response | Promise<Response>): void',
      Initializer: 'abstract entry: number\n = (age >= limit)',
      Implementation: 'abstract handle(): boolean { return age < limit; }',
      Constructor: 'abstract constructor(value: number): void',
    }[member];
    const separator = boundary === 'Semicolon' ? '; ' : '\n';
    const source = `/* 🧪 海 */ ${prefix}class Controller {
      ${element}${separator}check() { return score <= limit; }
    }${boundary === 'Broken' ? '\nconst =' : ''}`;
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    if (declaration !== 'Concrete' && boundary !== 'Broken' && ['Property', 'Readonly', 'Method'].includes(member)) {
      assert.equal(result.path, 'fast', source);
      assert.equal(result.candidates.length, 1, source);
    } else {
      assert.notEqual(result.path, 'fast', source);
    }
  });
}

test('abstract remains an ordinary member name when no modifier is present', () => {
  const source = 'abstract class Controller { abstract(n: number) { return n < 1; } }';
  const result = extract(source, options);
  assert.equal(result.path, 'fast');
  assert.deepEqual(result.candidates, extractFallback(source, options).candidates);
});

test('declaration and explicit export still conflict under the usual binding rules', () => {
  const source = 'export abstract class Controller { abstract run(): void; } export { Controller };';
  assert.notEqual(extract(source, options).path, 'fast');
});
