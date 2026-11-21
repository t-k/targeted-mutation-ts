import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
