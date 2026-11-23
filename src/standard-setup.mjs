import { afterEach, beforeAll, beforeEach, inject } from 'vitest';

const session = inject('tmtSession');
// The in-thread engine replaces the injected state for each control and trial it starts.
const state = globalThis[Symbol.for('targeted-mutation-ts/trial')] ?? session;
globalThis[Symbol.for('targeted-mutation-ts/session')] = { ...session, focusedIds: new Set(session.focusedIds ?? []) };
const { active, hitLimit, phase, staticActivation, shift } = state;
const namespace = globalThis.__stryker__ ??= {};
namespace.activeMutant = staticActivation ? active : undefined;
namespace.hitCount = 0;
namespace.hitLimit = hitLimit;
namespace.shift = shift ?? 0;

if (phase === 'baseline') {
  beforeEach(({ task }) => { namespace.currentTestId = task.id; });
  afterEach(() => { namespace.currentTestId = undefined; });
} else if (phase === 'trial' && !staticActivation) {
  beforeAll(() => { namespace.activeMutant = active; });
}
