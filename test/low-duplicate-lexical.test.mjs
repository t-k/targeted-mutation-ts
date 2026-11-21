import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { extract, extractFallback } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function check(source, native, file = 'case.ts') {
  const options = { file, logical: true, requireNative: true };
  const actual = extract(source, options);
  const reference = native ? extractYuku(source, options) : extractFallback(source, options);
  assert.equal(actual.reason === 'duplicate-lexical', native, source);
  assert.equal(actual.path, 'diagnostic', source);
  assert.deepEqual(actual.candidates, [], source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const rows = readFileSync(new URL('../verification/pict/low-duplicate-lexical.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [declaration, suffix, repeated] = row.split('\t');
  test(`Low* duplicate lexical diagnostic: ${declaration} ${suffix} ${repeated}`, () => {
    const first = declaration === 'Let' ? 'let' : 'const';
    const next = declaration === 'Const' ? 'const' : 'let';
    const name = repeated === 'First' ? 'token' : 'other';
    const ending = {
      Valid: 'let another;',
      Invalid: 'const broken = ;',
      SecondConflict: 'const token = 1;',
      Unsupported: 'export const another = (a < b);',
    }[suffix];
    check(`/* 🌊 */${first} token = a < b; const other = 1; ${next} ${name} = false; ${ending}`, suffix === 'Valid');
  });
}

test('reports byte spans and preserves input dialect, path, and ASI', () => {
  check('/*🌊*/ const key = a < b;\r\nconst key = 1;\r\n', true, '海.tsx');
  check('let alpha\nlet alpha\n', true);
  check('let $name;\nconst second = 0xF;\nlet $name = second >= 2\nlet tail = null;', true);
});

test('the normal addon reports a complete diagnostic without parser dependencies installed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-native-diagnostic-'));
  try {
    mkdirSync(join(root, 'build'));
    mkdirSync(join(root, 'src'));
    for (const path of ['build/tmt.node', 'src/extract.mjs', 'src/source-text.mjs', 'src/typescript-extraction.mjs', 'src/typescript-bindings.mjs', 'src/typescript-grammar.mjs']) {
      copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
    }
    const { extract: isolatedExtract } = await import(pathToFileURL(join(root, 'src/extract.mjs')));
    const source = '/* 🌊 */ const path = x < y; let path;';
    const result = isolatedExtract(source, { requireNative: true });
    assert.equal(result.reason, 'duplicate-lexical');
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.diagnostics, extractYuku(source).diagnostics);
    assert.equal(result.diagnostics[0].path, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('other syntax and errors keep the full reference diagnostic order', () => {
  check('const k = a < b; const k = ;', false);
  check('const k = a < b; const k = 1; const z = ;', false);
  check('const k = a < b; const k = 1; const jsx = <Button disabled={left || right} />;', false, 'case.tsx');
  check('const k = a < b; const k = 1; const jsx = <Button disabled={left || right} />; const =', false, 'case.tsx');
  check('const k = a < b; const k = 1; let eval = 2;', false);
  check('const k = a < b; const k = 1; let \u{1D4D0} = 2;', false);
});
