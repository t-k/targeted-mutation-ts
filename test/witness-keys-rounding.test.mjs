import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWitnessRules, parseSource } from '../src/witness-rules.mjs';
import { analyzeWitnesses } from '../src/witness-analysis.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('composite-key and rounding-order witness rules', () => {
  it('discovers divide-before-multiply/v1 for Math.floor and Math.trunc', () => {
    const src = [
      'export const fee = (cents: number, bps: number) => Math.floor((cents * bps) / 10000);',
      'export const share = (a: number, b: number) => Math.trunc((a * b) / 100);',
    ].join('\n');
    const rules = discoverWitnessRules(parseSource('src/fee.ts', src));
    assert.equal(rules.length, 2);
    assert.equal(rules[0].rule, 'divide-before-multiply/v1');
    assert.equal(rules[0].replacement, 'Math.floor(cents / 10000) * bps');
    const proposals = rules[0].propose([10000, 125]);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].next, 10080);
    assert.equal(proposals[0].original, 126);
    assert.equal(proposals[0].mutant, 125);
  });

  it('discovers composite-key-omit/v1 for template literals and array join', () => {
    const src = [
      'export const cacheKey = (tenant: string, slug: string) => `${tenant}:${slug}`;',
      'export const tupleKey = (region: string, id: number) => [region, id].join(":");',
    ].join('\n');
    const rules = discoverWitnessRules(parseSource('src/keys.ts', src));
    assert.equal(rules.length, 4);
    assert.ok(rules.every(r => r.rule === 'composite-key-omit/v1'));
    assert.equal(rules[0].replacement, '`:${slug}`');
    assert.equal(rules[1].replacement, '`${tenant}:`');
    assert.equal(rules[2].replacement, '[id].join(":")');
    assert.equal(rules[3].replacement, '[region].join(":")');

    const p = rules[0].propose(['acme', 'home']);
    assert.equal(p.length, 1);
    assert.equal(p[0].original, 'acme_alt:home');
    assert.equal(p[0].mutant, ':home');
  });

  it('confirms divide-before-multiply/v1 end-to-end with Vitest', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-rounding-'));
    try {
      mkdirSync(resolve(dir, 'src'), { recursive: true });
      mkdirSync(resolve(dir, 'test'), { recursive: true });
      symlinkSync(resolve(repoRoot, 'node_modules'), resolve(dir, 'node_modules'));
      writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(resolve(dir, 'src/fee.ts'), 'export const fee = (cents: number, bps: number) => Math.floor((cents * bps) / 10000);\n');
      writeFileSync(resolve(dir, 'test/fee.test.ts'), [
        "import { expect, it } from 'vitest';",
        "import { fee } from '../src/fee.ts';",
        "it('computes round fee', () => {",
        '  expect(fee(10000, 125)).toBe(125);',
        '});',
      ].join('\n'));

      const report = await analyzeWitnesses(dir, ['src/fee.ts'], { test: ['test/fee.test.ts'] });
      assert.equal(report.evaluation, 'evaluated');
      const gap = report.diagnostics.find(d => d.rule === 'divide-before-multiply/v1');
      assert.ok(gap, 'expected confirmed divide-before-multiply/v1 witness');
      assert.equal(gap.verification?.status, 'confirmed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers PICT witness-keys-rounding matrix', () => {
    const rows = readFileSync(new URL('../verification/pict/witness-keys-rounding.tsv', import.meta.url), 'utf8')
      .trim().split('\n').slice(1).map(l => l.split('\t'));
    assert.ok(rows.length >= 12);
  });
});
