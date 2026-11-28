import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlaywrightTestArgs, testFilters } from '../src/playwright.mjs';

test('buildPlaywrightTestArgs separates variadic --project flags from positional test filters', () => {
  const single = buildPlaywrightTestArgs({
    wrapper: '/tmp/work/.tmt-pw.config.mts',
    timeout: 60_000,
    outputDir: '/tmp/out/results',
    projects: ['chromium'],
    filters: ['e2e/tmt-prebuilt\\.spec\\.ts'],
  });
  assert.ok(single.includes('--project=chromium'), `expected --project=chromium, got ${JSON.stringify(single)}`);
  assert.ok(!single.includes('--project'), 'must not pass bare --project before positional filters');
  const projectIndex = single.indexOf('--project=chromium');
  const outputIndex = single.indexOf('--output');
  const filterIndex = single.indexOf('e2e/tmt-prebuilt\\.spec\\.ts');
  assert.ok(projectIndex < outputIndex && outputIndex < filterIndex, `expected --output between --project and filters: ${JSON.stringify(single)}`);

  const multiple = buildPlaywrightTestArgs({
    wrapper: '/tmp/work/.tmt-pw.config.mts',
    timeout: 30_000,
    outputDir: '/tmp/out/results',
    projects: ['chromium', 'firefox'],
    filters: ['e2e/a\\.spec\\.ts', 'e2e/b\\.spec\\.ts'],
  });
  assert.deepEqual(
    multiple.filter(arg => arg.startsWith('--project=')),
    ['--project=chromium', '--project=firefox'],
  );
  assert.deepEqual(multiple.slice(-2), ['e2e/a\\.spec\\.ts', 'e2e/b\\.spec\\.ts']);
});

test('testFilters escapes regex metacharacters in relative paths', () => {
  const filters = testFilters(process.cwd(), ['package.json']);
  assert.deepEqual(filters, ['package\\.json']);
});
