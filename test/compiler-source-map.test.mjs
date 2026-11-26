import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { certificationCases, denseCases } from '../scripts/generate-compiler-validation-cases.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { compile } = require('../src/compiler.cjs');
const router = require('../src/compiler-routes.cjs').compile;

const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// An independent decoder: one array of [generatedColumn, sourceLine, sourceColumn] per generated line.
// A segment of one field marks generated text and decodes to [generatedColumn].
function decode(mappings) {
  let sourceLine = 0, sourceColumn = 0;
  return mappings.split(';').map(line => {
    let column = 0;
    return line === '' ? [] : line.split(',').map(segment => {
      const fields = [];
      let value = 0, shift = 0;
      for (const character of segment) {
        const digit = digits.indexOf(character);
        assert.ok(digit >= 0, segment);
        value += (digit & 31) * 2 ** shift;
        shift += 5;
        if (digit < 32) {
          fields.push(value % 2 ? -(value - 1) / 2 : value / 2);
          value = shift = 0;
        }
      }
      column += fields[0];
      if (fields.length === 1) return [column];
      assert.equal(fields.length, 4, segment);
      assert.equal(fields[1], 0, segment);
      sourceLine += fields[2];
      sourceColumn += fields[3];
      return [column, sourceLine, sourceColumn];
    });
  });
}

const lines = text => text.split(/\r\n|[\n\r\u2028\u2029]/);

// Blank, word or punctuation. Only ASCII blanks separate runs, so a no-break space in a string counts as a word character.
const kind = character => /[ \t\v\f]/.test(character) ? 0 : /[\w$\u0080-\uffff]/.test(character) ? 1 : 2;

// Every segment sits on a token of the output and maps it to the same text in the source.
// Returns the number of segments. Lowered output also holds generated text, which has no segment.
export function assertSegmentsFaithful(source, result, projection = false) {
  const table = decode(result.sourceMap.mappings);
  const generated = lines(result.code), original = lines(source);
  assert.ok(table.length <= generated.length);
  let count = 0, previous;
  for (const [row, segments] of table.entries()) {
    for (const [index, [column, sourceLine, sourceColumn]] of segments.entries()) {
      if (sourceLine === undefined) {
        // Generated text is marked once, where it first follows a mapped copy, on the same line or a later one.
        // In a projection only a written separator or parenthesis is generated.
        assert.ok(previous?.length === 3 && (index === 0 || column > segments[index - 1][0]) &&
          (!projection || /[;()]/.test(generated[row][column])), `unmapped segment at line ${row} column ${column}`);
        previous = segments[index];
        continue;
      }
      previous = segments[index];
      const here = generated[row][column];
      assert.ok(here !== undefined && kind(here) !== 0, `segment at line ${row} column ${column} is not on a token`);
      if (projection) {
        assert.ok(column === 0 || kind(generated[row][column - 1]) !== kind(here), `segment at line ${row} column ${column} splits a run`);
      }
      let end = column + 1;
      while (end < generated[row].length && kind(generated[row][end]) === kind(here)) end++;
      const run = generated[row].slice(column, end);
      const there = original[sourceLine]?.slice(sourceColumn, sourceColumn + run.length);
      // A copy may end inside a run of lowered output, and may continue behind a written separator or parenthesis.
      assert.ok(there === run || there?.[0] === here && (!projection || /[;()]/.test(run)),
        `segment at line ${row} column ${column} maps ${JSON.stringify(run)} to ${JSON.stringify(there)}`);
      count++;
    }
  }
  return count;
}

// Whether the output keeps every byte position of the source. A lowered output may have the same length by chance,
// so the line breaks have to sit at the same offsets as well.
export function isProjection(source, code) {
  const from = Buffer.from(source), to = Buffer.from(code);
  return from.length === to.length && from.every((byte, at) => (byte === 10 || byte === 13) === (to[at] === 10 || to[at] === 13));
}

// Every token of the output maps to the same token text in the source.
export function assertTokensMapped(source, result) {
  assertSegmentsFaithful(source, result, true);
  const table = decode(result.sourceMap.mappings);
  const generated = lines(result.code), original = lines(source);
  const starts = [0];
  for (const match of result.code.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) starts.push(match.index + match[0].length);
  const scanner = ts.createScanner(ts.ScriptTarget.ESNext, true, ts.LanguageVariant.Standard, result.code);
  let line = 0, tokens = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const at = scanner.getTokenStart();
    while (line + 1 < starts.length && starts[line + 1] <= at) line++;
    const column = at - starts[line];
    const segment = (table[line] ?? []).findLast(entry => entry[0] <= column);
    // A written separator that opens a line has no segment when the text before it was generated as well.
    if (!segment && /^[;()]$/.test(scanner.getTokenText())) continue;
    assert.ok(segment, `No mapping for line ${line} column ${column}`);
    // A string or template may span lines. Its first line is enough to identify it.
    // The scanner cannot tell a template tail from a brace, so it may run on. The first run of
    // characters without white space still identifies the position.
    const token = lines(scanner.getTokenText())[0].split(/\s/)[0];
    const found = segment.length === 1 ? '' : original[segment[1]].slice(segment[2] + column - segment[0]);
    // A separator or a parenthesis written over erased syntax has no counterpart in the source.
    if (segment.length === 1 || !found.startsWith(token)) {
      assert.ok(token === ';' || token === '(' || token === ')',
        `line ${line} column ${column}: ${JSON.stringify(token)} maps to ${JSON.stringify(found.slice(0, 20))}`);
    }
    else tokens++;
  }
  return tokens;
}

