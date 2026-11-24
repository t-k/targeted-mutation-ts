import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planUndo } from '../src/change-undone.mjs';
import { renderText } from '../src/cli-output.mjs';

function repository(action) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-subhunk-test-')));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    return action(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function patchOf(old, current) {
  return repository((root, git) => {
    writeFileSync(join(root, 'f.ts'), old);
    git('add', '.');
    git('commit', '-qm', 'old');
    writeFileSync(join(root, 'f.ts'), current);
    return git('diff', '--no-color', '--unified=0', 'HEAD', '--', 'f.ts');
  });
}

const apply = (current, trial) =>
  Buffer.concat([current.subarray(0, trial.edit[0]), trial.replacement, current.subarray(trial.edit[1])]).toString();

const rows = readFileSync(new URL('../verification/pict/undo-subhunk.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1)
  .map(line => line.split('\t'));

test('the undo-subhunk PICT table has every required seed', () => {
  const seeds = readFileSync(new URL('../verification/pict/undo-subhunk.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
  const table = new Set(rows.map(row => row.join('\t')));
  for (const seed of seeds) assert.ok(table.has(seed), seed);
});

for (const [kind, position, multiChange, trailingComma] of rows) {
  test(`PICT subhunk: ${kind} / ${position} / ${multiChange} / trailing=${trailingComma}`, () => {
    let oldText;
    let curText;
    const tc = trailingComma === 'Yes' ? ',' : '';
    if (kind === 'AndTerm' || kind === 'OrTerm') {
      const op = kind === 'AndTerm' ? '&&' : '||';
      oldText = 'export const ok = (a: boolean, b: boolean, c: boolean, d: boolean) => a;\n';
      if (multiChange === 'SingleAdded') {
        const expr = position === 'First' ? `b ${op} a` : `a ${op} b`;
        curText = `export const ok = (a: boolean, b: boolean, c: boolean, d: boolean) => ${expr};\n`;
      } else {
        const expr = position === 'First' ? `b ${op} c ${op} a`
          : position === 'Middle' ? `a ${op} b ${op} c`
            : `a ${op} b ${op} c`;
        curText = `export const ok = (a: boolean, b: boolean, c: boolean, d: boolean) => ${expr};\n`;
      }
    } else {
      const prop = (name, val) => kind === 'ObjectShorthand' ? name : `${name}: ${val}`;
      oldText = `export const build = (a: number, b: number, c: number) => ({ ${prop('a', '1')}${tc} });\n`;
      if (multiChange === 'SingleAdded') {
        const props = position === 'First' ? [prop('b', '2'), prop('a', '1')] : [prop('a', '1'), prop('b', '2')];
        curText = `export const build = (a: number, b: number, c: number) => ({ ${props.join(', ')}${tc} });\n`;
      } else {
        const props = position === 'First' ? [prop('b', '2'), prop('c', '3'), prop('a', '1')]
          : position === 'Middle' ? [prop('a', '1'), prop('b', '2'), prop('c', '3')]
            : [prop('a', '1'), prop('b', '2'), prop('c', '3')];
        curText = `export const build = (a: number, b: number, c: number) => ({ ${props.join(', ')}${tc} });\n`;
      }
    }
    const old = Buffer.from(oldText);
    const current = Buffer.from(curText);
    const patch = patchOf(old, current);
    const planned = planUndo('f.ts', old, current, patch);
    const subhunks = planned.filter(t => t.subhunk !== undefined);
    if (multiChange === 'SingleAdded') {
      // Removing the single added term/property is identical to the whole hunk: no duplicate sub-hunk.
      assert.equal(subhunks.length, 0);
    } else {
      // Two added items -> at least two independent parseable sub-hunks, each leaving the other intact.
      assert.equal(subhunks.length, 2, JSON.stringify(subhunks.map(s => apply(current, s))));
      for (const s of subhunks) {
        assert.equal(s.parses, true);
        const undone = apply(current, s);
        assert.notEqual(undone, curText);
        assert.notEqual(undone, oldText);
      }
    }
  });
}

test('end-to-end --undo-changes catches an untested added && term and an untested added object property hidden in a tested hunk', () => repository((root, git) => {
  writeFileSync(join(root, 'subject.ts'), `export const allow = (a: boolean, b: boolean, c: boolean) => a;
export const make = (a: number) => ({ a });
`);
  writeFileSync(join(root, 'subject.test.ts'), `import { expect, it } from 'vitest';
import { allow, make } from './subject';
it('checks b but forgets c', () => {
  expect(allow(true, true, true)).toBe(true);
  expect(allow(true, false, true)).toBe(false);
});
it('checks b property but forgets c property', () => {
  expect(make(1).b).toBe(2);
});
`);
  git('add', '.');
  git('commit', '-qm', 'base');
  writeFileSync(join(root, 'subject.ts'), `export const allow = (a: boolean, b: boolean, c: boolean) => a && b && c;
export const make = (a: number) => ({ a, b: 2, c: 3 });
`);
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--since', 'HEAD', '--undo-changes', '--format', 'json'],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  const undoMutants = report.mutants.filter(m => m.rule === 'change-undone/v1');
  // The whole-hunk undo is killed (because b is tested), while sub-hunk undos for `&& c` and `c: 3` survive!
  assert.ok(undoMutants.some(m => m.subhunk === 'logical-term' && m.status === 'survived'), JSON.stringify(undoMutants));
  assert.ok(undoMutants.some(m => m.subhunk === 'object-property' && m.status === 'survived'), JSON.stringify(undoMutants));
  const untested = report.diagnostics.filter(d => d.kind === 'UNTESTED CHANGE');
  assert.ok(untested.some(d => d.subhunk === 'logical-term'));
  assert.ok(untested.some(d => d.subhunk === 'object-property'));
  const text = renderText(report);
  assert.match(text, /UNTESTED CHANGE/);
}));
