import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderJsonl, renderSarif } from '../src/sarif.mjs';
import { chooseFormat } from '../src/cli-output.mjs';

const sampleReport = {
  schemaVersion: 1,
  runner: 'vitest',
  mutators: 'targeted',
  evaluation: 'evaluated',
  extraction: [{ file: 'src/cart.ts', path: 'native' }],
  mutants: [
    { site: 's1', rule: 'comparison-boundary/v1', location: { file: 'src/cart.ts', line: 10, column: 5 }, status: 'survived', replacement: '>' },
  ],
  diagnostics: [
    {
      kind: 'INPUT GAP',
      location: { file: 'src\\cart.ts', line: 10, column: 5 },
      rule: 'comparison-boundary/v1',
      expression: 'age >= 18',
      mutations: [{ rule: 'comparison-boundary/v1', replacement: 'age > 18' }],
      missing: 'a test with age = 18',
      suggestedTest: 'expect(isAdult(18)).toBe(true)',
    },
    {
      kind: 'INPUT GAP',
      location: { file: 'src/cart.ts', line: 20, column: 5 },
      rule: 'nullish-fallback/v1',
      expression: 'count ?? 10',
      mutations: [{ rule: 'nullish-fallback/v1', replacement: 'count || 10' }],
      weakened: { since: 'abc1234567890', killedByOldTests: ['old test'] },
    },
  ],
};

describe('SARIF 2.1.0 and JSONL output', () => {
  it('accepts text, json, jsonl, and sarif in chooseFormat', () => {
    assert.equal(chooseFormat('sarif', true), 'sarif');
    assert.equal(chooseFormat('jsonl', false), 'jsonl');
    assert.throws(() => chooseFormat('xml', false), /Expected --format/);
  });

  it('renders valid SARIF 2.1.0 with POSIX URIs, partialFingerprints, and weakened-test rule', () => {
    const sarif = renderSarif(sampleReport, { version: '0.1.1' });
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs.length, 1);
    const run = sarif.runs[0];
    assert.equal(run.tool.driver.name, 'targeted-mutation');
    assert.equal(run.tool.driver.version, '0.1.1');
    assert.equal(run.invocations[0].executionSuccessful, true);
    assert.equal(run.results.length, 2);

    assert.equal(run.results[0].ruleId, 'input-gap');
    assert.equal(run.results[0].level, 'warning');
    assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, 'src/cart.ts');
    assert.match(run.results[0].partialFingerprints.tmtFindingId, /^tmt-[0-9a-f]{16}$/);

    assert.equal(run.results[1].ruleId, 'weakened-test');
    assert.equal(run.results[1].level, 'error');
    assert.match(run.results[1].message.text, /Weakened test/);
  });

  it('marks executionSuccessful=false on baseline_error or incomplete evaluation', () => {
    const sarif = renderSarif({ ...sampleReport, evaluation: 'baseline_error', diagnostics: [] });
    assert.equal(sarif.runs[0].invocations[0].executionSuccessful, false);
  });

  it('renders valid NDJSON lines for JSONL format', () => {
    const text = renderJsonl(sampleReport);
    const lines = text.split('\n').map(line => JSON.parse(line));
    assert.equal(lines[0].event, 'summary');
    assert.equal(lines[1].event, 'mutant');
    assert.equal(lines[2].event, 'diagnostic');
    assert.equal(lines[3].event, 'diagnostic');
    assert.equal(lines.at(-1).event, 'complete');
    assert.equal(lines.at(-1).mutants, 1);
    assert.equal(lines.at(-1).diagnostics, 2);
  });
});
