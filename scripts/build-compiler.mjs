import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'build/compiler.node');
const headers = [
  process.env.TMT_NODE_INCLUDE,
  resolve(dirname(process.execPath), '../include/node'),
  '/opt/homebrew/include/node',
  '/usr/local/include/node',
  '/usr/include/node',
].find(path => path && existsSync(resolve(path, 'node_api.h')));
if (!headers) throw new Error('Set TMT_NODE_INCLUDE to the directory containing node_api.h');

const macOS = process.platform === 'darwin';
const compiler = process.env.CC ?? (macOS ? '/usr/bin/clang' : 'cc');
mkdirSync(dirname(output), { recursive: true });
const scratch = mkdtempSync(resolve(dirname(output), '.compiler-'));
try {
  const pending = resolve(scratch, 'compiler.node');
  const common = ['-std=c11', '-O3', '-fPIC', '-fvisibility=hidden', '-Wall', '-Wextra', '-Werror',
    '-Wno-parentheses', '-I', headers, '-I', 'native/runtime',
    ...(macOS ? ['-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip'] : ['-shared']),
    'native/compiler/addon.c', 'native/compiler/generated/Custard.c', '-o', pending];
  const built = spawnSync(compiler, ['-flto', ...common], { cwd: root, encoding: 'utf8' });
  if (built.error) throw built.error;
  const result = built.status === 0 ? built : spawnSync(compiler, common, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || built.stderr);
  renameSync(pending, output);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
