import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const fixtures = {
  Numeric: 'export enum Ready { Zero, Minus = -2, Next, Reset = 4, Final, }',
  Strings: 'export const enum Ready { First = "yes", Second = "いいえ", Number = 42 }',
  Automatic: 'export const View = (x: number) => <><div enabled title="a &amp; b">{x}<br/></div></>;',
  Classic: 'export const View = (x) => <div enabled title="text">{x}<br/></div>;',
};

const data = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const runtime = data('export const Fragment = "fragment"; export function jsx(type, props) { return {type, props}; } export const jsxs = jsx;');
const classic = 'const React = {Fragment:"fragment", createElement(type, props, ...children) { return {type, props, children}; }};\n';
async function load(code) {
  return import(data(classic + code.replace(/(["'])react\/jsx-runtime\1/g, JSON.stringify(runtime))));
}

const rows = readFileSync(new URL('../verification/pict/compiler-lowering.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [form, layout, tail] = row.split('\t');
  test('native runtime lowering ' + row.replaceAll('\t', ' '), async () => {
    const jsx = form === 'Classic' ? 'classic' : 'automatic';
    const file = form === 'Classic' ? 'input.jsx' : form === 'Automatic' ? 'input.tsx' : 'input.ts';
    const source = (layout === 'Unicode' ? '/* 東京🧪 */\r\n' : '') + fixtures[form] +
      (tail === 'Broken' ? ' export const x =' : '');
    const native = compile(source, { file, jsx });
    if (tail === 'Broken') {
      assert.equal(native.code, null);
      assert.notEqual(native.backend, 'pulse');
      return;
    }
    assert.equal(native.backend, 'pulse');
    assert.deepEqual(native.diagnostics, []);
    const reference = compile(source, { file, jsx, sourceMap: true });
    assert.deepEqual(reference.diagnostics, []);
    const x = await load(native.code);
    const y = await load(reference.code);
    if (x.Ready) assert.deepEqual(x.Ready, y.Ready);
    else assert.deepEqual(x.View(42), y.View(42));
  });
}

test('native enum and JSX lowering do not load TypeScript', () => {
  const source = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'typescript') throw new Error('TypeScript loaded');
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    for (const [file, text] of [['main.ts', 'export enum Mode { One = 1, Two }'],
      ['main.tsx', 'export const App = () => <div title="ok"><strong>ready</strong></div>']]) {
      if (compile(text, { file }).backend !== 'pulse') throw new Error(file);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('native runtime lowering defers ambiguous transforms and honors options', () => {
  for (const [file, source] of [
    ['main.tsx', 'export const View = () => <span key="view" />;'],
    ['main.tsx', '/** @jsxImportSource alternate */ export const View = <span />;'],
    ['main.tsx', 'export const View = () => <span></em>;'],
    ['main.ts', 'export enum Ready { A = compute(), B }'],
    ['main.ts', 'export enum Ready { A = "s", B }'],
  ]) assert.notEqual(compile(source, { file }).backend, 'pulse');
  assert.notEqual(compile(fixtures.Automatic, { file: 'input.tsx', jsx: 'preserve' }).backend, 'pulse');
  assert.notEqual(compile(fixtures.Numeric, { target: 'es2018', sourceMap: true }).backend, 'pulse');
});

test('automatic JSX imports exactly the helpers used by emitted code', async () => {
  const source = 'export const X = <i/>;';
  const result = compile(source, { file: 'fixture.tsx' });
  assert.equal(result.backend, 'pulse');
  const jsxOnly = data('export function jsx(type, props) { return {type, props}; }');
  const code = result.code.replace(/(["'])react\/jsx-runtime\1/g, JSON.stringify(jsxOnly));
  assert.deepEqual((await import(data(code))).X, { type: 'i', props: {} });
});

test('runtime lowering preserves JSX this and enum zero semantics', async () => {
  const jsx = 'export const View = () => <this/>;';
  const nativeJsx = compile(jsx, { file: 'input.tsx' });
  const refJsx = compile(jsx, { file: 'input.tsx', sourceMap: true });
  assert.deepEqual((await load(nativeJsx.code)).View(), (await load(refJsx.code)).View());
  const nativeEnum = compile('export enum E { Z = -0, Next }');
  const module = await load(nativeEnum.code);
  assert.equal(Object.is(module.E.Z, 0), true);
  assert.equal(module.E.Next, 1);
});

test('JSX pragma matching is case-insensitive and Unicode separators defer to the layout-aware emitter', () => {
  const pragma = compile('/** @JSXImportSource preact */ export const X = <i/>;', { file: 'input.tsx' });
  assert.equal(pragma.backend, 'typescript');
  assert.match(pragma.code, /preact\/jsx-runtime/);
  for (const separator of ['\u2028', '\u2029']) {
    assert.equal(compile('export const X = <i>a' + separator + 'b</i>;', { file: 'input.tsx' }).backend, 'typescript');
  }
});

test('mixed modules lower local enums after imports and preserve the value code', async () => {
  const source = 'import type { Mark } from "unused";\n' +
    'export const before: number = 42;\nconst enum State { Red, Green = 4, Blue }\n' +
    'export function state(): number { return State.Blue; }';
  const lowered = compile(source);
  assert.equal(lowered.backend, 'pulse+node-strip');
  assert.doesNotMatch(lowered.code, /\bconst enum\b/);
  const module = await load(lowered.code);
  assert.equal(module.before, 42);
  assert.equal(module.state(), 5);
});

test('mixed TSX modules lower multiple declarations and share one runtime import', async () => {
  const source = 'import type { Config } from "unused";\nexport const size: number = 2;\n' +
    'export const View = (x: number) => <span>{x}</span>;\nconst other = <i/>;\nexport const get = () => other;';
  const lowered = compile(source, { file: 'input.tsx' });
  assert.equal(lowered.backend, 'pulse+node-strip');
  assert.equal(lowered.code.match(/react\/jsx-runtime/g).length, 1);
  const module = await load(lowered.code);
  assert.deepEqual(module.View(module.size), { type: 'span', props: { children: 2 } });
  assert.deepEqual(module.get(), { type: 'i', props: {} });
});

test('unsupported later items cannot publish a partially lowered module', () => {
  const source = 'export enum First { Value }\nexport enum Later { Value = lookup() }\nexport const calculate = () => Later.Value;';
  assert.equal(compile(source).backend, 'typescript');
});
