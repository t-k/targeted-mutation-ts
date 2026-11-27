import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { coldSource, simdSource } from './native-simd-source.mjs';

const { values } = parseArgs({ options: {
  'scalar-scans': { type: 'boolean' },
  'audit-v8': { type: 'boolean' },
  'pgo': { type: 'boolean' },
} });
const usePgo = values.pgo || process.env.TMT_PGO === '1';

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
const shared = macOS ? ['-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip'] : ['-shared'];
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(resolve(output, '.compiler-'));
try {
  const cpuFlags = process.env.TMT_NATIVE_CPU === '1' && macOS && process.arch === 'arm64' ? ['-mcpu=native'] : [];
  const validator = resolve(scratch, 'validate-js.o');
  const validatorSources = ['-std=c++20', '-O3', ...cpuFlags, '-fPIC', '-fvisibility=hidden',
    ...auditFlags, '-isystem', headers, 'native/compiler/validate-js.cc'];
  const checked = spawnSync(cpp, [...validatorSources, '-c', '-o', validator], { cwd: root, encoding: 'utf8' });
  if (values['audit-v8'] && checked.status !== 0) throw new Error(checked.stderr || checked.error?.message);
  const moduleFlags = checked.status === 0 ? ['-DTMT_V8_VALIDATOR', ...auditFlags, validator] : [];
  const binaries = ['compiler.node', 'compiler-module.node'];
  const javascript = 'compiler-js.node';
  if (checked.status === 0) {
    const built = spawnSync(cpp, [...validatorSources, ...shared, '-DTMT_JAVASCRIPT_ADDON',
      '-o', resolve(scratch, javascript)], { cwd: root, encoding: 'utf8' });
    if (built.status !== 0) throw new Error(built.stderr || built.error?.message);
    binaries.push(javascript);
  }
  // The extracted parser is hundreds of small functions that pass their state by value. The default
  // inlining limits leave most of them as calls, which costs 20 to 30 percent of a pass.
  const clang = /clang/i.test(spawnSync(compiler, ['--version'], { encoding: 'utf8' }).stdout ?? '');
  const inlineThreshold = process.env.TMT_INLINE_THRESHOLD ?? '2000';
  const inlining = clang ? (macOS ? (inlineThreshold === 'default' ? [] : ['-mllvm', `-inline-threshold=${inlineThreshold}`, `-Wl,-mllvm,-inline-threshold=${inlineThreshold}`]) : []) :
    ['--param=inline-unit-growth=1000', '--param=max-inline-insns-single=6000', '--param=max-inline-insns-auto=600',
      '--param=large-function-growth=2000', '--param=large-unit-insns=400000', '--param=large-function-insns=20000'];
  const common = ['-std=c11', '-O3', ...cpuFlags, ...inlining, '-fPIC', '-fvisibility=hidden', '-Wall', '-Wextra', '-Werror',
    '-Wno-parentheses', '-I', headers, '-I', 'native/runtime',
    ...(values['scalar-scans'] ? ['-DTMT_SCALAR_SCANS'] : []),
    ...shared,
    'native/compiler/addon.c', 'native/compiler/lowering.c'];
  for (const [name, flags, source] of [
    ['compiler.node', ['-DTMT_DIRECT'], 'native/compiler/generated/direct'],
    ['compiler-module.node', moduleFlags, 'native/compiler/generated'],
  ]) {
    const input = simdSource(root, coldSource(root, source + '/Custard.c', scratch), scratch, values['scalar-scans']);
    const pgoArgs = [];
    if (usePgo && clang && name === 'compiler-module.node') {
      const profRaw = resolve(scratch, 'compiler.profraw');
      const profData = resolve(scratch, 'compiler.profdata');
      const instOut = resolve(scratch, name);
      const instArgs = [...common, ...flags, '-fprofile-instr-generate=' + profRaw, '-I', source, input, '-o', instOut];
      const instBuilt = spawnSync(compiler, instArgs, { cwd: root, encoding: 'utf8' });
      if (instBuilt.status === 0) {
        // Train on real-world TS/MTS/TSX benchmarks if present, otherwise on built-in synthetic samples.
        const trainCode = `
          const fs = require('fs');
          const addon = { exports: {} };
          process.dlopen(addon, ${JSON.stringify(instOut)});
          const emit = addon.exports.emitTypeScript;
          for (const f of [
            'build/compiler-upstream/official-oxc-transform-renderer.ts.json',
            'build/compiler-upstream/official-oxc-transform-table.tsx.json',
            'build/compiler-upstream/official-oxc-transform-UserSettings.tsx.json',
            'build/compiler-upstream/official-swc-next-App.tsx.json',
          ]) {
            if (!fs.existsSync(f)) continue;
            const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
            for (const r of rows) {
              const b = Buffer.from(r.source, 'base64');
              const fl = /\\.tsx$/i.test(r.file) ? 1 : 0;
              for (let i = 0; i < 10; i++) emit(b, fl);
            }
          }
          if (fs.existsSync('build/fable/corpora/as-mts.json')) {
            const rows = JSON.parse(fs.readFileSync('build/fable/corpora/as-mts.json', 'utf8'));
            for (let i = 0; i < rows.length; i++) {
              const b = Buffer.from(rows[i].source, 'base64');
              if (typeof emit(b, 2) === 'string') {
                for (let k = 0; k < 4; k++) emit(b, 2);
              }
            }
          }
        `;
        const trained = spawnSync(process.execPath, ['-e', trainCode], { cwd: root, encoding: 'utf8' });
        const profTool = macOS ? 'xcrun' : 'llvm-profdata';
        const profCmd = macOS ? ['llvm-profdata', 'merge', '-output=' + profData, profRaw] : ['merge', '-output=' + profData, profRaw];
        if (trained.status === 0 && existsSync(profRaw) && spawnSync(profTool, profCmd, { cwd: root, encoding: 'utf8' }).status === 0) {
          pgoArgs.push('-fprofile-instr-use=' + profData, '-Wno-profile-instr-out-of-date', '-Wno-profile-instr-unprofiled');
        }
      }
    }
    const args = [...common, ...flags, ...pgoArgs, '-I', source, input, '-o', resolve(scratch, name)];
    const built = spawnSync(compiler, ['-flto', ...args], { cwd: root, encoding: 'utf8' });
    if (built.error) throw built.error;
    const result = built.status === 0 ? built : spawnSync(compiler, args, { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || built.stderr);
  }
  for (const name of binaries) renameSync(resolve(scratch, name), resolve(output, name));
  if (checked.status !== 0) rmSync(resolve(output, javascript), { force: true });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
