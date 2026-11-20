import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareConventional } from '../src/conventional.mjs';

const rows = readFileSync(new URL('../verification/pict/conventional-scope.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(line => line.trim().split('\t'));

for (const [scope, newline, prefix] of rows) {
  test(`conventional scope: ${scope} ${newline} ${prefix}`, async () => {
    const name = 'src/limits.ts';
    const eol = newline === 'CRLF' ? '\r\n' : '\n';
    const label = prefix === 'Astral' ? '😺' : 'ABC';
    const input = Buffer.from([
      `export const upper = (s: string, x: number) => s === '${label}' ? x < 3 : false;`,
      'export const lower = (x: number) => x > 2;',
    ].join(eol));
    const result = await prepareConventional([{ file: name, input, selected: line => scope === 'All' || scope === 'Line' && line === 1 }]);
    assert.equal(result.sources[0]?.file, scope === 'None' ? undefined : name);
    assert.equal(result.mutants.some(mutant => mutant.location.line === 2), scope === 'All');
    assert.equal(result.mutants.some(mutant => mutant.location.line === 1), scope !== 'None');
    for (const mutant of result.mutants) {
      assert.equal(input.subarray(...mutant.edit).toString(), mutant.original);
      assert.equal(mutant.location.file, name);
    }
    if (scope === 'None') return;
    const changed = result.mutants.find(mutant => mutant.original === 'x < 3' && mutant.replacement === 'x <= 3');
    assert.ok(changed);
    assert.equal(changed.location.start, input.indexOf('x < 3'));
    assert.equal(changed.location.end, input.indexOf('x < 3') + 5);
    assert.ok(result.sources[0].output.includes('__stryker__'));
  });
}

test('does not mutate a node spanning an unselected line or a disabled node', async () => {
  const input = Buffer.from(`export function isInRange(n: number) {
  if (n >=
      0) return true;
  // Stryker disable next-line all
  return n < 2;
}
`);
  const collect = selected => prepareConventional([{ file: 'limits.ts', input, selected }]);
  const result = await collect(line => line >= 2 && line <= 3 || line === 5);
  const order = result.mutants.filter(mutant => mutant.mutatorName === 'EqualityOperator');
  assert.equal(order.some(mutant => mutant.original.includes('n >=')), true);
  assert.equal(order.find(mutant => mutant.original === 'n < 2')?.status, 'ignored');
  const secondOnly = await collect(line => line === 2);
  assert.equal(secondOnly.mutants.some(mutant => mutant.original.includes('n >=')), false);
});

test('rejects malformed UTF-8 instead of reporting shifted offsets', async () => {
  const input = Buffer.concat([Buffer.from('// '), Buffer.of(255), Buffer.from('\nexport const b = a < 3;')]);
  await assert.rejects(prepareConventional([{ file: 'invalid.ts', input, selected: () => true }]), /Invalid UTF-8 in invalid.ts/);
});

test('preserves byte edits for comparisons in TSX attributes', async () => {
  const input = Buffer.from('export const Button = ({ value }: { value: number }) => <button title="⏳" disabled={value < 1} />;');
  const result = await prepareConventional([{ file: 'button.tsx', input, selected: () => true }]);
  const variant = result.mutants.find(mutant => mutant.original === 'value < 1' && mutant.replacement === 'value <= 1');
  assert.ok(variant);
  assert.equal(variant.edit[0], input.indexOf('value < 1'));
});