function mapped(source, file = 'a.ts', input = source) {
  const options = file === undefined ? { sourceMap: true } : { file, sourceMap: true };
  const result = compile(input, options);
  const plain = compile(input, file === undefined ? {} : { file });
  if (result.backend === 'pulse') assert.equal(result.code, plain.code);
  assert.deepEqual(router(input, options), result);
  // Apart from the mappings, the map is the one TypeScript writes for the same name.
  const reference = JSON.parse(ts.transpileModule(source, { fileName: file ?? 'input.ts', compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, sourceMap: true, inlineSources: true,
  } }).sourceMapText);
  for (const key of ['version', 'file', 'sourceRoot', 'sources', 'names', 'sourcesContent']) {
    assert.deepEqual(result.sourceMap[key], reference[key], key);
  }
  assert.deepEqual(Object.keys(result.sourceMap), Object.keys(reference));
  return result;
}

const rows = readFileSync(new URL('../verification/pict/compiler-source-map.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const endings = { LF: '\n', CRLF: '\r\n', CR: '\r', LS: '\u2028', PS: '\u2029' };
// The native grammar takes non-ASCII text in strings and comments, not in identifiers.
const kept = { None: 'plain', KeptBmp: 'val\u00e9\u578b', KeptAstral: 'v\u{20bb7}x', ErasedBmp: 'plain', ErasedAstral: 'plain' };
const erased = { None: 'plain', KeptBmp: 'plain', KeptAstral: 'plain', ErasedBmp: 'K\u00e9\u578b\u2014', ErasedAstral: 'K\u{20bb7}' };
const names = { TS: 'a.ts', MTS: 'a.mts', Nested: 'src/deep/a.ts', Omitted: undefined };

for (const row of rows) {
  test('compiler source map ' + row.replaceAll('\t', ' '), () => {
    const [ending, nonAscii, edit, form, name] = row.split('\t');
    const text = `"${kept[nonAscii]}"`, literal = `"${erased[nonAscii]}"`;
    const body = {
      None: [`const value = ${text};`, `export const result = [value, ${text}];`],
      Annotation: [`type Kind = ${literal} | string;`, `const value: Kind | ${literal} = ${text}; const other: ${literal} | Kind = value as Kind;`,
        `export const result = [value, other];`],
      ErasedStatement: [`const value = ${text};`, `interface Shape { field: ${literal} } const after = ${text};`, `type Other = Shape;`,
        `export const result = [value, after];`],
      Separator: [`type Kind = ${literal}`, `const value = ${text}`, `type Next = Kind | ${literal}`, `;[value].length`,
        `export const result = value`],
      // An arrow result type with non-ASCII text is outside the native grammar, so the literal stays in the parameter.
      Parenthesis: [`type Kind = ${literal};`, `const value = async (first: Kind | ${literal}): Promise<Kind> => first;`,
        `export const result = [value, ${text}];`],
      Lowered: [`enum Kind { First }`, `const value = [Kind.First, ${text}, ${literal}];`, `export const result = value;`],
    }[edit];
    const source = body.join(endings[ending]) + endings[ending];
    const result = mapped(source, names[name], form === 'Bytes' ? Buffer.from(source) : source);
    assert.equal(result.backend, 'pulse');
    if (edit === 'Lowered') {
      // The enum body is generated. Its name, its members and the statements around it are copies.
      assert.ok(assertSegmentsFaithful(source, result) >= 12);
      const table = decode(result.sourceMap.mappings);
      const last = lines(result.code).findLastIndex(line => line.startsWith('export const result'));
      assert.deepEqual(table[last][0], [0, 2, 0]);
      return;
    }
    assert.ok(assertTokensMapped(source, result) >= 8);
  });
}

test('fixtures keep every token mapped', () => {
  let native = 0, lowered = 0;
  for (const { file, source } of [...denseCases(), ...certificationCases()]) {
    if (!/\.ts$/.test(file)) continue;
    const text = Buffer.from(source, 'base64').toString();
    const result = compile(Buffer.from(text), { file, sourceMap: true });
    if (result.backend !== 'pulse') continue;
    assert.equal(result.code, compile(Buffer.from(text), { file }).code, file);
    if (isProjection(text, result.code)) assertTokensMapped(text, result);
    else if (result.sourceMap.mappings !== '') lowered += assertSegmentsFaithful(text, result) > 0;
    native++;
  }
  assert.ok(native >= 60, String(native));
  assert.ok(lowered >= 5, String(lowered));
});

test('outputs that are not projections and unusual inputs take the router', () => {
  const typed = 'const n: number = 1;\nexport const result = n;\n';
  for (const [source, file] of [
    ['export const view = <i {...{ __proto__: null }}/>;\n', 'a.tsx'],
    ['\ufeff' + typed, 'a.ts'],
    [typed, 'index.d.ts'],
    [typed, 'index.d.mts'],
    [typed, 'A.TS'],
    [typed, 'dir\\a.ts'],
    ['export const n = 1;\n', 'a.mjs'],
  ]) {
    for (const input of [source, Buffer.from(source)]) {
      const options = { file, sourceMap: true };
      const result = compile(input, options);
      assert.notEqual(result.backend, 'pulse', file + ' ' + JSON.stringify(source));
      assert.deepEqual(result, router(input, options));
    }
  }
  assert.deepEqual(compile('const s: string = "\ud800";\n', { file: 'a.ts', sourceMap: true }),
    router('const s: string = "\ud800";\n', { file: 'a.ts', sourceMap: true }));
});

test('parameter properties map the copied names and the text around the inserted statements', () => {
  const source = 'class C {\n  constructor(public first: number, private readonly second = 2) { this.first; }\n}\nexport const result = new C(1);\n';
  const result = mapped(source);
  assert.equal(result.backend, 'pulse');
  assertSegmentsFaithful(source, result);
  const table = decode(result.sourceMap.mappings);
  const generated = lines(result.code);
  const at = (row, text) => table[row].find(segment => segment[0] === generated[row].indexOf(text));
  // Field declarations and assignments point at the parameter names.
  assert.deepEqual(at(generated.indexOf('first;'), 'first'), [0, 1, 21]);
  assert.deepEqual(at(generated.indexOf('second;'), 'second'), [0, 1, 53]);
  const assignment = generated.findIndex(line => line.startsWith('this.first = first;'));
  assert.deepEqual(table[assignment], [[0], [5, 1, 21], [10], [13, 1, 21], [18]]);
  const tail = generated.findIndex(line => line.startsWith('export const result'));
  assert.deepEqual(table[tail][0], [0, 3, 0]);
  // Text after the insertions on the constructor's line keeps its own columns.
  const body = generated.findIndex(line => line.includes('this.first; }'));
  assert.deepEqual(at(body, 'this.first; }'), [generated[body].indexOf('this.first; }'), 1, 67]);
});

test('lowered JSX maps the copied names and expressions on both sides of the inserted import', () => {
  const source = [
    '// lead',
    'const prefix: string = "p";',
    'import { useState } from "react";',
    'type Props = { name: string };',
    'export function View({ name }: Props) {',
    '  const [count, setCount] = useState<number>(0);',
    '  return <div className="box" onClick={() => setCount(count + 1)}>',
    '    Hello {name}: {prefix}',
    '  </div>;',
    '}',
    '',
  ].join('\n');
  for (const jsx of ['automatic', 'classic']) {
    const options = { file: 'view.tsx', sourceMap: true, jsx };
    const result = compile(source, options);
    assert.equal(result.backend, 'pulse');
    assert.deepEqual(router(source, options), result);
    assert.equal(result.code, compile(source, { file: 'view.tsx', jsx }).code);
    assert.equal(result.sourceMap.file, 'view.js');
    assert.ok(assertSegmentsFaithful(source, result) >= 30);
    const table = decode(result.sourceMap.mappings);
    const generated = lines(result.code), original = lines(source);
    const mapsTo = (text, sourceText = text) => {
      const row = generated.findIndex(line => line.includes(text));
      const segment = table[row].find(entry => entry[0] === generated[row].indexOf(text));
      const sourceRow = original.findIndex(line => line.includes(sourceText));
      assert.deepEqual(segment, [generated[row].indexOf(text), sourceRow, original[sourceRow].indexOf(sourceText)], text);
    };
    // Text before the inserted helper import, the import itself and text after it.
    mapsTo('prefix', 'prefix: string');
    mapsTo('useState } from');
    mapsTo('View(');
    mapsTo('setCount(count', 'setCount(count');
    mapsTo('name)', 'name}');
    mapsTo('prefix)', 'prefix}');
    mapsTo('div', 'div className');
    // The generated helper call is not attributed to the copy before it.
    const row = generated.findIndex(line => line.includes('return '));
    const helper = generated[row].indexOf(jsx === 'classic' ? 'React.createElement' : '_tmtJsx');
    assert.deepEqual(table[row].findLast(entry => entry[0] <= helper), [helper]);
  }
});

test('generated text at the start of a line does not inherit the mapping of the line before', () => {
  const source = 'export const View = () => (\r\n  <X/>\r\n);\r\n';
  const result = compile(source, { file: 'view.tsx', jsx: 'classic', sourceMap: true });
  assert.equal(result.backend, 'pulse');
  const table = decode(result.sourceMap.mappings);
  const row = lines(result.code).findIndex(line => line.includes('React.createElement'));
  assert.ok(row > 0);
  assert.deepEqual(table[row][0], [lines(result.code)[row].indexOf('React.createElement')]);
  assertSegmentsFaithful(source, result);
});

test('a JSX key expression keeps its mapping when it moves behind the properties', () => {
  const source = 'const item = { id: 1 };\nexport const view = <Item key={item.id} label="caf\u00e9 \u{1f600}" other={item} />;\n';
  const result = compile(source, { file: 'view.tsx', sourceMap: true });
  assert.equal(result.backend, 'pulse');
  assertSegmentsFaithful(source, result);
  const table = decode(result.sourceMap.mappings);
  const generated = lines(result.code);
  const row = generated.findIndex(line => line.includes('item.id'));
  const column = generated[row].indexOf('item.id');
  assert.ok(column > generated[row].indexOf('other'), generated[row]);
  assert.deepEqual(table[row].find(entry => entry[0] === column), [column, 1, lines(source)[1].indexOf('item.id')]);
});

test('an explicit module marker and a script directive leave the code as it is without a map', () => {
  const marked = 'export type T = number;\r\nconst n: T = 1;\r\nconsole.log(n);\r\n';
  const module = compile(marked, { file: 'main.mts', sourceMap: true });
  assert.equal(module.backend, 'pulse');
  assert.equal(module.code, compile(marked, { file: 'main.mts' }).code);
  assert.match(module.code, /export \{\};\n$/);
  assert.equal(module.sourceMap.file, 'main.mjs');
  assert.ok(assertSegmentsFaithful(marked, module) >= 8);
  assert.deepEqual(router(marked, { file: 'main.mts', sourceMap: true }), module);

  const erased = compile('// note\nexport type T = number;\n', { file: 'types.mts', sourceMap: true });
  assert.equal(erased.backend, 'pulse');
  assert.equal(erased.code, compile('// note\nexport type T = number;\n', { file: 'types.mts' }).code);
  assert.match(erased.code, /export \{\};\n$/);
  assert.equal(erased.sourceMap.mappings, '');

  const text = 'const message: string = "caf\u00e9";\r\nconsole.log(message);\r\n';
  for (const input of [text, Buffer.from(text)]) {
    const script = compile(input, { file: 'tool.ts', sourceMap: true });
    assert.equal(script.backend, 'pulse');
    assert.deepEqual({ ...script, sourceMap: null }, compile(input, { file: 'tool.ts' }));
    assert.match(script.code, /^"use strict";\n/);
    assert.deepEqual(router(input, { file: 'tool.ts', sourceMap: true }), script);
    const table = decode(script.sourceMap.mappings);
    assert.deepEqual(table[0], []);
    assert.deepEqual(table[1].slice(0, 2), [[0, 0, 0], [6, 0, 6]]);
    assert.deepEqual(table[2][0], [0, 1, 0]);
    assert.deepEqual(script.sourceMap.sourcesContent, [text]);
  }
});

test('a module of types alone has an empty map', () => {
  for (const source of ['export type T = number;\n', '// note\nexport interface I { x: number }\n/* tail */\n',
    'import type { A } from "./a.js";\nexport type T = A']) {
    const result = mapped(source);
    assert.equal(result.backend, 'pulse');
    assert.equal(result.sourceMap.mappings, '');
    assert.doesNotMatch(result.code.replace(/\/\/.*|\/\*[^]*?\*\//g, ''), /\S/);
  }
});

test('only a projection of the source receives mappings', () => {
  const addon = { exports: {} };
  process.dlopen(addon, fileURLToPath(new URL('../build/compiler-module.node', import.meta.url)));
  const mappings = (source, code) => addon.exports.projectionMappings(Buffer.from(source), Buffer.from(code));
  const positions = (source, code) => decode(mappings(source, code));
  assert.deepEqual(positions('let a: T = 1;\n', 'let a    = 1;\n'), [[[0, 0, 0], [4, 0, 4], [9, 0, 9], [11, 0, 11], [12, 0, 12]], []]);
  assert.deepEqual(positions('a\r\nb\u2028c\rd\u2029e\nf', 'a\r\nb\u2028c\rd\u2029e\nf'),
    [[[0, 0, 0]], [[0, 1, 0]], [[0, 2, 0]], [[0, 3, 0]], [[0, 4, 0]], [[0, 5, 0]]]);
  // The separator written over the opening parenthesis is generated text.
  assert.deepEqual(positions('x as T\n(y)', 'x     \n;y)'), [[[0, 0, 0]], [[0], [1, 1, 1], [2, 1, 2]]]);
  assert.deepEqual(positions('a = 1\n  public [k]() {}', 'a = 1\n  ;      [k]() {}'),
    [[[0, 0, 0], [2, 0, 2], [4, 0, 4]], [[2], [9, 1, 9], [10, 1, 10], [11, 1, 11], [15, 1, 15]]]);
  // Erased scalars keep their UTF-8 and UTF-16 width, so columns after them agree on both sides.
  assert.deepEqual(positions('let a: "\u00e9\u578b\u{20bb7}" = 1', 'let a   \u00a0\u2002 \ufeff  = 1'),
    [[[0, 0, 0], [4, 0, 4], [14, 0, 14], [16, 0, 16]]]);
  assert.deepEqual(positions('["\u00e9\u578b\u{20bb7}"];', '["\u00e9\u578b\u{20bb7}"];'), [[[0, 0, 0], [2, 0, 2], [6, 0, 6]]]);
  for (const [source, code] of [
    ['let a: T = 1;', 'let b    = 1;'],
    ['let a: T = 1;', 'let a  x = 1;'],
    ['let a = 1;', 'let a = 1;;'],
    ['let a = 1;;', 'let a = 1;'],
    ['a\nb', 'a b'],
    ['a\r\nb', 'a\r b'],
    ['a\rb', 'a b'],
    ['a\u2028b', 'a\u2002b'],
    ['a\u2029b', 'a   b'],
    ['"\u578b"', '"   "'],
    ['"\u00e9"', '"  "'],
    ['"\u{20bb7}"', '"    "'],
    ['"\u578b"', '"\u2002'],
    ['x\u00e9', 'x;\u00a9'],
  ]) {
    assert.equal(mappings(source, code), undefined, JSON.stringify([source, code]));
  }
});

test('copy runs map across generated text, earlier copies and long sources', () => {
  const addon = { exports: {} };
  process.dlopen(addon, fileURLToPath(new URL('../build/compiler-module.node', import.meta.url)));
  const mappings = (source, code, runs) =>
    addon.exports.projectionMappings(Buffer.from(source), Buffer.from(code), Uint32Array.from(runs.flat()));
  const at = (text, part, from = 0) => Buffer.byteLength(text.slice(0, text.indexOf(part, from)));
  const positions = (...values) => decode(mappings(...values));

  // Generated non-ASCII text moves the generated column by its UTF-16 width, also across a generated line.
  let source = 'alpha beta';
  let code = '\u{20bb7}\u00e9(beta);\n\u578b alpha';
  assert.deepEqual(positions(source, code, [[at(code, 'beta'), 6, 4], [at(code, 'alpha'), 0, 5]]), [[[4, 0, 6], [8]], [[2, 0, 0]]]);

  // An erased scalar inside a copy leaves the source position at its end for the next copy.
  source = 'f(a as "\u{20bb7}\u578b", b)';
  code = 'f(a      \ufeff\u2002 , b)';
  const split = at(source, ', b');
  assert.deepEqual(positions(source, code, [[0, 0, split], [split, split, 4]]),
    [[[0, 0, 0], [1, 0, 1], [2, 0, 2], [12, 0, 12], [14, 0, 14], [15, 0, 15]]]);

  // A copy of earlier text in a long source finds its line and column again.
  const lines = Array.from({ length: 900 }, (_, index) => `const name${index} = ${index};`);
  source = lines.join('\r\n');
  const early = at(source, 'name3 '), late = at(source, 'name870 ');
  code = source.slice(0, late) + 'name870, name3 /* generated */ ' + source.slice(late);
  const table = positions(source, code, [[0, 0, late + 7], [late + 9, early, 5], [late + 31, late, Buffer.byteLength(source) - late]]);
  assert.deepEqual(table[870], [[0, 870, 0], [6, 870, 6], [13], [15, 3, 6], [20], [37, 870, 6], [45, 870, 14], [47, 870, 16], [50, 870, 19]]);
  assert.deepEqual(table[899].at(-1), [19, 899, 19]);
  assert.equal(table.length, 900);

  for (const [from, to, runs] of [
    ['a\r\nb', 'a\rX\nb', [[0, 0, 2], [3, 2, 2]]],
    ['abcd', 'abcd', [[0, 0, 3], [2, 2, 2]]],
    ['abcd', 'abcd', [[0, 2, 4]]],
    ['abcd', 'abcd', [[2, 0, 4]]],
    ['abcd', 'abxd', [[0, 0, 4]]],
    ['a\r\nb', 'xb', [[1, 2, 1], [0, 0, 0]]],
    ['a\r\nb', '\nb', [[0, 2, 2]]],
  ]) {
    assert.equal(mappings(from, to, runs), undefined, JSON.stringify([from, to, runs]));
  }
});

test('the command line writes the native map inline', () => {
  const source = 'const n: number = 1;\nexport const result = n;\n';
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/tmt-compile.mjs', import.meta.url)),
    '--source-map', '--file', 'a.ts', '-'], { input: source, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const expected = compile(source, { file: 'a.ts', sourceMap: true });
  assert.equal(expected.backend, 'pulse');
  const [code, comment] = run.stdout.split('\n//# sourceMappingURL=data:application/json;base64,');
  assert.equal(code, expected.code);
  assert.deepEqual(JSON.parse(Buffer.from(comment.trim(), 'base64').toString()), expected.sourceMap);
});

test('a file with legacy decorators gets a map that leads to the source', () => {
  const options = { file: 'legacy.ts', experimentalDecorators: true };
  for (const [source, metadata] of [
    ['function d(c: any) {}\n@d export class A { x: number = 1; m(): void {} }\nexport const n: number = 2;', false],
    ['const dec = (...a: any[]): any => () => {};\nexport class S {\n  @dec() name: string = "a";\n  constructor(@dec() private readonly dep: Dep, public other = 1) {}\n  @dec() run(@dec() p: number): number { return p; }\n}\nexport enum E { A }\n', false],
    ['const dec = (c: any) => c;\n@dec\nexport class Self {\n  static make() { return new Self(); }\n}\n// a comment\nexport const after: string = "x";\n', false],
    ['const dec = (...a: any[]): any => () => {};\r\nclass Dep {}\r\n@dec()\r\nexport class M {\r\n  @dec() field: Dep;\r\n  constructor(private d: Dep, n: number) {}\r\n}\r\n', true],
    ['const dec = (c: any) => c;\nnamespace N { export const a: number = 1; }\n@dec export default class extends Object { static n: number = N.a; }\nfunction tail(x: string): string { return x; }\nexport { tail };', false],
  ]) {
    const plain = compile(Buffer.from(source), { ...options, emitDecoratorMetadata: metadata });
    const result = compile(Buffer.from(source), { ...options, emitDecoratorMetadata: metadata, sourceMap: true });
    assert.equal(result.backend, 'pulse', source);
    // The code is the same with and without a map.
    assert.equal(result.code, plain.code, source);
    assert.deepEqual({ ...result.sourceMap, mappings: '' }, { version: 3, file: 'legacy.js', sourceRoot: '', sources: ['legacy.ts'], names: [], mappings: '', sourcesContent: [source] });
    assert.ok(assertSegmentsFaithful(source, result) >= 10, source);
    // What the lowering wrote has no place in the source: the helper in front of the first statement has no segment.
    assert.match(result.sourceMap.mappings, /^;+/);
  }
  // A token behind the class still leads to its place in the source.
  const source = 'function d(c: any) {}\n@d export class A { x: number = 1; }\nexport const marker: number = 2;';
  const result = compile(Buffer.from(source), { ...options, sourceMap: true });
  const table = decode(result.sourceMap.mappings);
  const row = lines(result.code).findIndex(line => line.includes('marker'));
  const column = lines(result.code)[row].indexOf('marker');
  const segment = table[row].findLast(entry => entry[0] <= column && entry.length === 3);
  assert.deepEqual([segment[1], segment[2] + (column - segment[0])], [2, source.split('\n')[2].indexOf('marker')]);
  // Without a decorator the option changes nothing, and a file that the lowering leaves to TypeScript still gets TypeScript's map.
  const none = 'export const a: number = 1; // mail @home';
  assert.deepEqual(compile(Buffer.from(none), { ...options, sourceMap: true }), compile(Buffer.from(none), { file: 'legacy.ts', sourceMap: true }));
  const refused = compile(Buffer.from('function d(c: any) {}\nfor (const i of [1]) { @d class K { static me() { return K; } } }\nexport {};'), { ...options, sourceMap: true });
  assert.equal(refused.backend, 'typescript');
  assert.equal(typeof refused.sourceMap.mappings, 'string');
});

test('leading a map on through an unchanged text gives the map itself', () => {
  const { composeLegacyMappings } = require('../src/compiler-legacy-maps.cjs');
  for (const source of [
    'export enum E { A = 1, B }\nnamespace N { export const a: number = E.A; export function f(x: string): string { return x; } }\nexport class C { constructor(public x: number, private y = 2) {} }\nexport const out: number = N.a;\n',
    'export const a: number = 1;\r\nexport function f(x: string): string {\r\n  return x as string;\r\n}\r\nexport enum Color { Red = "red", Blue = "blue" }\r\n',
    'const s: string = "café → x"; // été\nexport enum U { A }\nexport const t: string = s;\n',
  ]) {
    const result = compile(Buffer.from(source), { file: 'same.ts', sourceMap: true });
    assert.equal(result.backend, 'pulse', source);
    const bytes = Buffer.from(source);
    assert.equal(composeLegacyMappings(bytes, bytes, [[bytes.length, 0]], result.sourceMap.mappings, result.code), result.sourceMap.mappings, source);
    // The same text in three pieces, one of them empty.
    const cut = bytes.indexOf(10) + 1;
    assert.equal(composeLegacyMappings(bytes, bytes, [[cut, 0], [0, -1], [bytes.length - cut, cut]], result.sourceMap.mappings, result.code), result.sourceMap.mappings, source);
  }
  // A text with a line written in front: every place moves down by a line, and nothing leads into the new line.
  const source = 'export enum E { A }\nexport const a: number = E.A;\n';
  const front = Buffer.from('const added = 0;\n'), bytes = Buffer.from(source), rewritten = Buffer.concat([front, bytes]);
  const result = compile(rewritten, { file: 'same.ts', sourceMap: true });
  const led = composeLegacyMappings(bytes, rewritten, [[front.length, -1], [bytes.length, 0]], result.sourceMap.mappings, result.code);
  const direct = compile(bytes, { file: 'same.ts', sourceMap: true });
  assert.equal(led, ';' + direct.sourceMap.mappings);
  // A map that is no map, or that does not fit the text, is not led on.
  const good = direct.sourceMap.mappings;
  for (const [mappings, spans, code] of [
    ['AAAA,!', [[bytes.length, 0]], direct.code], ['AAAA,g', [[bytes.length, 0]], direct.code], ['AAA', [[bytes.length, 0]], direct.code], ['ACAA', [[bytes.length, 0]], direct.code],
    [good, [[bytes.length - 1, 0]], direct.code], [good, [[bytes.length, 0]], 'x'], ['AAoGA', [[bytes.length, 0]], direct.code], ['AAAoG,oG', [[bytes.length, 0]], direct.code],
  ]) {
    assert.equal(composeLegacyMappings(bytes, bytes, spans, mappings, code), null, mappings);
  }
});

test('what the decorator lowering wrote is marked as generated behind a copy', () => {
  const source = 'function d(c: any) {}\n@d export class A { x: number = 1; }\nexport const marker: number = 2;';
  const result = compile(Buffer.from(source), { file: 'legacy.ts', experimentalDecorators: true, sourceMap: true });
  const table = decode(result.sourceMap.mappings);
  const rows = lines(result.code);
  const row = rows.findIndex(line => line.includes('__decorate(['));
  const column = rows[row].indexOf('__decorate([');
  // The call of the helper is generated text: the segment that covers it has one field.
  const covering = table.slice(0, row + 1).flat().length === 0 ? undefined : (table[row].findLast(entry => entry[0] <= column) ?? table.slice(0, row).flat().at(-1));
  assert.equal(covering.length, 1, JSON.stringify(table[row]));
  // A line with generated text and a copy behind it keeps both.
  const mixed = 'const dec = (...a: any[]): any => () => {};\nexport class S {\n  constructor(@dec() private readonly dep: object, public other = 1) {}\n  m(): number { return 1; }\n}\nexport const tail: number = 3;\n';
  const lowered = compile(Buffer.from(mixed), { file: 'legacy.ts', experimentalDecorators: true, sourceMap: true });
  assert.equal(lowered.backend, 'pulse');
  const segments = decode(lowered.sourceMap.mappings);
  assert.ok(segments.some(line => line.some((entry, index) => entry.length === 1 && line.slice(index + 1).some(later => later.length === 3))), lowered.sourceMap.mappings);
  assert.ok(assertSegmentsFaithful(mixed, lowered) >= 20);
});

test('a token behind a lowered decorator on the same line leads to its own place', () => {
  const source = 'const dec = (...a: any[]): any => () => {};\nexport class S { @dec() first() { return 1; } @dec() second() { return [2, 3]; } third() { return this; } }\nexport const end = 0;\n';
  const result = compile(Buffer.from(source), { file: 'legacy.ts', experimentalDecorators: true, sourceMap: true });
  assert.equal(result.backend, 'pulse');
  const table = decode(result.sourceMap.mappings);
  const rows = lines(result.code), original = lines(source);
  let checked = 0;
  for (const word of ['first', 'second', 'third', 'return 1', 'return [2, 3]', 'return this', 'end']) {
    const row = rows.findIndex(line => line.includes(word));
    const column = rows[row].indexOf(word);
    const segment = table[row].findLast(entry => entry[0] <= column);
    assert.equal(segment.length, 3, word);
    const place = [segment[1], segment[2] + (column - segment[0])];
    const expected = original.findIndex(line => line.includes(word));
    assert.deepEqual(place, [expected, original[expected].indexOf(word)], word);
    checked++;
  }
  assert.equal(checked, 7);
  assert.ok(assertSegmentsFaithful(source, result) >= 10);
});

test('JavaScript published as written receives a map that leads every position to itself', () => {
  const identity = (source, file, down) => {
    const result = compile(Buffer.from(source), { file, sourceMap: true });
    assert.equal(result.backend, 'javascript', source);
    assert.equal(result.code, compile(Buffer.from(source), { file }).code);
    assert.ok(result.code.endsWith(source));
    assert.deepEqual(result.sourceMap.sources, [file.slice(file.lastIndexOf('/') + 1)]);
    assert.equal(result.sourceMap.file, result.sourceMap.sources[0]);
    assert.deepEqual(result.sourceMap.sourcesContent, [source]);
    const lines = decode(result.sourceMap.mappings);
    let segments = 0;
    lines.forEach((line, generatedLine) => {
      for (const [column, sourceLine, sourceColumn] of line) {
        assert.equal(sourceLine, generatedLine - down, source);
        assert.equal(sourceColumn, column, source);
        segments++;
      }
    });
    assert.ok(segments > 3, source);
    for (let line = 0; line < down; line++) assert.deepEqual(lines[line], []);
  };
  // A module is published as written.
  identity('// note\nexport   const a = 1\nexport function f(x) { return x+1 }\n', 'plain.js', 0);
  identity('export const text = "日本語", pair = "😀", after = `a\n${text}b`;\n', 'dir/unicode.mjs', 0);
  identity('export const a = 1;\r\nexport const b = a;\r\n', 'crlf.js', 0);
  // A script is published behind a strict directive, which moves the map down by one line.
  identity('const a = 1;\nconsole.log(a);\n', 'script.js', 1);
  // What is not published as written keeps the TypeScript route: a hashbang, JSX, and invalid text.
  assert.equal(compile(Buffer.from('#!/usr/bin/env node\nexport const a = 1;\n'), { file: 'bin.mjs', sourceMap: true }).backend, 'typescript');
  assert.equal(compile(Buffer.from('export const e = <div/>;\n'), { file: 'view.jsx', sourceMap: true }).backend, 'typescript');
  assert.equal(compile(Buffer.from('const a = ;\n'), { file: 'broken.js', sourceMap: true }).code, null);
  identity('const a = 1;\nmodule.exports = a;\n', 'common.cjs', 1);
});

test('source maps for CommonJS output, jsx: preserve, and non-ASCII identifiers are faithful', () => {
  // 1. CommonJS output (.ts, .tsx, .js, and legacy decorators + CJS).
  for (const [source, file, extra = {}] of [
    ['import { helper } from "./dep";\nexport const value: number = helper(1) + 2;\nexport function greet(name: string): string { return name + value; }\n', 'mod.ts'],
    ['import defaultFn from "./dep";\nexport const fn = (x: number) => defaultFn(x);\nexport default class Box { id: number = 1; }\n', 'dir/box.ts'],
    ['import { helper } from "./dep";\nexport const View = ({ id }: { id: string }) => <div data-id={id}>{helper(id)}</div>;\n', 'View.tsx'],
    ['import { helper } from "./dep";\nexport const x = helper(1);\n', 'plain.js'],
    ['import { dec } from "./dec";\n@dec()\nexport class Svc {\n  run(x: number): number { return x + 1; }\n}\n', 'svc.ts', { experimentalDecorators: true }],
  ]) {
    const opts = { file, module: 'cjs', sourceMap: true, ...extra };
    const result = compile(Buffer.from(source), opts);
    assert.equal(result.backend, file.endsWith('.js') ? 'javascript' : 'pulse', file);
    assert.equal(result.code, compile(Buffer.from(source), { file, module: 'cjs', ...extra }).code, file);
    const ref = JSON.parse(ts.transpileModule(source, { fileName: file, compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS,
      jsx: extra.jsx === 'preserve' ? ts.JsxEmit.Preserve : ts.JsxEmit.ReactJSX,
      sourceMap: true, inlineSources: true, ...(extra.experimentalDecorators ? { experimentalDecorators: true } : {}),
    } }).sourceMapText);
    for (const key of ['version', 'file', 'sourceRoot', 'sources', 'names', 'sourcesContent']) {
      assert.deepEqual(result.sourceMap[key], ref[key], `${file}:${key}`);
    }
    assert.ok(assertSegmentsFaithful(source, result) >= 4, file);
  }

  // 2. jsx: 'preserve' (.tsx with and without JSX elements).
  for (const [source, file] of [
    ['export const View = <Box<string> id="a">{1 as number}</Box>;\n', 'src/View.tsx'],
    ['export const value: number = 42;\n', 'src/NoJsx.tsx'],
  ]) {
    const result = compile(Buffer.from(source), { file, jsx: 'preserve', sourceMap: true });
    assert.equal(result.backend, 'pulse', file);
    assert.equal(result.code, compile(Buffer.from(source), { file, jsx: 'preserve' }).code, file);
    assert.equal(result.sourceMap.file, file.slice(file.lastIndexOf('/') + 1).replace(/\.tsx$/, '.jsx'));
    assert.deepEqual(result.sourceMap.sources, [file.slice(file.lastIndexOf('/') + 1)]);
    assert.deepEqual(result.sourceMap.sourcesContent, [source]);
    assert.ok(assertSegmentsFaithful(source, result, true) >= 5, file);
  }

  // 3. Non-ASCII identifiers (BMP and CJK) with type erasure.
  for (const [source, file] of [
    ['export const café: number = 1;\nexport function 合計(値: number): number { return 値 + café; }\n', 'unicode.ts'],
    ['export const données: { clé: string } = { clé: "ok" };\n', 'dir/fr.mts'],
  ]) {
    const result = compile(Buffer.from(source), { file, sourceMap: true });
    assert.equal(result.backend, 'pulse', file);
    assert.equal(result.code, compile(Buffer.from(source), { file }).code, file);
    const ref = JSON.parse(ts.transpileModule(source, { fileName: file, compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, sourceMap: true, inlineSources: true,
    } }).sourceMapText);
    for (const key of ['version', 'file', 'sourceRoot', 'sources', 'names', 'sourcesContent']) {
      assert.deepEqual(result.sourceMap[key], ref[key], `${file}:${key}`);
    }
    assert.ok(assertSegmentsFaithful(source, result, true) >= 5, file);
  }

  // 4. Review round 35 source map regressions: CJS directive, re-export specifier, and uppercase .JSX.
  const dirSrc = '"use client";\nimport { a } from "./dep";\nexport const x = a;\n';
  const dirRes = compile(Buffer.from(dirSrc), { file: 'dir.ts', module: 'cjs', sourceMap: true });
  assert.equal(dirRes.backend, 'pulse');
  assert.ok(assertSegmentsFaithful(dirSrc, dirRes) >= 4);
  const dirRows = lines(dirRes.code);
  const dirLine = dirRows.findIndex(l => l.includes('"use client"'));
  assert.ok(decode(dirRes.sourceMap.mappings)[dirLine].some(seg => seg.length === 3 && seg[1] === 0), dirRes.sourceMap.mappings);

  const reexpSrc = 'export { default as answer } from "./dep";\n';
  const reexpRes = compile(Buffer.from(reexpSrc), { file: 're.ts', module: 'cjs', sourceMap: true });
  assert.equal(reexpRes.backend, 'pulse');
  assert.ok(assertSegmentsFaithful(reexpSrc, reexpRes) >= 1);
  assert.ok(decode(reexpRes.sourceMap.mappings).flat().some(seg => seg.length === 3 && seg[1] === 0), reexpRes.sourceMap.mappings);

  const upperJsx = compile(Buffer.from('export const x = 1;\n'), { file: 'A.JSX', jsx: 'preserve', sourceMap: true });
  assert.equal(upperJsx.backend, 'javascript');
  assert.equal(upperJsx.sourceMap.file, 'A.jsx');
});
