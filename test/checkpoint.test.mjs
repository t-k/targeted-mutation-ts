import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCampaignContext, openCheckpoint } from '../src/checkpoint.mjs';
import { analyzeOperators } from '../src/operator-analysis.mjs';

const fixture = fileURLToPath(new URL('../fixtures/eligibility', import.meta.url));

describe('--checkpoint durable JSONL resume', () => {
  it('records and resumes matching-context outcomes while ignoring non-reusable statuses', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-ckpt-'));
    try {
      const file = resolve(dir, 'checkpoint.jsonl');
      const ctx = computeCampaignContext([{ file: 'src/a.ts', input: Buffer.from('export const x = 1;') }], { mutators: 'targeted' });

      const c1 = openCheckpoint(file, ctx);
      assert.equal(c1.matched, false);
      assert.equal(c1.reused, 0);
      assert.equal(c1.record('k1', { status: 'killed', tests: [] }), true);
      assert.equal(c1.record('k2', { status: 'survived' }), true);
      assert.equal(c1.record('k3', { status: 'error' }), false);
      assert.equal(c1.recorded, 2);

      // Resume with same context
      const c2 = openCheckpoint(file, ctx);
      assert.equal(c2.matched, true);
      assert.equal(c2.reused, 2);
      assert.equal(c2.get('k1').status, 'killed');
      assert.equal(c2.get('k2').status, 'survived');
      assert.equal(c2.get('k3'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers safely from a truncated trailing JSONL line after a simulated crash', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-ckpt-crash-'));
    try {
      const file = resolve(dir, 'checkpoint.jsonl');
      const ctx = computeCampaignContext([{ file: 'src/a.ts', input: Buffer.from('export const x = 1;') }]);

      const c1 = openCheckpoint(file, ctx);
      c1.record('k1', { status: 'killed' });
      // Simulate mid-write crash leaving a corrupted trailing fragment.
      appendFileSync(file, '{"event":"outcome","key":"k2","outcome":{"stat');

      const c2 = openCheckpoint(file, ctx);
      assert.equal(c2.matched, true);
      assert.equal(c2.reused, 1);
      assert.equal(c2.get('k1').status, 'killed');
      assert.equal(c2.get('k2'), undefined);
      // Appending after recovery produces valid JSONL.
      c2.record('k2', { status: 'survived' });
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.doesNotThrow(() => lines.forEach(line => JSON.parse(line)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets cleanly without leaking stale outcomes when context changes', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-ckpt-ctx-'));
    try {
      const file = resolve(dir, 'checkpoint.jsonl');
      const ctx1 = computeCampaignContext([{ file: 'src/a.ts', input: Buffer.from('export const x = 1;') }]);
      const ctx2 = computeCampaignContext([{ file: 'src/a.ts', input: Buffer.from('export const x = 2;') }]);

      const c1 = openCheckpoint(file, ctx1);
      c1.record('k1', { status: 'killed' });
      c1.complete();

      const c2 = openCheckpoint(file, ctx2);
      assert.equal(c2.matched, false);
      assert.equal(c2.reused, 0);
      assert.equal(c2.get('k1'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses outcomes end-to-end across two analyzeOperators runs', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-ckpt-e2e-'));
    try {
      const ckpt = resolve(dir, 'run.jsonl');
      const first = await analyzeOperators(fixture, ['src/eligibility.ts'], { mutators: 'targeted', checkpoint: ckpt });
      assert.equal(first.evaluation, 'evaluated');
      assert.equal(first.checkpoint.resumed, false);
      assert.ok(first.checkpoint.recorded >= 1);

      const second = await analyzeOperators(fixture, ['src/eligibility.ts'], { mutators: 'targeted', checkpoint: ckpt });
      assert.equal(second.evaluation, 'evaluated');
      assert.equal(second.checkpoint.resumed, true);
      assert.ok(second.checkpoint.reused >= 1);
      assert.equal(second.mutants.length, first.mutants.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
