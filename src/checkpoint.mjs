import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const CHECKPOINT_VERSION = 1;
const REUSABLE_STATUSES = new Set(['killed', 'survived', 'timeout', 'unreached']);
const CONTEXT_SKIP_DIRS = new Set(['.git', '.worktree', '.worktrees', 'node_modules', 'dist', 'build', 'coverage', 'docs.local', '.stryker-tmp']);
const CONTEXT_FILE_RE = /(?:\.(?:[cm]?[jt]s|[jt]sx|json)|^(?:package\.json|tsconfig(?:\.[^.]+)?\.json|(?:vite|vitest|playwright)(?:\.[^.]+)*\.config\.[cm]?[jt]s))$/;

function collectProjectContextFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (CONTEXT_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmt-')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collectProjectContextFiles(root, full, out);
    } else if (entry.isFile() && CONTEXT_FILE_RE.test(entry.name)) {
      const size = statSync(full, { throwIfNoEntry: false })?.size ?? 0;
      if (size <= 2 * 1024 * 1024) {
        out.push(relative(root, full));
      }
    }
  }
  return out;
}

// Hash all relevant source, test, and config files plus execution options so any edit to tests,
// dependencies, or runner configs invalidates cached checkpoint outcomes.
export function computeCampaignContext(targets, options = {}, root = null) {
  const hash = createHash('sha256');
  if (root && existsSync(root)) {
    const projectFiles = collectProjectContextFiles(root).sort();
    for (const rel of projectFiles) {
      hash.update(rel.replaceAll(sep, '/'));
      hash.update('\0');
      hash.update(readFileSync(resolve(root, rel)));
      hash.update('\0');
    }
  } else {
    const sortedTargets = [...targets].sort((a, b) => a.file.localeCompare(b.file));
    for (const target of sortedTargets) {
      hash.update(target.file);
      hash.update('\0');
      hash.update(target.input);
      hash.update('\0');
    }
  }
  hash.update(JSON.stringify({
    mutators: options.mutators ?? 'targeted',
    runner: options.runner ?? 'vitest',
    config: options.config ?? null,
    test: options.test ?? null,
    ...(options.testSpecs?.length ? { testSpecs: options.testSpecs } : {}),
    lines: options.lines ?? null,
    since: options.since ?? null,
    shard: options.shard ?? null,
    sharding: options.sharding ?? 'slice',
    deterministic: !!options.deterministic,
    displaceThresholds: !!options['displace-thresholds'],
    excludeRules: options['exclude-rule'] ?? null,
    ...(options['type-check'] ? { typeCheck: true } : {}),
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
    timeout: options.timeout ?? null,
    ...(options['baseline-timeout'] !== undefined ? { baselineTimeout: options['baseline-timeout'] } : {}),
    ...(options['baseline-workers'] !== undefined ? { baselineWorkers: options['baseline-workers'] } : {}),
    copyExclude: options['copy-exclude'] ?? null,
    isolatedTrials: !!options['isolated-trials'],
  }));
  return hash.digest('hex');
}

export function checkpointKeyForTrial(trial) {
  const file = trial.site?.location?.file ?? trial.location?.file ?? '';
  const edit = trial.edit ?? [];
  const rule = trial.rule ?? trial.mutatorName ?? '';
  const replacement = trial.replacement ?? '';
  return `${file}:${edit[0]}:${edit[1]}:${rule}:${replacement}`;
}

export function openCheckpoint(path, context, metadata = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const stored = new Map();
  let reused = 0;
  let recorded = 0;
  let matched = false;

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    if (raw.length > 0) {
      const lines = raw.split('\n');
      let validByteLength = 0;
      let sawFormat = false;
      let logContext = null;
      let truncated = false;
      let missingTrailingNewline = !raw.endsWith('\n');
      const candidateOutcomes = new Map();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isLast = i === lines.length - 1;
        if (!line.length && isLast) break;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          if (isLast && sawFormat) {
            truncated = true;
            missingTrailingNewline = false;
            break;
          }
          throw new Error(`Refusing to overwrite non-checkpoint file at ${path}`);
        }
        validByteLength += Buffer.byteLength(line, 'utf8') + (isLast ? 0 : 1);
        if (i === 0) {
          if (parsed.event !== 'format' || parsed.version !== CHECKPOINT_VERSION) {
            throw new Error(`Refusing to overwrite non-checkpoint file at ${path}`);
          }
          sawFormat = true;
        } else if (parsed.event === 'campaign_started' && typeof parsed.context === 'string') {
          logContext = parsed.context;
        } else if (parsed.event === 'outcome' && typeof parsed.key === 'string' && parsed.outcome && REUSABLE_STATUSES.has(parsed.outcome.status)) {
          candidateOutcomes.set(parsed.key, parsed.outcome);
        }
      }

      if (sawFormat && logContext === context) {
        matched = true;
        if (truncated) {
          truncateSync(path, validByteLength);
        } else if (missingTrailingNewline) {
          appendFileSync(path, '\n', 'utf8');
        }
        for (const [k, v] of candidateOutcomes) {
          stored.set(k, v);
        }
        reused = stored.size;
      }
    }
  }

  if (!matched) {
    const header = [
      JSON.stringify({ event: 'format', version: CHECKPOINT_VERSION }),
      JSON.stringify({ event: 'campaign_started', context, metadata }),
    ].join('\n') + '\n';
    writeFileSync(path, header, 'utf8');
  }

  return {
    path,
    context,
    matched,
    get reused() { return reused; },
    get recorded() { return recorded; },
    get(key) {
      return stored.get(key);
    },
    record(key, outcome, diagnostic = undefined) {
      if (!outcome || !REUSABLE_STATUSES.has(outcome.status)) return false;
      if (stored.has(key)) return false;
      const sanitized = {
        status: outcome.status,
        ...(outcome.statusReason ? { statusReason: outcome.statusReason } : {}),
        ...(outcome.tests ? { tests: outcome.tests } : {}),
        ...(outcome.reachedTests?.length ? { reachedTests: outcome.reachedTests } : {}),
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
        ...(diagnostic ? { diagnostic } : {}),
      };
      appendFileSync(path, JSON.stringify({ event: 'outcome', key, outcome: sanitized }) + '\n', 'utf8');
      stored.set(key, sanitized);
      recorded++;
      return true;
    },
    complete() {
      appendFileSync(path, JSON.stringify({ event: 'campaign_completed' }) + '\n', 'utf8');
    },
    summary() {
      return { path, reused, recorded, resumed: matched };
    },
  };
}
