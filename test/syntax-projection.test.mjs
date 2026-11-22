import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTypeScriptExtractor } from '../src/typescript-extraction.mjs';

const require = createRequire(import.meta.url);
const compilerPath = require.resolve('typescript');
const original = createTypeScriptExtractor(require('typescript'));
const matrix = readFileSync(new URL('../verification/pict/syntax-projection.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const texts = {
  Valid: '/* 🐈 */ class C { #count = 0; ready() { return this.#count < limit; } }',
  Diagnostic: '/* 🐈 */ const first = ;\nconst second = value < limit;',
  Repair: '/* 🐈 */ const fn = <T>(n: T) => <input disabled={n < high || wait} />;',
};

test('the generated TypeScript parser keeps full compiler results and load semantics', async t => {
  const root = mkdtempSync(resolve('build/.test-syntax-'));
  try {
    cpSync('src', join(root, 'src'), { recursive: true });
    const built = join(root, 'stage');
    const build = spawnSync(process.execPath, ['scripts/build-typescript-syntax.mjs', built], {
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr + build.stdout);
    const source = readFileSync(join(built, 'typescript-syntax.cjs'), 'utf8');
    assert.match(source, /Copyright \(c\) Microsoft Corporation/);
    assert.match(readFileSync(join(built, 'LICENSE.txt'), 'utf8'), /Apache License/);
    mkdirSync(join(root, 'build', 'typescript-syntax'), { recursive: true });
    const assetPath = join(root, 'build', 'typescript-syntax', 'typescript-syntax.cjs');
    const variant = {
      Invalid: 'var =',
      WrongVersion: source + '\nmodule.exports = { ...module.exports, version: "0.0.0" };',
      ParserFailure: source + '\nmodule.exports = { ...module.exports, createSourceFile() { throw new Error("parse failed"); } };',
    };
    const probe = join(root, 'probe.mjs');
    writeFileSync(probe, `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.argv[2] === 'CompilerLoaded') require('typescript');
const { extractTypeScript } = await import('./src/typescript-extraction.mjs');
const [source, options] = JSON.parse(process.argv[3]);
const results = [extractTypeScript(source, options), extractTypeScript(source, options)];
console.log(JSON.stringify({ results, full: Boolean(require.cache[${JSON.stringify(compilerPath)}]) }));
`);
    for (const [asset, dialect, mode, shape] of matrix) await t.test(`${asset} ${dialect} ${mode} ${shape}`, () => {
      if (asset === 'Missing') rmSync(assetPath, { force: true });
      else writeFileSync(assetPath, variant[asset] ?? source);
      const suffix = dialect.toLowerCase();
      const options = { file: `sample.${suffix}`, dialect: suffix, mode: mode.toLowerCase(), logical: true };
      const args = JSON.stringify([texts[shape], options]);
      const child = spawnSync(process.execPath, [probe, asset, args], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const actual = JSON.parse(child.stdout);
      const expected = original(texts[shape], options);
      assert.deepEqual(actual.results, [expected, expected]);
      assert.equal(actual.full, asset !== 'Ready');
    });
    await t.test('a short-stack retry leaves the projected parser available to the caller', () => {
      writeFileSync(assetPath, source);
      const retry = join(root, 'retry.mjs');
      writeFileSync(retry, `import { createRequire } from 'node:module';
import { extractFallback } from './src/extract.mjs';
const require = createRequire(import.meta.url);
const nested = '('.repeat(3000) + 'value < limit' + ')'.repeat(3000);
const deep = extractFallback('const deep = ' + nested + ';');
const shallow = extractFallback('const check = value >= limit;');
console.log(JSON.stringify({ deep, shallow, full: Boolean(require.cache[${JSON.stringify(compilerPath)}]) }));
`);
      const child = spawnSync(process.execPath, ['--stack-size=512', retry], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const { deep, shallow, full } = JSON.parse(child.stdout);
      assert.deepEqual(deep.candidates.map(({ operator }) => operator), ['<']);
      assert.deepEqual(shallow.candidates.map(({ operator }) => operator), ['>=']);
      assert.equal(full, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
