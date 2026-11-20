import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
