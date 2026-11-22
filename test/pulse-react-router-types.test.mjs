import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'router.ts', mode: 'module', requireNative: true };
function compare(source, fast) {
  const actual = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
  assert.equal(actual.path === 'fast', fast, source);
}
const rows = readFileSync(new URL('../verification/pict/pulse-react-router-types.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const tokens = {
  ObjectInfer: ['type Query<T> = T extends { pages: infer P extends ReadonlyArray<string>; } ? P : never;',
    'type Query<T> = T extends { pages: infer P extends ; } ? P : never;'],
  TemplateInfer: ['type Token<T> = T extends `\${infer Head extends string}\${infer Rest}` ? [Head, Rest] : never;',
    'type Token<T> = T extends `\${infer Head extends }\${infer Rest}` ? [Head, Rest] : never;'],
  SignatureBinding: ['type Encode = (request: object, {onError, references,}: object,) => string;',
    'type Encode = (request: object, {onError, onError}: object,) => string;'],
  EscapedKey: [String.raw`const layout = { "\u2028": a < b, '\u20a0': c > d };`,
    String.raw`const layout = { "\u20XX": a < b };`],
};
for (const row of rows) {
  const [surface, input, suffix] = row.split('\t');
  test(`Pulse router type: ${surface} ${input} ${suffix}`, () => {
    const code = tokens[surface][Number(input === 'Invalid')];
    compare(`/* 海 🧪 */ const hit = a >= b; ${code}${suffix === 'Broken' ? ' const =' : ''}`,
      input === 'Valid' && suffix === 'Complete');
  });
}
test('special ASCII keys, signature defaults, and runtime templates retain their behavior', () => {
  compare(String.raw`const object = { "__pro\u0074o__": a < b, __proto__: c < d };`, false);
  compare(String.raw`class Shape { static "pro\u0074otype" = a < b; }`, false);
  compare(String.raw`class Shape { "\u00E9" = a < b; }`, true);
  compare('type Member = (x: number, {x, other}: object) => string;', false);
  compare('type Member = ({x, other = a < b}: object) => string;', false);
  compare('type Member = ({x, y: z}: object) => string;', false);
  compare('type Member = ({x, y}: object, other: number) => string;', false);
  compare('type Query<T> = T extends { value: infer P; } ? P : never; const run = `\${a < b}`;', true);
});
