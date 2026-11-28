import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPlaywrightTestArgs, exactTestFilters, testFilters } from '../src/playwright.mjs';

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

test('exactTestFilters anchors resolved paths to prevent suffix matches and leading-dash CLI flag collisions', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-pw-exact-filter-')));
  try {
    mkdirSync(join(root, 'e2e'), { recursive: true });
    mkdirSync(join(root, 'nested/e2e'), { recursive: true });
    writeFileSync(join(root, 'e2e/selected.spec.ts'), '');
    writeFileSync(join(root, 'nested/e2e/selected.spec.ts'), '');
    writeFileSync(join(root, '-dash.spec.ts'), '');

    const [topFilter, dashFilter] = exactTestFilters(root, ['e2e/selected.spec.ts', '-dash.spec.ts']);
    assert.ok(topFilter.startsWith('^') && topFilter.endsWith('$'));
    assert.ok(dashFilter.startsWith('^') && dashFilter.endsWith('$'));
    assert.ok(!dashFilter.startsWith('-'), 'anchored filter must not start with a dash');

    const topRe = new RegExp(topFilter);
    assert.ok(topRe.test(join(root, 'e2e/selected.spec.ts').replaceAll('\\', '/')));
    assert.ok(!topRe.test(join(root, 'nested/e2e/selected.spec.ts').replaceAll('\\', '/')));

    const dashRe = new RegExp(dashFilter);
    assert.ok(dashRe.test(join(root, '-dash.spec.ts').replaceAll('\\', '/')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
