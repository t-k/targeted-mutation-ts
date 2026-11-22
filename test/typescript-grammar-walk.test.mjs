import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extractTypeScript } from '../src/typescript-extraction.mjs';
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
    const source = `/* 🧪 */ ${body}`;
    const options = { mode: mode.toLowerCase(), file: dialect === 'TSX' ? 'walk.tsx' : 'walk.ts', logical: true };
    const result = extractTypeScript(source, options);
    if (branch === 'Candidate') {
      assert.equal(result.path, 'fallback');
      assert.deepEqual(result.candidates, extractYuku(source, options).candidates);
      assert.equal(result.candidates.length, 2);
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
