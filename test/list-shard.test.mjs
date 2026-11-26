import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { candidateKey, candidateOrder, computeShardSelection, listCandidates, parseShard, parseShardingStrategy, selectShard } from '../src/shard.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/eligibility', import.meta.url));

describe('--shard and --list', () => {
  it('validates --shard K/N and --sharding', () => {
    assert.equal(parseShard(undefined), undefined);
    assert.deepEqual(parseShard('0/4'), { index: 0, total: 4 });
    assert.deepEqual(parseShard('3/4'), { index: 3, total: 4 });
    assert.deepEqual(parseShard('0/1'), { index: 0, total: 1 });
    assert.deepEqual(parseShard(`0/${Number.MAX_SAFE_INTEGER}`), { index: 0, total: Number.MAX_SAFE_INTEGER });
    assert.throws(() => parseShard(`0/${Number.MAX_SAFE_INTEGER + 1}`), /Invalid --shard/);
    assert.throws(() => parseShard('4/4'), /Invalid --shard/);
    assert.throws(() => parseShard('5/4'), /Invalid --shard/);
    assert.throws(() => parseShard('0/0'), /Invalid --shard/);
    assert.throws(() => parseShard('-1/2'), /Expected --shard/);
    assert.throws(() => parseShard('abc'), /Expected --shard/);
    assert.throws(() => parseShard(null), /Expected --shard/);
    assert.equal(parseShardingStrategy(undefined), 'slice');
    assert.equal(parseShardingStrategy('round-robin'), 'round-robin');
    assert.throws(() => parseShardingStrategy('hash'), /Expected --sharding/);
    assert.throws(() => parseShardingStrategy(null), /Expected --sharding/);
  });

  it('assigns candidates to ordered slices or interleaved shards', () => {
    const rows = readFileSync(new URL('../verification/pict/self-tmt-shard-placement.tsv', import.meta.url), 'utf8')
      .trim().split(/\r?\n/).slice(1);
    for (const row of rows) {
      const [distribution, count, shards] = row.split('\t');
      const strategy = distribution === 'Slice' ? 'slice' : 'round-robin';
      const items = Array.from({ length: Number(count) }, (_, index) => `item-${index}`);
      const total = Number(shards);
      const partitions = Array.from({ length: total }, (_, index) => {
        const { selected, meta } = selectShard(items, { index, total }, strategy);
        assert.deepEqual(meta, { index, total, strategy, totalCandidates: items.length, selectedCandidates: selected.length }, row);
        return selected;
      });
      if (strategy === 'slice') {
        assert.deepEqual(partitions.flat(), items, row);
        const sizes = partitions.map(partition => partition.length);
        assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), row);
        assert.ok(sizes[0] - sizes.at(-1) <= 1, row);
      } else {
        assert.deepEqual(partitions, Array.from({ length: total }, (_, index) =>
          Array.from({ length: Math.ceil((items.length - index) / total) }, (_, step) => items[index + step * total])), row);
      }
    }
  });

  it('breaks ordering ties by file, start, longest span, rule and replacement', () => {
    const candidates = [
      { location: { file: 'a.ts', start: 0, end: 1 }, rule: 'z', replacement: 'z' },
      { location: { file: 'a.ts', start: 1, end: 4 }, rule: 'b', replacement: 'a' },
      { location: { file: 'a.ts', start: 1, end: 3 }, mutatorName: 'a', replacement: 'b' },
      { location: { file: 'a.ts', start: 1, end: 3 }, rule: 'a', replacement: 'c' },
      { location: { file: 'a.ts', start: 1, end: 3 }, rule: 'b', replacement: 'a' },
      { location: { file: 'b.ts', start: 0, end: 4 }, rule: 'a', replacement: 'a' },
    ];
    assert.deepEqual(candidates.toReversed().sort(candidateOrder), candidates);
  });

  it('computes the same shard selection as the full-profile candidate list', () => {
    const files = ['src/eligibility.ts'];
    const options = { mutators: 'full', sharding: 'round-robin' };
    const all = listCandidates(fixture, files, options);
    const chosen = listCandidates(fixture, files, { ...options, shard: '1/2' });
    assert.equal(all.mutators, 'full');
    assert.ok(all.mutants.some(candidate => candidate.mutatorName === 'ArrowFunction'));
    assert.deepEqual(chosen.mutants, all.mutants.filter((_, index) => index % 2 === 1));
    assert.equal(computeShardSelection(fixture, files, options), null);
    const expected = { keys: new Set(chosen.mutants.map(candidateKey)), meta: chosen.shard };
    assert.deepEqual(computeShardSelection(fixture, files, { ...options, shard: '1/2' }), expected);
    assert.deepEqual(computeShardSelection(fixture, files, { ...options, shard: { index: 1, total: 2 } }), expected);
  });

  it('builds stable keys from candidate locations or fallback edits', () => {
    assert.equal(candidateKey({ location: { file: 'a.ts', start: 0, end: 2 }, edit: [1, 3], rule: 'boundary', replacement: '>' }),
      'a.ts:0:2:boundary:>');
    assert.equal(candidateKey({ edit: [1, 3], mutatorName: 'EqualityOperator', replacement: '' }), ':1:3:EqualityOperator:');
    assert.equal(candidateKey({}), ':0:0::');
  });

  it('warns about a missing explicit type-check config and keeps automatic checks silent', () => {
    const files = ['src/eligibility.ts'];
    const warnings = [];
    const options = { tsconfig: 'missing-tsconfig.json', onTypeCheckWarning: warning => warnings.push(warning) };
    listCandidates(fixture, files, { ...options, 'type-check': 'auto' });
    assert.deepEqual(warnings, []);
    listCandidates(fixture, files, { ...options, 'type-check': true });
    assert.deepEqual(warnings, ['--type-check: tsconfig file not found (missing-tsconfig.json); skipping type-based suppression.']);
  });

  it('--list enumerates candidates without running tests and supports --shard', () => {
    const all = listCandidates(fixture, ['src/eligibility.ts'], { mutators: 'targeted' });
    assert.equal(all.evaluation, 'listed');
    assert.ok(all.mutants.length >= 1);
    assert.ok(all.mutants.every(m => m.status === 'listed'));

    const s0 = listCandidates(fixture, ['src/eligibility.ts'], { mutators: 'targeted', shard: '0/2', sharding: 'slice' });
    const s1 = listCandidates(fixture, ['src/eligibility.ts'], { mutators: 'targeted', shard: '1/2', sharding: 'slice' });
    assert.equal(s0.mutants.length + s1.mutants.length, all.mutants.length);
    assert.equal(s0.shard.index, 0);
    assert.equal(s0.shard.total, 2);
  });

  it('CLI supports --list with --format jsonl and --format sarif', () => {
    const out = execFileSync(process.execPath, [cli, 'analyze', fixture, 'src/eligibility.ts', '--list', '--format', 'jsonl'], { encoding: 'utf8' });
    const events = out.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[0].event, 'summary');
    assert.equal(events[0].evaluation, 'listed');
    assert.equal(events.at(-1).event, 'complete');
  });
});
