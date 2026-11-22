import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractTypeScript } from '../src/typescript-extraction.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

const options = { file: 'binding.ts', requireNative: true };
const cases = readFileSync(new URL('../verification/pict/pulse-binding-defaults.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

function compare(source, expected) {
  const result = extract(source, options);
  assert.equal(result.path, expected, source);
  for (const oracle of [extractTypeScript, extractYuku]) {
    assert.deepEqual(result.candidates, oracle(source, options).candidates, source);
  }
  return result;
}

for (const row of cases) {
  const [context, kind, tail] = row.split('\t');
  test(`Pulse binding default: ${context} ${kind} ${tail}`, () => {
    const value = {
      Property: 'globalThis.console',
      Call: 'getEtag(content, { weak: true })',
      Class: 'class {} as typeof globalThis.HTMLElement',
      Comparison: 'item > cutoff',
    }[kind];
    const binding = `item = ${value}`;
    const statement = {
      ExportedObject: `export const { ${binding} } = data;`,
      Array: `const [${binding}] = data;`,
      Function: `function check({ ${binding} }) { return item <= cutoff; }`,
      Arrow: `const check = ({ ${binding} }) => item <= cutoff;`,
    }[context];
    const source = `/* 海 🧪 */\n${statement}` + (tail === 'Broken' ? '\nconst =' : '');
    const result = compare(source, tail === 'Complete' ? 'fast' : 'diagnostic');
    if (tail === 'Broken') assert.equal(result.candidates.length, 0);
    else assert.equal(result.candidates.length, Number(kind === 'Comparison') + Number(context === 'Function' || context === 'Arrow'));
  });
}

test('namespace star exports reserve their public name and preserve later candidates', () => {
  for (const prefix of ['export * as API', 'export type * as API', 'export * as default']) {
    compare(`${prefix} from 'module'; const value = left > right;`, 'fast');
    compare(`${prefix} from 'module'; ${prefix} from 'other'; const value = left > right;`, 'diagnostic');
  }
});

test('nested defaults preserve binding identities and fail closed on truncated expressions', () => {
  compare('const { x = (() => { const x = 1; return x > 0; })(), y = z < w } = data;', 'fast');
  compare('const { a: { b = a < 1 }, c = z >= w } = data;', 'fast');
  compare('const { x = arrow(b > c), x } = data;', 'diagnostic');
  compare('const { x = arrow(a < b, } = data;', 'diagnostic');
});
