import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extractYuku } from './support/yuku-extraction.mjs';
import { extractTypeScript } from '../src/typescript-extraction.mjs';

function compare(source, options) {
  const result = extractTypeScript(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, reference.path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  for (const diagnostic of result.diagnostics ?? []) {
    assert.equal(diagnostic.severity, 'error');
    assert.equal(diagnostic.path, options.file ?? null);
    assert.ok(diagnostic.message.length > 0);
    assert.ok(diagnostic.start >= 0 && diagnostic.start <= diagnostic.end);
    assert.ok(diagnostic.end <= Buffer.byteLength(source));
    assert.ok(Array.isArray(diagnostic.labels));
  }
  return result;
}

const rows = readFileSync(new URL('../verification/pict/typescript-compatibility.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [dialect, mode, kind] = row.split('\t');
  test(`TypeScript compatibility: ${dialect} ${mode} ${kind}`, () => {
    const sources = {
      Comparison: 'function test(value: number) { return value >= limit; }',
      BadStatement: 'const before = a < b; const =',
      BadBinding: 'let eval = left > right;',
      ModuleExport: 'export const before = a < b;',
      Logical: dialect === 'TSX' ? 'const view = <Button disabled={a > b || ready} />;' : 'const ready = a > b || active;',
      HoistedVar: 'try {} catch { switch (key) { default: for (var exported of values) {} } } export { exported };',
    };
    compare(`/* 🧪 */\n${sources[kind]}`, { file: dialect === 'TSX' ? 'case.tsx' : 'case.ts', mode: mode.toLowerCase(), logical: true });
  });
}

test('compatibility parser handles private JSX member names and unadorned TSX generic arrows', () => {
  const options = { file: '海.tsx', logical: true };
  compare('class C { #tag; render() { return <this.#tag disabled={value > cutoff || wait} />; } }', options);
  compare('const choose = <T>(item: T) => item < limit;', options);
  compare('const choose = async <T>(item: T) => await pick(item < limit);', options);
});

const decoratorContextRows = readFileSync(new URL('../verification/pict/decorator-context.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of decoratorContextRows) {
  const [enclosing, member, expression, mode] = row.split('\t');
  test(`class member decorator context: ${enclosing} ${member} ${expression} ${mode}`, () => {
    const enclosingFunction = {
      Async: 'async function outer()',
      Generator: 'function* outer()',
      AsyncGenerator: 'async function* outer()',
      Sync: 'function outer()',
    }[enclosing];
    const declaration = {
      Method: 'method() {}',
      AsyncMethod: 'async method() {}',
      GeneratorMethod: '*method() {}',
      Getter: 'get value() {}',
      Setter: 'set value(input) {}',
    }[member];
    const klass = `class C { @dec(${expression.toLowerCase()} value < limit) ${declaration} }`;
    const source = '/* 🧪 */ const keep = a > b; ' + (enclosingFunction ? `${enclosingFunction} { ${klass} }` : klass);
    const result = compare(source, { file: 'decorator.ts', mode: mode.toLowerCase() });
    const permitted = expression === 'Await'
      ? enclosing === 'Async' || enclosing === 'AsyncGenerator' || enclosing === 'Top' && mode === 'Module'
      : enclosing === 'Generator' || enclosing === 'AsyncGenerator';
    assert.equal(result.path, permitted ? 'fallback' : 'diagnostic');
    assert.deepEqual(result.candidates.map(candidate => candidate.operator), permitted ? ['>', '<'] : []);
  });
}

test('parenthesized method decorators retain comparisons inside await operands', () => {
  const source = '/* 🧪 */ async function outer() { class C { @(record(await (value < limit)), dec) method() {} } }';
  const result = compare(source, { file: 'decorator.ts' });
  assert.equal(result.candidates.length, 1);
  assert.equal(Buffer.from(source).toString('utf8', ...result.candidates[0].edit), '<');
});

test('decorator expressions leave method bodies, parameters, and nested functions in their own contexts', () => {
  for (const source of [
    'async function outer() { class C { @dec(await value < limit) method() { await value; } } }',
    'function* outer() { class C { @dec(yield value < limit) method() { yield value; } } }',
    'async function outer() { class C { @dec(await value < limit) async method(input = await value) {} } }',
    'function* outer() { class C { @dec(yield value < limit) *method(input = yield value) {} } }',
    'async function outer() { class C { @dec(() => await value < limit) method() {} } }',
  ]) {
    const result = compare(source, { file: 'decorator.ts' });
    assert.equal(result.path, 'diagnostic', source);
    assert.equal(result.diagnostics.length, 1, source);
    assert.equal(result.diagnostics[0].end, source.lastIndexOf('value') + 'value'.length, source);
  }
});

test('custom early errors point to their UTF-8 source region', () => {
  const source = '/* 🧪 */\nclass A { static prototype = 1; } const probe = left < right;';
  const result = compare(source, { file: 'invalid.ts' });
  const issue = result.diagnostics.find(diagnostic => diagnostic.message.includes("static property named 'prototype'"));
  assert.ok(issue);
  assert.equal(Buffer.from(source).toString('utf8', issue.start, issue.end), 'prototype');
});

test('compiler syntax errors have UTF-8 boundaries on astral tokens', () => {
  const source = '/* 🧪 */const keep = a < b; const 🧪 = value;';
  const result = compare(source, { file: 'astral.ts' });
  const input = Buffer.from(source);
  const isBoundary = position => position === input.length || (input[position] & 0xc0) !== 0x80;
  assert.ok(result.diagnostics.every(diagnostic => isBoundary(diagnostic.start) && isBoundary(diagnostic.end)));
});

test('recovered syntax keeps independent early errors before the malformed region', () => {
  const source = '/* 🧪 */ const keep = a < b; function f() { let eval; const = }';
  const result = compare(source, { file: 'recovery.ts' });
  assert.ok(result.diagnostics.length >= 2);
  const binding = result.diagnostics.find(diagnostic => diagnostic.message.includes("'eval'"));
  assert.ok(binding);
  assert.equal(Buffer.from(source).toString('utf8', binding.start, binding.end), 'eval');
});

test('module comment directives stay separate from source parsing diagnostics', () => {
  compare('/// <amd-module name="first" />\n/// <amd-module name="second" />\nconst keep = a < b;', { file: 'directives.ts' });
});

test('script validation distinguishes lexical restrictions and nested strict scopes', () => {
  const options = { file: 'script.js', mode: 'script' };
  for (const source of [
    'break; const keep = a < b;',
    'return a < b;',
    'function f() { "use strict"; let eval = a < b; }',
    'class A { run(a, a) { return a < b; } }',
    'function f(a, a = 0) { return a < b; }',
    'const arrow = (a, a) => a < b;',
    'function f(a, a) { return a < b; }',
    'if (flag) function f() { return a < b; }',
    'if (flag) let value = a < b;',
    'let eval = a < b; delete eval;',
    '"use strict"; let await = a < b;',
    'async function f() { let await = a < b; }',
    'function f() { try {} catch (error) { let error = a < b; } }',
    'try { run(a < b); } catch ({ a: error, b: error }) {}',
  ]) compare(source, options);
});

test('hoisted vars, parameter type names, and nested exports retain their scopes', () => {
  const module = { file: 'scope.ts' };
  const script = { ...module, mode: 'script' };
  compare('{ var value; } export { value }; const keep = a < b;', module);
  compare('let value; { var value; } const keep = a < b;', module);
  compare('function read(value) { type value = number; return value < b; }', module);
  compare('function read(value) { interface value {} return value < b; }', module);
  compare('function read() { export const value = a < b; }', module);
  compare('namespace Values { export const value = a < b; }', script);
  compare('namespace Values { export { value }; } const keep = a < b;', script);
  compare('type NumberMask = number; const mask = 0755; const keep = a < b;', script);
  compare('function read() {"use strict"; const mask = 0755; return mask < b;}', script);
});

test('field expressions and formal parameters reject invalid value references', () => {
  const options = { file: 'field.ts' };
  for (const source of [
    'function f(){return private < b;}',
    'class C { x = arguments < b; }',
    'class C { x = f(arguments); } const keep = a < b;',
    'class C { x = () => arguments; } const keep = a < b;',
    'class C { x = () => typeof arguments; } const keep = a < b;',
    'const x = new.target; const keep = a < b;',
    'function f() { return new.target; } const keep = a < b;',
    'const f = () => new.target; const keep = a < b;',
    'const keep = a < b; function* f(x=yield 1){}',
    'const keep = a < b; const [...x,y] = z;',
    'const keep = a < b; for (const x, y of z) {}',
    'const keep = a < b; ({ x: 1 } = y);',
    'class C { #x; #x; } const keep = a < b;',
    'class C { m() { return this.#x; } } const keep = a < b;',
    'class C { #x; m() { return this.#x; } } const keep = a < b;',
    'class C { get #x() { return 1; } set #x(v) {} } const keep = a < b;',
  ]) compare(source, options);
});

test('JSX adaptation preserves mixed types, private names, and unmatched tags', () => {
  const options = { file: 'scopes.tsx', logical: true };
  for (const source of [
    'const f = <T>(x:T) => x < y; const view = <div>{a < b}</div>;',
    'const view = <div>{a < b}</div>; const f = async <T>(x:T) => await x < y;',
    'class C { #é; m(){return <this.#é disabled={a < b || c}/>}}',
    'class C { #t; m(){return <this. /* gap */ #t>{a < b}</this.#t>}}',
    'const view = <X.#tag disabled={a || b} />;',
    'class C { #tag; m(){return <this.#tag></this._tag>}} const keep = a < b;',
  ]) compare(source, options);
});

test('TSX repairs keep contextual type parameters and dotted tag spellings', () => {
  const options = { file: 'mixed.tsx', logical: true };
  for (const header of ['const T>', 'T>/* parameter */', 'T// parameter\n>', String.raw`\u0054>`]) {
    compare('const make = <' + header + '(x:T) => x < y; const view = <X disabled={a || b} />;', options);
  }
  for (const tag of ['X.#tag.#item', 'X.#tag-xx', 'X.x-y.#tag', 'X. /*<*/ #tag', 'X.x-y.z']) {
    compare('const view = <' + tag + ' disabled={a || b}>{c < d}</' + tag + '>;', options);
  }
  compare('const view = <X.#item-name></X.item-name>;', options);
  compare('const view = <X.item-name></X.item_name>;', options);
});

test('assignment patterns and iteration heads validate each target', () => {
  const options = { file: 'patterns.ts' };
  for (const expression of [
    '([...x,y]=z)', '({...x,y}=z)', '([...1]=z)', '({...1}=z)', '([...x=1]=z)', '({...x=1}=z)',
    '([x?.y]=z)', '({x:eval}=z)', '({... {x}}=z)', '({...x,}=z)', '([...x,]=z)',
    '({...x}=z)', '([... [x]]=z)', '([x = a < b, { y: target }]=z)',
    '({x:eval as T}=z)', '(eval as T) = rhs', '(eval) = rhs', '(x?.y).z = rhs',
  ]) compare('const keep = a < b; ' + expression + ';', options);
  for (const initializer of ['i,a', '1', 'f()', 'x?.y', 'x as T', '[{ x: a }, ...rest]', '{...rest}']) {
    compare('const keep = a < b; for (' + initializer + ' of xs) {}', options);
  }
  compare('const keep = a < b; const obj = { get #x() { return 3; } };', options);
});

test('script legacy escapes respect nested strictness and actual escape boundaries', () => {
  const options = { file: 'legacy.ts', mode: 'script' };
  for (const escape of ['141', '8', '08', '0', '000', '\\141']) {
    const literal = "'" + '\\' + escape + "'";
    compare('type Z=0; const word=' + literal + ';const keep = a < b;', options);
    compare('function f() { "use strict"; const word=' + literal + ';return a < b;}', options);
  }
  compare('const keep = a < b; while (flag) function f() {}', options);
  compare('const keep = a < b; for (var x=1 in z) {}', options);
});

test('independent errors survive recovery in bodies', () => {
  const cases = [
    ['for (const x,y of z) { const = }', 'Only a single variable', 'const x,y'],
    ['class C { constructor() {} constructor() { const = } }', 'only have one constructor', 'constructor'],
    ['function f(a=1){"use strict"; const =}', 'Illegal', '"use strict"'],
  ];
  for (const [source, message, anchor] of cases) {
    const result = compare(source, { file: 'recovery.ts' });
    const diagnostic = result.diagnostics.find(item => item.message.includes(message));
    assert.ok(diagnostic, source);
    assert.equal(Buffer.from(source).toString('utf8', diagnostic.start, diagnostic.end), anchor);
  }
});

test('unparenthesized assertions can be assignment targets without changing byte spans', () => {
  const options = { file: 'assertion.ts' };
  for (const expression of [
    '(x as T = z)', '(eval as T = z)', '(<T>x = z)', '(x satisfies T = z)',
    'x as T as U += z', 'foo(x as T = z, x < y)', '(x as T = z) < q',
    '([] as T = z)', '(x as T + y = z)',
  ]) compare('/* 🧪 */ const keep = a < b; ' + expression + ';', options);
  compare('const view = <X.#tag-xx>{a < b}</X.#tag-xx>; const raw = "</X.#tag-xx>";', { file: 'literal.tsx' });
});

test('computed enum members and strict labelled function declarations discard mutations', () => {
  const options = { file: 'declarations.ts' };
  for (const member of ['[foo]', '["foo"]', '[1]', 'plain', '"plain"']) {
    compare('enum X { ' + member + ' = 1 } const keep = a < b;', options);
  }
  compare('label: function f() {} const keep = a < b;', options);
  compare('label: function f() {} const keep = a < b;', { ...options, mode: 'script' });
});

test('type argument lists after import types can cross trivia with a line break', () => {
  const options = { file: 'import-types.ts' };
  for (const gap of ['\n', ' /* 🧪\n */ ', ' // comment\r\n ', '\u2028']) {
    for (const tail of ['<T> >= limit', '<T>> limit', '<T> + a < b', '<Box<T> + limit', '<T']) {
      compare('const keep = a < b; const value = input as keyof import("pkg").Model' + gap + tail + ';', options);
    }
  }
  compare('const value = input as Other\n<T> + a < b;', options);
});

test('var declarations stay visible through statement edges in the same scope', () => {
  const options = { file: 'hoist.ts' };
  for (const body of [
    'if (flag) { var clash; } else { var clash; }',
    'switch (key) { case 0: var clash; break; default: break; }',
    'try {} catch { var clash; } finally { var clash; }',
    'label: for (var clash of items) {}',
    'call(function () { var clash; });',
    'class C { static { var clash; } }',
    'namespace Nested { var clash; }',
  ]) compare('let clash; ' + body + ' const keep = a < b;', options);
  compare('let broken; const broken = 0;', options);
  compare('const value = a || b;', { ...options, logical: true });
});
