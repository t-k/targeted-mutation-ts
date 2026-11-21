import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { withCopy } from '../src/vitest.mjs';

const rows = readFileSync(new URL('../verification/pict/copy-links.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(row => row.trim().split('\t'));

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
