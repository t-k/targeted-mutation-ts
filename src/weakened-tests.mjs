import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { sep } from 'node:path';
import { verdict } from './analysis.mjs';
import { inParallel } from './in-parallel.mjs';
import { rewrite } from './probe.mjs';
import { inside, runVitestAsync, withCopy } from './vitest.mjs';

const TEST_FILE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_WEAKENED_TRIALS = 32;

function git(root, args) {
  return execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function toGitPath(file) {
  return sep === '/' ? file : file.replaceAll(sep, '/');
}

function fromGitPath(file) {
  return sep === '/' ? file : file.replaceAll('/', sep);
}

export function resolveRevision(root, revision) {
  try {
    return git(root, ['rev-parse', '--verify', `${revision}^{commit}`]).toString('utf8').trim();
  } catch {
    return null;
  }
}

// Find test files modified since `revision` that also existed at `revision`.
export function changedTestFiles(root, revision) {
  const rev = resolveRevision(root, revision);
  if (!rev) return { revision: null, files: [] };
  const raw = git(root, ['diff', '--name-only', '--relative', '--no-renames', '-z', rev, '--']);
  const paths = raw.toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (const gitPath of paths) {
    if (!TEST_FILE_RE.test(gitPath)) continue;
    try {
      const oldContent = git(root, ['show', `${rev}:${gitPath}`]);
      files.push({ file: fromGitPath(gitPath), gitPath, oldContent });
    } catch {
      // Newly added test file since `rev` has no older version to replay.
    }
  }
  return { revision: rev, files };
}

function mutantKey(mutant) {
  const file = mutant.location?.file ?? '';
  const edit = mutant.edit ?? [];
  return `${file}:${edit[0]}:${edit[1]}:${mutant.replacement ?? ''}`;
}

function isReplayableSurvivor(mutant) {
  return mutant?.status === 'survived' &&
    mutant.since === undefined &&
    mutant.location?.file &&
    Array.isArray(mutant.edit) && mutant.edit.length === 2 &&
    typeof mutant.replacement === 'string';
}

// Re-run surviving mutants against the test files as they were at `options.since`.
// Any survivor killed by the old tests is marked with `weakened: { since, killedByOldTests }`.
export async function detectWeakenedTests(project, report, options = {}) {
  if (!options.since || report?.evaluation !== 'evaluated' || report?.runner !== 'vitest') {
    return report;
  }
  const root = realpathSync(project);
  const { revision, files: oldTests } = changedTestFiles(root, options.since);
  if (!revision || !oldTests.length) return report;

  const survivors = (report.mutants ?? []).filter(isReplayableSurvivor).slice(0, MAX_WEAKENED_TRIALS);
  if (!survivors.length) return report;

  const runWithOldTests = mutant => withCopy(root, async (workspace, temp) => {
    for (const entry of oldTests) {
      writeFileSync(inside(workspace, entry.file), entry.oldContent);
    }
    if (mutant) {
      const targetPath = inside(workspace, mutant.location.file);
      const originalBytes = readFileSync(targetPath);
      const edit = mutant.source?.edit ?? mutant.edit;
      const replacement = mutant.source?.replacement ?? mutant.replacement;
      writeFileSync(targetPath, rewrite(originalBytes, edit, replacement));
    }
    return runVitestAsync(workspace, temp, {
      product: true,
      config: options.config,
      testFiles: options.test,
      ...(options.timeout ? { timeout: options.timeout * 1000 } : {}),
    });
  }, { exclude: options['copy-exclude'] });

  // Verify old tests compile and pass on the current production code before attributing weakened tests.
  const oldBaseline = await runWithOldTests(null);
  if (oldBaseline.status !== 'passed') {
    return report;
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? Math.max(1, availableParallelism() - 1), 8));
  const weakenedByKey = new Map();
  const weakenedBySite = new Map();

  await inParallel(survivors, concurrency, async mutant => {
    const run = await runWithOldTests(mutant);
    if (verdict(run, oldBaseline) === 'killed') {
      const killedByOldTests = (run.tests ?? [])
        .filter(t => t.status === 'failed')
        .map(t => `${t.file} > ${t.name}`);
      const info = { since: revision, killedByOldTests };
      weakenedByKey.set(mutantKey(mutant), info);
      if (mutant.site) weakenedBySite.set(mutant.site, info);
    }
  });

  if (!weakenedByKey.size) return report;

  const mutants = (report.mutants ?? []).map(mutant => {
    const info = weakenedByKey.get(mutantKey(mutant));
    return info ? { ...mutant, weakened: info } : mutant;
  });

  const diagnostics = (report.diagnostics ?? []).map(diag => {
    const bySite = diag.site ? weakenedBySite.get(diag.site) : undefined;
    const byMutation = (diag.mutations ?? [])
      .map(m => weakenedByKey.get(`${diag.location?.file ?? ''}:${m.edit?.[0]}:${m.edit?.[1]}:${m.replacement ?? ''}`))
      .find(Boolean);
    const info = bySite ?? byMutation;
    return info ? { ...diag, weakened: info } : diag;
  });

  return {
    ...report,
    mutants,
    diagnostics,
    weakened: {
      since: revision,
      count: weakenedByKey.size,
      changedTests: oldTests.map(entry => entry.file),
    },
  };
}
