import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extract, extractFallback } from '../src/extract.mjs';

const { positionals: projects, values } = parseArgs({ allowPositionals: true,
  options: { prefix: { type: 'string', default: '' }, 'source-only': { type: 'boolean' }, logical: { type: 'boolean' } } });
if (!projects.length) throw new Error('Usage: audit-extraction [--prefix PATH] [--source-only] [--logical] GIT_CHECKOUT [GIT_CHECKOUT...]');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

const reports = projects.map(project => {
  const root = resolve(project);
  const revision = git(root, ['rev-parse', 'HEAD']).trim();
  const paths = git(root, ['ls-files', '-z']).split('\0')
    .filter(file => file.startsWith(values.prefix) && ['.ts', '.tsx'].includes(extname(file)) &&
      !file.endsWith('.d.ts') && (!values['source-only'] || !/(?:^|\/)__tests[^/]*\/|\.(?:test|spec)\.tsx?$/.test(file)) &&
      existsSync(resolve(root, file)));
  const files = paths.map(file => ({ file, source: readFileSync(resolve(root, file)) }));
  const report = { project: basename(root), revision, files: files.length, bytes: 0, tsxFiles: 0, fastFiles: 0, fastBytes: 0,
    candidates: 0, candidateFiles: 0, fastCandidates: 0, nativeFiles: 0, nativeCandidates: 0,
    yukuFiles: 0, yukuCandidates: 0, yukuCandidateFiles: 0, tokenFiles: 0, tokenCandidates: 0, diagnostics: 0,
    nativeDiagnosticFiles: 0,
    fastCandidateFiles: [], tokenCandidateFiles: [], fallbackReasons: {}, candidateBytes: 0, maxDepth: 0 };
  for (const { file, source } of files) {
    const options = { file, logical: values.logical, requireNative: true };
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, `${root}/${file}`);
    assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', `${root}/${file}`);
    assert.deepEqual(result.diagnostics, reference.diagnostics, `${root}/${file}`);
    report.bytes += source.length;
    if (file.endsWith('.tsx')) report.tsxFiles++;
    report.candidates += result.candidates.length;
    if (result.candidates.length) report.candidateFiles++;
    report.candidateBytes += result.metrics?.candidateBytes ?? 0;
    if (result.path === 'fast') {
      report.fastFiles++;
      report.fastBytes += source.length;
      report.fastCandidates += result.candidates.length;
      if (result.candidates.length) report.fastCandidateFiles.push({ file, candidates: result.candidates.length });
      report.maxDepth = Math.max(report.maxDepth, result.metrics.maxDepth);
    } else if (result.path === 'native') {
      report.nativeFiles++;
      report.nativeCandidates += result.candidates.length;
      report.maxDepth = Math.max(report.maxDepth, result.metrics.maxDepth);
    } else if (result.reason === 'duplicate-lexical') {
      report.nativeDiagnosticFiles++;
    } else {
      if (result.reason !== 'invalid-utf8') {
        report.yukuFiles++;
        report.yukuCandidates += result.candidates.length;
        if (result.candidates.length) report.yukuCandidateFiles++;
      }
      report.fallbackReasons[result.reason] = (report.fallbackReasons[result.reason] ?? 0) + 1;
      if (result.fallback === 'tokens') {
        report.tokenFiles++;
        report.tokenCandidates += result.candidates.length;
        report.tokenCandidateFiles.push({ file, candidates: result.candidates.length });
      }
    }
    if (result.path === 'diagnostic') report.diagnostics++;
  }
  return report;
});

console.log(JSON.stringify({
  runtime: process.version, system: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model,
  reference: 'yuku-parser 0.19.0',
  scope: { prefix: values.prefix, sourceOnly: !!values['source-only'], logical: !!values.logical }, reports,
}, null, 2));
