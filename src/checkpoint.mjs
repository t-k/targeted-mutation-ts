import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CHECKPOINT_VERSION = 1;
const REUSABLE_STATUSES = new Set(['killed', 'survived', 'timeout', 'unreached']);

export function computeCampaignContext(targets, options = {}) {
  const hash = createHash('sha256');
  const sortedTargets = [...targets].sort((a, b) => a.file.localeCompare(b.file));
  for (const target of sortedTargets) {
    hash.update(target.file);
    hash.update('\0');
    hash.update(target.input);
    hash.update('\0');
  }
  hash.update(JSON.stringify({
    mutators: options.mutators ?? 'targeted',
    runner: options.runner ?? 'vitest',
    config: options.config ?? null,
    test: options.test ?? null,
    lines: options.lines ?? null,
    since: options.since ?? null,
    shard: options.shard ?? null,
    sharding: options.sharding ?? 'slice',
    deterministic: !!options.deterministic,
    displaceThresholds: !!options['displace-thresholds'],
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
    const lines = raw.split('\n');
    let validByteLength = 0;
    let sawFormat = false;
    let logContext = null;
    let truncated = false;
    const candidateOutcomes = new Map();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      if (!line.length && isLast) break;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Crash-safe recovery: discard an incomplete trailing line.
        if (isLast) {
          truncated = true;
          break;
        }
        logContext = null;
        break;
      }
      validByteLength += Buffer.byteLength(line, 'utf8') + (isLast ? 0 : 1);
      if (parsed.event === 'format' && parsed.version === CHECKPOINT_VERSION) {
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
      }
      for (const [k, v] of candidateOutcomes) {
        stored.set(k, v);
      }
      reused = stored.size;
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
    record(key, outcome) {
      if (!outcome || !REUSABLE_STATUSES.has(outcome.status)) return false;
      if (stored.has(key)) return false;
      const sanitized = {
        status: outcome.status,
        ...(outcome.tests ? { tests: outcome.tests } : {}),
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
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
