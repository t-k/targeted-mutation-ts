import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'frontier.ts', requireNative: true };
function check(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}
const variance = readFileSync(new URL('../verification/pict/pulse-interface-variance.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of variance) {
  const [prefix, tail, context] = row.split('\t');
  test(`Pulse interface variance ${prefix} ${tail} ${context}`, () => {
    const name = { In: 'in T', Out: 'out T', Both: 'in out T', BareOut: 'out',
      Reversed: 'out in T', Newline: 'in\nout T' }[prefix];
    const parameter = name + { Plain: '', Bound: ' extends Base', Default: ' = Base' }[tail];
    const type = `interface Container<${parameter}> {}`;
    const declaration = {
      TopLevel: type, Ambient: `declare module "pkg" { export ${type} }`,
      Function: `function wrap<${parameter}>() {}`,
    }[context];
    check(`/* 海 */ ${declaration} const hit = a < b;`,
      (prefix === 'BareOut' && tail !== 'Bound') || context !== 'Function' && !['Reversed', 'Newline', 'BareOut'].includes(prefix));
  });
}

test('type getters retain their return type and distinguish an ordinary get member', () => {
  check('interface View { get selectors(): Map<string, number>; get(): number; get?: string } const hit = a < b;', true);
  for (const getter of ['get value<T>(): T', 'get value?(): number', 'get value(x: number): number', 'get a-b(): number']) {
    check(`type View = { ${getter} }; const hit = a < b;`, false);
  }
});

test('local interfaces are scoped and module interfaces can merge with a type-only namespace', () => {
  check('function run(){ interface Entry { key: string } return a < b; } const next = c >= d;', true);
  check('export interface Entry {} export namespace Entry { export interface Props {} } const hit = a < b;', true);
  check('namespace Entry { export interface Props {} } interface Entry {} const hit = a < b;', true);
  check('type Entry = string; interface Entry {} const hit = a < b;', false);
  check('namespace Entry { export const key = 1; } interface Entry {} const hit = a < b;', false);
});

test('ambient typed functions accept annotated single parameters without initializers', () => {
  check('declare global { function Show<T>(props: Props<T>): Node<T>\nfunction Close(): void; } const hit = a < b;', true);
  for (const mixed of ['var item: number; function item(): void;', 'function item(x: number, x: number): void;',
    'function item(x = a > b): void;', 'function item(): void {}']) {
    check(`declare global { ${mixed} } const hit = a < b;`, false);
  }
  check('declare global { var item: number; } declare global { function item(): void; } const hit = a < b;', false);
  check('declare global { function item(): void; } declare global { var item: number; } const hit = a < b;', false);
});

test('a typed callback can end in a simple object binding', () => {
  check('type Read = (input: unknown, { key, }: { key: string },) => number; const hit = a < b;', true);
  check('type Read = ({ key }: { key: string }) => number; const hit = a < b;', true);
  for (const params of ['key: unknown, { key }: Input', '{ key = 1 }: Input', '{ key, other }: Input',
    '{ key }: Input, other: number', '...{ key }: Input']) {
    check(`type Read = (${params}) => number; const hit = a < b;`, false);
  }
});

test('constructor and override signatures resolve to their matching implementation', () => {
  check('class Box extends Base { constructor(n: number); constructor(...items: string[]); constructor(n: unknown) { super(n); } override getMore(n: number): number; override getMore(n: number) { return n < limit; } } const hit = a < b;', true);
  for (const members of ['constructor(n: number);', 'constructor(n: number); other() {} constructor(n: number) {}',
    'constructor(n: number) {} constructor(n: string) {}',
    'constructor(public n: number); constructor(n: number) {}',
    'override getMore(n: number): number; getMore(n: number) { return n < limit; }']) {
    check(`class Box extends Base { ${members} } const hit = a < b;`, false);
  }
});
