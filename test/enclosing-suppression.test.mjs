import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { suppressEnclosingDiagnostics } from '../src/enclosing-suppression.mjs';

describe('enclosing-site duplicate suppression', () => {
  const inner = {
    kind: 'INPUT GAP',
    location: { file: 'src/a.ts', line: 5, column: 10, start: 50, end: 55 },
    rule: 'equality-constant/v1',
  };
  const outerLogical = {
    kind: 'INPUT GAP',
    location: { file: 'src/a.ts', line: 5, column: 10, start: 50, end: 65 },
    rule: 'ignored-operand/v1',
    mutations: [{ rule: 'ignored-operand/v1', replacement: '(a === 1, b)' }],
  };
  const outerRightDrop = {
    kind: 'INPUT GAP',
    location: { file: 'src/a.ts', line: 5, column: 10, start: 50, end: 65 },
    rule: 'ignored-operand/v1',
    mutations: [{ rule: 'ignored-operand/v1', replacement: '(a === 1 && (b, true))' }],
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

  it('suppresses strictly enclosing left-drop ignored-operand INPUT GAP over inner constant INPUT GAP while keeping right-drop', () => {
    const out = suppressEnclosingDiagnostics([inner, outerLogical, outerRightDrop]);
    assert.deepEqual(out, [inner, outerRightDrop]);
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
