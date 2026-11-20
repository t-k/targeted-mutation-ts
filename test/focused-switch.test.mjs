import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareFocused } from '../src/focused-switch-runtime.mjs';

const rows = readFileSync(new URL('../verification/pict/focused-switch.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(line => line.trim().split('\t'));
const session = Symbol.for('targeted-mutation-ts/session');

for (const [operator, activation, domain] of rows) {
  test(`focused switch: ${operator} ${activation} ${domain}`, () => {
    const less = operator === 'Less';
    const rhs = domain === 'Limit' ? (less ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER) : 7;
    const lhs = less ? rhs - 1 : rhs + 1;
    const ns = { activeMutant: { Focused: 'targeted', Standard: 'other' }[activation],
      currentTestId: 'test-id', hitCount: 0, hitLimit: 5 };
    globalThis[session] = { phase: activation === 'Baseline' ? 'baseline' : 'trial', focusedIds: new Set(['targeted']) };
    globalThis.__stryker__ = ns;
    let coercions = 0;
    const operand = domain === 'Opaque' ? { valueOf() { coercions++; return lhs; } } : lhs;
    try {
      const actual = compareFocused('targeted', less ? '<' : '>', operand, rhs);
      assert.equal(actual, activation !== 'Focused');
      assert.equal(coercions, domain === 'Opaque' ? 1 : 0);
      assert.equal(ns.hitCount, activation === 'Focused' ? 1 : 0);
      assert.deepEqual(ns.focused?.targeted, activation === 'Baseline'
        ? domain === 'Safe' ? [['test-id', lhs, rhs]] : false
        : undefined);
    } finally {
      delete globalThis[session];
      delete globalThis.__stryker__;
    }
  });
}

test('does not emit rows for unattributed comparison evaluation', () => {
  globalThis[session] = { phase: 'baseline', focusedIds: new Set(['targeted']) };
  globalThis.__stryker__ = {};
  try {
    assert.equal(compareFocused('targeted', '>', 1, 0), true);
    assert.equal(globalThis.__stryker__.focused.targeted, false);
  } finally {
    delete globalThis[session];
    delete globalThis.__stryker__;
  }
});
