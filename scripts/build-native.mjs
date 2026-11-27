import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { coldSource, simdSource } from './native-simd-source.mjs';

const { values } = parseArgs({ options: {
  'low-only': { type: 'boolean' }, 'scalar-scans': { type: 'boolean' }, pgo: { type: 'boolean' }, output: { type: 'string' },
} });

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, values.output ?? 'build/tmt.node');
const outputDirectory = dirname(output);
const macOS = process.platform === 'darwin';
const windows = process.platform === 'win32';

function windowsNodeSdk() {
  const { TMT_NODE_INCLUDE, TMT_NODE_LIB, npm_config_node_gyp } = process.env;
  if (TMT_NODE_INCLUDE || TMT_NODE_LIB) return [TMT_NODE_INCLUDE, TMT_NODE_LIB];
  if (!npm_config_node_gyp) {
    throw new Error('Run npm run build:native or set TMT_NODE_INCLUDE and TMT_NODE_LIB to the Windows Node SDK paths');
  }
  const cache = resolve(root, 'build/node-sdk');
  const fetched = spawnSync(process.execPath, [npm_config_node_gyp, 'install', '--ensure', '--devdir', cache],
    { cwd: root, stdio: 'inherit', timeout: 120_000 });
  if (fetched.error) throw fetched.error;
  if (fetched.status !== 0) throw new Error('Could not install the Windows Node SDK');
  const version = resolve(cache, process.versions.node);
  return [resolve(version, 'include/node'), resolve(version, 'x64/node.lib')];
}

if (windows && process.arch !== 'x64') throw new Error('The native Windows build requires x64 Node.js');
const candidates = [
  process.env.TMT_NODE_INCLUDE,
  resolve(dirname(process.execPath), '../include/node'),
  '/opt/homebrew/include/node',
  '/usr/local/include/node',
  '/usr/include/node',
].filter(Boolean);
const [headers, nodeLibrary] = windows ? windowsNodeSdk() : [candidates.find(path => existsSync(resolve(path, 'node_api.h')))];
if (!headers || !existsSync(resolve(headers, 'node_api.h'))) {
  throw new Error('Set TMT_NODE_INCLUDE to the directory containing node_api.h');
}
if (windows && (!nodeLibrary || !existsSync(nodeLibrary))) {
  throw new Error('Set TMT_NODE_LIB to the path of the x64 Node import library (node.lib)');
}
mkdirSync(outputDirectory, { recursive: true });

function nativeOptimizationFlags(compiler) {
  if (!macOS && process.platform !== 'linux') return [];
  const flags = ['-fvisibility=hidden'];
  const scratch = mkdtempSync(resolve(outputDirectory, '.lto-'));
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

const compiler = process.env.CC ?? (macOS ? '/usr/bin/clang' : windows ? 'clang.exe' : 'cc');

const args = [
  '-std=c11', '-O3', '-Wall', '-Wextra', '-Werror', '-Wno-parentheses',
  ...(windows ? [] : ['-fPIC']),
  ...nativeOptimizationFlags(compiler),
  // Compiler-recorded source paths would otherwise carry the build directory into the published binary.
  `-ffile-prefix-map=${outputDirectory}=build`, `-ffile-prefix-map=${root}=./`,
  ...(macOS ? [
    `-mmacosx-version-min=${process.env.MACOSX_DEPLOYMENT_TARGET ?? '11.0'}`,
    '-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip',
    '-Wl,-exported_symbol,_napi_register_module_v1', '-Wl,-exported_symbol,_node_api_module_get_api_version_v1',
  ] : windows ? [
    '--target=x86_64-pc-windows-msvc', '-shared', '-Wl,/Brepro', resolve(nodeLibrary),
  ] : ['-shared', '-Wl,--exclude-libs,ALL']),
  ...(values['low-only'] ? ['-DTMT_LOW_ONLY'] : []),
  '-I', resolve(headers), '-I', 'native/generated', '-I', 'native/runtime',
  'native/addon.c', 'native/parser.c', 'native/positions.c',
];

function compile(input, target, flags = [], stdio = 'inherit') {
  return spawnSync(compiler, [...args, input, ...flags, '-o', target], { cwd: root, stdio });
}

function profileTool() {
  if (process.env.TMT_LLVM_PROFDATA) return process.env.TMT_LLVM_PROFDATA;
  if (macOS) {
    const found = spawnSync('/usr/bin/xcrun', ['--find', 'llvm-profdata'], { encoding: 'utf8', timeout: 10_000 });
    if (found.status === 0) return found.stdout.trim();
  }
  return 'llvm-profdata';
}

function buildProfiled(input) {
  const tool = profileTool();
  const probe = spawnSync(tool, ['--version'], { stdio: 'ignore', timeout: 10_000 });
  if (probe.status !== 0) return false;
  const scratch = mkdtempSync(resolve(outputDirectory, '.profile-'));
  try {
    const instrumented = resolve(scratch, 'instrumented.node');
    if (compile(input, instrumented, ['-fprofile-instr-generate'], 'pipe').status !== 0) return false;
    const raw = resolve(scratch, 'training.profraw');
    const trained = spawnSync(process.execPath, [resolve(root, 'scripts/train-native.mjs'), instrumented], {
      cwd: root, env: { ...process.env, LLVM_PROFILE_FILE: raw }, stdio: 'inherit', timeout: 15_000,
    });
    if (trained.status !== 0 || !existsSync(raw)) return false;
    const profile = resolve(scratch, 'training.profdata');
    const merged = spawnSync(tool, ['merge', '-o', profile, raw], { cwd: root, stdio: 'inherit', timeout: 15_000 });
    if (merged.status !== 0) return false;
    const optimized = resolve(scratch, 'optimized.node');
    if (compile(input, optimized, [`-fprofile-instr-use=${profile}`]).status !== 0) return false;
    renameSync(optimized, output);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const scratch = mkdtempSync(resolve(outputDirectory, '.native-'));
try {
  const input = simdSource(root, coldSource(root, 'native/generated/Custard.c', scratch), scratch, values['scalar-scans']);
  if (values.pgo && buildProfiled(input)) {
    console.log('Built native extractor with fixture PGO');
  } else {
    if (values.pgo) console.warn('Fixture PGO unavailable. Building the regular native extractor.');
    const pending = resolve(scratch, 'tmt.node');
    const built = compile(input, pending);
    if (built.error) throw built.error;
    if (built.status === 0) renameSync(pending, output);
    else process.exitCode = built.status ?? 1;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
