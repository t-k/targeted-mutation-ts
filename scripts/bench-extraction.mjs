import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as current from '../src/extract.mjs';

const { positionals: [baselineFile, corpusPath], values } = parseArgs({ allowPositionals: true,
  options: { prefix: { type: 'string', default: '' }, 'source-only': { type: 'boolean' }, 'token-subset': { type: 'boolean' } } });
if (!baselineFile || !corpusPath) throw new Error('Usage: bench-extraction [--prefix PATH] [--source-only] [--token-subset] BASELINE_MODULE GIT_CHECKOUT');
const baseline = await import(pathToFileURL(resolve(baselineFile)));
const root = resolve(corpusPath);
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const revision = git('rev-parse', 'HEAD').trim();
const files = git('ls-files', '-z').split('\0')
  .filter(file => file.startsWith(values.prefix) && ['.ts', '.tsx'].includes(extname(file)) &&
    !file.endsWith('.d.ts') && (!values['source-only'] || !/(?:^|\/)__tests[^/]*\/|\.(?:test|spec)\.tsx?$/.test(file)) &&
    existsSync(resolve(root, file)))
  .map(file => ({ file, source: readFileSync(resolve(root, file)) }));
const resultShape = ({ path, candidates, diagnostics }) => ({ diagnostic: path === 'diagnostic', candidates, diagnostics });
const tokenSubset = values['token-subset'] ? files.filter(({ file, source }) => current.extract(source, { file }).fallback === 'tokens') : [];
const inputs = [
  { name: 'repository', revision, files },
  ...(tokenSubset.length ? [{ name: 'validated token files', revision, files: tokenSubset, turns: 100 }] : []),
  { name: 'L1 TSX', files: Array.from({ length: 120 }, (_, index) => ({
    file: 'logic.tsx',
    source: Buffer.from('/* ' + '🐈 > < literal '.repeat(64 + index) + ' */\n' +
      'export const Badge = (n: number) => <Tag title="🐈 > 2" hi={n /* < */ >= 3} />'),
  })) },
];

const repetitions = 9;
const reports = [];
for (const input of inputs) {
  const turns = input.turns ?? 7;
  const bytes = input.files.reduce((size, entry) => size + entry.source.length, 0);
  let fast = 0;
  let fastCandidates = 0;
  let tokenFiles = 0;
  let tokenCandidates = 0;
  for (const { file, source } of input.files) {
    const original = baseline.extract(source, { file, requireNative: true });
    const optimized = current.extract(source, { file, requireNative: true });
    assert.deepEqual(resultShape(original), resultShape(optimized), file);
    if (optimized.path === 'fast') {
      fast++;
      fastCandidates += optimized.candidates.length;
    }
    if (optimized.fallback === 'tokens') {
      tokenFiles++;
      tokenCandidates += optimized.candidates.length;
    }
  }

  function batch(implementation) {
    let candidates = 0;
    for (let repeat = 0; repeat < turns; repeat++) {
      for (const { file, source } of input.files) candidates += implementation.extract(source, { file }).candidates.length;
    }
    return candidates;
  }

  batch(baseline);
  batch(current);
  const summaries = [[], []];
  for (let round = 0; round < repetitions; round++) {
    for (const index of round % 2 === 0 ? [0, 1] : [1, 0]) {
      globalThis.gc?.();
      const start = performance.now();
      batch([baseline, current][index]);
      summaries[index].push((performance.now() - start) / turns);
    }
  }

  const stats = samples => {
    const sorted = samples.toSorted((a, b) => a - b);
    return { medianMs: sorted[4], p25Ms: sorted[2], p75Ms: sorted[6] };
  };
  reports.push({
    workload: input.name, revision: input.revision, files: input.files.length, bytes, turnsPerRepetition: turns, fastFiles: fast,
    fastCandidates, tokenFiles, tokenCandidates,
    baseline: stats(summaries[0]), optimized: stats(summaries[1]), samplesMs: summaries,
  });
}
console.log(JSON.stringify({
  node: process.version, os: [platform(), release(), arch()].join(' '), cpu: cpus()[0]?.model,
  repetitions, collectBetweenSamples: typeof globalThis.gc === 'function', temperature: 'warm',
  scope: { prefix: values.prefix, sourceOnly: !!values['source-only'] }, reports,
}, null, 2));
