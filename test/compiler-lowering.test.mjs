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
    ['main.tsx', '/** @jsxRuntime classic */ export const View = <span />;'],
    ['main.tsx', '/** @jsxImportSource alternate*/ export const View = <span />;'],
    ['main.tsx', 'export const View = () => <span></em>;'],
    ['main.ts', 'export enum Ready { A = compute(), B }'],
    ['main.ts', 'export enum Ready { A = "s", B }'],
  ]) assert.notEqual(compile(source, { file }).backend, 'pulse');
  // JSX that is kept is written as it stands, with the types erased.
  const kept = compile(fixtures.Automatic, { file: 'input.tsx', jsx: 'preserve' });
  assert.equal(kept.backend, 'pulse');
  assert.match(kept.code, /=> <><div enabled title="a &amp; b">\{x\}<br\/><\/div><\/>;/);
  // An older target is native while the source holds no form newer than it.
  assert.equal(compile(fixtures.Numeric, { target: 'es2018', sourceMap: true }).backend, 'pulse');
  assert.notEqual(compile(fixtures.Numeric + '\nexport const a = Ready?.Zero;', { target: 'es2018', sourceMap: true }).backend, 'pulse');
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
  // The plain import-source pragma is native. Other pragmas keep the TypeScript emitter.
  const pragma = compile('/** @JSXImportSource preact */ export const X = <i/>;', { file: 'input.tsx' });
  assert.equal(pragma.backend, 'pulse');
  assert.match(pragma.code, /preact\/jsx-runtime/);
  const factory = compile('/** @JSXRuntime classic */ /** @JSX h */ export const X = <i/>;', { file: 'input.tsx' });
  assert.equal(factory.backend, 'typescript');
  assert.match(factory.code, /h\("i"/);
  for (const separator of ['\u2028', '\u2029']) {
    assert.equal(compile('export const X = <i>a' + separator + 'b</i>;', { file: 'input.tsx' }).backend, 'typescript');
  }
});

test('mixed modules lower local enums after imports and preserve the value code', async () => {
  const source = 'import type { Mark } from "unused";\n' +
    'export const before: number = 42;\nconst enum State { Red, Green = 4, Blue }\n' +
    'export function state(): number { return State.Blue; }';
  const lowered = compile(source);
  assert.equal(lowered.backend, 'pulse');
  assert.doesNotMatch(lowered.code, /\bconst enum\b/);
  const module = await load(lowered.code);
  assert.equal(module.before, 42);
  assert.equal(module.state(), 5);
});

test('mixed TSX modules lower multiple declarations and share one runtime import', async () => {
  const source = 'import type { Config } from "unused";\nexport const size: number = 2;\n' +
    'export const View = (x: number) => <span>{x}</span>;\nconst other = <i/>;\nexport const get = () => other;';
  const lowered = compile(source, { file: 'input.tsx' });
  assert.equal(lowered.backend, 'pulse');
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

test('cold direct compilation does not initialize path or filesystem modules', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/\/src\/compiler(?:-routes)?\.cjs$/.test(context.parentURL ?? '') &&
          ['node:path', 'node:fs'].includes(specifier)) throw new Error(specifier);
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    assert.equal(compile('export const answer: number = 42;').backend, 'pulse');
    assert.equal(compile('export const X = <i/>;', { file: 'a.tsx' }).backend, 'pulse');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('an import-first typed module loads only the full compiler addon', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.endsWith('/compiler.node')) throw new Error('Direct compiler addon loaded');
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    const input = 'import type { T } from "unused"; export function View(x: T) { return <i>{x}</i>; }';
    assert.equal(compile(input, { file: 'module.tsx' }).backend, 'pulse');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

const runRows = readFileSync(new URL('../verification/pict/compiler-jsx-runs.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of runRows) {
  const [runtime, position, boundary] = row.split('\t');
  test('JSX byte runs preserve ' + row.replaceAll('\t', ' '), async () => {
    const special = { Plain: 'x', Entity: '&amp;', Quoted: '\\"', Unicode: '東京🧪', Newline: '\r\n  ' }[boundary];
    for (const length of [0, 15, 16, 17, 30, 31, 32, 33, 63, 64, 65]) {
      const value = 'A'.repeat(length) + special + 'Z'.repeat(80);
      const markup = position === 'Attribute' ? `<i title='${value}'/>` : `<i>${value}</i>`;
      const source = 'export const View = ' + markup + ';';
      const options = { file: 'runs.tsx', jsx: runtime.toLowerCase() };
      const fast = compile(source, options);
      const expected = compile(source, { ...options, sourceMap: true });
      assert.equal(fast.backend, 'pulse');
      assert.deepEqual((await load(fast.code)).View, (await load(expected.code)).View);
    }
  });
}

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
    assert.equal(result.backend, 'pulse', body);
    const reference = compile(source, { ...options, sourceMap: true });
    assert.deepEqual((await load(result.code)).View(), (await load(reference.code)).View());
  }
  assert.equal(compile('export function View() { return (<i/>; }', { file: 'component.tsx' }).code, null);
});

