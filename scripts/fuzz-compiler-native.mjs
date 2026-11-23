// Coverage-guided fuzzing of the handwritten emitter under AddressSanitizer and
// UndefinedBehaviorSanitizer. It needs a clang that ships libFuzzer (set TMT_FUZZ_CLANG, for example
// to Homebrew's llvm). Corpus files are read as data and become seeds. Nothing they contain is executed.
//
//   node scripts/fuzz-compiler-native.mjs --seconds 300 [--jobs 4] corpus.json...
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fragments, statements } from './fuzz-compiler-certification.mjs';
import { simdSource } from './native-simd-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  seconds: { type: 'string', default: '60' }, jobs: { type: 'string', default: '1' },
  'max-bytes': { type: 'string', default: '8192' }, artifacts: { type: 'string', default: 'build/compiler-fuzz' },
  'scalar-scans': { type: 'boolean' },
} });
assert.ok(positionals.length, 'Pass one or more JSON corpora');
const clang = [process.env.TMT_FUZZ_CLANG, '/opt/homebrew/opt/llvm/bin/clang', '/opt/homebrew/opt/llvm@22/bin/clang', 'clang']
  .find(path => path && (path === 'clang' || existsSync(path)));
const artifacts = resolve(root, values.artifacts);
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(join(artifacts, '.run-'));
try {
  const sdk = process.platform === 'darwin' ? spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).stdout.trim() : '';
  const parser = simdSource(root, 'native/compiler/generated/Custard.c', scratch, values['scalar-scans']);
  const target = join(scratch, 'fuzz-compiler');
  const built = spawnSync(clang, [...(sdk ? ['-isysroot', sdk] : []), '-std=c11', '-O1', '-g', '-fno-omit-frame-pointer',
    '-fsanitize=fuzzer,address,undefined', '-fno-sanitize-recover=undefined', '-DTMT_V8_VALIDATOR',
    ...(values['scalar-scans'] ? ['-DTMT_SCALAR_SCANS'] : []),
    '-I', 'native/compiler/generated', '-I', 'native/compiler', '-I', 'native/runtime',
    'native/compiler/fuzz.c', 'native/compiler/lowering.c', parser, '-o', target], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr || built.error?.message);

  const seeds = join(scratch, 'seeds');
  mkdirSync(seeds);
  const limit = Number(values['max-bytes']);
  let count = 0;
  for (const path of positionals) {
    const input = JSON.parse(readFileSync(path));
    for (const test of input.rows ?? input) {
      const bytes = Buffer.from(test.source, 'base64');
      if (!/\.(?:tsx?|jsx?|mjs)$/.test(test.file) || bytes.length > limit) continue;
      // The first byte selects the entry options. JSX sources start on the JSX routes.
      const flags = /sx$/.test(test.file) ? 0x31 : 0x29;
      writeFileSync(join(seeds, String(count++)), Buffer.concat([Buffer.from([flags]), bytes]));
    }
  }
  const dictionary = join(scratch, 'typescript.dict');
  const entry = text => '"' + [...Buffer.from(text)].map(byte => '\\x' + byte.toString(16).padStart(2, '0')).join('') + '"';
  writeFileSync(dictionary, [...new Set([...fragments, ...statements])].filter(text => text.length <= 64).map(entry).join('\n') + '\n');

  const run = spawnSync(target, [seeds, '-max_total_time=' + Number(values.seconds), '-max_len=65537', '-timeout=20',
    '-rss_limit_mb=4096', '-dict=' + dictionary, '-artifact_prefix=' + artifacts + '/', '-print_final_stats=1',
    ...(Number(values.jobs) > 1 ? ['-fork=' + Number(values.jobs), '-ignore_crashes=0'] : [])],
  { cwd: scratch, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } });
  const stats = Object.fromEntries([...run.stderr.matchAll(/^stat::(\w+):\s+(\d+)/gm)].map(([, key, value]) => [key, Number(value)]));
  const coverage = [...run.stderr.matchAll(/cov: (\d+)/g)].at(-1)?.[1];
  const findings = readdirSync(artifacts).filter(name => /^(?:crash|timeout|oom|leak)-/.test(name));
  console.log(JSON.stringify({ clang, seeds: count, seconds: Number(values.seconds), status: run.status,
    executions: stats.number_of_executed_units, edges: coverage ? Number(coverage) : undefined, findings }));
  if (run.status !== 0 || findings.length) {
    console.error(run.stderr.split('\n').filter(line => /ERROR|SUMMARY|runtime error|#[0-9] /.test(line)).slice(0, 24).join('\n'));
    process.exitCode = 1;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
