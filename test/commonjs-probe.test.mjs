import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { needsProbePreload, freshProbeBinding, installProbe, instrument } from '../src/probe.mjs';

const formats = {
  CJS: ['cjs', '{"type":"module"}'],
  CTS: ['cts', '{"type":"module"}'],
  MJS: ['mjs', '{"type":"module"}'],
  JSCommon: ['js', '\uFEFF{"type":"commonjs"}'],
  JSImplicit: ['js', '{}', 'module.exports = true;\n'],
  JSImplicitESM: ['js', '{}', 'export const esm = true;\n'],
  TSCommon: ['ts', '{"type":"commonjs"}', 'module.exports = true;\n'],
  TSImplicit: ['ts', '{}', 'module.exports = true;\n'],
  TSTypeOnly: ['ts', '{}', 'export type Value = number; module.exports = true;\n'],
};

const rows = readFileSync(new URL('../verification/pict/commonjs-probe.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [file, site, strict] = row.split('\t');
  test(`focused probe syntax: ${file} ${site} ${strict}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tmt-cjs-probe-'));
    try {
      const [extension, manifest, prelude = ''] = formats[file];
      const sourceFile = 'subject.' + extension;
      const source = Buffer.from((strict === 'Directive' ? '"use strict";\n' : '') + prelude +
        (site === 'TopLevel' ? 'console.log(1 < 2);\n' : 'function check() { return 1 < 2; } console.log(check());\n'));
      const sites = extract(source, { file: sourceFile }).candidates.map(candidate => ({ ...candidate, id: 'check' }));
      assert.equal(sites.length, 1);
      const path = join(root, sourceFile);
      writeFileSync(join(root, 'package.json'), manifest);
      const binding = needsProbePreload(root, path, source) ? freshProbeBinding([source]) : undefined;
      if (file === 'JSImplicitESM' || file === 'MJS') assert.equal(binding, undefined);
      else assert.ok(binding);
      const preload = installProbe(root, binding);
      const output = instrument(root, sourceFile, source, sites, binding);
      if (strict === 'Directive') assert.match(output, /^"use strict";/);
      writeFileSync(path, output);
      writeFileSync(join(root, '.tmt-probe', 'probe-runtime.mjs'), 'export const compare = (id, op, replacement, left, right) => left < right;\n' +
        'export const loaded = sites => console.log(...sites);');
      const run = spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), path],
        { encoding: 'utf8', timeout: 10_000 });
      assert.equal(run.status, 0, run.error?.message ?? run.stderr);
      assert.equal(run.stdout, 'true\ncheck\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('implicit package detection distinguishes erased declarations and runtime ESM syntax', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-probe-format-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    const path = join(root, 'subject.ts');
    for (const [source, preload] of [
      ['export declare const version: number; module.exports = 1 < 2;', true],
      ['await Promise.resolve(); globalThis.boot = 1 < 2;', false],
      ['export interface Entry {} ; void import.meta.url; console.log(a < b);', false],
      ['for await (const item of values) console.log(item < bound);', false],
      ['const require = console; console.log(1 < 2);', false],
      ['async function tick() { await Promise.resolve(); } module.exports = 1 < 2;', true],
    ]) assert.equal(needsProbePreload(root, path, Buffer.from(source)), preload, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function analyze(root, filename) {
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, filename, '--audit'],
    { encoding: 'utf8', timeout: 45_000 });
  assert.equal(run.status, 0, run.error?.message ?? (run.stderr + run.stdout));
  return JSON.parse(run.stdout);
}

test('Vitest createRequire observes and audits native CommonJS', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-cjs-vitest-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const source = '"use strict";\nfunction require() { throw Error("source require"); }\nconst boot = 1 < 2;\nmodule.exports = value => boot && value >= 2;\n';
    writeFileSync(join(root, 'subject.cjs'), source);
    writeFileSync(join(root, 'subject.test.mjs'), "import { createRequire } from 'node:module'; import { expect, it } from 'vitest'; const keep = createRequire(import.meta.url)('./subject.cjs'); it('checks boundary', () => expect(keep(2)).toBe(true));");
    const report = analyze(root, 'subject.cjs');
    assert.equal(report.instrumented.status, 'passed');
    assert.deepEqual(report.mutants.map(({ status, audit }) => [status, audit.status]), [
      ['survived', 'agreed'], ['killed', 'agreed'],
    ]);
    assert.equal(readFileSync(join(root, 'subject.cjs'), 'utf8'), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditing an unloaded candidate cannot report agreement', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-unloaded-audit-'));
  try {
    writeFileSync(join(root, 'subject.mjs'), 'export const check = n => n >= 2;');
    writeFileSync(join(root, 'subject.test.mjs'), "import { expect, it } from 'vitest'; it('runs independently', () => expect(1).toBe(1));");
    const [mutant] = analyze(root, 'subject.mjs').mutants;
    assert.equal(mutant.status, 'unevaluated');
    assert.equal(mutant.sourceVerdict, 'survived');
    assert.equal(mutant.audit.status, 'inconclusive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('focused audit requires a trace row proving activation in the probe run', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-missing-activation-'));
  try {
    writeFileSync(join(root, 'subject.mjs'), 'export const check = n => n >= 2;');
    writeFileSync(join(root, 'subject.test.mjs'), "import { expect, it } from 'vitest'; import { check } from './subject.mjs'; it('uses the subject only when the probe is disabled', () => expect(process.env.TMT_ACTIVE_SITE ? true : check(3)).toBe(true));");
    const [mutant] = analyze(root, 'subject.mjs').mutants;
    assert.equal(mutant.status, 'survived');
    assert.deepEqual(mutant.audit, { status: 'inconclusive', source: 'survived', probe: 'unevaluated' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
