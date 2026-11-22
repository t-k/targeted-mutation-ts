import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const supported = process.platform === 'darwin' || process.platform === 'linux';

test('the native build only enables LTO when the selected compiler can link it', { skip: !supported }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-native-flags-'));
  try {
    const build = join(root, 'scripts', 'build-native.mjs');
    const compiler = join(root, 'fake-cc');
    const log = join(root, 'arguments.jsonl');
    mkdirSync(join(root, 'scripts'));
    cpSync(new URL('../scripts/build-native.mjs', import.meta.url), build);
    cpSync(new URL('../scripts/native-simd-source.mjs', import.meta.url), join(root, 'scripts/native-simd-source.mjs'));
    writeFileSync(join(root, 'node_api.h'), '');
    writeFileSync(compiler, `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.TMT_COMPILER_LOG, JSON.stringify(args) + '\\n');
if (args.at(-1) === '-' && process.env.TMT_ACCEPT_LTO === 'no') process.exit(1);
require('node:fs').writeFileSync(args[args.lastIndexOf('-o') + 1], 'compiled addon');
`, { mode: 0o700 });

    for (const ltoAvailable of [true, false]) {
      writeFileSync(log, '');
      const target = join(root, 'isolated', 'tmt.node');
      const child = spawnSync(process.execPath, [build, '--low-only', '--output', target], {
        encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, CC: compiler, TMT_NODE_INCLUDE: root, TMT_COMPILER_LOG: log,
          TMT_ACCEPT_LTO: ltoAvailable ? 'yes' : 'no' },
      });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const invocations = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(invocations.length, 2);
      const [probe, selected] = invocations;
      const mode = process.platform === 'darwin' ? '-bundle' : '-shared';
      assert.ok(probe.includes(mode) && probe.includes('-flto'));
      assert.ok(selected.includes(mode) && selected.includes('-fvisibility=hidden'));
      assert.equal(selected.includes('-flto'), ltoAvailable);
      assert.equal(readFileSync(target, 'utf8'), 'compiled addon');
      assert.deepEqual(readdirSync(join(root, 'isolated')), ['tmt.node']);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
