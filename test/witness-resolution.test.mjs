import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { importMatches } from '../src/witness-fixtures.mjs';

const rows = readFileSync(new URL('../verification/pict/witness-imports.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(line => line.trim().split('\t'));

for (const [spelling, layout, candidates] of rows) {
  test(`witness resolution: ${spelling} ${layout} ${candidates}`, () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-imports-')));
    const target = { TS: 'src/query.ts', TSX: 'src/query.tsx', Index: 'src/query/index.ts' }[layout];
    const imported = spelling === 'Explicit' ? '../' + target
      : spelling === 'JsAlias' ? '../src/query.js' : '../src/query';
    try {
      const source = join(project, target);
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, '');
      if (candidates === 'Multiple') {
        writeFileSync(join(project, layout === 'TS' ? 'src/query.tsx' : 'src/query.ts'), '');
      }
      assert.equal(importMatches('test/query.test.ts', imported, target, project), candidates === 'Unique');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

test('recognizes dotted filenames with an omitted TypeScript extension', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-dotted-import-')));
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'src/query.service.ts'), '');
    assert.equal(importMatches('test/query.test.ts', '../src/query.service', 'src/query.service.ts', project), true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
