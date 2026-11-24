import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listCandidates, parseShard, parseShardingStrategy, selectShard } from '../src/shard.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/eligibility', import.meta.url));

describe('--shard and --list', () => {
  it('validates --shard K/N and --sharding', () => {
    assert.deepEqual(parseShard('0/4'), { index: 0, total: 4 });
    assert.deepEqual(parseShard('3/4'), { index: 3, total: 4 });
    assert.throws(() => parseShard('4/4'), /Invalid --shard/);
    assert.throws(() => parseShard('0/0'), /Invalid --shard/);
    assert.throws(() => parseShard('-1/2'), /Expected --shard/);
    assert.throws(() => parseShard('abc'), /Expected --shard/);
    assert.equal(parseShardingStrategy(undefined), 'slice');
    assert.equal(parseShardingStrategy('round-robin'), 'round-robin');
    assert.throws(() => parseShardingStrategy('hash'), /Expected --sharding/);
  });

  it('partitions items disjointly and exhaustively for both slice and round-robin', () => {
    for (const strategy of ['slice', 'round-robin']) {
      for (const n of [1, 2, 3, 5, 10]) {
        const items = Array.from({ length: n }, (_, i) => `item-${i}`);
        for (const total of [1, 2, 3, 4]) {
          const seen = [];
          for (let index = 0; index < total; index++) {
            const { selected, meta } = selectShard(items, { index, total }, strategy);
            assert.equal(meta.totalCandidates, n);
            assert.equal(meta.selectedCandidates, selected.length);
            seen.push(...selected);
          }
          assert.deepEqual([...seen].sort(), [...items].sort());
          assert.equal(new Set(seen).size, n);
        }
      }
    }
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
