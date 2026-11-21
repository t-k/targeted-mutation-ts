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

const syntaxBuild = resolve(root, 'build/syntax');
const rust = spawnSync(process.env.TMT_CARGO ?? 'cargo', [
  'rustc', '--release', '--locked', '--manifest-path', 'native/syntax/Cargo.toml',
  '--target-dir', syntaxBuild, '--', '--print=native-static-libs',
], { cwd: root, encoding: 'utf8' });
if (rust.error) throw rust.error;
if (rust.status !== 0) throw new Error(rust.stderr || rust.stdout);
const nativeLibs = rust.stderr.match(/native-static-libs:\s*([^\r\n]+)/)?.[1];
if (!nativeLibs) throw new Error('Cargo did not report the native link libraries');
const archive = resolve(syntaxBuild, 'release/libtmt_syntax.a');

const args = [
  '-std=c11', '-O3', '-Wall', '-Wextra', '-Werror', '-Wno-parentheses', '-fPIC',
  ...(process.platform === 'darwin' ? [
    '-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip',
    '-Wl,-exported_symbol,_napi_register_module_v1', '-Wl,-exported_symbol,_node_api_module_get_api_version_v1',
  ] : ['-shared', '-Wl,--exclude-libs,ALL']),
  '-I', headers, '-I', 'native/generated', '-I', 'native/runtime',
  'native/addon.c', 'native/parser.c', 'native/positions.c',
  'native/generated/TmtGrammar.c', 'native/generated/TmtScan.c', 'native/generated/TmtParser.c',
  archive, ...nativeLibs.trim().split(/\s+/),
  '-o', output,
];
const compiler = process.env.CC ?? (process.platform === 'darwin' ? '/usr/bin/clang' : 'cc');
const built = spawnSync(compiler, args, { cwd: root, stdio: 'inherit' });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
