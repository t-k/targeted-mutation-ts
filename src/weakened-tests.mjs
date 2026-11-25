import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { verdict } from './analysis.mjs';
import { inParallel } from './in-parallel.mjs';
import { rewrite } from './probe.mjs';
import { canonicalPath, copyPathIsExcluded, inside, resolveCopyExclusions, runVitestAsync, withCopy } from './vitest.mjs';

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
  const root = canonicalPath(project);
  const { revision, files: rawOldTests } = changedTestFiles(root, options.since);
  const exclusions = resolveCopyExclusions(root, options['copy-exclude'] ?? []);
  const oldTests = rawOldTests.filter(entry => !copyPathIsExcluded(root, resolve(root, entry.file), exclusions));
  if (!revision || !oldTests.length) return report;

  const survivors = (report.mutants ?? []).filter(isReplayableSurvivor).slice(0, MAX_WEAKENED_TRIALS);
  if (!survivors.length) return report;

  const safeWorkspaceTarget = (workspace, relFile) => {
    const realWorkspace = canonicalPath(workspace);
    const target = resolve(realWorkspace, relFile);
    const fromRoot = relative(realWorkspace, target);
    if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) {
      throw new Error(`Path escapes the workspace: ${relFile}`);
    }
    // Walk every path segment to ensure no existing parent or target is a symlink escaping the workspace.
    const parts = fromRoot.split(sep);
    let cursor = realWorkspace;
    for (let i = 0; i < parts.length; i++) {
      cursor = resolve(cursor, parts[i]);
      if (existsSync(cursor)) {
        const st = lstatSync(cursor);
        if (st.isSymbolicLink()) {
          throw new Error(`Refusing to write through symbolic link in workspace: ${relFile}`);
        }
        const realCursor = canonicalPath(cursor);
        const relCheck = relative(realWorkspace, realCursor);
        if (relCheck === '..' || relCheck.startsWith('..' + sep) || isAbsolute(relCheck)) {
          throw new Error(`Path escapes the workspace: ${relFile}`);
        }
      } else if (i < parts.length - 1) {
        mkdirSync(cursor);
      }
    }
    return target;
  };

  const runWithOldTests = mutant => withCopy(root, async (workspace, temp) => {
    for (const entry of oldTests) {
      writeFileSync(safeWorkspaceTarget(workspace, entry.file), entry.oldContent);
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
    const byMutation = (diag.mutations ?? [])
      .map(m => weakenedByKey.get(`${diag.location?.file ?? ''}:${m.edit?.[0]}:${m.edit?.[1]}:${m.replacement ?? ''}`))
      .find(Boolean);
    return byMutation ? { ...diag, weakened: byMutation } : diag;
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
