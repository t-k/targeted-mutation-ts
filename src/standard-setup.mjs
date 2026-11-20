import { afterEach, beforeAll, beforeEach, inject } from 'vitest';

const state = inject('tmtSession');
globalThis[Symbol.for('targeted-mutation-ts/session')] = { ...state, focusedIds: new Set(state.focusedIds ?? []) };
const { active, hitLimit, phase, staticActivation } = state;
const namespace = globalThis.__stryker__ ??= {};
namespace.activeMutant = staticActivation ? active : undefined;
namespace.hitCount = 0;
namespace.hitLimit = hitLimit;

if (phase === 'baseline') {
  beforeEach(({ task }) => { namespace.currentTestId = task.id; });
  afterEach(() => { namespace.currentTestId = undefined; });
} else if (!staticActivation) {
  beforeAll(() => { namespace.activeMutant = active; });
}