test('whole-module JSX erases types in the original source gaps before lowering', async () => {
  const source = 'import type { Label } from "unused";\n' +
    'export function View(title: Label) {\n' +
    '  const nested = (name: string) => <strong>{name}</strong>;\n' +
    '  return <i type="text" as="label">Shown as an interface {nested(title)}</i>;\n}';
  const options = { file: 'native.tsx' };
  const result = compile(source, options);
  const reference = compile(source, { ...options, sourceMap: true });
  assert.equal(result.backend, 'pulse');
  assert.deepEqual((await load(result.code)).View('東京'), (await load(reference.code)).View('東京'));
  const generic = 'export function View(value: number) { return <i>{convert < number > (value)}</i>; }';
  assert.notEqual(compile(generic, options).backend, 'pulse');
});

test('mixed TSX keeps directives and complex JavaScript expressions in place', async () => {
  const source = '"use client";\n' +
    'const attrs = () => ({ hidden: true });\nconst format = (x: number) => [x, x + 1].join(":");\n' +
    'export function View(x: number) { return <article {...attrs()} onClick={() => format(x)}>{format(x)}</article>; }';
  const actual = compile(source, { file: 'component.tsx' });
  assert.equal(actual.backend, 'pulse');
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
  assert.equal(result.backend, 'pulse');
  assert.deepEqual((await load(result.code)).View(), { type: 'i', props: { children: { type: 'b', props: {} } } });
});

test('the runtime import lands on its statement boundary after an earlier JSX edit', async () => {
  const source = 'const view = <div>longer output</div>;\nexport const getView = () => view;';
  const actual = compile(source, { file: 'component.tsx' });
  assert.equal(actual.backend, 'pulse');
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
    assert.equal(result.backend, 'pulse');
    const reference = compile(source, { file: 'module.tsx', sourceMap: true });
    const native = (await load(result.code)).Outer(5);
    const original = (await load(reference.code)).Outer(5);
    assert.deepEqual(native, original);
  });
}

test('whole-module JSX decodes numeric references and composes with runtime enums', async () => {
  const source = 'enum E { Start, Next } export const View = () => <i title="&#x1F600;">&#123;{E.Next}&#125;</i>;';
  const result = compile(source, { file: 'component.tsx' });
  assert.equal(result.backend, 'pulse');
  const view = (await load(result.code)).View();
  assert.deepEqual(view, { type: 'i', props: { title: '😀', children: ['{', 1, '}'] }, multiple: true });
});

test('a TSX module with no markup still erases TypeScript without the compiler', () => {
  const result = compile('export function read(x: object) { return x; }', { file: 'empty-markup.tsx' });
  assert.equal(result.backend, 'pulse');
  assert.doesNotMatch(result.code, /: object/);
});

