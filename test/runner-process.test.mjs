import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('a lost CLI parent cancels its active process group', { skip: process.platform === 'win32', timeout: 6_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'tmt-supervisor-test-'));
  const runner = resolve('src/runner-process.mjs');
  const pidFile = join(temp, 'child.pid');
  const alive = join(temp, 'alive');
  const stopped = join(temp, 'stopped');
  const program = join(temp, 'program.mjs');
  writeFileSync(program, `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(stopped)}, String(process.pid)); process.exit(0); });
writeFileSync(${JSON.stringify(alive)}, String(process.pid));
setTimeout(() => process.exit(1), 5_000);`);
  const caller = spawn(process.execPath, ['--input-type=module', '-e', `
import { spawnSync } from 'node:child_process';
spawnSync(process.execPath, ${JSON.stringify([runner, pidFile, '4500', program])}, { stdio: 'ignore' });
`], { stdio: 'ignore' });
  try {
    const ready = Date.now() + 2_000;
    while (!existsSync(alive) && Date.now() < ready) await delay(20);
    assert.ok(existsSync(alive), 'dummy child never started');
    assert.equal(readFileSync(alive, 'utf8'), readFileSync(pidFile, 'utf8'));
    caller.kill('SIGTERM');
    const closed = Date.now() + 2_000;
    while (!existsSync(stopped) && Date.now() < closed) await delay(20);
    assert.ok(existsSync(stopped), 'owned child kept running after its caller exited');
    assert.equal(readFileSync(stopped, 'utf8'), readFileSync(pidFile, 'utf8'));
  } finally {
    caller.kill('SIGTERM');
    rmSync(temp, { recursive: true, force: true });
  }
});
