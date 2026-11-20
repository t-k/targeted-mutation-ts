import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'build/tmt.node');
const candidates = [
  process.env.TMT_NODE_INCLUDE,
  resolve(dirname(process.execPath), '../include/node'),
  '/opt/homebrew/include/node',
  '/usr/local/include/node',
  '/usr/include/node',
].filter(Boolean);
const headers = candidates.find(path => existsSync(resolve(path, 'node_api.h')));
if (!headers) throw new Error('Set TMT_NODE_INCLUDE to the directory containing node_api.h');
mkdirSync(dirname(output), { recursive: true });

const args = [
  '-std=c11', '-O3', '-Wall', '-Wextra', '-Werror', '-Wno-parentheses', '-fPIC',
  ...(process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared']),
  '-I', headers, '-I', 'native/generated', '-I', 'native/runtime',
  'native/addon.c', 'native/parser.c', 'native/generated/TmtGrammar.c', 'native/generated/TmtScan.c',
  '-o', output,
];
const built = spawnSync(process.env.CC ?? 'cc', args, { cwd: root, stdio: 'inherit' });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
