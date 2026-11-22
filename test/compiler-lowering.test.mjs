import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const fixtures = {
  Numeric: 'export enum Ready { Zero, Minus = -2, Next, Reset = 4, Final, }',
  Strings: 'export const enum Ready { First = "yes", Second = "いいえ", Number = 42 }',
  Automatic: 'export const View = (x: number) => <><div enabled title="a &amp; b">{x}<br/></div></>;',
  Function: 'export function View(x: number) { return (<i>{x}</i>); }',
  Classic: 'export const View = (x) => <div enabled title="text">{x}<br/></div>;',
};

const data = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const runtime = data('export const Fragment = "fragment"; export function jsx(type, props, key) { return key === undefined ? {type, props} : {type, props, key}; } export function jsxs(type, props, key) { return {...jsx(type, props, key), multiple: true}; }');
const classic = 'const React = {Fragment:"fragment", createElement(type, props, ...children) { return {type, props, children}; }};\n';
async function load(code) {
  const create = data('export function createElement(type, props, ...children) { return {type, props, children}; }');
  return import(data(classic + code.replace(/(["'])react\/jsx-runtime\1/g, JSON.stringify(runtime))
    .replace(/(["'])react\1/g, JSON.stringify(create))));
}

const rows = readFileSync(new URL('../verification/pict/compiler-lowering.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [form, layout, tail] = row.split('\t');
  test('native runtime lowering ' + row.replaceAll('\t', ' '), async () => {
    const jsx = form === 'Classic' ? 'classic' : 'automatic';
    const file = form === 'Classic' ? 'input.jsx' : (form === 'Automatic' || form === 'Function') ? 'input.tsx' : 'input.ts';
    const markup = '<i>  first \r\n\t東京 &amp; second \r\n  {x} <b/>\n final  </i>';
    const fixture = layout !== 'Multiline' ? fixtures[form] : form === 'Function' ?
      'export function View(x: number) { return (' + markup + '); }' :
      'export const View = (x) => ' + markup + ';';
    const source = (layout === 'Unicode' ? '/* 東京🧪 */\r\n' : '') + fixture +
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

test('direct lowering works with only the small native addon loaded', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { registerHooks } from 'node:module';
    assert.equal(existsSync('./build/compiler-module.node'), true);
    registerHooks({ resolve(specifier, context, next) {
      if (/compiler-module\\.node$/.test(specifier)) throw new Error('Full module addon loaded');
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    assert.equal(compile('export const C = <i/>;', { file: 'input.tsx' }).backend, 'pulse');
    assert.equal(compile('export enum State { Ready }').backend, 'pulse');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('multiline JSX preserves significant leading, trailing and single-line whitespace', async () => {
  for (const children of ['  a \n \t \n b  ', ' \n  ', '  ', ' \na\n  ', 'a\r  b',
    'a\n &lt;\n b', '\u200b\n\u3000a', 'a\u00a0\n b\u202f', '{/* gap */}\n  a']) {
    const source = 'export const X = <i>' + children + '</i>;';
    const actual = compile(source, { file: 'layout.tsx' });
    assert.equal(actual.backend, 'pulse', JSON.stringify(children));
    const expected = compile(source, { file: 'layout.tsx', sourceMap: true });
    assert.deepEqual((await load(actual.code)).X, (await load(expected.code)).X, JSON.stringify(children));
  }
});

test('grouped JSX supports const initializers, arrow functions and default functions', async () => {
  for (const [source, exported] of [
    ['export const View = ((<i/>));', 'View'],
    ['export const View = () => (\n  <i/>\n);', 'View'],
    ['export default function () { return (\n  <i/>\n); }', 'default'],
    ['export default function View(): object { return (<i/>) }', 'default'],
  ]) {
    const actual = compile(source, { file: 'component.tsx' });
    assert.equal(actual.backend, 'pulse', source);
    const reference = compile(source, { file: 'component.tsx', sourceMap: true });
    const a = (await load(actual.code))[exported], b = (await load(reference.code))[exported];
    assert.deepEqual(typeof a === 'function' ? a() : a, typeof b === 'function' ? b() : b);
  }
});

test('whole-module JSX preserves ASI and the surrounding function body', async () => {
  for (const body of ['return\n<i/>;', 'return <i/>; extra();', 'return (<i/>).value;']) {
    const source = 'export function View() { ' + body + ' }';
    const options = { file: 'component.tsx' };
    const result = compile(source, options);
    assert.equal(result.backend, 'pulse+node-strip', body);
    const reference = compile(source, { ...options, sourceMap: true });
    assert.deepEqual((await load(result.code)).View(), (await load(reference.code)).View());
  }
  assert.equal(compile('export function View() { return (<i/>; }', { file: 'component.tsx' }).code, null);
});

test('mixed TSX keeps directives and complex JavaScript expressions in place', async () => {
  const source = '"use client";\n' +
    'const attrs = () => ({ hidden: true });\nconst format = (x: number) => [x, x + 1].join(":");\n' +
    'export function View(x: number) { return <article {...attrs()} onClick={() => format(x)}>{format(x)}</article>; }';
  const actual = compile(source, { file: 'component.tsx' });
  assert.equal(actual.backend, 'pulse+node-strip');
  assert.match(actual.code, /^"use client";/);
  const reference = compile(source, { file: 'component.tsx', sourceMap: true });
  for (const result of [actual, reference]) {
    const view = (await load(result.code)).View(42);
    assert.equal(view.props.children, '42:43');
    assert.equal(view.props.onClick(), '42:43');
    assert.equal(view.props.hidden, true);
  }
});

test('mixed JSX expression copies lower nested conditional children', async () => {
  const source = 'const visible = true; export const View = () => <i>{visible ? <b/> : null}</i>;';
  const result = compile(source, { file: 'component.tsx' });
  assert.equal(result.backend, 'pulse+node-strip');
  assert.deepEqual((await load(result.code)).View(), { type: 'i', props: { children: { type: 'b', props: {} } } });
});

test('the runtime import lands on its statement boundary after an earlier JSX edit', async () => {
  const source = 'const view = <div>longer output</div>;\nexport const getView = () => view;';
  const actual = compile(source, { file: 'component.tsx' });
  assert.equal(actual.backend, 'pulse+node-strip');
  assert.match(actual.code, /;\s*import\{[\s\S]+\nexport const getView/);
  assert.deepEqual((await load(actual.code)).getView(), { type: 'div', props: { children: 'longer output' } });
});

const moduleCases = readFileSync(new URL('../verification/pict/compiler-jsx-module.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [placement, key, tail] of moduleCases) {
  test('arbitrary JSX placement with ' + [placement, key, tail].join(' '), async () => {
    const attrs = key === 'None' ? '' : key === 'BeforeSpread' ? ' key={x} {...props}' : ' {...props} key={x}';
    const child = '<strong' + attrs + '>{x}</strong>';
    const body = {
      Callback: '[x].map(x => ' + child + ')[0]',
      Conditional: 'x ? ' + child + ' : <b/>',
      Attribute: '<div item={[x].map(x => ' + child + ')[0]} />',
    }[placement];
    const source = 'const props = { title: "hi" }; export function Outer(x: number) { return ' + body + '; }' +
      (tail === 'Invalid' ? ' export const broken = ' : '');
    const result = compile(source, { file: 'module.tsx' });
    if (tail === 'Invalid') {
      assert.equal(result.code, null);
      return;
    }
    assert.equal(result.backend, 'pulse+node-strip');
    const reference = compile(source, { file: 'module.tsx', sourceMap: true });
    const native = (await load(result.code)).Outer(5);
    const original = (await load(reference.code)).Outer(5);
    assert.deepEqual(native, original);
  });
}

test('whole-module JSX decodes numeric references and composes with runtime enums', async () => {
  const source = 'enum E { Start, Next } export const View = () => <i title="&#x1F600;">&#123;{E.Next}&#125;</i>;';
  const result = compile(source, { file: 'component.tsx' });
  assert.equal(result.backend, 'pulse+node-strip');
  const view = (await load(result.code)).View();
  assert.deepEqual(view, { type: 'i', props: { title: '😀', children: ['{', 1, '}'] }, multiple: true });
});

test('a TSX module with no markup still erases TypeScript without the compiler', () => {
  const result = compile('export function read(x: object) { return x; }', { file: 'empty-markup.tsx' });
  assert.equal(result.backend, 'pulse+node-strip');
  assert.doesNotMatch(result.code, /: object/);
});
