import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-declare-line.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const gaps = { LF: '\n', CRLF: '\r\n', Unicode: '\u2028', LineComment: ' // trivia\n',
  BlockComment: ' /* split\nhere */ ', None: ' ', InlineComment: ' /* on the same line */ ' };

for (const row of rows) {
  test('contextual declare line boundary ' + row.replaceAll('\t', ' '), async () => {
    const [line, sourceKind, mode] = row.split('\t');
    const inline = line === 'None' || line === 'InlineComment';
    const prefix = inline ? 'declare' + gaps[line] + 'const removed: number;\n' :
      'var declare: any;\ndeclare' + gaps[line] + 'const alive = 42;\n';
    const observed = inline ? '42' : 'alive';
    const input = prefix + (sourceKind === 'Module' ? 'export ' : '') + 'function read() { return ' + observed + '; }';
    const result = compile(input, { file: 'entry.ts', mode: mode.toLowerCase() });
    if (mode === 'Strip' && !inline) {
      assert.equal(result.code, null);
      assert.equal(result.diagnostics[0].code, 'AMBIGUOUS_TYPE_ERASURE');
    } else {
      assert.ok(result.code);
      if (inline) assert.doesNotMatch(result.code, /\bremoved\b/);
      if (sourceKind === 'Module') {
        const { read } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
        assert.equal(read(), 42);
      } else {
        assert.equal(Function(result.code + '\nreturn read();')(), 42);
      }
    }
  });
}

test('a contextual name inside retained literal text does not affect erasure', () => {
  const source = 'export const value: string = `declare\nconst value = 0;`;';
  const result = compile(source, { mode: 'strip' });
  assert.equal(result.backend, 'node-strip');
  assert.match(result.code, /`declare\nconst value = 0;`/);
});

test('raw matches inside erased template types and comments do not prevent strip mode', () => {
  for (const prefix of ['type X = `declare\nconst foo`;', 'interface X { /* declare\nconst foo */ x: number }']) {
    const result = compile(prefix + '\nexport const n: number = 1;', { file: 'entry.ts', mode: 'strip' });
    assert.equal(result.backend, 'node-strip');
    assert.match(result.code, /export const n\s*= 1;/);
    assert.deepEqual(result.diagnostics, []);
  }
});

test('constructor parameter properties cannot bypass the declare boundary check', async () => {
  const source = 'var declare: any; declare\nconst alive = 42; ' +
    'export class Box { constructor(public n: number) {} } ' +
    'export function read() { return new Box(alive).n; }';
  const result = compile(source, { file: 'entry.ts' });
  // The parse reads the split declare as an expression statement, so the native route keeps the binding.
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /declare\nconst alive = 42;/);
  const { read } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(read(), 42);
});
