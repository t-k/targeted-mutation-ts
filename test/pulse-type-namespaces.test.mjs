import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'namespaces.ts', mode: 'module', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-type-namespaces.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [scope, member, suffix] = row.split('\t');
  test(`Pulse type namespace: ${scope} ${member} ${suffix}`, () => {
    const text = {
      Interface: 'interface Options { min: number }',
      Alias: 'export type Option = number | string;',
      Mixed: 'export type Option = number; interface Options { value: Option }',
      DuplicateAlias: 'type Option = number; type Option = string;',
      Runtime: 'const value = x >= y;',
    }[member];
    const wrapped = `namespace Shapes { ${text} }`;
    const namespaces = { Local: wrapped, Exported: 'export ' + wrapped, Global: `declare global { ${wrapped} }` };
    const source = `import "setup"; /* 海 🧪 */ ${namespaces[scope]} const hit = a < b;` +
      (suffix === 'Broken' ? ' const =' : '');
    const fast = suffix === 'Valid' && (member === 'Interface' || scope !== 'Global' && ['Alias', 'Mixed'].includes(member));
    compare(source, fast);
  });
}

test('namespace scope does not leak members to outer exports or sibling scopes', () => {
  compare('namespace One { type Entry = number; } namespace Two { type Entry = string; } let age = a < b;', true);
  compare('namespace One { type Entry = number; } export { Entry };', false);
  compare('const One = age < limit; export namespace One { interface Entry {} }', false);
  compare('namespace One { namespace Other { type Entry = 1; } }', false);
});

test('global augmentations keep the supported mergeable interfaces', () => {
  compare('import "setup"; declare global { namespace Shapes { interface Entry {} interface Entry { id: string } } } const hit = a < b;', true);
  compare('import "setup"; declare global { namespace Shapes { interface Entry { id: } } } const hit = a < b;', false);
});

test('large interface-only namespaces keep the native sibling loop bounded', () => {
  const members = 'interface Options {}\n'.repeat(24_000);
  const source = `import "setup"; declare global { namespace Shapes { ${members} } } const hit = a < b;`;
  const result = extract(source, options);
  assert.equal(result.path, 'fast');
  assert.equal(result.candidates.length, 1);
  assert.equal(Buffer.from(source).subarray(...result.candidates[0].edit).toString(), '<');
});
