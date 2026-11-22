import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createTypeScriptExtractor, extractTypeScript } from '../src/typescript-extraction.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

const cases = {
  Candidate: ['const keep = value < floor || value > ceiling;', []],
  Type: ['const keep = read<>(value) < stop;', ['A type argument list cannot be empty']],
  Context: ['const read = () => super(); const keep = a < b;',
    ["'super()' is only valid in a constructor of a derived class"]],
  Private: ['class C { get tag() { return this.#missing; } } const keep = a < b;',
    ["Private field '#missing' must be declared in an enclosing class"]],
  StrictLiteral: ['"use strict"; const keep = 012 < size;', []],
  Recovery: ['const keep = a < b; class A { readonly get value() {return this.#missing;} } function bad(...xs) { "use strict"; } const =', [
    "A 'readonly' modifier can only appear on a property declaration or index signature",
    "Private field '#missing' must be declared in an enclosing class",
    "Illegal 'use strict' directive in function with non-simple parameter list",
    'Variable declaration expected.',
  ]],
};

const rows = readFileSync(new URL('../verification/pict/typescript-grammar-walk.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [branch, dialect, mode] = row.split('\t');
  test(`compatibility grammar walk ${branch} ${dialect} ${mode}`, () => {
    const [body, messages] = cases[branch];
    const jsx = branch === 'Candidate' && dialect === 'TSX'
      ? 'const view = <div disabled={count < max || ready} visible={a || b}><span disabled={(left || right)} /></div>;'
      : '';
    const source = `/* 🧪 */ ${body}${jsx}`;
    const options = { mode: mode.toLowerCase(), file: dialect === 'TSX' ? 'walk.tsx' : 'walk.ts', logical: true };
    const result = extractTypeScript(source, options);
    if (branch === 'Candidate') {
      assert.equal(result.path, 'fallback');
      assert.deepEqual(result.candidates, extractYuku(source, options).candidates);
      assert.equal(result.candidates.length, jsx ? 4 : 2);
      return;
    }
    const expected = branch === 'StrictLiteral' ? [mode === 'Module'
      ? "Octal literals are not allowed. Use the syntax '0o12'."
      : 'Octal literals are not allowed in strict mode'] : messages;
    assert.equal(result.path, 'diagnostic');
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.message), expected);
  });
}

test('expression diagnostics precede type diagnostics at the same byte range', () => {
  const source = '/* 🧪 */ export {} from 42;';
  const options = { file: 'walk.ts', mode: 'script' };
  const result = extractTypeScript(source, options);
  const start = Buffer.byteLength('/* 🧪 */ ');
  const end = Buffer.byteLength(source);
  assert.deepEqual(result.diagnostics.map(diagnostic => [diagnostic.start, diagnostic.end, diagnostic.message]), [
    [start, end, "Cannot use 'export' declaration outside a module"],
    [start, end, "Expected module specifier, but found '42'"],
  ]);
});

test('scope collisions precede statement errors at the same binding span', () => {
  const source = '/* 🧪 */ function f(eval, eval) { return a < b; }';
  const result = extractTypeScript(source, { file: 'walk.ts', mode: 'module' });
  assert.deepEqual(result.candidates, []);
  const [first, duplicate, second] = result.diagnostics;
  assert.deepEqual(result.diagnostics.map(entry => entry.message), [
    "'eval' is not allowed as a binding identifier in strict mode",
    "Identifier 'eval' has already been declared",
    "'eval' is not allowed as a binding identifier in strict mode",
  ]);
  assert.equal(duplicate.start, second.start);
  assert.equal(duplicate.end, second.end);
  assert.deepEqual(duplicate.labels.map(({ start, end }) => [start, end]), [[first.start, first.end]]);
});

test('hash text does not trigger a private scope traversal', () => {
  const ts = createRequire(import.meta.url)('typescript');
  let visits = 0;
  const extract = createTypeScriptExtractor({ ...ts, forEachChild(node, ...callbacks) {
    if (ts.isSourceFile(node)) visits++;
    return ts.forEachChild(node, ...callbacks);
  } });
  const options = { file: 'walk.ts', mode: 'module' };
  const source = '// TOKEN\nconst text = "TOKEN"; const mark = /TOKEN/; const hit = a < b;';
  const ordinary = extract(source.replaceAll('TOKEN', 'plain'), options);
  const ordinaryVisits = visits;
  visits = 0;
  const hash = extract(source.replaceAll('TOKEN', '#text'), options);
  assert.deepEqual(hash, ordinary);
  assert.equal(visits, ordinaryVisits);
  const invalid = extract('/* #text */ class C { read() { return input.#missing; } } const hit = a < b;', options);
  assert.equal(invalid.path, 'diagnostic');
  assert.deepEqual(invalid.candidates, []);
  assert.match(invalid.diagnostics[0].message, /#missing/);
});
