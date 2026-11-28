import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { canonicalPath, copyPathIsExcluded, resolveCopyExclusions, resolveCopyInclusions } from './vitest.mjs';

const CHECKPOINT_VERSION = 1;
const REUSABLE_STATUSES = new Set(['killed', 'survived', 'timeout', 'unreached']);
const CONTEXT_SKIP_DIRS = new Set(['.git', '.worktree', '.worktrees', 'node_modules', 'dist', 'build', 'coverage', 'docs.local', '.stryker-tmp']);
const CONTEXT_FILE_RE = /(?:\.(?:[cm]?[jt]s|[jt]sx|json)|^(?:package\.json|tsconfig(?:\.[^.]+)?\.json|(?:vite|vitest|playwright)(?:\.[^.]+)*\.config\.[cm]?[jt]s))$/;

const normalizePathKey = value => (process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value);
const PROTECTED_INPUT_NAME_RE = /^(?:package\.json|package-lock\.json|tsconfig(?:\.[^.]+)?\.json|targeted-mutation\.config\.(?:json|mjs)|(?:vite|vitest|playwright)(?:\.[^.]+)*\.config\.[cm]?[jt]s)$/i;
const SOURCE_OR_TEST_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;

function addProtectedPath(set, inodes, fullPath) {
  set.add(normalizePathKey(fullPath));
  const st = statSync(fullPath, { throwIfNoEntry: false });
  if (st?.isFile()) inodes.add(`${st.dev}:${st.ino}`);
  if (existsSync(fullPath)) {
    try {
      set.add(normalizePathKey(canonicalPath(fullPath)));
    } catch {
      // Ignore unreadable path.
    }
  }
}

function resolveOutputPathKeys(options = {}, targets = [], root = null) {
  const protectedKeys = new Set();
  const protectedInodes = new Set();
  if (root && existsSync(root)) {
    const canonicalRoot = canonicalPath(root);
    for (const target of targets ?? []) {
      if (target?.file) addProtectedPath(protectedKeys, protectedInodes, resolve(canonicalRoot, target.file));
    }
    for (const testFile of options.test ?? []) {
      if (testFile) addProtectedPath(protectedKeys, protectedInodes, resolve(canonicalRoot, testFile));
    }
    for (const optKey of ['config', 'tsconfig', 'spec']) {
      if (typeof options[optKey] === 'string' && options[optKey].trim()) {
        addProtectedPath(protectedKeys, protectedInodes, resolve(canonicalRoot, options[optKey]));
      }
    }
  }
  const keys = new Set();
  for (const flag of ['checkpoint', 'json-out', 'sarif-out', 'write-baseline']) {
    const raw = options[flag];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const abs = resolve(raw);
    const baseName = abs.split(/[\\/]/).at(-1) ?? '';
    if (PROTECTED_INPUT_NAME_RE.test(baseName) || SOURCE_OR_TEST_EXT_RE.test(baseName)) {
      throw new Error(`Refusing to use project input file as --${flag} output: ${raw}`);
    }
    const outStat = statSync(abs, { throwIfNoEntry: false });
    if (outStat?.isFile() && protectedInodes.has(`${outStat.dev}:${outStat.ino}`)) {
      throw new Error(`Refusing to use analysis input file as --${flag} output: ${raw}`);
    }
    const candidates = [abs];
    if (existsSync(abs)) {
      try {
        candidates.push(canonicalPath(abs));
      } catch {
        // Ignore unreadable paths; lexical absolute path is already checked.
      }
    } else {
      const parent = dirname(abs);
      if (existsSync(parent)) {
        try {
          candidates.push(resolve(canonicalPath(parent), relative(parent, abs)));
        } catch {
          // Ignore unreadable parent.
        }
      }
    }
    for (const candidate of candidates) {
      const key = normalizePathKey(candidate);
      if (protectedKeys.has(key)) {
        throw new Error(`Refusing to use analysis input file as --${flag} output: ${raw}`);
      }
      keys.add(key);
    }
  }
  return keys;
}

