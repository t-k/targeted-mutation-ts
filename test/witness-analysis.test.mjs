import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = 'fixtures/witnesses';
const source = 'src/queries.ts';
const suite = 'test/queries.test.ts';

function runWitness(project, target, selected, ...args) {
  const run = spawnSync(process.execPath,
    ['bin/tmt.mjs', 'analyze', project, target, '--witnesses', '--test', selected, ...args],
    { encoding: 'utf8', timeout: 40_000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  return JSON.parse(run.stdout);
}

const analyze = (...args) => runWitness(root, source, suite, ...args);

const entryRows = readFileSync(new URL('../verification/pict/witness-entrypoint.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [language, registration, assertion] of entryRows) {
  test(`witness entry point: ${language} ${registration} ${assertion}`, () => {
    const project = mkdtempSync(join(tmpdir(), 'tmt-witness-entry-'));
    try {
      const typed = language === 'TS';
      const file = 'position.' + language.toLowerCase();
      writeFileSync(join(project, 'package.json'), '{"type":"module"}');
      writeFileSync(join(project, file), typed
        ? 'export const positionOf = (items: number[], target: number) => items.indexOf(target);'
        : 'export const positionOf = (items, target) => items.indexOf(target);');
      const expected = assertion === 'Literal' ? '0' : 'expected';
      const direct = `it('checks', () => expect(positionOf([5, 6], 5)).toBe(${expected}));`;
      const entry = {
        Top: direct,
        Nested: `group('positions', () => { suite('duplicates', function () { ${direct} }); });
suite('other', () => { it('checks', () => expect(1).toBe(1)); });`,
        Dynamic: `it.each([[0]])('checks %d', () => expect(positionOf([5, 6], 5)).toBe(${expected}));`,
      }[registration];
      writeFileSync(join(project, 'position.test.js'), `
import { describe as group, suite, it, expect } from 'vitest';
import { positionOf } from './${file}';
const expected = 0;
${entry}
`);
      const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', project, '--witnesses', '--test', 'position.test.js'],
        { encoding: 'utf8', timeout: 30_000 });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      const report = JSON.parse(run.stdout);
      const matched = Number(registration !== 'Dynamic' && assertion === 'Literal');
      assert.deepEqual(report.witnessSearch, { candidates: 1, matched, unmatched: 1 - matched, evaluated: matched, omitted: 0 });
      assert.equal(report.diagnostics.length, matched);
      if (matched) {
        const [gap] = report.diagnostics;
        assert.equal(gap.verification.status, 'confirmed');
        assert.equal(gap.seed.test, registration === 'Nested' ? 'positions > duplicates > checks' : 'checks');
        assert.deepEqual([gap.fixtureEdit.original, gap.fixtureEdit.replacement], ['6', '5']);
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

function isolatedFixture(action) {
  const project = mkdtempSync(join(tmpdir(), 'tmt-witness-'));
  try {
    cpSync(root, project, { recursive: true });
    return action(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test('a suite-local subject cannot seed an appended witness for an imported function', () => isolatedFixture(project => {
  writeFileSync(join(project, suite), `
import { describe, it, expect } from 'vitest';
import { positionOf } from '../src/queries';
describe('positions', () => {
  if (true) { var positionOf = () => 0; }
  it('checks', () => expect(positionOf([5,], 5)).toBe(0));
});
`);
  const result = runWitness(project, source, suite, '--lines', `${source}:5-5`);
  assert.equal(result.witnessSearch.candidates, 1);
  assert.equal(result.witnessSearch.unmatched, 1);
  assert.deepEqual(result.diagnostics, []);
}));

test('a failed baseline leaves fixture matching unknown', () => isolatedFixture(project => {
  writeFileSync(join(project, suite), "import { it, expect } from 'vitest'; it('fails', () => expect(1).toBe(0));");
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', project, source,
    '--witnesses', '--test', suite, '--lines', `${source}:5-5`], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.evaluation, 'baseline_error');
  assert.deepEqual(report.witnessSearch, { candidates: 1, matched: 0, unmatched: null, evaluated: 0, omitted: 0 });
}));

test('verifies same-type substitutions and the first-versus-last duplicate witness', () => {
  const before = readFileSync(`${root}/${suite}`);
  const { mutants, diagnostics } = analyze();
  assert.ok(mutants.some(mutant => mutant.replacement === 'updatedAt' && mutant.status === 'survived'));
  assert.ok(mutants.some(mutant => mutant.replacement === 'entry.updatedAt' && mutant.status === 'survived'));
  const position = diagnostics.find(gap => gap.rule === 'first-to-last-index/v1');
  assert.deepEqual(position.witness.arguments, [[5, 5], 5]);
  assert.deepEqual([position.witness.original, position.witness.mutant], [0, 1]);
  assert.deepEqual(position.observedOutcomes, ['found', 'missing']);
  assert.equal(position.fixtureEdit.original, '6');
  assert.equal(position.fixtureEdit.replacement, '5');
  assert.equal(position.verification.status, 'confirmed');
  const date = diagnostics.find(gap => gap.rule === 'substitute-number/v1' && gap.location.line === 1);
  assert.deepEqual(date.witness.arguments, [90, 100, 100]);
  assert.deepEqual([date.witness.original, date.witness.mutant], [true, false]);
  assert.equal(date.verification.status, 'confirmed');
  assert.deepEqual(readFileSync(`${root}/${suite}`), before);
});

test('source line selection also bounds supplemental witnesses', () => {
  const result = analyze('--lines', `${source}:5-5`);
  assert.ok(result.mutants.length);
  assert.ok(result.mutants.every(mutant => mutant.location.line === 5));
});

test('edits one bit mask or one zero-valued fixture element', () => {
  const { diagnostics } = analyze('--lines', `${source}:7-9`);
  const mask = diagnostics.find(gap => gap.rule === 'any-to-all-flags/v1');
  const sum = diagnostics.find(gap => gap.rule === 'include-next-element/v1');
  assert.deepEqual(mask.witness.arguments, [1, 3]);
  assert.deepEqual([mask.witness.original, mask.witness.mutant], [true, false]);
  assert.deepEqual([sum.fixtureEdit.original, sum.fixtureEdit.replacement], ['0', '1']);
  assert.deepEqual([sum.witness.original, sum.witness.mutant], [3, 4]);
});

test('validates a public read and a pair masked by a round trip', () => {
  const { mutants, diagnostics } = runWitness(root, 'src/contracts.ts', 'test/contracts.test.ts', '--spec', 'witness-spec.json');
  const pair = mutants.find(mutant => mutant.rule === 'paired-source/v1');
  assert.deepEqual(pair.singletons, [{ status: 'killed', seedFailed: true }, { status: 'killed', seedFailed: true }]);
  assert.equal(pair.status, 'survived');
  const wire = diagnostics.find(gap => gap.rule === pair.rule);
  assert.equal(wire.verification.status, 'confirmed');
  assert.deepEqual([wire.witness.original, wire.witness.mutant], ['2,1', '1,2']);
  const state = diagnostics.find(gap => gap.rule === 'contract-source/v1');
  assert.equal(state.verification.status, 'confirmed');
  assert.deepEqual([state.witness.original, state.witness.mutant], [null, '1']);
});

test('does not infer a paired gap from tests other than the named seed', () => isolatedFixture(project => {
  const file = join(project, 'witness-spec.json');
  const specification = JSON.parse(readFileSync(file, 'utf8'));
  specification.witnessPlans = [specification.witnessPlans[0]];
  specification.witnessPlans[0].seedTest = 'reads a successful write';
  writeFileSync(file, JSON.stringify(specification));
  const result = runWitness(project, 'src/contracts.ts', 'test/contracts.test.ts', '--spec', 'witness-spec.json');
  assert.deepEqual(result.mutants[0].singletons, [{ status: 'killed', seedFailed: false }, { status: 'killed', seedFailed: false }]);
  assert.ok(!result.diagnostics.some(gap => gap.site === result.mutants[0].id));
}));

test('reports a byte-accurate fixture edit and preserves the import alias', () => isolatedFixture(project => {
  const file = join(project, suite);
  const input = "// 🧪\nimport { it, expect } from 'vitest';\nimport { positionOf as lookup } from '../src/queries';\nit('finds one', () => expect(lookup([5, 6], 5)).toBe(0));";
  writeFileSync(file, input);
  const { diagnostics: [gap] } = runWitness(project, source, suite, '--lines', `${source}:5-5`);
  const start = Buffer.from(input).lastIndexOf('6');
  assert.deepEqual([gap.fixtureEdit.start, gap.fixtureEdit.end], [start, start + 1]);
  assert.match(gap.suggestedTest, /lookup\(/);
}));

test('verifies an appended witness when the literal array has a trailing comma', () => isolatedFixture(project => {
  writeFileSync(join(project, suite), "import { it, expect } from 'vitest'; import { positionOf } from '../src/queries'; it('finds one', () => expect(positionOf([5,], 5)).toBe(0));");
  const { diagnostics: [gap] } = runWitness(project, source, suite, '--lines', `${source}:5-5`);
  assert.equal(gap.fixtureEdit, undefined);
  assert.deepEqual(gap.witness.arguments, [[5, 5], 5]);
  assert.equal(gap.verification.status, 'confirmed');
}));

for (const target of ['src/queries.tsx', 'src/queries/index.ts']) {
  test(`discovers a witness through an extensionless import of ${target}`, () => isolatedFixture(project => {
    const input = readFileSync(join(project, source));
    rmSync(join(project, source));
    mkdirSync(dirname(join(project, target)), { recursive: true });
    writeFileSync(join(project, target), input);
    const result = runWitness(project, target, suite, '--lines', `${target}:5-5`);
    assert.ok(result.diagnostics.some(gap => gap.rule === 'first-to-last-index/v1'));
  }));
}

test('applies a project-wide sort specification to a different selected source', () => {
  const result = runWitness(root, source, suite, '--spec', 'order-spec.json', '--lines', `${source}:5-5`);
  assert.ok(result.diagnostics.some(gap => gap.rule === 'first-to-last-index/v1'));
});
