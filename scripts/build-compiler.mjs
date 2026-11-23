import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { simdSource } from './native-simd-source.mjs';

const { values } = parseArgs({ options: {
  'scalar-scans': { type: 'boolean' },
  'audit-v8': { type: 'boolean' },
} });

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, values['audit-v8'] ? 'build/compiler-v8-audit' : 'build');
const auditFlags = values['audit-v8'] ? ['-DTMT_AUDIT_V8'] : [];
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
const cpp = process.env.CXX ?? (macOS ? '/usr/bin/clang++' : 'c++');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(resolve(output, '.compiler-'));
try {
  const validator = resolve(scratch, 'validate-js.o');
  const checked = spawnSync(cpp, ['-std=c++20', '-O3', '-fPIC', '-fvisibility=hidden',
    ...auditFlags, '-isystem', headers, '-c', 'native/compiler/validate-js.cc', '-o', validator], { cwd: root, encoding: 'utf8' });
  if (values['audit-v8'] && checked.status !== 0) throw new Error(checked.stderr || checked.error?.message);
  const moduleFlags = checked.status === 0 ? ['-DTMT_V8_VALIDATOR', ...auditFlags, validator] : [];
  const common = ['-std=c11', '-O3', '-fPIC', '-fvisibility=hidden', '-Wall', '-Wextra', '-Werror',
    '-Wno-parentheses', '-I', headers, '-I', 'native/runtime',
    ...(values['scalar-scans'] ? ['-DTMT_SCALAR_SCANS'] : []),
    ...(macOS ? ['-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip'] : ['-shared']),
    'native/compiler/addon.c', 'native/compiler/lowering.c'];
  for (const [name, flags, source] of [
    ['compiler.node', ['-DTMT_DIRECT'], 'native/compiler/generated/direct'],
    ['compiler-module.node', moduleFlags, 'native/compiler/generated'],
  ]) {
    const input = simdSource(root, source + '/Custard.c', scratch, values['scalar-scans']);
    const args = [...common, ...flags, '-I', source, input, '-o', resolve(scratch, name)];
    const built = spawnSync(compiler, ['-flto', ...args], { cwd: root, encoding: 'utf8' });
    if (built.error) throw built.error;
    const result = built.status === 0 ? built : spawnSync(compiler, args, { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || built.stderr);
  }
  for (const name of ['compiler.node', 'compiler-module.node']) renameSync(resolve(scratch, name), resolve(output, name));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