function collectProjectContextFiles(root, dir = root, out = [], exclusions = [], inclusions = [], ignoredOutputs = new Set()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (CONTEXT_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmt-')) continue;
    if (entry.isDirectory() && entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (ignoredOutputs.has(normalizePathKey(full))) continue;
    if (copyPathIsExcluded(root, full, exclusions, inclusions)) continue;
    if (entry.isDirectory()) {
      collectProjectContextFiles(root, full, out, exclusions, inclusions, ignoredOutputs);
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
// dependencies, or runner configs invalidates cached checkpoint outcomes while ignoring outputs
// owned by the same invocation.
export function computeCampaignContextDetails(targets, options = {}, root = null) {
  const filesHasher = createHash('sha256');
  const ignoredOutputs = resolveOutputPathKeys(options, targets, root);
  if (root && existsSync(root)) {
    const canonicalRoot = canonicalPath(root);
    const exclusions = options['copy-exclude']?.length
      ? resolveCopyExclusions(canonicalRoot, options['copy-exclude'], { onMissing: () => {} })
      : [];
    const inclusions = options['copy-include']?.length
      ? resolveCopyInclusions(canonicalRoot, options['copy-include'], { onMissing: () => {} })
      : [];
    const projectFiles = collectProjectContextFiles(canonicalRoot, canonicalRoot, [], exclusions, inclusions, ignoredOutputs).sort();
    for (const rel of projectFiles) {
      filesHasher.update(rel.replaceAll(sep, '/'));
      filesHasher.update('\0');
      filesHasher.update(readFileSync(resolve(canonicalRoot, rel)));
      filesHasher.update('\0');
    }
  } else {
    const sortedTargets = [...targets].sort((a, b) => a.file.localeCompare(b.file));
    for (const target of sortedTargets) {
      filesHasher.update(target.file);
      filesHasher.update('\0');
      filesHasher.update(target.input);
      filesHasher.update('\0');
    }
  }
  const filesHash = filesHasher.digest('hex');

  const optionsPayload = JSON.stringify({
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
    ...(options['copy-include']?.length ? { copyInclude: options['copy-include'] } : {}),
    ...(options.exclude?.length ? { exclude: options.exclude } : {}),
    isolatedTrials: !!options['isolated-trials'],
    ...(options['verify-trials'] ? { verifyTrials: options['verify-trials'] } : {}),
  });
  const optionsHash = createHash('sha256').update(optionsPayload).digest('hex');
  const context = createHash('sha256').update(filesHash).update('\0').update(optionsHash).digest('hex');
  return { context, filesHash, optionsHash };
}

export function computeCampaignContext(targets, options = {}, root = null) {
  return computeCampaignContextDetails(targets, options, root).context;
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
  let invalidationReason = null;

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    if (raw.length > 0) {
      const lines = raw.split('\n');
      let validByteLength = 0;
      let sawFormat = false;
      let logContext = null;
      let logMetadata = null;
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
          logMetadata = parsed.metadata ?? null;
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
      } else if (sawFormat && logContext !== null) {
        const prevFiles = logMetadata?.filesHash;
        const prevOptions = logMetadata?.optionsHash;
        const curFiles = metadata?.filesHash;
        const curOptions = metadata?.optionsHash;
        if (prevFiles && curFiles && prevOptions && curOptions) {
          const filesChanged = prevFiles !== curFiles;
          const optionsChanged = prevOptions !== curOptions;
          if (filesChanged && optionsChanged) invalidationReason = 'project files and analysis options changed';
          else if (filesChanged) invalidationReason = 'project files changed';
          else if (optionsChanged) invalidationReason = 'analysis options changed';
          else invalidationReason = 'campaign context changed';
        } else {
          invalidationReason = 'campaign context changed';
        }
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
    invalidationReason,
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
        ...(outcome.fallback ? { fallback: outcome.fallback } : {}),
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
      return {
        path,
        reused,
        recorded,
        resumed: matched,
        ...(invalidationReason ? { invalidationReason } : {}),
      };
    },
  };
}