test('a JSX expression can contain more comparisons than the small expression scratch buffer', async () => {
  const values = Array.from({ length: 160 }, (_, index) => 'input > ' + index).join(',');
  const source = 'export function Test(input: number) { return <i values={[' + values + ']} />; }';
  const result = compile(source, { file: 'large-expression.tsx' });
  assert.equal(result.backend, 'pulse');
  assert.equal((await load(result.code)).Test(42).props.values.filter(Boolean).length, 42);
});

test('whole-file automatic JSX supports scripts with a directive prologue', () => {
  const input = '"use client";\nconst view = <b/>;';
  const result = compile(input, { file: 'script.tsx' });
  assert.equal(result.backend, 'pulse+node-strip');
  assert.match(result.code, /^"use client";\s*import/);
});

test('whole-file classic JSX supports strict script output', () => {
  const input = 'declare const React: any; const view = <b />;';
  const result = compile(input, { file: 'script.tsx', jsx: 'classic' });
  assert.equal(result.backend, 'pulse+node-strip');
  assert.match(result.code, /^"use strict";/);
  const React = { createElement: name => name };
  assert.equal(Function('React', result.code + '\nreturn view;')(React), 'b');
});

test('whole-module JSX accepts comments between attributes and a spaced closing delimiter', async () => {
  const source = 'export function View() { return (<div><b /* attribute */ className="work" ' +
    '// end of opening tag\n / ></div>); }';
  const result = compile(source, { file: 'comment.tsx' });
  assert.notEqual(result.backend, 'typescript');
  const reference = compile(source, { file: 'comment.tsx', sourceMap: true });
  assert.deepEqual((await load(result.code)).View(), (await load(reference.code)).View());
});

test('literal JSX spread with a getter retains the original accessor', async () => {
  const source = 'let reads = 0; export const View = <b {...{ get count() { reads++; return 1 } }} />;' +
    ' export const count = () => reads;';
  const { View, count } = await load(compile(source, { file: 'accessor.tsx' }).code);
  assert.equal(count(), 0);
  assert.equal(View.props.count, 1);
  assert.equal(count(), 1);
});

