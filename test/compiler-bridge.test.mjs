import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';
import { extract } from '../src/extract.mjs';

const samples = {
  Module: 'import type { Input } from "fixture"; export function pick(input: Input): number { const a: number = input.value; return a; }',
  Script: '// export const marker = 0\nconst local: number = 1; function run() { return this; }',
  Invalid: 'export function pick(x: number, x: number) { return x; } export const broken =',
  Empty: '#!/usr/bin/env node\n/* license */\nimport type { Input } from "unused";\nexport interface Box { input: Input; }',
  Runtime: 'export enum Mode { Ready = read() } export const next = Mode.Ready;',
};
const rows = readFileSync(new URL('../verification/pict/compiler-bridge.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [source, target, map] = row.split('\t');
  test('native erasure bridge ' + row.replaceAll('\t', ' '), async () => {
    const input = samples[source];
    const result = compile(input, { target: target === 'Modern' ? 'esnext' : 'es2018', sourceMap: map === 'On' });
    const bridged = ['Module', 'Empty', 'Script'].includes(source) && target === 'Modern' && map === 'Off';
    assert.equal(result.backend, bridged ? 'pulse' : 'typescript');
    if (source === 'Invalid') assert.equal(result.code, null);
    if (bridged && source === 'Module') {
      const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
      assert.equal(module.pick({ value: 42 }), 42);
    }
    if (bridged && source === 'Empty') assert.match(result.code, /^#!.*\n\/\* license \*\//);
    if (source === 'Script') {
      assert.match(result.code, /"use strict"/);
      assert.equal(Function(result.code + '\nreturn run();')(), undefined);
    }
  });
}

test('erasure needs an original ESM declaration and a surviving ESM marker', () => {
  for (const source of [
    'import type { X } from "fixture";\nconst local: number = 42;\nconsole.log(local);',
    '"export const x = 1";\nconst local: number = 1;',
    'import("fixture"); const local: number = 1;',
    'import.meta.url; const local: number = 1;',
    '/// <reference />\nexport const value: Set<number> = new Set();',
  ]) assert.notEqual(compile(source).backend, 'node-strip', source);
});

test('later module markers survive erasure and runtime text is not a triple-slash directive', async () => {
  const source = 'import type { X } from "fixture";\nconst prefix: string = "a:///b";\n' +
    'export function read(_value: X): string { return prefix; }';
  const lowered = compile(source);
  assert.equal(lowered.backend, 'pulse');
  const module = await import('data:text/javascript;base64,' + Buffer.from(lowered.code).toString('base64'));
  assert.equal(module.read(null), 'a:///b');
});

test('a hashbang can precede a later module marker', () => {
  const result = compile('#!/usr/bin/env node\nconst value: number = 1;\nexport function read() { return value; }');
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /^#!\/usr\/bin\/env node/);
});

test('parameter properties can lower without TypeScript while preserving constructor order', async () => {
  const source = [
    'const log: string[] = [];',
    'class Base { constructor() { log.push("base"); } }',
    'export class Widget extends Base {',
    '  observed = log.push("field");',
    '  constructor(public value: number) { super(); log.push("body"); }',
    '}',
    'export function read() { return log.slice(); }',
  ].join('\n');
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const baseline = compile(source, { sourceMap: true });
  for (const code of [result.code, baseline.code]) {
    const m = await import('data:text/javascript;base64,' + Buffer.from(code + (code === result.code ? '\n// first' : '\n// second')).toString('base64'));
    const instance = new m.Widget(42);
    assert.equal(instance.value, 42);
    assert.equal(instance.observed, 2);
    assert.deepEqual(m.read(), ['base', 'field', 'body']);
  }
});


test('a fully erased module retains an explicit ESM marker and its comments', async () => {
  const result = compile(samples.Empty.replace(/^#!.*\n/, ''), { file: 'input.mts' });
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /\/\* license \*\//);
  assert.match(result.code, /export \{\};\n$/);
  const empty = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.deepEqual(Object.keys(empty), []);
});

test('type erasure preserves globals, runtime exports and Unicode position padding', async () => {
  const input = 'declare global { interface Window { readonly name: string } }\n' +
    'interface Config { /** 構成 */ value: number }\nexport function read(x: Config) { return x.value; }';
  const result = compile(input);
  assert.equal(result.backend, 'pulse');
  assert.equal(result.code, stripTypeScriptTypes(input));
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(loaded.read({ value: 42 }), 42);
});

test('a validated ordinary script emits TypeScript strict semantics', () => {
  const source = 'declare const ambient: string; function read() { return this; }';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /^"use strict";/);
  assert.equal(Function(result.code + '\nreturn read()')(), undefined);
  const existing = compile('"use\\x20strict"; function read() { return this; }');
  assert.notEqual(existing.backend, 'node-strip');
});

test('parameter properties accept identifiers and object keys containing runtime keywords', () => {
  const result = compile('export class Box { constructor(public enumerable: number) {} } ' +
    'export const value: object = { namespace: "demo" };');
  assert.equal(result.backend, 'pulse');
});

test('a static import list can contain hundreds of specifiers', () => {
  const imports = Array.from({ length: 180 }, (_, index) => 'member' + index).join(',');
  const source = 'import {' + imports + '} from "unused"; export function get(): number { return 42; }';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.equal(result.code, stripTypeScriptTypes(source));
});

test('modern JavaScript scripts and modules do not need TypeScript', async () => {
  const script = '/* license */\n"use strict";\nvar result = (function () { return this; })();';
  const emitted = compile(script, { file: 'plain.js' });
  assert.equal(emitted.backend, 'javascript');
  assert.equal(emitted.code, script);
  const sloppy = compile('var result = (function () { return this; })();', { file: 'plain.js' });
  assert.match(sloppy.code, /^"use strict";/);
  const module = 'export const value = 42;';
  const written = compile(module, { file: 'module.mjs' });
  assert.equal(written.backend, 'javascript');
  assert.equal(written.code, module);
});

test('syntax validation is independent of the mutation candidate capacity', async () => {
  const statements = 'result += (0 < 1) + (2 >= 3);\n'.repeat(160);
  const source = 'export let result: number = 0;\n' + statements;
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const actual = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(actual.result, 160);
  assert.equal(compile(source + 'export { missing };').code, null);
  assert.equal(compile(source + 'export const broken =').code, null);
});

const annotationRows = readFileSync(new URL('../verification/pict/compiler-annotations.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of annotationRows) {
  const [binding, source, layout] = row.split('\t');
  test('module type annotation erasure ' + row.replaceAll('\t', ' '), async () => {
    const gap = { Inline: ' ', Multiline: '\n  ', Comment: ' /* type comment */ ',
      Unicode: ' /* サイズ 😀\u2028 annotation */ ' }[layout];
    const declarations = {
      Local: 'const value:' + gap + 'number = Math.abs(-6);\nexport { value };',
      Parameter: 'function twice(x:' + gap + 'number) { return x * 2; }\nexport const value = twice(3);',
      Return: 'function twice(x):' + gap + 'number { return x * 2; }\nexport const value = twice(3);',
    };
    const erased = 'import type {T} from "unused";\ninterface Shape { value: T }\ntype S = Shape;\n';
    const prefix = source === 'TypePrelude' ? erased : '';
    const suffix = source === 'GenericCall' ? '\nexport const generic = twice < number > (3);' :
      source === 'Malformed' ? '\nexport const broken =' : source === 'LateType' ? '\n' + erased : '';
    const input = prefix + declarations[binding] + suffix;
    const result = compile(input);
    if (source === 'Malformed') assert.equal(result.code, null);
    const lateType = source === 'LateType';
    if (source !== 'Module' && source !== 'TypePrelude' && !lateType) {
      assert.notEqual(result.backend, 'pulse', input);
      return;
    }
    assert.equal(result.backend, 'pulse', input);
    const code = lateType ? result.code.replace(/^;(?= +$)/gm, ' ') : result.code;
    assert.equal(code, stripTypeScriptTypes(input));
    const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(module.value, 6);
  });
}

test('annotation erasure distinguishes a comparison, a generic call and import aliases', () => {
  const source = 'import { limit as threshold } from "fixture";\n' +
    'export function below(value: number) { if (value < threshold) return true; return false; }';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.equal(result.code, stripTypeScriptTypes(source));
  for (const suffix of [
    '\nexport const generic = below < number > (3);',
    '\nexport const generic = below < " ; > " > (3);',
    '\nbelow as Function\n(3);',
  ]) {
    const input = source + suffix;
    const bridged = compile(input);
    assert.notEqual(bridged.backend, 'pulse', suffix);
    assert.ok(bridged.code);
    assert.doesNotMatch(bridged.code, /below\s*[<]|below as/);
  }
});

test('a colon closes assertions in conditional results and switch labels', async () => {
  const source = 'export function conditional(flag: boolean) { return flag ? 42 as number : 0; }\n' +
    'export function select(value: number) { switch (value) { case 42 satisfies number: return true; default: return false; } }';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const { conditional, select } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(conditional(true), 42);
  assert.equal(conditional(false), 0);
  assert.equal(select(42), true);
  assert.equal(select(0), false);
});

test('native multiline parameter annotations preserve delimiters and line endings', () => {
  const source = [
    'import { one } from "fixture";',
    'export const value = ({ name, values }: {',
    '  name: string;',
    '  values: number[]; // Removed with the annotation.',
    '}) => name + (values[0] ?? one);',
  ].join('\r\n');
  for (const file of ['params.ts', 'params.tsx']) {
    const result = compile(source, { file });
    assert.equal(result.backend, 'pulse', file);
    assert.equal(result.code, stripTypeScriptTypes(source));
  }
});

test('class heritage erases generic arguments and preserves the qualified runtime base', async () => {
  for (const file of ['derived.ts', 'derived.tsx']) {
    for (const args of ['<number>', '<\r\n  { value: number }\r\n>']) {
      const source = 'class Base { read() { return 7; } }\r\n' +
        'const runtime = { Base };\r\n' +
        `export class Derived extends runtime.Base${args} { tag: string = "derived"; }`;
      const result = compile(source, { file });
      assert.equal(result.backend, 'pulse', file);
      assert.equal(result.code, stripTypeScriptTypes(source));
      const { Derived } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
      assert.equal(new Derived().read(), 7);
    }
  }
});

test('a TSX comparison keeps subsequent comments in JavaScript lexical context', () => {
  const source = 'const small = (input: number) => input < 10;\n' +
    '// Preserve this as a comment after a comparison.\n' +
    'export const View = () => <p>{small(4)}</p>;';
  const result = compile(source, { file: 'comments.tsx' });
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /"react\/jsx-runtime"/);
  assert.match(result.code, /as a comment after a comparison/);
});

test('annotation erasure keeps contextual references on separate lines after an expression', () => {
  for (const keyword of ['as', 'satisfies']) {
    const source = 'export {}; const x: number = 1\n' + keyword + '\nnumber;';
    const result = compile(source);
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code, stripTypeScriptTypes(source));
    const jsx = compile(source + '\nexport const View = () => <i/>;', { file: 'source.tsx' });
    assert.equal(jsx.backend, 'pulse', source);
    assert.match(jsx.code, new RegExp('1\\n' + keyword + '\\nnumber;'));
  }
});

test('native generic calls and arrows preserve the exact boundary of type arguments', async () => {
  for (const file of ['generic.ts', 'generic.tsx']) {
    const source = 'export function id<T>(x: T): T { return x; }\n' +
      'const arrow = <T,>(x: T) => x;\n' +
      'export const value = id<number> /* keep before the call */ (arrow<number>(7));';
    const result = compile(source, { file });
    assert.equal(result.backend, 'pulse', file);
    assert.equal(result.code, stripTypeScriptTypes(source));
    const actual = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(actual.value, 7);
  }
  const source = 'export const value = String<number>(7);';
  assert.equal(compile(source).backend, 'pulse');
  assert.equal(compile(source).code, stripTypeScriptTypes(source));
});

test('native generic arguments preserve line endings inside an erased object type', () => {
  for (const file of ['generic.ts', 'generic.tsx']) {
    for (const newline of ['\n', '\r\n']) {
      const source = [
        'import { createContext } from "fixture";',
        'export const value = createContext<{',
        '  values: Array<string>; // erased comment',
        '  name: string | null;',
        '}>({ values: [], name: null });',
      ].join(newline);
      const result = compile(source, { file });
      assert.equal(result.backend, 'pulse', file);
      assert.equal(result.code, stripTypeScriptTypes(source));
    }
  }
});

const overloadRows = readFileSync(new URL('../verification/pict/compiler-overload.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of overloadRows) {
  const [binding, parameters, signature] = row.split('\t');
  test('module overload erasure ' + row.replaceAll('\t', ' '), async () => {
    const prefix = binding === 'Local' ? '' : 'export ';
    const generic = parameters === 'Generic';
    const type = generic ? 'T' : 'number';
    const defaultValue = signature === 'Default' ? ' = 0 < 1' : '';
    const source = `${prefix}function pick${generic ? '<T>' : ''}(value: ${type}${defaultValue}): ${type};
${prefix}function pick(value: number) { return value * 2; }
export const value = pick(6);`;
    const result = compile(source);
    if (signature === 'Default') {
      assert.notEqual(result.backend, 'pulse');
      return;
    }
    assert.equal(result.backend, 'pulse');
    const actual = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(actual.value, 12);
    assert.equal(typeof actual.pick, binding === 'Local' ? 'undefined' : 'function');
    assert.doesNotMatch(result.code, /pick<(?:T|number)>|value: /);
  });
}

test('native assertions and optional markers leave the value grammar intact', async () => {
  const source = 'export function pick(x?: number) {\n' +
    '  const record = { current: x! };\n' +
    '  return (record satisfies { current: number }).current as number;\n}';
  const emitted = compile(source);
  assert.equal(emitted.backend, 'pulse');
  assert.equal(emitted.code, stripTypeScriptTypes(source));
  const actual = await import('data:text/javascript;base64,' + Buffer.from(emitted.code).toString('base64'));
  assert.equal(actual.pick(7), 7);
  const continuation = 'export const n: number = 7 as number\n(3);';
  const bridged = compile(continuation);
  assert.notEqual(bridged.backend, 'pulse');
  assert.equal(bridged.code, stripTypeScriptTypes(continuation));
});

test('delimited assertions can span lines and contextual words can be value bindings', () => {
  const source = [
    'import { readonly } from "fixture";',
    'export function select(object: { type: string }) {',
    '  return (readonly && object.type) as',
    '    string | false;',
    '}',
  ].join('\n');
  for (const file of ['assertion.ts', 'assertion.tsx']) {
    const result = compile(source, { file });
    assert.equal(result.backend, 'pulse', file);
    assert.equal(result.code, stripTypeScriptTypes(source));
  }
});

test('assertion erasure preserves ASI before a new statement', async () => {
  for (const statement of ['const size = name.length;', 'let size = name.length;', 'if (name.length) return name.length;']) {
    const source = 'export function read(value: unknown) {\n' +
      '  const name = value as string\n' +
      `  ${statement}\n` +
      (statement.startsWith('if') ? '  return 0;\n}' : '  return size;\n}');
    const result = compile(source);
    assert.equal(result.backend, 'pulse');
    assert.equal(result.code, stripTypeScriptTypes(source));
    const actual = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(actual.read('sample'), 6);
  }
});

const modifierRows = readFileSync(new URL('../verification/pict/compiler-class-modifiers.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of modifierRows) {
  const [member, placement, dialect] = row.split('\t');
  test('class modifier erasure ' + row.replaceAll('\t', ' '), async () => {
    const stat = placement === 'Static' ? 'static ' : '';
    const members = {
      Field: `public /* keep */ ${stat}readonly count: number = 1;`,
      Method: `protected ${stat}count(value: number) { return value + 1; }`,
      ContextualName: `${stat}readonly: number = 1;`,
    };
    const input = `export class C { ${members[member]} }`;
    const result = compile(input, { file: dialect === 'TS' ? 'class.ts' : 'class.tsx' });
    assert.equal(result.backend, 'pulse', input);
    assert.equal(result.code, stripTypeScriptTypes(input));
    const { C } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    const target = stat ? C : new C();
    if (member === 'Method') assert.equal(target.count(3), 4);
    else assert.equal(target[member === 'Field' ? 'count' : 'readonly'], 1);
  });
}

test('an erased type-only import keeps the requested module format and its directives', () => {
  const source = 'import type { T } from "unused";\n"use client";\nconst value: T = Math.abs(-6);';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.equal(result.code, stripTypeScriptTypes(source));
  const esm = compile(source, { module: 'esm' });
  assert.equal(esm.backend, 'pulse');
  assert.equal(esm.code, result.code + '\nexport {};\n');
});

const importRows = readFileSync(new URL('../verification/pict/compiler-imports.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of importRows) {
  const [imports, late, dialect] = row.split('\t');
  test('inline type imports and late declarations ' + row.replaceAll('\t', ' '), () => {
    const members = {
      Leading: 'type Shape, one',
      Middle: 'one, type Shape, two',
      Trailing: 'one, type Shape',
      TypeOnly: 'type Shape',
      Aliased: 'type Shape as Alias, one as first',
    };
    const tails = {
      None: '',
      Alias: 'type ShapeAgain = number;\n',
      Continuation: 'Math.abs\ntype ShapeAgain = number\n(3);\n',
    };
    const input = `import { ${members[imports]} } from "fixture";\nexport const n: number = 1;\n${tails[late]}`;
    const emitted = compile(input, { file: dialect === 'TS' ? 'input.ts' : 'input.tsx' });
    assert.equal(emitted.backend, 'pulse', input);
    const stripped = stripTypeScriptTypes(input);
    const actual = late === 'Alias' ? emitted.code.replace(/\n;(?= +\n$)/, '\n ') : emitted.code;
    assert.equal(actual, stripped);
  });
}

test('JavaScript pass-through declines TypeScript syntax and ambiguous strict directives', () => {
  for (const source of ['export const bad: number = 0;', '"use strict" + effect();']) {
    assert.notEqual(compile(source, { file: 'plain.js' }).backend, 'javascript');
  }
});

const ambientRows = readFileSync(new URL('../verification/pict/compiler-ambient.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of ambientRows) {
  const [declaration, placement, dialect] = row.split('\t');
  test('ambient range erasure ' + row.replaceAll('\t', ' '), () => {
    const declarations = {
      Global: 'declare global { interface Window { value: number } }',
      Module: 'declare module "fixture" { export interface Shape { value: number } }',
      TypeNamespace: 'namespace Types { export interface Shape { value: number } }',
      AmbientEnum: 'declare enum Key { A = 1 }',
    };
    const active = 'export const one: number = read();';
    const range = declarations[declaration];
    const source = 'import { read } from "fixture";\n' +
      (placement === 'Prelude' ? `${range}\n${active}` : `${active}\n${range}`);
    const result = compile(source, { file: dialect === 'TS' ? 'ambient.ts' : 'ambient.tsx' });
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code.replace(/^[; \t]+$/gm, '').trim(), stripTypeScriptTypes(source).replace(/^[; \t]+$/gm, '').trim());
  });
}

test('an ambient declaration cannot erase a runtime namespace or a malformed member', () => {
  const runtime = 'export namespace State { export const value: number = 3; }';
  assert.notEqual(compile(runtime).backend, 'pulse');
  const malformed = 'export {}; declare global { interface Window { value: } }';
  assert.equal(compile(malformed).code, null);
});

test('JavaScript pass-through rejects Annex B HTML comment syntax', () => {
  for (const text of ['<!-- ignored\nconsole.log(1);', ' --> ignored\nconsole.log(1);', '/* ignored */ --> ignored\nvar x = 1;']) {
    assert.equal(compile(text, { file: 'plain.js' }).code, null);
  }
  const ordinary = '"use strict";\n// arrow --> example\nvar text = "-->";';
  const result = compile(ordinary, { file: 'plain.js' });
  assert.equal(result.backend, 'javascript');
  assert.equal(result.code, ordinary);
});

test('plain JavaScript scripts do not load compiler addons on the first call', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('/src/compiler.cjs') &&
          /(?:compiler(?:-module)?\\.node|source-text\\.mjs)$/.test(specifier)) throw new Error(specifier);
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    const source = Buffer.from('/* 東京 */ const n = 42;');
    const result = compile(source, { file: 'script.js' });
    assert.equal(result.backend, 'javascript');
    assert.equal(result.code, '"use strict";\\n' + source.toString());
    Object.defineProperty(source, 'length', { value: 1 });
    assert.equal(compile(source, { file: 'script.js' }).code, result.code);
    assert.equal(compile(Buffer.from([0xc0, 0x80]), { file: 'script.js' }).diagnostics[0].code, 'INVALID_ENCODING');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('type erasure diagnoses local exports whose runtime bindings disappeared', () => {
  for (const trivia of [' /* list */ ', ' // list of bindings\n']) {
    const source = 'export const value = 42; interface OnlyType { x: number } export' + trivia + '{ OnlyType };';
    for (const sourceMap of [false, true]) {
      const result = compile(source, { sourceMap });
      assert.equal(result.code, null);
      assert.equal(result.diagnostics[0].code, 'UNBOUND_RUNTIME_EXPORT');
    }
  }
  for (const text of ['export { X } from "elsewhere";', 'export const A = 42; export { A as B };']) {
    assert.notEqual(compile(text).code, null);
  }
});

const reexportRows = readFileSync(new URL('../verification/pict/compiler-reexports.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of reexportRows) {
  const [form, scope, dialect] = row.split('\t');
  test('native type re-export ' + row.replaceAll('\t', ' '), () => {
    const clauses = {
      TypeList: 'export type { Shape as PublicShape }',
      TypeStar: 'export type *',
      TypeStarAlias: 'export type * as Shapes',
      MixedLeading: 'export { type Shape, one as count }',
      MixedTrailing: 'export { one as count, type Shape as PublicShape }',
      InlineOnly: 'export { type Shape }',
      ValueAlias: 'export { one as type }',
    };
    const from = scope === 'Remote' ? ' from "fixture"' : '';
    const input = `${clauses[form]}${from};\ninterface Shape { x: number }\nconst one: number = 1;\n`;
    const result = compile(input, { file: dialect === 'TS' ? 'input.ts' : 'input.tsx' });
    assert.equal(result.backend, 'pulse', input);
    const expected = stripTypeScriptTypes(input);
    assert.equal(result.code.replace(/^;(?= +$)/gm, ' '), expected);
    if (form === 'InlineOnly' && scope === 'Remote') {
      assert.match(result.code, /^export \{\s*\} from "fixture";/);
    }
  });
}

test('type re-export erasure preserves runtime aliases in a JSX module', () => {
  const input = 'export type * as Shapes from "kinds";\nexport { value as type } from "value";\n' +
    'export const View = (x: number) => <b>{x}</b>;';
  const result = compile(input, { file: 'view.tsx' });
  assert.equal(result.backend, 'pulse');
  assert.doesNotMatch(result.code, /from "kinds"/);
  assert.match(result.code, /export \{ value as type \} from "value"/);
  assert.match(result.code, /_tmtJsx0\("b",\{children: \(x\)\}\)/);
});

test('re-export records cannot hide an invalid declaration or runtime binding', () => {
  const doubled = 'export type { type Shape } from "fixture";';
  assert.notEqual(compile(doubled).backend, 'pulse');
  assert.equal(compile(doubled, { mode: 'strip' }).code, null);
  const unbound = 'export { Missing as value, type Shape }; interface Shape {}';
  assert.equal(compile(unbound).code, null);
});

const assertionChains = readFileSync(new URL('../verification/pict/compiler-assertion-chain.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of assertionChains) {
  const [first, second, gap, dialect] = row.split('\t');
  test('consecutive type assertion ' + row.replaceAll('\t', ' '), async () => {
    const type = gap === 'MultilineType' ? '[\n  number\n]' : '[number]';
    const trivia = gap === 'Comment' ? ' /* keep */ ' : ' ';
    const input = `export const result = ([42] ${first.toLowerCase()} ${type}${trivia}${second.toLowerCase()} [number])[0];`;
    const result = compile(input, { file: dialect === 'TS' ? 'input.ts' : 'input.tsx' });
    assert.equal(result.backend, 'pulse', input);
    const actual = gap === 'Comment' ? result.code.replace('/* keep */', ' '.repeat(10)) : result.code;
    assert.equal(actual, stripTypeScriptTypes(input));
    const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(module.result, 42);
  });
}

test('consecutive type assertions cannot erase a following call boundary', () => {
  const input = 'export const cast = Math.abs as unknown as Function\n(3);';
  const result = compile(input);
  assert.notEqual(result.backend, 'pulse');
  assert.equal(result.code, stripTypeScriptTypes(input));
});

const eventCapacity = readFileSync(new URL('../verification/pict/compiler-event-capacity.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of eventCapacity) {
  const [size, shape, dialect] = row.split('\t');
  test('compiler event capacity ' + row.replaceAll('\t', ' '), async () => {
    const count = { Below: 127, At: 128, Above: 129 }[size];
    const operators = shape === 'Single' ? ['<'] : ['<', '>='];
    const source = 'export let value: number = 0;\n' +
      (shape === 'Single' ? 'value += 0 < 1;\n' : 'value += (0 < 1) + (2 >= 3);\n').repeat(count);
    assert.ok(Buffer.byteLength(source) < 4096);
    const file = dialect === 'TS' ? 'input.ts' : 'input.tsx';
    const result = compile(source, { file });
    assert.equal(result.backend, 'pulse');
    assert.equal(result.code, stripTypeScriptTypes(source));
    const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(module.value, count);
    const picked = extract(source, { requireNative: true, dialect: dialect.toLowerCase() });
    assert.equal(picked.path, 'fast');
    assert.deepEqual(picked.candidates.map(site => site.operator), Array(count).fill(operators).flat());
    assert.deepEqual(picked.candidates.map(site => source.slice(...site.edit)), Array(count).fill(operators).flat());
  });
}
