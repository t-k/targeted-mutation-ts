import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { extract } from '../src/extract.mjs';

const parseCounter = Symbol.for('tmt-threshold-test-parse-count');
const prototypeURL = new URL('../src/prototype.mjs', import.meta.url).href;
const hook = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url !== prototypeURL) return result;
  return { ...result, source: String(result.source).replace(
    '  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);',
    `  globalThis[Symbol.for('tmt-threshold-test-parse-count')]++;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);`,
  ) };
} });
const { planFocusedTrials } = await import('../src/analysis.mjs');
hook.deregister();

const matrix = readFileSync(new URL('../verification/pict/focused-planning.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const passing = { id: 'passed', file: 'test.ts', project: 'test', status: 'passed' };
const second = { ...passing, id: 'second' };

for (const [text, sites, trace] of matrix) {
  test(`focused planning ${text} ${sites} ${trace}`, () => {
    const operators = sites === 'Single' ? ['>='] : ['>=', '>=', sites === 'MixedOperators' ? '<' : '>='];
    const prefix = text === 'Unicode' ? '/* 🧪 */\n' : '';
    const source = prefix + operators.map((operator, index) => `export const check${index} = (value: number) => value ${operator} ${10 + index};`).join('\n');
    const input = Buffer.from(source);
    const file = 'source.ts';
    const candidates = extract(input, { file }).candidates.map((candidate, index) => ({ ...candidate, id: `site-${index}` }));
    const observations = candidates.map((site, index) => ({
      site: site.id, operator: site.operator, identity: passing, operands: [20, 10 + index], result: site.operator === '>=',
    }));
    const rows = [{ loaded: candidates.map(site => site.id) }];
    if (trace !== 'LoadedOnly') {
      rows.push(...observations.toReversed(), ...observations.map(row => ({ ...row, identity: second, operands: [21, row.operands[1]] })));
      if (trace === 'Invalid') rows.push({ ...observations[0], operands: [20, '10'] });
    }
    globalThis[parseCounter] = 0;
    const planned = planFocusedTrials([{ file, input, sites: candidates }], rows, { tests: [passing, second] }, {}, true);
    assert.equal(globalThis[parseCounter], trace === 'LoadedOnly' || trace === 'Invalid' && sites === 'Single' ? 0 : 1);
    const boundary = planned.filter(trial => trial.rule === 'comparison-boundary/v1');
    assert.deepEqual(boundary.map(trial => trial.site.id), candidates.map(site => site.id));
    for (const [index, trial] of boundary.entries()) {
      const eligible = trace !== 'LoadedOnly' && !(trace === 'Invalid' && index === 0);
      assert.equal(trial.observation.complete, eligible);
      assert.equal(trial.observation.loaded, true);
      assert.deepEqual(trial.observation.rows, rows.filter(row => row.site === trial.site.id));
      const thresholdTrial = planned.find(entry => entry.site.id === trial.site.id &&
        (trial.site.operator === '>=' ? entry.rule === 'comparison-boundary/v1'
          : entry.rule === 'comparison-threshold/v1' || entry.rule === 'comparison-tighten/v1'));
      assert.equal(thresholdTrial?.threshold?.meta.functionName, eligible ? `check${index}` : undefined);
      // A single shift edit is never duplicated across comparison-threshold/v1 and comparison-tighten/v1.
      const shiftTrials = planned.filter(entry => entry.site.id === trial.site.id && entry.adjustment !== undefined);
      assert.ok(shiftTrials.length <= 1);
    }
  });
}

test('threshold metadata stays scoped to its source and baseline', () => {
  const subjects = [10, 20].map(threshold => {
    const file = `threshold-${threshold}.ts`;
    const input = Buffer.from(`export const check = (value: number) => value >= ${threshold};`);
    const sites = extract(input, { file }).candidates.map(site => ({ ...site, id: file }));
    return { file, input, sites };
  });
  const trace = subjects.map(({ file }, index) => ({
    site: file, operator: '>=', identity: passing, operands: [30, (index + 1) * 10], result: true,
  }));
  const boundary = trials => trials.filter(trial => trial.rule === 'comparison-boundary/v1');
  globalThis[parseCounter] = 0;
  const accepted = boundary(planFocusedTrials(subjects, trace, { tests: [passing] }, {}, false));
  assert.deepEqual(accepted.map(trial => trial.threshold?.meta.threshold), [10, 20]);
  assert.equal(globalThis[parseCounter], 2);

  const unknown = boundary(planFocusedTrials(subjects, trace, { tests: [second] }, {}, false));
  assert.deepEqual(unknown.map(trial => trial.threshold), [null, null]);
  assert.equal(globalThis[parseCounter], 2);
});

test('keeps non-literal constant-RHS threshold shift even when integer-adjacent to boundary toggle', () => {
  const source = Buffer.from('export function ok(x: number, bound: number) { return x >= bound; }\n');
  const opAt = source.indexOf('>=');
  const rhsAt = source.indexOf('bound', opAt);
  const site = {
    id: 'site-nonlit',
    rule: 'comparison-boundary/v1',
    operator: '>=',
    replacement: '>',
    edit: [opAt, opAt + 2],
    left: [opAt - 2, opAt - 1],
    right: [rhsAt, rhsAt + 5],
    location: { file: 'src/nonlit.ts', line: 1, column: opAt + 1 },
  };
  const passing = { project: '', file: 'test/nonlit.test.ts', id: 't1', name: 'runs', status: 'passed' };
  const trace = [{ site: site.id, operator: '>=', identity: passing, operands: [9, 10], result: false }];
  const trials = planFocusedTrials([{ file: 'src/nonlit.ts', input: source, sites: [site] }], trace, { tests: [passing] }, {}, false);
  const boundaryTrial = trials.find(trial => trial.rule === 'comparison-boundary/v1');
  const thresholdTrial = trials.find(trial => trial.rule === 'comparison-threshold/v1');
  assert.equal(boundaryTrial.equivalentOnSafeIntegers, undefined);
  assert.ok(thresholdTrial, 'non-literal RHS shift must not be dropped as integer-boundary-equivalent');
  assert.equal(thresholdTrial.replacement, '((bound) + 1)');
});
