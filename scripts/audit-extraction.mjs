import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { extract, extractYuku } from '../src/extract.mjs';

const projects = process.argv.slice(2);
if (!projects.length) throw new Error('Usage: audit-extraction GIT_CHECKOUT [GIT_CHECKOUT...]');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

const reports = projects.map(project => {
  const root = resolve(project);
  const revision = git(root, ['rev-parse', 'HEAD']).trim();
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(file => ['.ts', '.tsx'].includes(extname(file)) && !file.endsWith('.d.ts') && existsSync(resolve(root, file)));
  const files = paths.map(file => ({ file, source: readFileSync(resolve(root, file)) }));
  const report = { project: basename(root), revision, files: files.length, bytes: 0, tsxFiles: 0, fastFiles: 0, fastBytes: 0,
    candidates: 0, fastCandidates: 0, diagnostics: 0, fallbackReasons: {}, candidateBytes: 0, maxDepth: 0 };
  for (const { file, source } of files) {
    const options = { file, requireNative: true };
    const result = extract(source, options);
    const reference = extractYuku(source, options);
    assert.deepEqual(result.candidates, reference.candidates, `${root}/${file}`);
    assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', `${root}/${file}`);
    report.bytes += source.length;
    if (file.endsWith('.tsx')) report.tsxFiles++;
    report.candidates += result.candidates.length;
    report.candidateBytes += result.metrics?.candidateBytes ?? 0;
    if (result.path === 'fast') {
      report.fastFiles++;
      report.fastBytes += source.length;
      report.fastCandidates += result.candidates.length;
      report.maxDepth = Math.max(report.maxDepth, result.metrics.maxDepth);
    } else {
      report.fallbackReasons[result.reason] = (report.fallbackReasons[result.reason] ?? 0) + 1;
    }
    if (result.path === 'diagnostic') report.diagnostics++;
  }
  return report;
});

console.log(JSON.stringify({
  runtime: process.version, system: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model,
  reference: 'yuku-parser 0.19.0', reports,
}, null, 2));
