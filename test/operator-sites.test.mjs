import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { collectOperatorSites, operatorRules } from '../src/operator-sites.mjs';

const scenarios = readFileSync(new URL('../verification/pict/operator-sites.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const families = {
  StrictEquality: [['===', '!=='], ['!==', '===']],
  LooseEquality: [['==', '!='], ['!=', '==']],
  Logical: [['&&', '||'], ['||', '&&']],
  Nullish: [['??', '&&']],
  Additive: [['+', '-'], ['-', '+']],
  Multiplicative: [['*', '/'], ['/', '*'], ['%', '*']],
};
const rules = { StrictEquality: 'equality-negation/v1', LooseEquality: 'equality-negation/v1', Logical: 'logical-operator/v1',
  Nullish: 'logical-operator/v1', Additive: 'arithmetic-operator/v1', Multiplicative: 'arithmetic-operator/v1' };

for (const [family, operands, dialect] of scenarios) {
  for (const [operator, replacement] of families[family]) {
    test(`operator site: ${family} ${operator} ${operands} ${dialect}`, () => {
      const typed = dialect === 'Js' ? '' : ': any';
      const left = operands === 'StringLiteral' ? "'x'" : 'a';
      // Operator spellings in comments, strings, types and JSX text are not expressions.
      const lines = [
        operands === 'NonAscii' ? `/* é😀 ${operator} */ const label = "日本語 ${operator} b";` : `// a ${operator} b`,
        dialect === 'Js' ? '' : 'type Either = { a: 1 } | { b: 2 } & { c: 3 };',
        `export const value = (a${typed}, b${typed}) => ${left} ${operator} b;`,
        dialect === 'Tsx' ? `export const view = <p title="a ${operator} b">a ${operator} b</p>;` : '',
      ];
      const input = Buffer.from(lines.join('\n'));
      const file = { Ts: 'src/value.ts', Tsx: 'src/value.tsx', Js: 'src/value.js' }[dialect];
      const sites = collectOperatorSites(input, file);
      if (operator === '+' && operands === 'StringLiteral') {
        assert.deepEqual(sites, []);
        return;
      }
      assert.equal(sites.length, 1, JSON.stringify(sites));
      const [site] = sites;
      assert.deepEqual([site.rule, site.operator, site.replacement, site.unobserved], [rules[family], operator, replacement, true]);
      assert.equal(input.subarray(...site.edit).toString(), operator);
      assert.equal(input.subarray(...site.left).toString(), left);
      assert.equal(input.subarray(...site.right).toString(), 'b');
      assert.equal(input.indexOf(`${left} ${operator} b;`) + Buffer.byteLength(left) + 1, site.edit[0]);
    });
  }
}

test('nested operators are reported in source order and comparisons are left to the native extractor', () => {
  const input = Buffer.from('export const f = (a: number, b: number, c: string) => a * b + 1 >= 3 && c !== `v${a - b}` || a + `x` > c;');
  const sites = collectOperatorSites(input, 'f.ts');
  assert.deepEqual(sites.map(site => [site.operator, site.replacement]),
    [['*', '/'], ['+', '-'], ['&&', '||'], ['!==', '==='], ['-', '+'], ['||', '&&']]);
  assert.deepEqual(sites.map(site => site.edit[0]), sites.map(site => site.edit[0]).toSorted((a, b) => a - b));
  for (const site of sites) assert.equal(input.subarray(...site.edit).toString(), site.operator);
  assert.equal(input.subarray(...sites[2].left).toString(), 'a * b + 1 >= 3');
});

test('assignments, unary operators and files without operators yield no site', () => {
  assert.deepEqual(collectOperatorSites(Buffer.from('let a = 1; a += 2; a -= -a; a++; const b = !a; const c = a < 2;'), 'a.ts'), []);
  assert.deepEqual(collectOperatorSites(Buffer.from(''), 'a.ts'), []);
});

test('every rule replaces an operator with a different operator of the same family', () => {
  assert.equal(operatorRules.size, 12);
  for (const [operator, [rule, replacement]] of operatorRules) {
    assert.notEqual(operator, replacement);
    assert.match(rule, /^(equality-negation|logical-operator|arithmetic-operator)\/v1$/);
  }
});
