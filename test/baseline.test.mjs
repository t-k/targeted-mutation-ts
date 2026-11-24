import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  annotateFindingIds,
  applyBaseline,
  findingId,
  loadBaseline,
  parseBaseline,
  tmtIgnoreLines,
  writeBaseline,
} from '../src/baseline.mjs';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { ignoredSwaps } from '../src/builtin-switches.mjs';

describe('tmt:ignore inline suppression', () => {
  it('suppresses same-line trailing comment only on that line', () => {
    const src = [
      'export const a = (x: number) => x >= 10; // tmt:ignore checked upstream',
      'export const b = (x: number) => x >= 20;',
    ].join('\n');
    const lines = tmtIgnoreLines(src);
    assert.equal(lines.get(0), 'checked upstream');
    assert.equal(lines.has(1), false);

    const mutations = collectMutations(src, 'a.ts', { targeted: true });
    const line0 = mutations.filter(m => m.start < src.indexOf('\n'));
    const line1 = mutations.filter(m => m.start > src.indexOf('\n'));
    assert.ok(line0.length > 0);
    assert.ok(line0.every(m => m.ignored === 'checked upstream'));
    assert.ok(line1.length > 0);
    assert.ok(line1.every(m => m.ignored === undefined));
  });

  it('suppresses next line when tmt:ignore is on a standalone comment line', () => {
    const src = [
      '// tmt:ignore legacy behavior',
      'export const a = (x: number) => x >= 10;',
      'export const b = (x: number) => x >= 20;',
    ].join('\n');
    const lines = tmtIgnoreLines(src);
    assert.equal(lines.has(0), false);
    assert.equal(lines.get(1), 'legacy behavior');
    assert.equal(lines.has(2), false);

    const swaps = ignoredSwaps(Buffer.from(src), 'a.ts');
    assert.equal(swaps.size, 1);
  });

  it('supports block comments and ignores tmt:ignore inside string literals', () => {
    const src = [
      'export const msg = "// tmt:ignore not a comment";',
      '/* tmt:ignore block reason */ export const a = (x: number) => x >= 10;',
    ].join('\n');
    const lines = tmtIgnoreLines(src);
    assert.equal(lines.has(0), false);
    assert.equal(lines.get(1), 'block reason');
  });

  it('defaults reason when omitted', () => {
    const lines = tmtIgnoreLines('export const a = (x: number) => x >= 10; // tmt:ignore');
    assert.equal(lines.get(0), 'Ignored using tmt:ignore');
  });
});

describe('baseline v2 stable IDs and suppression', () => {
  const diagA = {
    kind: 'INPUT GAP',
    location: { file: 'src/cart.ts', line: 10, column: 5 },
    rule: 'nullish-fallback/v1',
    expression: 'count ?? 10',
  };
  const diagAMoved = {
    ...diagA,
    location: { file: 'src/cart.ts', line: 42, column: 9 },
  };
  const diagB = {
    kind: 'ASSERTION GAP',
    location: { file: 'src/cart.ts', line: 20, column: 3 },
    rule: 'arithmetic-swap/v1',
    expression: 'a * b',
  };

  it('produces identical stable IDs when lines move and disambiguates duplicates by occurrence', () => {
    assert.equal(findingId(diagA, 0), findingId(diagAMoved, 0));
    const dup = annotateFindingIds([diagA, diagAMoved]);
    assert.notEqual(dup[0].findingId, dup[1].findingId);
  });

  it('writes, loads, and applies a v2 baseline', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-baseline-'));
    try {
      const file = resolve(dir, 'baseline.json');
      const written = writeBaseline(file, [diagA]);
      assert.equal(written.version, 2);
      assert.equal(written.findings.length, 1);

      const ids = loadBaseline(file);
      assert.equal(ids.size, 1);

      const report = { diagnostics: [diagAMoved, diagB] };
      const filtered = applyBaseline(report, ids);
      assert.equal(filtered.diagnostics.length, 1);
      assert.equal(filtered.diagnostics[0].rule, 'arithmetic-swap/v1');
      assert.deepEqual(filtered.suppressed, { baseline: 1, ids: [written.findings[0].id] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed or unsupported baseline versions', () => {
    assert.throws(() => parseBaseline('{invalid'), /Invalid baseline JSON/);
    assert.throws(() => parseBaseline(JSON.stringify({ version: 99, findings: [] })), /Unsupported baseline format/);
  });

  it('covers every PICT row in verification/pict/baseline-suppression.tsv', () => {
    const rows = readFileSync(new URL('../verification/pict/baseline-suppression.tsv', import.meta.url), 'utf8')
      .trim().split('\n').slice(1).map(line => line.split('\t'));
    assert.ok(rows.length >= 20);
    for (const [inlineComment, baselineMode] of rows) {
      if (inlineComment === 'SameLine') {
        assert.ok(tmtIgnoreLines('const x = a >= 1; // tmt:ignore ok').has(0));
      } else if (inlineComment === 'PrevLine') {
        assert.ok(tmtIgnoreLines('// tmt:ignore ok\nconst x = a >= 1;').has(1));
      } else if (inlineComment === 'BlockSameLine') {
        assert.ok(tmtIgnoreLines('/* tmt:ignore ok */ const x = a >= 1;').has(0));
      }
      if (baselineMode === 'ApplyMatch' || baselineMode === 'ApplyMovedLine') {
        const ids = new Set([findingId(diagA, 0)]);
        const out = applyBaseline({ diagnostics: [baselineMode === 'ApplyMovedLine' ? diagAMoved : diagA] }, ids);
        assert.equal(out.diagnostics.length, 0);
        assert.equal(out.suppressed.baseline, 1);
      } else if (baselineMode === 'ApplyMismatch') {
        const ids = new Set(['tmt-0000000000000000']);
        const out = applyBaseline({ diagnostics: [diagA] }, ids);
        assert.equal(out.diagnostics.length, 1);
      }
    }
  });
});
