import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'low-only': { type: 'boolean' }, 'scalar-scans': { type: 'boolean' }, pgo: { type: 'boolean' }, output: { type: 'string' },
} });

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, values.output ?? 'build/tmt.node');
const outputDirectory = dirname(output);
const candidates = [
  process.env.TMT_NODE_INCLUDE,
  resolve(dirname(process.execPath), '../include/node'),
  '/opt/homebrew/include/node',
  '/usr/local/include/node',
  '/usr/include/node',
].filter(Boolean);
const headers = candidates.find(path => existsSync(resolve(path, 'node_api.h')));
if (!headers) throw new Error('Set TMT_NODE_INCLUDE to the directory containing node_api.h');
mkdirSync(outputDirectory, { recursive: true });

const macOS = process.platform === 'darwin';

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

const compiler = process.env.CC ?? (macOS ? '/usr/bin/clang' : 'cc');

function parserSource(scratch) {
  const original = 'native/generated/Custard.c';
  if (values['scalar-scans'] || !['arm64', 'x64'].includes(process.arch) || (!macOS && process.platform !== 'linux') ||
      !existsSync(resolve(root, original))) return original;
  const loops = [
    ['line_comment', 'cf6e07f63ffcc5d57ae9e50d9b68929ce6b9abee12c1d8ce0c30df4174ce353f',
      'bool value = TmtPulseParser_line_break(input, at);', '13, 10'],
    ['block_comment', 'e6770b3162644da48fd1f8ff8e56d3c6b33e7e034d017d507a435ef3f8800e96',
      'bool value = TmtPulseParser_same(input, at, 42U);', '42, 42'],
    ['string_end', '5c83da47f362169e93a6540a250fc7d3453d5af5bd0624696c117a9bae6508ad',
      'uint8_t value = TmtPulseMemory_peek(input, at);', 'delimiter, 92'],
  ];
  let source = readFileSync(resolve(root, original), 'utf8');
  const include = '#include "Custard.h"\n';
  const simd = '#if defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))\n';
  if (!source.includes(include)) return original;
  for (const [loop, expected, scalar, sentinels] of loops) {
    const start = source.indexOf(`\nTmtPulseParser_${loop}(`);
    const end = source.indexOf('\n}\n', start);
    if (start < 0 || end < 0) return original;
    const body = source.slice(start, end);
    // A changed scalar transition can invalidate skipping, even with the same scalar anchor.
    if (createHash('sha256').update(body).digest('hex') !== expected) return original;
    const anchor = `    else\n    {\n      ${scalar}`;
    const at = body.indexOf(anchor);
    if (at < 0) return original;
    const position = start + at + anchor.length - scalar.length - 6;
    const fast = `${simd}      if (at < input.size && fuel >= 16U && input.size - at >= 16U) {
        const unsigned skipped = tmt_simd_scan(input.source + at, ${sentinels});
        if (skipped != 0U) { at += skipped; fuel -= skipped; continue; }
      }
#endif
`;
    source = source.slice(0, position) + fast + source.slice(position);
  }
  const output = resolve(scratch, 'Custard.simd.c');
  const header = simd + '#include "tmt_simd_scan.h"\n#endif\n';
  writeFileSync(output, source.replace(include, include + header));
  return output;
}

const args = [
  '-std=c11', '-O3', '-Wall', '-Wextra', '-Werror', '-Wno-parentheses', '-fPIC',
  ...nativeOptimizationFlags(compiler),
  ...(macOS ? [
    '-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip',
    '-Wl,-exported_symbol,_napi_register_module_v1', '-Wl,-exported_symbol,_node_api_module_get_api_version_v1',
  ] : ['-shared', '-Wl,--exclude-libs,ALL']),
  ...(values['low-only'] ? ['-DTMT_LOW_ONLY'] : []),
  '-I', headers, '-I', 'native/generated', '-I', 'native/runtime',
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
  const input = parserSource(scratch);
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
