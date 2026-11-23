import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function temporaryProject(files, action) {
  const root = mkdtempSync(join(tmpdir(), 'tmt-in-worker-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    // A project with its own node_modules has to provide Vitest itself.
    if (existsSync(join(root, 'node_modules'))) symlinkSync(resolve('node_modules/vitest'), join(root, 'node_modules/vitest'), 'dir');
    return action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function analyze(root, ...args) {
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, ...args, '--format', 'json'],
    { encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  assert.ok(run.stdout, run.stderr);
  return JSON.parse(run.stdout);
}

const verdicts = report => new Map(report.mutants.map(mutant => [`${mutant.location.file}:${mutant.edit}:${mutant.replacement}`, mutant]));
const find = (report, file, original, replacement) => report.mutants.find(mutant =>
  mutant.location.file === file && mutant.original === original && mutant.replacement === replacement);

// One suite with the ways a test can disturb the worker it runs in. The functions that leave state behind come last,
// so the earlier ones are decided inside the worker before the first control run fails.
const hazards = {
  'vitest.config.mjs': 'export default { test: { testTimeout: 300 } };',
  'node_modules/counter-dep/package.json': '{ "name": "counter-dep", "type": "module", "main": "index.js" }',
  'node_modules/counter-dep/index.js': 'let issued = 0;\nexport const next = () => ++issued;\n',
  'subject.ts': `export const price = (n: number, member: boolean) => member && n >= 10 ? n - 1 : n;
export function sign(n: number) { return n > 0 ? 'pos' : 'neg'; }
export function grade(n: number) { return n > 5 ? 'big' : 'small'; }
export function spin(n: number) { let i = 0; while (i < n) i++; return i; }
export async function wait(n: number) { if (n > 7) return 'done'; return new Promise(() => {}); }
export function unused(n: number) { return n + 1; }
// Evaluated while the module loads, so its mutations run every test of a file, including the ones that leave state behind.
export const TABLE = [1, 2, 3].map(n => n * 2);
export function remember(n: number) { (globalThis as any).__seen = n > 3 ? 'big' : 'small'; return n; }
export function recall() { return (globalThis as any).__seen ?? 'none'; }
`,
  'ticket.ts': `import { next } from 'counter-dep';
export function ticket(n: number) { return n > 1 ? next() : 0; }
`,
  'a.test.ts': `import { expect, it, vi } from 'vitest';
import { TABLE, grade, price, recall, remember, sign, spin, wait } from './subject';
it('recall before remember', () => expect(recall()).toBe('none'));
it('price plain', () => expect(price(10, false)).toBe(10));
it('price member', () => expect(price(10, true)).toBe(9));
it('table', () => expect(TABLE).toEqual([2, 4, 6]));
it('sign with fake timers', () => { vi.useFakeTimers(); expect(sign(1)).toBe('pos'); vi.useRealTimers(); });
it('sign after a real timer', async () => { await new Promise(resolve => setTimeout(resolve, 1)); expect(sign(-1)).toBe('neg'); });
it('late check', () => { void Promise.resolve().then(() => { if (grade(7) !== 'big') throw new Error('late'); }); });
it('spin', () => expect(spin(3)).toBe(3));
it('wait', async () => expect(await wait(8)).toBe('done'));
it('remember', () => { expect(remember(5)).toBe(5); expect(recall()).toBe('big'); });
`,
  'b.test.ts': `import { expect, it } from 'vitest';
import { price } from './subject';
it('price small member', () => expect(price(3, true)).toBe(3));
it('price large member', () => expect(price(20, true)).toBe(19));
`,
  'ticket.test.ts': `import { expect, it } from 'vitest';
import { ticket } from './ticket';
it('first ticket', () => expect(ticket(2)).toBe(1));
`,
};

test('mutations decided inside a worker get the verdict of a fresh Vitest run each', () => temporaryProject(hazards, root => {
  for (const profile of ['full', 'standard']) {
    const subjects = ['subject.ts', 'ticket.ts'];
    const shared = analyze(root, ...subjects, '--mutators', profile, '--concurrency', '2');
    const fresh = analyze(root, ...subjects, '--mutators', profile, '--isolated-trials');
    assert.equal(shared.evaluation, 'evaluated');
    assert.equal(fresh.evaluation, 'evaluated');
    const expected = verdicts(fresh);
    assert.equal(shared.mutants.length, fresh.mutants.length);
    for (const [key, mutant] of verdicts(shared)) {
      assert.equal(mutant.status, expected.get(key).status, `${profile} ${key}`);
      if (mutant.status === 'killed') assert.ok(mutant.tests.length > 0, `${profile} ${key}`);
    }
    if (profile !== 'standard') continue;
    assert.equal(fresh.trials.inWorker, 0);
    assert.ok(shared.trials.inWorker >= 20, JSON.stringify(shared.trials));
    assert.equal(shared.trials.inWorker + shared.trials.isolated, shared.mutants.filter(mutant => mutant.status !== 'unreached').length);
    // The suite leaves a global and a counter in a dependency behind. Those mutations need the fresh runs.
    assert.ok(shared.trials.isolated >= 2, JSON.stringify(shared.trials));
    assert.equal(shared.trials.workers, 2);
    const status = (file, original, replacement) => find(shared, file, original, replacement)?.status;
    assert.equal(status('subject.ts', 'n >= 10', 'n > 10'), 'killed');
    assert.equal(status('subject.ts', 'n * 2', 'n / 2'), 'killed');
    assert.equal(status('subject.ts', 'n > 0', 'n >= 0'), 'survived');
    assert.equal(status('subject.ts', 'n > 5', 'n <= 5'), 'error');
    // An endless loop that keeps passing the mutation stops at the hit limit. A promise that never settles stops at the test timeout.
    assert.equal(status('subject.ts', 'i++', 'i--'), 'timeout');
    assert.equal(status('subject.ts', 'n > 7', 'false'), 'timeout');
    assert.equal(status('subject.ts', 'n + 1', 'n - 1'), 'unreached');
    assert.equal(status('subject.ts', "(globalThis as any).__seen ?? 'none'", "(globalThis as any).__seen && 'none'"), 'killed');
    assert.equal(status('ticket.ts', 'n > 1', 'n >= 1'), 'survived');
    assert.equal(status('ticket.ts', 'n > 1', 'n <= 1'), 'killed');
    // Both test files that reach the boundary report their failing test.
    assert.deepEqual(find(shared, 'subject.ts', 'n >= 10', 'n < 10').tests.map(killer => killer.file).sort(), ['a.test.ts', 'b.test.ts']);
  }
}));

test('a mutation that never returns is a timeout and the others are still decided', () => temporaryProject({
  'subject.ts': `export function drain() { let n = 0; const forward = true; while (n < 3) n += forward ? 1 : 0; return n; }
export function after(n: number) { return n > 2 ? 'many' : 'few'; }
`,
  'subject.test.ts': `import { expect, it } from 'vitest';
import { after, drain } from './subject';
it('drains', () => expect(drain()).toBe(3));
it('counts', () => { expect(after(3)).toBe('many'); expect(after(2)).toBe('few'); });
`,
}, root => {
  const report = analyze(root, 'subject.ts', '--mutators', 'standard');
  assert.equal(report.evaluation, 'evaluated');
  const stuck = find(report, 'subject.ts', 'true', 'false');
  assert.deepEqual([stuck.status, stuck.statusReason], ['timeout', 'The worker stopped answering']);
  assert.equal(find(report, 'subject.ts', 'n < 3', 'n <= 3').status, 'killed');
  assert.equal(find(report, 'subject.ts', 'n > 2', 'n >= 2').status, 'killed');
  assert.equal(find(report, 'subject.ts', 'n > 2', 'n <= 2').status, 'killed');
  assert.ok(report.mutants.every(mutant => mutant.status !== 'unevaluated'));
}));
