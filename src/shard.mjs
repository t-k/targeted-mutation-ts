import { readFileSync } from 'node:fs';
import { collectComparisons } from './analysis.mjs';
import { prepareBuiltinSwitches, targetedOrBoundary } from './builtin-switches.mjs';
import { selectScope } from './scope.mjs';
import { createTypeContext } from './type-equivalence.mjs';
import { canonicalPath, inside } from './vitest.mjs';

export function parseShard(spec) {
  if (spec === undefined) return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(String(spec).trim());
  if (!match) throw new Error(`Expected --shard K/N (0-based index / positive total), got: ${spec}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 0 || index >= total) {
    throw new Error(`Invalid --shard ${spec}: require 0 <= K < N and N >= 1`);
  }
  return { index, total };
}

export function parseShardingStrategy(strategy) {
  if (strategy === undefined) return 'slice';
  if (strategy !== 'slice' && strategy !== 'round-robin') {
    throw new Error(`Expected --sharding slice|round-robin, got: ${strategy}`);
  }
  return strategy;
}

export function selectShard(items, shard, strategy = 'slice') {
  if (!shard) return { selected: items, meta: undefined };
  const { index, total } = shard;
  let selected;
  if (strategy === 'round-robin') {
    selected = items.filter((_, i) => i % total === index);
  } else {
    const base = Math.floor(items.length / total);
    const rem = items.length % total;
    const start = index * base + Math.min(index, rem);
    const size = base + (index < rem ? 1 : 0);
    selected = items.slice(start, start + size);
  }
  return {
    selected,
    meta: {
      index,
      total,
      strategy,
      totalCandidates: items.length,
      selectedCandidates: selected.length,
    },
  };
}

export function candidateKey(candidate) {
  const file = String(candidate.location?.file ?? '');
  const start = candidate.location?.start ?? candidate.edit?.[0] ?? 0;
  const end = candidate.location?.end ?? candidate.edit?.[1] ?? 0;
  const rule = String(candidate.rule ?? candidate.mutatorName ?? '');
  const replacement = String(candidate.replacement ?? '');
  return `${file}:${start}:${end}:${rule}:${replacement}`;
}

export function candidateOrder(a, b) {
  return String(a.location?.file ?? '').localeCompare(String(b.location?.file ?? '')) ||
    (a.location?.start ?? 0) - (b.location?.start ?? 0) ||
    (b.location?.end ?? 0) - (a.location?.end ?? 0) ||
    String(a.rule ?? a.mutatorName ?? '').localeCompare(String(b.rule ?? b.mutatorName ?? '')) ||
    String(a.replacement ?? '').localeCompare(String(b.replacement ?? ''));
}

// Preview all scoped mutation candidates without executing any test runner.
export function listCandidates(project, files, options = {}) {
  const root = canonicalPath(project);
  const profile = options.mutators ?? 'targeted';
  const shard = parseShard(options.shard);
  const strategy = parseShardingStrategy(options.sharding);

  const excludedRuleSet = new Set((options['exclude-rule'] ?? []).map(r => String(r).trim()).filter(Boolean));
  const { subjects, extraction } = collectComparisons(root, files, { ...options, mutators: undefined });
  const boundaryKeys = new Set();
  const candidates = [];
  for (const subject of subjects) {
    for (const site of subject.sites) {
      if (excludedRuleSet.has(site.rule)) continue;
      boundaryKeys.add(`${site.location.file}:${site.edit[0]}:${site.replacement}`);
      candidates.push({
        id: site.id,
        site: site.id,
        rule: site.rule,
        location: site.location,
        operator: site.operator,
        original: site.original ?? site.operator,
        edit: site.edit,
        replacement: site.replacement,
        status: 'listed',
      });
    }
  }

  const targets = selectScope(root, files, options).map(subject => ({
    ...subject,
    input: readFileSync(inside(root, subject.file)),
  }));
  const typeContext = options['type-check']
    ? createTypeContext(root, targets.map(t => t.file), {
      tsconfig: options.tsconfig,
      onWarning: options.onTypeCheckWarning,
      silent: options['type-check'] === 'auto',
    })
    : null;
  const { mutants: prepared } = prepareBuiltinSwitches(targets, {
    dialect: options.dialect,
    excludeRules: options['exclude-rule'],
    typeContext,
    targeted: true,
    ...(profile === 'targeted' ? { keep: targetedOrBoundary } : {}),
  });
  for (const mutant of prepared) {
    if (mutant.parametric) continue;
    if (mutant.operatorSwap && boundaryKeys.has(`${mutant.location.file}:${mutant.operatorSwap.join(':')}`)) continue;
    const { source: _source, operatorSwap: _swap, targeted: _targeted, ...rest } = mutant;
    candidates.push({
      ...(profile === 'full'
        ? { ...rest, rule: rest.rule ?? rest.mutatorName }
        : { id: rest.id, site: rest.id, rule: rest.mutatorName, ...rest, mutatorName: undefined }),
      status: mutant.status ?? 'listed',
    });
  }

  candidates.sort(candidateOrder);
  const { selected, meta } = selectShard(candidates, shard, strategy);

  return {
    schemaVersion: 1,
    runner: options.runner ?? 'vitest',
    mutators: profile,
    extraction,
    mutants: selected,
    diagnostics: [],
    evaluation: selected.length ? 'listed' : 'no_sites',
    selection: {
      config: options.config,
      tests: options.test,
      copyExclude: options['copy-exclude'],
      ...(options['copy-include']?.length ? { copyInclude: options['copy-include'] } : {}),
      ...(options.exclude?.length ? { exclude: options.exclude } : {}),
    },
    ...(meta ? { shard: meta } : {}),
  };
}

export function computeShardSelection(project, files, options = {}) {
  const shard = typeof options.shard === 'string' ? parseShard(options.shard) : options.shard;
  if (!shard) return null;
  const listed = listCandidates(project, files, { ...options, shard: `${shard.index}/${shard.total}` });
  return {
    keys: new Set(listed.mutants.map(candidateKey)),
    meta: listed.shard,
  };
}
