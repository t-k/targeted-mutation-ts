import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const rows = readFileSync(new URL('../verification/pict/analysis-syntax-projection.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

test('analysis syntax consumers reuse the projection and preserve full compiler answers', async t => {
  const root = mkdtempSync(resolve('build/.test-analysis-syntax-'));
  try {
    cpSync('src', join(root, 'src'), { recursive: true });
    const path = join(root, 'build', 'typescript-syntax');
    mkdirSync(path, { recursive: true });
    const current = readFileSync('build/typescript-syntax/typescript-syntax.cjs', 'utf8');
    const assetPath = join(path, 'typescript-syntax.cjs');
    const probe = join(root, 'probe.mjs');
    writeFileSync(probe, `import { createRequire } from 'node:module';
import { join } from 'node:path';
const [operation, asset, shape] = process.argv.slice(2);
const require = createRequire(import.meta.url);
if (asset === 'Preloaded') require('typescript');
const { comparisonThresholdSites } = await import('./src/prototype.mjs');
const { needsProbePreload } = await import('./src/probe.mjs');
const threshold = {
  Plain: 'export const ready = (value: number) => value >= 18;',
  Contextual: '/* 🐈 */ export const ready = (value: number) => value < -0x10; export const ignored = (first, second) => first > 1;',
  Diagnostic: 'export const ready = (value: number) => value >= ;',
};
const moduleSource = {
  Plain: ['exports.run = () => true;', 'export const x = 1;'],
  Contextual: ['export type Name = string; exports.x = 1;', 'const { module } = thing;', 'void import.meta.url;', 'await work();'],
  Diagnostic: ['export const value = ;', 'module.exports ='],
};
const readThreshold = source => {
  try { return comparisonThresholdSites(source, 'source.ts'); }
  catch (error) { return { error: error.message }; }
};
const result = operation === 'Threshold' ? readThreshold(threshold[shape]) :
  moduleSource[shape].map(source => needsProbePreload(import.meta.dirname, join(import.meta.dirname, 'source.ts'), source));
const followup = readThreshold(threshold.Plain);
console.log(JSON.stringify({ result, followup, full: Boolean(require.cache[require.resolve('typescript')]) }));
`);
    const run = (operation, asset, shape) => {
      const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' };
      const child = spawnSync(process.execPath, [probe, operation, asset, shape], {
        env, encoding: 'utf8', timeout: 15_000,
      });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      return JSON.parse(child.stdout);
    };
    const references = new Map();
    for (const [operation, asset, shape] of rows) await t.test(`${operation} ${asset} ${shape}`, () => {
      if (asset === 'Missing') rmSync(assetPath, { force: true });
      else if (asset === 'Stale') writeFileSync(assetPath, 'exports.version = "0.0.0";');
      else if (asset === 'ReadFailure') writeFileSync(assetPath,
        current + '\nmodule.exports = { ...module.exports, createSourceFile() { throw new Error("parse failed"); } };');
      else writeFileSync(assetPath, current);

      const key = JSON.stringify([operation, shape]);
      if (!references.has(key)) references.set(key, run(operation, 'Preloaded', shape));
      const expected = references.get(key);
      const actual = run(operation, asset, shape);
      assert.deepEqual(actual.result, expected.result);
      assert.deepEqual(actual.followup, expected.followup);
      assert.equal(actual.full, asset !== 'Ready');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
