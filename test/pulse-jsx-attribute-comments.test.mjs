import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'attributes.tsx', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}
const rows = readFileSync(new URL('../verification/pict/pulse-jsx-attribute-comments.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [placement, comment, closing] = row.split('\t');
  test(`Pulse JSX attribute trivia: ${placement} ${comment} ${closing}`, () => {
    const note = { Block: '/* 海 🧪 n <= m */', Line: '// 海 🧪 n <= m\r\n', Unclosed: '/* 海 🧪 n <= m' }[comment];
    const attributes = {
      First: `${note} value={a >= b}`,
      Between: `active ${note} value={a >= b}`,
      BeforeEqual: `value ${note} ={a >= b}`,
      AfterEqual: `value= ${note} {a >= b}`,
      Final: `value={a >= b} ${note}`,
    }[placement];
    const end = closing === 'SelfClosing' ? '/>;' : '>{left > right}</View>;';
    compare(`/* 🧪 */ const before = q < r; const view = <View ${attributes} ${end}`, comment !== 'Unclosed');
  });
}

test('comment-like JSX text and quoted values stay literal', () => {
  compare('const view = <View label="/* raw */">/* child */{x < y}</View>;', true);
  compare('const view = <View /* note */ value={a < b} />; const =;', false);
});
