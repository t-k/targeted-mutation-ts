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
      assert.equal(fields.length, 4, segment);
      assert.equal(fields[1], 0, segment);
      column += fields[0];
      sourceLine += fields[2];
      sourceColumn += fields[3];
      return [column, sourceLine, sourceColumn];
    });
  });
}

const lines = text => text.split(/\r\n|[\n\r\u2028\u2029]/);

const kind = character => /\s/.test(character) ? 0 : /[\w$\u0080-\uffff]/.test(character) ? 1 : 2;

// Every segment sits on a token of the output and maps it to the same text in the source.
// Returns the number of segments. Lowered output also holds generated text, which has no segment.
export function assertSegmentsFaithful(source, result, projection = false) {
  const table = decode(result.sourceMap.mappings);
  const generated = lines(result.code), original = lines(source);
  assert.ok(table.length <= generated.length);
  let count = 0;
  for (const [row, segments] of table.entries()) {
    for (const [column, sourceLine, sourceColumn] of segments) {
      const here = generated[row][column];
      assert.ok(here !== undefined && kind(here) !== 0, `segment at line ${row} column ${column} is not on a token`);
      if (projection) {
        assert.ok(column === 0 || kind(generated[row][column - 1]) !== kind(here), `segment at line ${row} column ${column} splits a run`);
      }
      let end = column + 1;
      while (end < generated[row].length && kind(generated[row][end]) === kind(here)) end++;
      const run = generated[row].slice(column, end);
      const there = original[sourceLine]?.slice(sourceColumn, sourceColumn + run.length);
      // A separator or a parenthesis written over erased syntax has no counterpart, and a copy may end inside a run.
      assert.ok(there === run || /^[;()]/.test(run) || there?.[0] === here && !projection,
        `segment at line ${row} column ${column} maps ${JSON.stringify(run)} to ${JSON.stringify(there)}`);
      count++;
    }
  }
  return count;
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
    assert.ok(segment, `No mapping for line ${line} column ${column}`);
    // A string or template may span lines. Its first line is enough to identify it.
    // The scanner cannot tell a template tail from a brace, so it may run on. The first run of
    // characters without white space still identifies the position.
    const token = lines(scanner.getTokenText())[0].split(/\s/)[0];
    const found = original[segment[1]].slice(segment[2] + column - segment[0]);
    // A separator or a parenthesis written over erased syntax has no counterpart in the source.
    if (!found.startsWith(token)) {
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
    if (Buffer.byteLength(result.code) === Buffer.byteLength(text)) assertTokensMapped(text, result);
    else if (result.sourceMap.mappings !== '') lowered += assertSegmentsFaithful(text, result) > 0;
    native++;
  }
  assert.ok(native >= 60, String(native));
  assert.ok(lowered >= 5, String(lowered));
});

test('outputs that are not projections and unusual inputs take the router', () => {
  const typed = 'const n: number = 1;\nexport const result = n;\n';
  for (const [source, file] of [
    ['export const view = <i {...{ a: 1 }}/>;\n', 'a.tsx'],
    ['\ufeff' + typed, 'a.ts'],
    [typed, 'a.cts'],
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
  assert.deepEqual(table[assignment], [[5, 1, 21], [13, 1, 21]]);
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
  assert.deepEqual(positions('x as T\n(y)', 'x     \n;y)'), [[[0, 0, 0]], [[0, 1, 0], [1, 1, 1], [2, 1, 2]]]);
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
  assert.deepEqual(positions(source, code, [[at(code, 'beta'), 6, 4], [at(code, 'alpha'), 0, 5]]), [[[4, 0, 6]], [[2, 0, 0]]]);

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
  assert.deepEqual(table[870], [[0, 870, 0], [6, 870, 6], [15, 3, 6], [37, 870, 6], [45, 870, 14], [47, 870, 16], [50, 870, 19]]);
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