const mixedEnumRows = readFileSync(new URL('../verification/pict/compiler-jsx-enum.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of mixedEnumRows) {
  const [placement, form, runtime] = row.split('\t');
  test('mixed JSX and enum lowering ' + row.replaceAll('\t', ' '), async () => {
    const prefix = { Local: 'enum', Exported: 'export enum', Const: 'const enum' }[form];
    const enum_ = prefix + ' Tone { Warm = 4, Cool }';
    const view = 'export const View = (x: number) => <i>{Tone.Cool + x}</i>;';
    const code = placement === 'Before' ? [enum_, view] : placement === 'After' ? [view, enum_] :
      ['export const header = <b/>;', enum_, view];
    code.push('export const lookup = () => Tone[4];');
    const file = 'mixed.tsx';
    const jsx = runtime.toLowerCase();
    const source = code.join('\n');
    const result = compile(source, { file, jsx });
    assert.equal(result.backend, 'pulse');
    assert.doesNotMatch(result.code, /\benum Tone\b/);
    assert.equal((result.code.match(/react\/jsx-runtime/g) ?? []).length, jsx === 'automatic' ? 1 : 0);
    const actual = await load(result.code);
    const expected = await load(compile(source, { file, jsx, sourceMap: true }).code);
    assert.equal(actual.lookup(), 'Warm');
    assert.deepEqual(actual.View(6), expected.View(6));
    assert.deepEqual(actual.Tone, expected.Tone);
    assert.deepEqual(actual.header, expected.header);
  });
}

test('a later unsupported enum cannot publish a partial native TSX result', () => {
  const source = 'export enum Ready { Value }\nexport const View = () => <i>{Ready.Value}</i>;\n' +
    'export enum Quantity { Value = compute() }';
  assert.notEqual(compile(source, { file: 'mixed.tsx' }).backend, 'pulse');
});

const jsxModuleRows = readFileSync(new URL('../verification/pict/compiler-jsx-dialect.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of jsxModuleRows) {
  const [dialect, runtime, layout] = row.split('\t');
  test('whole JSX module ' + row.replaceAll('\t', ' '), async () => {
    const source = {
      TwoExports: 'export const A = <i/>; export const B = <b/>;',
      Directive: '"use client";\nexport const A = <i/>;\nexport const B = <b/>;',
      Nested: 'export const A = <i>{<s/>}</i>; const node = <b/>; export { node as B };',
    }[layout];
    const options = { file: 'view.' + dialect.toLowerCase(), jsx: runtime.toLowerCase() };
    const result = compile(source, options);
    assert.equal(result.backend, 'pulse', source);
    if (layout === 'Directive') assert.match(result.code, /^"use client";/);
    const actual = await load(result.code);
    const reference = await load(compile(source, { ...options, sourceMap: true }).code);
    assert.deepEqual(actual.A, reference.A);
    assert.deepEqual(actual.B, reference.B);
  });
}

test('whole JSX modules emit with TypeScript unavailable', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'typescript') throw new Error('TypeScript loaded');
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    const input = 'export const A = <i/>; export const B = <b/>;';
    assert.equal(compile(input, { file: 'view.jsx' }).backend, 'pulse');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('the full JavaScript JSX route does not erase TypeScript syntax', () => {
  const input = 'export const A: number = 42; export const B = <i/>;';
  assert.notEqual(compile(input, { file: 'view.jsx' }).backend, 'pulse');
  assert.equal(compile(input, { file: 'view.tsx' }).backend, 'pulse');
});

const jsxPlainRows = readFileSync(new URL('../verification/pict/compiler-jsx-pass-through.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of jsxPlainRows) {
  const [shape, leading, runtime] = row.split('\t');
  test('unchanged JavaScript in a JSX module ' + row.replaceAll('\t', ' '), async () => {
    const body = {
      Async: 'export const value = async () => { function* values() { yield 42; } return values().next().value; };',
      Class: 'export const value = () => { class K { #v = 42; value() { return this.#v; } } return new K().value(); };',
      Expression: 'export const value = () => (2 ** 3 ** 2) - (470 ?? 0);',
    }[shape];
    const source = (leading === 'Directive' ? '"use client";\n' : '') + body;
    const result = compile(Buffer.from(source), { file: 'plain.jsx', jsx: runtime.toLowerCase() });
    assert.equal(result.backend, 'javascript');
    assert.equal(result.code, source);
    assert.equal(await (await import(data(result.code))).value(), 42);
  });
}

test('JavaScript JSX pass-through rejects an unbound export and a type annotation', () => {
  for (const source of ['export { missing };', 'export const a: number = 1;']) {
    assert.notEqual(compile(source, { file: 'plain.jsx' }).backend, 'javascript');
  }
});

const namespaceAttributeRows = readFileSync(new URL('../verification/pict/compiler-jsx-namespace-attribute.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of namespaceAttributeRows) {
  const [value, dialect, runtime] = row.split('\t');
  test('namespaced JSX attribute ' + row.replaceAll('\t', ' '), async () => {
    const attribute = { Expression: 'prop:id={7}', Text: 'prop:id="a&amp;b"', Boolean: 'prop:id' }[value];
    const source = `export const A = <i ${attribute}/>;\nexport const B = <b/>;`;
    const options = { file: 'attribute.' + dialect.toLowerCase(), jsx: runtime.toLowerCase() };
    const result = compile(source, options);
    assert.equal(result.backend, 'pulse');
    const actual = await load(result.code);
    const reference = await load(compile(source, { ...options, sourceMap: true }).code);
    assert.deepEqual(actual.A, reference.A);
    assert.equal(actual.A.props['prop:id'], { Expression: 7, Text: 'a&b', Boolean: true }[value]);
  });
}

test('malformed namespaced JSX attributes cannot produce native output', () => {
  for (const attribute of ['prop:', ':name', 'prop::name']) {
    const source = `export const A = <i ${attribute}/>;\nexport const B = <b/>;`;
    assert.notEqual(compile(source, { file: 'attribute.jsx' }).backend, 'pulse');
  }
});
