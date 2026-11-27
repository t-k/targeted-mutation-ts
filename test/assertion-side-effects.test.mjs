import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  diffEndSnapshots,
  recordingTestEndState,
  strengthenAssertions,
  testEndTargets,
  weakCalls,
  weakExpectations,
} from '../src/assertion-strength.mjs';
import { renderText } from '../src/cli-output.mjs';
import { loadTypeScript } from '../src/typescript-compiler.mjs';

const cli = resolve('bin/tmt.mjs');
const pictRows = readFileSync(new URL('../verification/pict/assertion-side-effect.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(line => line.split('\t'));

function withTempProject(files, action) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-side-effect-')));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSnapshotInVm(source, target, key = 'k1') {
  const rewritten = recordingTestEndState(source, target, key);
  assert.equal(loadTypeScript().createSourceFile('t.mjs', rewritten, 99, false).parseDiagnostics.length, 0);
  const lines = [];
  const context = vm.createContext({
    URL,
    process: {
      getBuiltinModule: name => name === 'node:fs'
        ? { appendFileSync: (_url, line) => lines.push(JSON.parse(line)) }
        : undefined,
    },
    it: (_name, fn) => { context.__testFn = fn; },
    expect: () => ({ toBe: () => {}, toBeGreaterThan: () => {}, toBeTruthy: () => {}, toBeDefined: () => {} }),
  });
  const runnable = rewritten.replaceAll('import.meta.url', "'file:///t/'");
  vm.runInContext(runnable, context);
  try {
    context.__testFn();
  } catch {
    // Test threw before reaching end hook.
  }
  return lines[0] ?? null;
}

test('PICT assertion-side-effect matrix covers all channels, diff shapes, and test outcomes', () => {
  for (const [channel, diffShape, testOutcome] of pictRows) {
    if (channel === 'WeakExpect') {
      const text = `import { expect, it } from 'vitest';
it('t', () => {
  const res = { count: 1, fee: 600 };
  expect(res).toBeDefined();
});
`;
      const found = weakExpectations(text, 't.test.ts', ['t']);
      assert.equal(found.length, 1);
      assert.equal(found[0].text, 'res');
      continue;
    }
    if (channel === 'BoundSubjectCall') {
      const text = `import { it } from 'vitest';
import { compute } from './subject';
it('t', () => {
  const input = { a: 1 };
  const res = compute(input);
});
`;
      const withAllow = weakCalls(text, 't.test.ts', 'subject.ts', ['t'], loadTypeScript(), { allowBoundNonLiteral: true });
      assert.equal(withAllow.length, 1);
      assert.equal(withAllow[0].bound, 'res');
      const withoutAllow = weakCalls(text, 't.test.ts', 'subject.ts', ['t']);
      assert.equal(withoutAllow.length, 0);
      continue;
    }

    const throwLine = testOutcome === 'Throw' ? '  throw new Error("boom");\n' : '';
    let origBody = '';
    let editBody = '';
    if (channel === 'ProxyState') {
      const editVal = diffShape === 'Unchanged' ? 'true' : 'false';
      origBody = `  const store = new Proxy({ count: 1, dirty: true, reset() {} }, { get(t, p) { return Reflect.get(t, p); } });\n${throwLine}`;
      editBody = `  const store = new Proxy({ count: 1, dirty: ${editVal}, reset() {} }, { get(t, p) { return Reflect.get(t, p); } });\n${throwLine}`;
    } else if (channel === 'DomState') {
      const makeDom = ({ count, transform, attr, childText }) => `
  const makeEl = (tag, text, tf, idx, children = []) => ({
    nodeType: 1, tagName: tag, childElementCount: children.length, children,
    textContent: text, className: 'row', scrollTop: 0, scrollLeft: 0,
    style: { length: tf ? 1 : 0, 0: 'transform', transform: tf, getPropertyValue: k => k === 'transform' ? tf : '' },
    attributes: idx !== null ? [{ name: 'data-index', value: String(idx) }] : [],
  });
  const container = makeEl('DIV', 'list', '', null, [makeEl('DIV', ${JSON.stringify(childText)}, ${JSON.stringify(transform)}, ${JSON.stringify(attr)})]);
  container.childElementCount = ${count};
`;
      origBody = makeDom({ count: 5, transform: 'translateY(40px)', attr: '2', childText: 'Row 2' }) + throwLine;
      const editParams = diffShape === 'Primitive'
        ? { count: 4, transform: 'translateY(40px)', attr: '2', childText: 'Row 2' }
        : diffShape === 'DomStyleOrAttr'
          ? { count: 5, transform: 'translateY(60px)', attr: '2', childText: 'Row 2' }
          : diffShape === 'DomChild'
            ? { count: 5, transform: 'translateY(40px)', attr: '3', childText: 'Row 3' }
            : { count: 5, transform: 'translateY(40px)', attr: '2', childText: 'Row 2' };
      editBody = makeDom(editParams) + throwLine;
    } else if (channel === 'CallbackVar') {
      const editCount = diffShape === 'Unchanged' ? 2 : 1;
      origBody = `  let called = 0;\n  called = 2;\n${throwLine}`;
      editBody = `  let called = 0;\n  called = ${editCount};\n${throwLine}`;
    }

    const origSrc = `it('t', () => {\n${origBody}});\n`;
    const editSrc = `it('t', () => {\n${editBody}});\n`;
    const [origTarget] = testEndTargets(origSrc, 't.test.ts', ['t']);
    const [editTarget] = testEndTargets(editSrc, 't.test.ts', ['t']);
    assert.ok(origTarget && editTarget);
    const origSnap = runSnapshotInVm(origSrc, origTarget, 'orig');
    const editSnap = runSnapshotInVm(editSrc, editTarget, 'edit');

    if (testOutcome === 'Throw') {
      assert.equal(origSnap, null, `Throw must not record snapshot for ${channel}/${diffShape}`);
      continue;
    }

    const diff = diffEndSnapshots(origSnap, editSnap);
    if (diffShape === 'Unchanged') {
      assert.equal(diff, null, `Expected no diff for ${channel}/Unchanged`);
    } else {
      assert.ok(diff, `Expected diff for ${channel}/${diffShape}`);
      if (channel === 'ProxyState') assert.equal(diff.suggestedTest, 'expect(store.dirty).toBe(true)');
      if (channel === 'CallbackVar') assert.equal(diff.suggestedTest, 'expect(called).toBe(2)');
      if (channel === 'DomState' && diffShape === 'Primitive') assert.equal(diff.suggestedTest, 'expect(container.childElementCount).toBe(5)');
      if (channel === 'DomState' && diffShape === 'DomStyleOrAttr') assert.equal(diff.suggestedTest, 'expect(container.children[0].style.transform).toBe("translateY(40px)")');
      if (channel === 'DomState' && diffShape === 'DomChild') assert.equal(diff.suggestedTest, 'expect(container.children[0].getAttribute("data-index")).toBe("2")');
    }
  }
});

test('E2E --suggest-assertions suggests concrete assertions for Proxy store and DOM virtual-list', () => {
  const storeSource = `export function createStore(initial: { count: number; dirty: boolean }) {
  const state = { ...initial };
  const listeners: Array<() => void> = [];
  return new Proxy(state, {
    set(target, prop, value) {
      (target as any)[prop] = value;
      if (prop === 'count' && Number(value) >= 1) {
        target.dirty = true;
      }
      for (const fn of listeners) fn();
      return true;
    },
  });
}
`;
  const storeTest = `import { expect, it } from 'vitest';
import { createStore } from './store';

it('updates count through proxy', () => {
  const store = createStore({ count: 0, dirty: false });
  store.count = 1;
  expect(store.count).toBe(1);
});
`;
  const vlistSource = `export interface FakeEl {
  nodeType: 1;
  tagName: string;
  childElementCount: number;
  textContent: string;
  className: string;
  scrollTop: number;
  scrollLeft: number;
  style: Record<string, any>;
  attributes: Array<{ name: string; value: string }>;
  children: FakeEl[];
}
export function renderVirtualList(container: FakeEl, scrollTop: number, rowHeight: number) {
  const start = scrollTop >= 20 ? Math.floor(scrollTop / rowHeight) : 0;
  const offset = start * rowHeight;
  const row: FakeEl = {
    nodeType: 1,
    tagName: 'DIV',
    childElementCount: 0,
    textContent: 'Row ' + start,
    className: 'row',
    scrollTop: 0,
    scrollLeft: 0,
    style: { length: 1, 0: 'transform', transform: 'translateY(' + offset + 'px)' },
    attributes: [{ name: 'data-index', value: String(start) }],
    children: [],
  };
  container.children = [row];
  container.childElementCount = 1;
}
`;
  const vlistTest = `import { expect, it } from 'vitest';
import { renderVirtualList, type FakeEl } from './virtual-list';

it('renders scrolled row into container', () => {
  const container: FakeEl = {
    nodeType: 1, tagName: 'DIV', childElementCount: 0, textContent: '', className: 'list',
    scrollTop: 0, scrollLeft: 0, style: { length: 0 }, attributes: [], children: [],
  };
  renderVirtualList(container, 20, 20);
  expect(container.childElementCount).toBe(1);
});
`;

  withTempProject({
    'src/store.ts': storeSource,
    'src/store.test.ts': storeTest,
    'src/virtual-list.ts': vlistSource,
    'src/virtual-list.test.ts': vlistTest,
  }, dir => {
    const storeRun = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/store.ts', '--test', 'src/store.test.ts', '--suggest-assertions', '--format', 'json'], {
      encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(storeRun.status, 0, storeRun.stderr);
    const storeReport = JSON.parse(storeRun.stdout);
    const proxyGap = storeReport.diagnostics.find(d => d.kind === 'ASSERTION GAP' && d.suggestedTest);
    assert.ok(proxyGap, `Expected concrete suggestion for Proxy store: ${JSON.stringify(storeReport.diagnostics)}`);
    assert.equal(proxyGap.suggestedTest, 'expect(store.dirty).toBe(true)');
    assert.equal(proxyGap.strengthens.kind, 'state');
    assert.match(renderText(storeReport), /leaves `store\.dirty` unasserted: it is true, and false with the edit/);

    const domRun = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/virtual-list.ts', '--test', 'src/virtual-list.test.ts', '--suggest-assertions', '--format', 'json'], {
      encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(domRun.status, 0, domRun.stderr);
    const domReport = JSON.parse(domRun.stdout);
    const domGap = domReport.diagnostics.find(d => d.kind === 'ASSERTION GAP' && d.suggestedTest);
    assert.ok(domGap, `Expected concrete suggestion for DOM virtual-list: ${JSON.stringify(domReport.diagnostics)}`);
    assert.equal(domGap.suggestedTest, 'expect(container.children[0].style.transform).toBe("translateY(20px)")');
    assert.equal(domGap.strengthens.kind, 'state');
  });
});

test('weak expect() on non-subject expression suggests exact value without Pass 2', async () => {
  await withTempProject({
    'subject.ts': 'export const compute = (x: number) => x * 2;\n',
    'subject.test.ts': `import { expect, it } from 'vitest';
import { compute } from './subject';
it('checks weakly', () => {
  const obj = { out: compute(5) };
  expect(obj.out).toBeGreaterThan(0);
});
`,
  }, async root => {
    const seen = [];
    const run = {
      sourceTrials: () => settings => {
        seen.push(settings.witness.rewrite.content);
        const edited = Boolean(settings.trial);
        return { status: 'passed', collected: (edited ? '"7"' : '"10"') + '\n' };
      },
    };
    const report = {
      diagnostics: [{
        kind: 'ASSERTION GAP',
        location: { file: 'subject.ts', line: 1, column: 1 },
        tests: [{ file: 'subject.test.ts', name: 'checks weakly' }],
        mutations: [{ edit: [38, 43], replacement: 'x + 2', source: { edit: [38, 43], replacement: 'x + 2' } }],
      }],
    };
    await strengthenAssertions(root, report, {}, run);
    assert.equal(report.diagnostics[0].suggestedTest, 'expect(obj.out).toBe(10)');
    assert.ok(seen.every(src => src.includes('__tmtValue_')), 'Expected Pass 1 weakExpectations to resolve without Pass 2');
  });
});

test('Review fixes: unsafe weak expects rejected, partial Proxy never uses toStrictEqual, truncated DOM attrs ignored, Pass 2 reachable after 4 Pass 1 candidates', async () => {
  // 1. Comma expression, nullish coalescing, and stateful call are rejected by weakExpectations.
  const unsafeTest = `import { expect, it } from 'vitest';
it('t', () => {
  const a = 1, b = 2, iterator = { next: () => ({ value: 1 }) };
  expect((a, b)).toBeTruthy();
  expect(a ?? b).toBeDefined();
  expect(iterator.next().value).toBeDefined();
  expect(a).toBeGreaterThan(0);
});
`;
  assert.deepEqual(weakExpectations(unsafeTest, 't.test.ts', ['t']).map(c => c.text), ['a']);

  // 2. Single-data-field Proxy with method emits property assertion, never whole-object toStrictEqual.
  const proxyOrigSrc = `it('t', () => { const store = new Proxy({ dirty: true, reset() {} }, {}); });\n`;
  const proxyEditSrc = `it('t', () => { const store = new Proxy({ dirty: false, reset() {} }, {}); });\n`;
  const [pOrigTarget] = testEndTargets(proxyOrigSrc, 't.test.ts', ['t']);
  const [pEditTarget] = testEndTargets(proxyEditSrc, 't.test.ts', ['t']);
  const pOrigSnap = runSnapshotInVm(proxyOrigSrc, pOrigTarget, 'po');
  const pEditSnap = runSnapshotInVm(proxyEditSrc, pEditTarget, 'pe');
  const pDiff = diffEndSnapshots(pOrigSnap, pEditSnap);
  assert.equal(pDiff.suggestedTest, 'expect(store.dirty).toBe(true)');

  // 3. Long DOM attribute (>200 chars) omitted on original must not be treated as null.
  const longAttrOrig = `it('t', () => { const el = { nodeType: 1, tagName: 'DIV', childElementCount: 0, textContent: '', className: '', scrollTop: 0, scrollLeft: 0, style: { length: 0 }, attributes: [{ name: 'data-label', value: 'x'.repeat(205) }], children: [] }; });\n`;
  const longAttrEdit = `it('t', () => { const el = { nodeType: 1, tagName: 'DIV', childElementCount: 0, textContent: '', className: '', scrollTop: 0, scrollLeft: 0, style: { length: 0 }, attributes: [{ name: 'data-label', value: 'short' }], children: [] }; });\n`;
  const [dOrigTarget] = testEndTargets(longAttrOrig, 't.test.ts', ['t']);
  const [dEditTarget] = testEndTargets(longAttrEdit, 't.test.ts', ['t']);
  const dOrigSnap = runSnapshotInVm(longAttrOrig, dOrigTarget, 'do');
  const dEditSnap = runSnapshotInVm(longAttrEdit, dEditTarget, 'de');
  assert.equal(diffEndSnapshots(dOrigSnap, dEditSnap), null);

  // 3b. Sparse arrays, augmented arrays, and stateful non-Proxy getters must not produce invalid suggestions.
  const sparseOrig = `it('t', () => { const events = [, 1]; const extra = Object.assign([1], { metadata: true }); });\n`;
  const sparseEdit = `it('t', () => { const events = [, 2]; const extra = Object.assign([2], { metadata: true }); });\n`;
  const [sOrigTarget] = testEndTargets(sparseOrig, 't.test.ts', ['t']);
  const [sEditTarget] = testEndTargets(sparseEdit, 't.test.ts', ['t']);
  assert.equal(diffEndSnapshots(runSnapshotInVm(sparseOrig, sOrigTarget, 'so'), runSnapshotInVm(sparseEdit, sEditTarget, 'se')), null);

  const getterOrig = `it('t', () => { let n = 0; const store = { get a() { n += 1; return 0; }, get value() { return n; } }; });\n`;
  const getterEdit = `it('t', () => { let n = 0; const store = { get a() { n += 2; return 0; }, get value() { return n; } }; });\n`;
  const [gOrigTarget] = testEndTargets(getterOrig, 't.test.ts', ['t']);
  const [gEditTarget] = testEndTargets(getterEdit, 't.test.ts', ['t']);
  assert.equal(diffEndSnapshots(runSnapshotInVm(getterOrig, gOrigTarget, 'go'), runSnapshotInVm(getterEdit, gEditTarget, 'ge')), null);

  // 4. Even when 4 Pass 1 weak calls produce identical values, Pass 2 still runs within the 4-trial per-gap budget.
  await withTempProject({
    'subject.ts': 'export const noop = (x: number) => x;\n',
    'subject.test.ts': `import { it } from 'vitest';
import { noop } from './subject';
it('t', () => {
  let called = 0;
  noop(1); noop(2); noop(3); noop(4);
  called = 2;
});
`,
  }, async root => {
    let pass1Runs = 0;
    let pass2Runs = 0;
    const run = {
      sourceTrials: () => settings => {
        const isPass2 = settings.witness.rewrite.content.includes('__tmtEndState_');
        if (settings.trial) {
          if (isPass2) pass2Runs++;
          else pass1Runs++;
        }
        if (isPass2) {
          return { status: 'passed', collected: JSON.stringify({ called: { k: 'val', v: settings.trial ? '1' : '2' } }) + '\n' };
        }
        return { status: 'passed', collected: '"1"\n' };
      },
    };
    const report = {
      diagnostics: [{
        kind: 'ASSERTION GAP',
        location: { file: 'subject.ts', line: 1, column: 1 },
        tests: [{ file: 'subject.test.ts', name: 't' }],
        mutations: [{ edit: [0, 1], replacement: 'x', source: { edit: [0, 1], replacement: 'x' } }],
      }],
    };
    await strengthenAssertions(root, report, {}, run);
    assert.equal(pass1Runs, 3);
    assert.equal(pass2Runs, 1);
    assert.equal(report.diagnostics[0].suggestedTest, 'expect(called).toBe(2)');
  });
});
