import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { resolveCopyExclusions, runnerPackage, withCopy } from '../src/vitest.mjs';

const rows = readFileSync(new URL('../verification/pict/copy-links.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(row => row.trim().split('\t'));
const excludeRows = readFileSync(new URL('../verification/pict/copy-exclude.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.trim().split('\t'));

function projectFixture(action) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-copy-test-')));
  try {
    const original = join(scratch, 'original');
    mkdirSync(original);
    return action(original, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const [spelling, kind, placement] of rows) {
  test(`copy preserves ${spelling.toLowerCase()} ${kind.toLowerCase()} alias to ${placement.toLowerCase()} target`, () =>
    projectFixture((original, scratch) => {
      const directory = kind === 'Directory';
      const destination = join(placement === 'External' ? scratch : original, 'target');
      if (directory) mkdirSync(destination);
      const item = directory ? join(destination, 'file.txt') : destination;
      writeFileSync(item, 'original');
      symlinkSync(spelling === 'Relative' ? relative(original, destination) : destination, join(original, 'alias'), directory ? 'dir' : 'file');
      withCopy(original, workspace => {
        const alias = directory ? join(workspace, 'alias', 'file.txt') : join(workspace, 'alias');
        if (placement === 'Excluded') {
          assert.equal(existsSync(alias), false);
        } else if (placement === 'External') {
          assert.equal(realpathSync(alias), item);
          assert.equal(readFileSync(alias, 'utf8'), 'original');
        } else {
          const copied = join(workspace, relative(original, item));
          writeFileSync(copied, 'trial');
          assert.equal(realpathSync(alias), copied);
          assert.equal(readFileSync(alias, 'utf8'), 'trial');
        }
      }, { exclude: placement === 'Excluded' ? ['target'] : [] });
      assert.equal(readFileSync(item, 'utf8'), 'original');
    }));
}

test('follows a chain of internal aliases within the trial', () => projectFixture(original => {
  writeFileSync(join(original, 'destination'), 'original');
  symlinkSync('destination', join(original, 'inner'), 'file');
  symlinkSync(join(original, 'inner'), join(original, 'outer'), 'file');
  withCopy(original, workspace => {
    writeFileSync(join(workspace, 'destination'), 'trial');
    assert.equal(readFileSync(join(workspace, 'outer'), 'utf8'), 'trial');
  });
}));


test('uses the nearest installed dependency inside a workspace package', () => projectFixture(original => {
  const local = join(original, 'packages/site');
  const excluded = join(original, 'packages/excluded');
  for (const [directory, name] of [[original, 'hoisted'], [local, 'local'], [excluded, 'excluded']]) {
    const dependency = join(directory, 'node_modules/tmt-copy-dependency');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'index.js'), `module.exports = ${JSON.stringify(name)};`);
  }
  withCopy(original, workspace => {
    const resolveFrom = createRequire(join(workspace, 'packages/site/index.cjs'));
    assert.equal(resolveFrom('tmt-copy-dependency'), 'local');
    assert.equal(existsSync(join(workspace, 'packages/excluded')), false);
  }, { exclude: ['packages/excluded'] });
}));

test('links hoisted runners alongside local packages and executable links', () => projectFixture(original => {
  const child = join(original, 'packages/site');
  const local = join(child, 'node_modules');
  mkdirSync(join(local, 'local'), { recursive: true });
  mkdirSync(join(local, '.bin'));
  const scope = join(original, 'local-playwright-scope');
  mkdirSync(join(scope, 'local'), { recursive: true });
  writeFileSync(join(scope, 'local/index.js'), 'module.exports = 17;');
  symlinkSync(scope, join(local, '@playwright'), 'dir');
  writeFileSync(join(local, 'local/index.js'), 'module.exports = true;');
  symlinkSync('../local/index.js', join(local, '.bin/local'));
  const runners = [['vitest', 'vitest', 'vitest.mjs'], ['playwright', '@playwright/test', 'cli.js']];
  for (const [, pkg, bin] of runners) {
    const hoisted = join(original, 'node_modules', pkg);
    mkdirSync(hoisted, { recursive: true });
    writeFileSync(join(hoisted, 'package.json'), '{}');
    writeFileSync(join(hoisted, bin), '');
  }
  withCopy(child, workspace => {
    const resolveFrom = createRequire(join(workspace, 'package.json'));
    assert.equal(resolveFrom('local'), true);
    assert.equal(resolveFrom('@playwright/local'), 17);
    assert.equal(readFileSync(join(workspace, 'node_modules/.bin/local'), 'utf8'), 'module.exports = true;');
    for (const [runner, pkg, bin] of runners) {
      const hoisted = join(original, 'node_modules', pkg);
      assert.equal(runnerPackage(workspace, runner), join(hoisted, 'package.json'));
      assert.equal(realpathSync(join(workspace, 'node_modules/.bin', runner)), join(hoisted, bin));
      assert.equal(existsSync(join(local, pkg)), false);
      assert.equal(existsSync(join(local, '.bin', runner)), false);
    }
  });
}));

test('honors explicit nested dependency-tree exclusions', () => projectFixture(original => {
  const dependency = join(original, 'packages/site/node_modules/dep');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'index.js'), 'module.exports = true;');
  withCopy(original, workspace => {
    assert.equal(existsSync(join(workspace, 'packages/site/node_modules')), false);
  }, { exclude: ['packages/site/node_modules'] });
  assert.throws(() => withCopy(original, () => assert.fail('projection must be rejected'),
    { exclude: ['packages/site/node_modules/dep'] }), /Copy exclusion cannot target node_modules contents/);
}));

for (const [pathKind, parentState, targetExistence, duplicate] of excludeRows) {
  test(`PICT copy-exclude ${pathKind}/${parentState}/${targetExistence}/${duplicate}`, () => projectFixture((original, scratch) => {
    const setupParent = () => {
      if (parentState === 'RealDir') {
        mkdirSync(join(original, 'packages/app'), { recursive: true });
        return 'packages/app';
      }
      if (parentState === 'MissingDir') return 'missing-parent/app';
      if (parentState === 'SymlinkDir') {
        mkdirSync(join(original, 'real-dir'), { recursive: true });
        symlinkSync('real-dir', join(original, 'linked-dir'), 'dir');
        return 'linked-dir';
      }
      if (parentState === 'BrokenSymlinkDir') {
        symlinkSync('does-not-exist', join(original, 'broken-dir'), 'dir');
        return 'broken-dir';
      }
      writeFileSync(join(original, 'plain-file'), 'not a dir');
      return 'plain-file';
    };

    let relPath;
    if (pathKind === 'Direct') {
      relPath = 'dist';
      if (targetExistence === 'Exists') mkdirSync(join(original, relPath));
    } else if (pathKind === 'Nested') {
      const parent = setupParent();
      relPath = `${parent}/dist`;
      if (targetExistence === 'Exists') mkdirSync(join(original, parent === 'linked-dir' ? 'real-dir/dist' : relPath), { recursive: true });
    } else if (pathKind === 'NestedNodeModules') {
      const parent = setupParent();
      relPath = `${parent}/node_modules`;
      if (targetExistence === 'Exists') mkdirSync(join(original, parent === 'linked-dir' ? 'real-dir/node_modules' : relPath), { recursive: true });
    } else if (pathKind === 'SymlinkTarget') {
      writeFileSync(join(original, 'real.txt'), 'ok');
      symlinkSync('real.txt', join(original, 'alias'), 'file');
      relPath = 'alias';
    } else if (pathKind === 'DanglingSymlink') {
      symlinkSync('no-such-target', join(original, 'dangling'), 'file');
      relPath = 'dangling';
    } else if (pathKind === 'Escape') {
      relPath = '../outside';
      if (targetExistence === 'Exists') mkdirSync(join(scratch, 'outside'));
    } else if (pathKind === 'RootNodeModules') {
      relPath = 'node_modules';
      if (targetExistence === 'Exists') mkdirSync(join(original, relPath));
    } else if (pathKind === 'NodeModulesContent') {
      relPath = 'packages/app/node_modules/dep';
      if (targetExistence === 'Exists') mkdirSync(join(original, relPath), { recursive: true });
    }

    const input = duplicate === 'Repeated' ? [relPath, `./${relPath}`] : [relPath];
    const missing = [];
    const expectError =
      pathKind === 'Escape' ? /Copy exclusion must be inside the project/
        : pathKind === 'RootNodeModules' ? /Copy exclusion cannot target node_modules/
          : pathKind === 'NodeModulesContent' ? /Copy exclusion cannot target node_modules contents/
            : (parentState === 'SymlinkDir' || parentState === 'BrokenSymlinkDir') ? /Copy exclusion must not traverse a symbolic link/
              : null;

    if (expectError) {
      assert.throws(() => resolveCopyExclusions(original, input, { onMissing: p => missing.push(p) }), expectError);
      assert.deepEqual(missing, []);
      return;
    }

    const resolved = resolveCopyExclusions(original, input, { onMissing: p => missing.push(p) });
    if (targetExistence === 'Exists') {
      assert.deepEqual(resolved, [join(original, relPath)]);
      assert.deepEqual(missing, []);
    } else {
      assert.deepEqual(resolved, []);
      assert.deepEqual(missing, [relPath]);
    }
  }));
}

test('withCopy skips missing exclusions and omits excluded dangling symlinks', () => projectFixture(original => {
  writeFileSync(join(original, 'keep.txt'), 'ok');
  symlinkSync('no-such-target', join(original, 'dangling'), 'file');
  withCopy(original, workspace => {
    assert.equal(readFileSync(join(workspace, 'keep.txt'), 'utf8'), 'ok');
    assert.equal(lstatSync(join(workspace, 'dangling'), { throwIfNoEntry: false }), undefined);
  }, { exclude: ['dist', 'nested/missing', 'dangling'] });
  withCopy(original, workspace => {
    assert.equal(lstatSync(join(workspace, 'dangling'), { throwIfNoEntry: false })?.isSymbolicLink(), true);
  });
  assert.throws(() => resolveCopyExclusions(original, ['.']), /Copy exclusion must be inside the project/);
  assert.throws(() => resolveCopyExclusions(original, [join(original, 'keep.txt')]), /Copy exclusion must be inside the project/);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.throws(() => resolveCopyExclusions(original, ['NODE_MODULES']), /Copy exclusion cannot target node_modules/);
    assert.throws(() => resolveCopyExclusions(original, ['NODE_MODULES/missing']), /Copy exclusion cannot target node_modules/);
    assert.throws(() => resolveCopyExclusions(original, ['packages/app/NODE_MODULES/dep']), /Copy exclusion cannot target node_modules contents/);
  }
}));

