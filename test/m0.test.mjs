import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function cli(args) {
  const result = spawnSync(process.execPath, ['bin/tmt.mjs', 'prototype', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

test('reports and verifies a shipping input gap with an independent expectation', () => {
  const source = 'fixtures/shipping/src/shipping.ts';
  const original = readFileSync(source, 'utf8');
  const result = cli(['fixtures/shipping', 'src/shipping.ts', '--spec', 'spec.json']);
  assert.equal(result.diagnostics.length, 1);
  const [gap] = result.diagnostics;
  assert.equal(gap.kind, 'INPUT GAP');
  assert.deepEqual(gap.location, { file: 'src/shipping.ts', line: 1, column: 50, start: 49, end: 53 });
  assert.equal(gap.mutation.source, 'yen >= 4999');
  assert.deepEqual(gap.observedInputs, [4800, 5000]);
  assert.deepEqual(gap.feasibleThresholds, [4801, 5000]);
  assert.deepEqual(gap.witness, { input: 4999, original: false, mutant: true, expectation: 'specification' });
  assert.equal(gap.suggestedTest, 'expect(shipsFree(4999)).toBe(false)');
  assert.deepEqual(gap.verification, {
    baseline: 'passed', instrumented: 'passed', rewrite: 'passed', baselineWithWitness: 'passed', rewriteWithWitness: 'failed',
  });
  assert.equal(readFileSync(source, 'utf8'), original);
});

test('derives a witness from a renamed export with one-sided observations and ignores an uncalled comparison', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-prototype-test-'));
  try {
    mkdirSync(join(root, 'test'));
    const source = '// an unrelated escaped string: \\n\nexport const admits = (years: number) => years >= 21;\nexport const unused = (n: number) => n >= 83;\n';
    writeFileSync(join(root, 'subject.ts'), source);
    writeFileSync(join(root, 'spec.json'), JSON.stringify({ admits: { operator: '>=', threshold: 31, rationale: 'Different behavior.' } }));
    writeFileSync(join(root, 'test/example.test.ts'), `import { it, expect } from 'vitest';
import { admits } from '../subject';
it('accepts 30', () => expect(admits(30)).toBe(true));
`);
    const result = cli([root, 'subject.ts', '--spec', 'spec.json']);
    assert.equal(result.diagnostics.length, 1);
    const [gap] = result.diagnostics;
    assert.equal(gap.suggestedTest, 'expect(admits(20)).toBe(false)');
    assert.equal(gap.witness.expectation, 'original');
    assert.deepEqual(gap.observedInputs, [30]);
    assert.equal(gap.verification.rewriteWithWitness, 'failed');
    assert.equal(readFileSync(join(root, 'subject.ts'), 'utf8'), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
