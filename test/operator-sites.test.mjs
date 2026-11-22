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

test('a replacement that would merge with a neighbouring token is separated by spaces', () => {
  const rewrite = (source, pick = 0) => {
    const input = Buffer.from(source);
    const site = collectOperatorSites(input, 'a.ts')[pick];
    return Buffer.concat([input.subarray(0, site.edit[0]), Buffer.from(site.replacement), input.subarray(site.edit[1])]).toString();
  };
  assert.equal(rewrite('const c = a*/* factor */b;'), 'const c = a/ /* factor */b;');
  assert.equal(rewrite('const c = a+-b;'), 'const c = a- -b;');
  assert.equal(rewrite('const c = a-+b;'), 'const c = a+ +b;');
  assert.equal(rewrite('const c = a++-b;'), 'const c = a++ +b;');
  assert.equal(rewrite('const c = a*b;'), 'const c = a/b;');
  assert.equal(rewrite('const c = a === b;'), 'const c = a !== b;');
});

test('a nullish operator chained with another nullish operator is left alone', () => {
  // `a && b ?? c` and `a ?? b && c` do not parse without parentheses.
  assert.deepEqual(collectOperatorSites(Buffer.from('const v = a ?? b ?? c;'), 'a.ts'), []);
  const grouped = collectOperatorSites(Buffer.from('const v = (a ?? b) ?? c; const w = a ?? (b || c);'), 'a.ts');
  assert.deepEqual(grouped.map(site => [site.operator, site.replacement]), [['??', '&&'], ['??', '&&'], ['??', '&&'], ['||', '&&']]);
});

test('the Playwright scope keeps the operand edit and adds the operator swap at the same position', async () => {
  const { collectComparisons } = await import('../src/analysis.mjs');
  const collect = mutators => collectComparisons('fixtures/playwright', ['src/save.tsx'], { runner: 'playwright', mutators })
    .subjects.flatMap(subject => subject.sites).filter(site => site.operator === '||');
  const focused = collect(undefined);
  assert.equal(focused.length, 1);
  const extended = collect('operators');
  assert.equal(extended.length, 2);
  assert.deepEqual(extended.map(site => site.location), [focused[0].location, focused[0].location]);
  assert.deepEqual(extended.find(site => !site.unobserved).replacement, focused[0].replacement);
  assert.equal(extended.find(site => site.unobserved).replacement, '&&');
  assert.equal(new Set(extended.map(site => site.id)).size, 2);
});

test('an explicit dialect decides whether angle brackets are JSX', () => {
  const input = Buffer.from('export const view = <div>Hello + world</div>;');
  assert.deepEqual(collectOperatorSites(input, 'view.ts', { dialect: 'tsx' }), []);
  assert.deepEqual(collectOperatorSites(input, 'view.tsx'), []);
  const cast = Buffer.from('const n = <number>a + b;');
  assert.deepEqual(collectOperatorSites(cast, 'cast.tsx', { dialect: 'ts' }).map(site => site.operator), ['+']);
});

test('a logical swap inside another binary expression is rewritten as a parenthesized group', () => {
  const rewrite = (source, pick) => {
    const input = Buffer.from(source);
    const site = collectOperatorSites(input, 'a.ts')[pick];
    const { edit, replacement } = site.source ?? site;
    return [Buffer.concat([input.subarray(0, edit[0]), Buffer.from(replacement), input.subarray(edit[1])]).toString(),
      input.subarray(...site.edit).toString(), site.replacement];
  };
  // Without the group, `a || b && c` would mean a || (b && c).
  assert.deepEqual(rewrite('const v = a && b && c;', 0), ['const v = (a || b) && c;', '&&', '||']);
  assert.deepEqual(rewrite('const v = a && b && c;', 1), ['const v = a && b || c;', '&&', '||']);
  assert.deepEqual(rewrite('const v = a || b && c;', 0), ['const v = a && b && c;', '||', '&&']);
  assert.deepEqual(rewrite('const v = x === (a || b);', 1), ['const v = x === (a && b);', '||', '&&']);
  assert.deepEqual(rewrite('const v = (a ?? b) === c;', 0), ['const v = (a && b) === c;', '??', '&&']);
  assert.deepEqual(rewrite('const v = a ?? b + c;', 0), ['const v = a && b + c;', '??', '&&']);
  assert.deepEqual(rewrite('let n = 1\na && b && c()', 0), ['let n = 1\nvoid 0, (a || b) && c()', '&&', '||']);
  assert.deepEqual(rewrite('let n = 1\na && b && c()', 1), ['let n = 1\na && b || c()', '&&', '||']);
});

test('enum member initializers yield no site', () => {
  assert.deepEqual(collectOperatorSites(Buffer.from('const enum E { A = 1 + 2, B = A * 2 } enum F { C = 1 << 1 | 2 - 1 }'), 'a.ts'), []);
  assert.deepEqual(collectOperatorSites(Buffer.from('enum E { A } export const n = E.A + 1;'), 'a.ts').map(site => site.operator), ['+']);
});
