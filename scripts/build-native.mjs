import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'low-only': { type: 'boolean' } } });

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

function syntaxLibraries() {
  const syntaxBuild = resolve(root, 'build/syntax');
  const rust = spawnSync(process.env.TMT_CARGO ?? 'cargo', [
    'rustc', '--release', '--locked', '--manifest-path', 'native/syntax/Cargo.toml',
    '--target-dir', syntaxBuild, '--', '--print=native-static-libs',
  ], { cwd: root, encoding: 'utf8' });
  if (rust.error) throw rust.error;
  if (rust.status !== 0) throw new Error(rust.stderr || rust.stdout);
  const nativeLibs = rust.stderr.match(/native-static-libs:\s*([^\r\n]+)/)?.[1];
  if (!nativeLibs) throw new Error('Cargo did not report the native link libraries');
  return [resolve(syntaxBuild, 'release/libtmt_syntax.a'), ...nativeLibs.trim().split(/\s+/)];
}

const macOS = process.platform === 'darwin';

function nativeOptimizationFlags(compiler) {
  if (!macOS && process.platform !== 'linux') return [];
  const flags = ['-fvisibility=hidden'];
  const scratch = mkdtempSync(resolve(root, 'build/.lto-'));
  try {
    const probe = spawnSync(compiler, [...flags, '-flto', '-fPIC', macOS ? '-bundle' : '-shared', '-x', 'c',
      '-o', resolve(scratch, 'probe.so'), '-'], {
      input: 'int tmt_lto_probe(void) { return 0; }',
      encoding: 'utf8',
    });
    if (probe.error) throw probe.error;
    if (probe.status === 0) flags.push('-flto');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return flags;
}

const compiler = process.env.CC ?? (macOS ? '/usr/bin/clang' : 'cc');
const withOxc = !values['low-only'];

const args = [
  '-std=c11', '-O3', '-Wall', '-Wextra', '-Werror', '-Wno-parentheses', '-fPIC',
  ...nativeOptimizationFlags(compiler),
  ...(macOS ? [
    '-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip',
    '-Wl,-exported_symbol,_napi_register_module_v1', '-Wl,-exported_symbol,_node_api_module_get_api_version_v1',
  ] : ['-shared', '-Wl,--exclude-libs,ALL']),
  ...(withOxc ? ['-DTMT_WITH_OXC'] : []),
  '-I', headers, '-I', 'native/generated', '-I', 'native/runtime',
  'native/addon.c', 'native/parser.c', 'native/positions.c',
  'native/generated/TmtGrammar.c', 'native/generated/TmtScan.c', 'native/generated/TmtParser.c',
  ...(withOxc ? syntaxLibraries() : []),
  '-o', output,
];
const built = spawnSync(compiler, args, { cwd: root, stdio: 'inherit' });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
