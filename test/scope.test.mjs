import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { selectScope } from '../src/scope.mjs';

test('Git scope selects additions and untracked files while ignoring deletion-only hunks', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-scope-test-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  const write = (file, text) => writeFileSync(join(root, file), text);
  try {
    git('init', '-q');
    write('changed.ts', 'const x = 3 < 4;\nconst y = 8 > 2;\n');
    write('only-deletion.ts', '// Remove this line\nconst x = 3 < 4;\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    write('changed.ts', 'const x = 3 < 4;\nconst y = 7 > 2;\n');
    write('only-deletion.ts', 'const x = 3 < 4;\n');
    write('new.tsx', 'const x = 3 < 4;\n');
    const scopes = selectScope(root, [], { since: 'HEAD' });
    assert.deepEqual(scopes.map(scope => scope.file), ['changed.ts', 'new.tsx']);
    assert.equal(scopes[0].selected(1), false);
    assert.equal(scopes[0].selected(2), true);
    assert.equal(scopes[1].selected(1), true);
    assert.throws(() => selectScope(root, [], { since: '--invalid' }), /Cannot resolve Git revision/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const scopedRows = readFileSync(new URL('../verification/pict/changed-sources.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const extensions = { TS: 'ts', TSX: 'tsx', JS: 'js', JSX: 'jsx', MJS: 'mjs', CTS: 'cts', Declaration: 'd.mts', Test: 'test.js' };
for (const [layout, extension, state] of scopedRows) {
  test(`changed sources: ${layout} ${extension} ${state}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-changed-sources-')));
    const git = (...args) => execFileSync('git', ['-C', root, ...args]);
    const project = layout === 'Root' ? root : join(root, 'packages/site');
    const file = 'code [case].' + extensions[extension];
    const source = join(project, file);
    try {
      mkdirSync(project, { recursive: true });
      git('init', '-q');
      writeFileSync(join(root, 'README.md'), 'outer');
      if (state !== 'Untracked') writeFileSync(source, '// header\nexport const n = 3;\n');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
      if (state === 'Deletion') writeFileSync(source, 'export const n = 3;\n');
      else if (state !== 'Clean') writeFileSync(source, '// header\nexport const n = 4;\n');
      if (state === 'Staged') git('add', '.');
      const selected = selectScope(project, [], { since: 'HEAD' });
      const included = !['Declaration', 'Test'].includes(extension) && !['Clean', 'Deletion'].includes(state);
      assert.deepEqual(selected.map(scope => scope.file), included ? [file] : []);
      if (included) {
        assert.equal(selected[0].selected(1), state === 'Untracked');
        assert.equal(selected[0].selected(2), true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function batchFixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-git-batch-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  const write = (file, source) => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  };
  try {
    git('init', '-q');
    run({ root, git, write, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const batchRows = readFileSync(new URL('../verification/pict/scope-batch.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(line => line.split('\t'));
const batchNames = {
  Plain: 'file.ts', Spaces: 'space b/ file [case].ts', Unicode: '🧪対象.ts', QuotedControls: 'quoted"\n\t\\name.ts',
};
for (const [layout, name, change] of batchRows) {
  test(`batched Git ranges: ${layout} ${name} ${change}`, { skip: name === 'QuotedControls' && process.platform === 'win32' }, () => {
    batchFixture(({ root, git, write, commit }) => {
      const folder = layout === 'Root' ? '' : 'packages/site';
      const project = join(root, folder);
      const file = normalize(batchNames[name]);
      const subject = join(folder, file);
      const sentinel = join(folder, '-sentinel.ts');
      write(subject, 'one\ntwo\nthree\nfour\nfive\n');
      write(sentinel, 'one\ntwo\n');
      if (folder) write('outside.ts', 'old\n');
      commit();
      git('config', 'core.quotePath', 'false');
      git('config', 'diff.noprefix', 'true');
      if (change === 'StagedAndUnstaged') {
        write(subject, 'staged\ntwo\nthree\nfour\nfive\n');
        git('add', '--', subject);
        write(subject, 'staged\ntwo\nthree\nfour\nunstaged\n');
      } else if (change === 'Deletion') {
        write(subject, 'one\ntwo\nfour\nfive\n');
      } else {
        write(subject, 'one\ntwo\nnew\nfour\nfive\n');
      }
      write(sentinel, 'one\nnew\n');
      if (folder) write('outside.ts', 'outside\n');
      const scopes = selectScope(project, [], { since: 'HEAD' });
      assert.deepEqual(scopes.map(({ file, changed }) => [file, changed]), [
        ['-sentinel.ts', [[2, 2]]],
        ...(change === 'Deletion' ? [] : [[file, change === 'Replacement' ? [[3, 3]] : [[1, 1], [5, 5]]]]),
      ]);
      if (change !== 'Deletion' && name !== 'QuotedControls') {
        const only = selectScope(project, [], { since: 'HEAD', lines: [file + ':4-5'] });
        assert.equal(only.length, 1);
        assert.equal(only[0].selected(1), false);
        assert.equal(only[0].selected(5), change === 'StagedAndUnstaged');
      }
    });
  });
}

test('a group of changed sources needs one Git patch request', t => {
  batchFixture(({ root, write, commit }) => {
    const files = Array.from({ length: 24 }, (_, index) => `source-${index}.ts`);
    for (const file of files) write(file, 'unchanged\nold\n');
    commit();
    for (const file of files) write(file, 'unchanged\nnew\n');
    const childProcess = createRequire(import.meta.url)('node:child_process');
    const original = childProcess.execFileSync;
    const patches = [];
    const spy = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
      if (command === 'git' && args.includes('--unified=0')) patches.push(args);
      return original(command, args, options);
    });
    syncBuiltinESMExports();
    try {
      const scopes = selectScope(root, [], { since: 'HEAD' });
      assert.deepEqual(scopes.map(({ file, changed }) => [file, changed]), files.toSorted().map(file => [file, [[2, 2]]]));
      assert.equal(patches.length, 1);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test('large Git patches retain following hunks and neighboring paths', () => {
  batchFixture(({ root, write, commit }) => {
    for (const file of ['large.ts', 'other.ts']) write(file, 'old\nkeep one\nkeep two\nold\n');
    commit();
    write('large.ts', `x${'a'.repeat(17 * 1024 * 1024)}\nkeep one\nkeep two\nnew\n`);
    write('other.ts', 'old\nkeep one\nkeep two\nnew\n');
    const scopes = selectScope(root, [], { since: 'HEAD' });
    assert.deepEqual(scopes.map(({ file, changed }) => [file, changed]), [
      ['large.ts', [[1, 1], [4, 4]]], ['other.ts', [[4, 4]]],
    ]);
  });
});
