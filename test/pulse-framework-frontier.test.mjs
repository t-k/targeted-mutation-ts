import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast, dialect = 'ts') {
  const options = { file: `frontier.${dialect}`, dialect, mode: 'module', requireNative: true };
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const matrix = readFileSync(new URL('../verification/pict/pulse-framework-frontier.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const forms = {
  Decimal: ['class Entry { 0: string; static 23 = a < b; } interface Items { 100?: Entry }',
    'class Entry { 07: string; } interface Items { 100n?: Entry }'],
  Angle: ['export default <Environment>{ check() { return a > b; }, other: total < .5 };',
    'export default <Environment>{ field: a < b;'],
  AmbientClass: ['declare class Entry { constructor(key: string); item: number; read(): boolean; }',
    'declare class Entry { read(): boolean { return a < b; } }'],
  AmbientNamespace: ['export declare namespace Entry { export interface Result { valid: boolean; } }',
    'export declare namespace Entry { export const valid = a < b; }'],
  AmbientEnum: ['declare enum Flag { Left, Right = 2 }', 'declare enum Flag { Left = }'],
  InterfaceMerge: ['export interface Entry { left: number; } export interface Entry { right: number; }',
    'export interface Entry<T> { left: T; } export type Entry<T> = { right: T; };'],
  CallComma: ['test(actual < expected, `expected \${actual} less than \${expected}`, expected, actual, false,);',
    'test(actual < expected, other >= limit);'],
};
for (const row of matrix) {
  const [surface, input, suffix] = row.split('\t');
  test(`Pulse framework frontier: ${surface} ${input} ${suffix}`, () => {
    const source = `/* 海 🧪 */ const earlier = x >= y; ${forms[surface][Number(input === 'Deferred')]}` +
      (suffix === 'Broken' ? ' const =' : '');
    compare(source, input === 'Supported' && suffix === 'Complete');
  });
}

test('generic calls, TypeScript assertions, and mixed interface declarations retain their meaning', () => {
  compare('const output = take(a<b,c>(d));', true);
  compare('const output = take(a < b, c > (d));', false);
  compare('const statement = <number>value >= limit;', false);
  compare('const statement = <number>value >= limit;', false, 'tsx');
  compare('const statement = <number>value ** 2 < limit;', false);
  compare('a < <T|U>(b);', false);
  compare('a << <T|U>(b);', false);
  compare('a<<T|U>(b);', false);
  compare('a<<T.U>(b);', false);
  compare('a<<T(U)>(b);', false);
  compare('a<<T.U>\nb;', false);
  compare('a<<T|U>`template`;', false);
  compare('a<<T|U>/x/;', false);
  compare('export default <T>{ n: a<<T|U>\nb };', false);
  compare('<N>(a<<T|U>(b));', false);
  compare('a<<b;', true);
  compare('a<<T>(b);', true);
  compare('const statement = a >= <number>value;', false);
  compare('const x = await <T>v;', false);
  compare('const x = await !<T>v;', false);
  compare('const x = <T>await {};', false);
  compare('export default <T>{}\n(1) < 2;', false);
  compare('export default <Environment>{ valid: a >= b }', true);
  compare('export interface Entry {} interface Entry { key: number; }', true);
  compare('export interface Entry<T> { left: T; } export interface Entry<T> { right: T; }', true);
  compare('export interface Entry {} export type Entry = number;', false);
  compare('export interface Entry {} export interface Entry extends Base {}', true);
  compare('declare class Entry { constructor(key: string) {} }', false);
  compare('class Entry { 12foo: number; }', false);
  compare('declare enum A { X = () => { function f() {} } } const yes = x < y;', false);
  compare('declare enum A { X = -4, Y = 2 } const yes = x < y;', true);
});

test('declared namespaces can export previously bound module names without leaking their members', () => {
  compare('import type { Item, Options } from "types"; export declare namespace Models { export { Item, Options, } } const hit = a < b;', true);
  compare('import type { Item } from "types"; export declare namespace Models { export { Item, Missing } }', false);
  compare('import type { Item } from "types"; export declare namespace Models { export { Item, Item } }', false);
  compare('import type { Item } from "types"; export declare namespace Models { export { Item as Value } }', false);
  compare('declare interface Entry { key?: number } const hit = a < b;', true);
});

test('a two-lane signature fingerprint collision does not defer distinct parameters', () => {
  const helper = 'export const below = () => value < limit;';
  const signature = (name) => 'export type Fetch = (id: string, importer?: string, ' + name + '?: Options) => Result;';
  compare(signature('options') + helper, true);
  compare(signature('importer') + helper, false);
  compare('export type Fetch = (code: string, expression: Expr, componentNames: Names, target: Target, diagnostics: Diagnostic[], bodyStatementJsx: Mode, serverRenderValueWrapper?: string, localJsxReturnFunctionNames?: Names, serverOutput?: string) => Result;' + helper, true);
});
