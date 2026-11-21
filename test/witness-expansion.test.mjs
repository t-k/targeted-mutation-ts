import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = 'fixtures/witnesses';
function invoke(project, source, suite, ...options) {
  return spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', project, source,
    '--witnesses', '--test', suite, ...options], { encoding: 'utf8', timeout: 40_000 });
}

function analyze(source, suite, ...options) {
  const run = invoke(root, source, suite, ...options);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('finds Unicode distinctions and inverts the sort order within the declared constraints', () => {
  const source = 'src/text-order.ts';
  const { diagnostics } = analyze(source, 'test/text-order.test.ts', '--spec', 'order-spec.json');
  const codePoints = diagnostics.find(gap => gap.rule === 'code-point-to-utf8-length/v1');
  assert.deepEqual(codePoints.witness.arguments, ['é']);
  assert.deepEqual([codePoints.witness.original, codePoints.witness.mutant], [1, 2]);
  const units = diagnostics.find(gap => gap.rule === 'code-unit-to-code-point-length/v1');
  assert.deepEqual([units.witness.original, units.witness.mutant], [2, 1]);
  const order = diagnostics.find(gap => gap.rule === 'substitute-sort-key/v1');
  assert.deepEqual([order.witness.original, order.witness.mutant], ['A,B', 'B,A']);
  const [a, b] = order.witness.arguments[0];
  assert.ok(a.createdAt <= a.updatedAt && b.createdAt <= b.updatedAt);
  assert.ok(a.createdAt < b.createdAt && a.updatedAt > b.updatedAt);
  assert.ok(diagnostics.every(gap => gap.verification.status === 'confirmed'));
});

test('requires registered sort constraints and all lines of a changed comparator', () => {
  const project = mkdtempSync(join(tmpdir(), 'tmt-order-scope-'));
  const subject = 'src/text-order.ts', suite = 'test/text-order.test.ts';
  try {
    cpSync(root, project, { recursive: true });
    const path = join(project, subject);
    const input = readFileSync(path, 'utf8').replace('a.createdAt - b.createdAt', 'a.createdAt -\n    b.createdAt');
    writeFileSync(path, input);
    const partial = invoke(project, subject, suite, '--spec', 'order-spec.json', '--lines', `${subject}:6-6`);
    assert.equal(partial.status, 0, partial.stderr);
    assert.deepEqual(JSON.parse(partial.stdout).mutants, []);
    const specification = join(project, 'order-spec.json');
    writeFileSync(specification, readFileSync(specification, 'utf8').replace('byCreated', 'byCreateTypo'));
    const invalid = invoke(project, subject, suite, '--spec', 'order-spec.json');
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Sort constraints do not match a supported export/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('discovers a connected endian pair and a borrowed reader without plans', () => {
  const { diagnostics, mutants } = analyze('src/contracts.ts', 'test/contracts.test.ts');
  const pair = diagnostics.find(gap => gap.rule === 'paired-source/v1');
  assert.deepEqual([pair.witness.original, pair.witness.mutant], ['2,1', '1,2']);
  const state = diagnostics.find(gap => gap.rule === 'contract-source/v1');
  assert.deepEqual([state.witness.original, state.witness.mutant], [null, '1']);
  assert.equal(state.borrowedFrom.test, 'reads a successful write');
  assert.ok([pair, state].every(gap => gap.verification.status === 'confirmed' && gap.witness.expectation === 'original'));
  assert.ok(mutants.find(mutant => mutant.rule === pair.rule).singletons.every(single => single.seedFailed));
});

test('requires both sides of a connected pair to be selected', () => {
  const result = analyze('src/contracts.ts', 'test/contracts.test.ts', '--lines', 'src/contracts.ts:3-3');
  assert.ok(result.mutants.every(mutant => mutant.rule !== 'paired-source/v1'));
});
