import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const repetitions = 9;

async function firstExtraction(entry, root) {
  const inputs = git(root, ['ls-files', '-z']).split('\0').filter(file =>
    ['.ts', '.tsx'].includes(extname(file)) && !file.endsWith('.d.ts') && existsSync(resolve(root, file)),
  ).map(file => ({ file, source: readFileSync(resolve(root, file)) }));
  const entryURL = pathToFileURL(resolve(entry));
  const compiler = new URL('typescript-compiler.mjs', entryURL);
  const start = performance.now();
  if (existsSync(compiler)) {
    const { enablePreparedTypeScript } = await import(compiler.href);
    enablePreparedTypeScript?.();
  }
  const { extract } = await import(entryURL.href);
  const results = inputs.map(({ file, source }) => extract(source, { file, requireNative: true }));
  const elapsedMs = performance.now() - start;
  const shapes = results.map(({ path, candidates }) => ({ diagnostic: path === 'diagnostic', candidates }));
  return {
    elapsedMs, files: inputs.length, candidates: shapes.reduce((sum, result) => sum + result.candidates.length, 0),
    diagnostics: shapes.filter(result => result.diagnostic).length,
    fingerprint: createHash('sha256').update(JSON.stringify(shapes)).digest('hex'),
  };
}

const [first, ...arguments_] = process.argv.slice(2);
if (first === '--worker') {
  console.log(JSON.stringify(await firstExtraction(...arguments_)));
} else {
  const { positionals: [baseline, ...checkouts], values } = parseArgs({
    allowPositionals: true, options: { current: { type: 'string' } },
  });
  if (!baseline || !checkouts.length) throw new Error('Usage: bench-first-extraction [--current MODULE] BASELINE_MODULE GIT_CHECKOUT ...');
  const implementations = [resolve(baseline), resolve(values.current ?? fileURLToPath(new URL('../src/extract.mjs', import.meta.url)))];
  const files = [];
  for (const path of checkouts) {
    const root = resolve(path);
    const samplesMs = [[], []];
    let expected;
    for (let round = 0; round < repetitions; round++) {
      for (const index of [round % 2, 1 - (round % 2)]) {
        const output = execFileSync(process.execPath, ['--max-old-space-size=1024', import.meta.filename,
          '--worker', implementations[index], root], { encoding: 'utf8', timeout: 60_000 });
        const { elapsedMs, ...actual } = JSON.parse(output);
        expected ??= actual;
        assert.deepEqual(actual, expected, path);
        samplesMs[index].push(elapsedMs);
      }
    }
    files.push({ checkout: path, revision: git(root, ['rev-parse', 'HEAD']).trim(), ...expected,
      medianMs: samplesMs.map(samples => samples.toSorted((a, b) => a - b)[Math.floor(repetitions / 2)]), samplesMs });
  }
  console.log(JSON.stringify({ node: process.version, os: [platform(), release(), arch()].join(' '),
    cpu: cpus()[0]?.model, repetitions, files }, null, 2));
}
