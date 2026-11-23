import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-annotation-terminator.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [declaration, delimiter, dialect] = row.split('\t');
  test('multiline annotation terminator ' + row.replaceAll('\t', ' '), async () => {
    const type = ':\n  number |\n  undefined' + (delimiter === 'Semicolon' ? ';' : '');
    const code = declaration === 'Local' ?
      'let value' + type + '\nconst seed = 42;\nvalue = seed;\nexport const answer = value;' :
      'class Record {\n  value' + type + '\n  read() { return this.value ?? 42; }\n}\nexport const answer = new Record().read();';
    const suffix = dialect === 'TSX' ? '\nexport const view = () => <i/>;' : '';
    const source = code + suffix;
    const emitted = compile(source, { file: 'boundary.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(emitted.backend, 'pulse', source);
    assert.equal(emitted.code.split('\n').length, source.split('\n').length);
    const { answer } = await import('data:text/javascript;base64,' + Buffer.from(emitted.code).toString('base64'));
    assert.equal(answer, 42);
  });
}
