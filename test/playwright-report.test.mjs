import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyPlaywright } from '../src/playwright.mjs';
import { verdict } from '../src/analysis.mjs';

const rows = readFileSync(new URL('../verification/pict/m3-playwright.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  test('Playwright report ' + row.replaceAll('\t', ' / '), () => {
    const [outcome, project, expected] = row.split('\t');
    const projects = project === 'Single' ? ['chrome'] : ['chrome', 'another-chrome'];
    function report(status, missing = false) {
      const needsNewAttempt = status === 'Flaky';
      const actual = { Passed: 'passed', Failed: 'failed', TimedOut: 'timedOut', Flaky: 'passed', SetupError: 'skipped' }[status];
      return {
        errors: status === 'SetupError' ? [{ message: 'Server start failed' }] : [],
        config: { projects: projects.map(name => ({ name, metadata: { tmtBrowser: 'chromium' } })) },
        suites: [{ specs: [{ id: 'example', file: 'e2e/main.spec.ts', title: 'does the thing',
          tests: projects.slice(0, missing ? -1 : undefined).map(projectName => ({
            projectName, expectedStatus: 'passed', status: status === 'Flaky' ? 'flaky' : actual === 'passed' ? 'expected' : 'unexpected',
            results: [{ status: actual, workerIndex: 0, parallelIndex: 0, retry: needsNewAttempt ? 1 : 0 }],
          })),
        }] }],
      };
    }
    const baseline = classifyPlaywright(report('Passed'), 0);
    const run = classifyPlaywright(report(outcome, expected === 'Missing'), outcome === 'Passed' || outcome === 'Flaky' ? 0 : 1);
    const result = verdict(run, baseline);
    const ground = { Passed: 'survived', Failed: 'killed', TimedOut: 'timeout', Flaky: 'unstable', SetupError: 'error' }[outcome];
    assert.equal(result, expected === 'Missing' && ['survived', 'killed'].includes(ground) ? (projects.length === 1 ? 'error' : 'unstable') :
      expected === 'Missing' && projects.length === 1 ? 'error' : ground);
    assert.ok(baseline.tests.every(test => test.browser === 'chromium'));
  });
}

test('a Playwright project with no managed web server fails rather than surviving local rewrites', async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runPlaywright } = await import('../src/playwright.mjs');
  const { withCopy } = await import('../src/vitest.mjs');
  const root = mkdtempSync(join(tmpdir(), 'tmt-unmanaged-test-'));
  try {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'playwright.config.ts'), 'export default { testDir: "./e2e", use: { baseURL: "https://example.invalid" } };');
    writeFileSync(join(root, 'e2e', 'trivial.spec.ts'), "import { test } from '@playwright/test'; test('passes', () => {});");
    const result = withCopy(root, (workspace, temp) => runPlaywright(workspace, temp));
    assert.equal(result.status, 'error');
    assert.match(result.output, /requires a managed webServer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the logical operator retains its own byte position in a multiline disabled expression', async () => {
  const { extract } = await import('../src/extract.mjs');
  const source = 'const view = <button disabled={saving\n || !valid} />;';
  const { candidates: [site] } = extract(source, { dialect: 'tsx', logical: true });
  assert.equal(site.edit[0], source.indexOf('saving'));
  assert.deepEqual(site.operatorEdit, [source.indexOf('||'), source.indexOf('||') + 2]);
});
