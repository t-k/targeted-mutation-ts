import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { suppressEnclosingDiagnostics } from '../src/enclosing-suppression.mjs';

describe('enclosing-site duplicate suppression', () => {
  const inner = {
    kind: 'INPUT GAP',
    location: { file: 'src/a.ts', line: 5, column: 10, start: 50, end: 55 },
    rule: 'comparison-boundary/v1',
  };
  const outerLogical = {
    kind: 'INPUT GAP',
    location: { file: 'src/a.ts', line: 5, column: 10, start: 50, end: 65 },
    rule: 'ignored-operand/v1',
  };
  const sameSpan = {
    kind: 'INPUT GAP',
    location: { file: 'src/a.ts', line: 5, column: 10, start: 50, end: 55 },
    rule: 'equality-constant/v1',
  };
  const outerAssertion = {
    kind: 'ASSERTION GAP',
    location: { file: 'src/a.ts', line: 5, column: 10, start: 50, end: 65 },
    rule: 'ignored-operand/v1',
  };

  it('suppresses strictly enclosing logical INPUT GAP over inner INPUT GAP', () => {
    const out = suppressEnclosingDiagnostics([inner, outerLogical]);
    assert.deepEqual(out, [inner]);
  });

  it('preserves same-span diagnostics and outer ASSERTION GAP diagnostics', () => {
    const out = suppressEnclosingDiagnostics([inner, sameSpan, outerAssertion]);
    assert.equal(out.length, 3);
  });

  it('does not suppress across different files', () => {
    const otherFile = {
      ...outerLogical,
      location: { ...outerLogical.location, file: 'src/b.ts' },
    };
    const out = suppressEnclosingDiagnostics([inner, otherFile]);
    assert.equal(out.length, 2);
  });
});