test('property: resolveCopyExclusions deduplicates existing and missing relative paths', () => projectFixture(original => {
  const pool = ['a', 'b', 'c/d', 'c/e', 'f/g/h'];
  let seed = 0x5eed1234;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const existing = new Set(['a', 'c/d']);
  for (const rel of existing) mkdirSync(join(original, rel), { recursive: true });

  for (let trial = 0; trial < 40; trial++) {
    const chosen = [];
    const expectedExisting = new Set();
    const expectedMissing = new Set();
    const count = 1 + Math.floor(next() * 8);
    for (let i = 0; i < count; i++) {
      const base = pool[Math.floor(next() * pool.length)];
      const variant = next() < 0.33 ? `./${base}` : next() < 0.66 ? `${base}/` : base;
      chosen.push(variant);
      const full = join(original, base);
      if (existing.has(base)) expectedExisting.add(full);
      else expectedMissing.add(full);
    }
    const missingCandidates = [];
    const resolved = resolveCopyExclusions(original, chosen, { onMissing: (_p, candidate) => missingCandidates.push(candidate) });
    assert.equal(new Set(resolved).size, resolved.length);
    assert.deepEqual(new Set(resolved), expectedExisting);
    assert.equal(new Set(missingCandidates).size, missingCandidates.length);
    assert.deepEqual(new Set(missingCandidates), expectedMissing);
  }
}));
