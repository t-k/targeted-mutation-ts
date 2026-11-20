import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [model, seeds, table] = process.argv.slice(2);
if (!table) throw new Error('Usage: pict-check MODEL SEEDS TABLE');
const read = path => readFileSync(path, 'utf8').trim().split(/\r?\n/);
const [header, ...rows] = read(table);
const [seedHeader, ...required] = read(seeds);
assert.equal(header, seedHeader);
for (const seed of required) assert.ok(rows.includes(seed), `Missing mandatory case: ${seed}`);

const exhaustive = spawnSync('pict', [model, '/o:max'], { encoding: 'utf8' });
assert.equal(exhaustive.status, 0, exhaustive.error?.message ?? exhaustive.stderr);
const [fullHeader, ...full] = exhaustive.stdout.trim().split(/\r?\n/);
assert.equal(header, fullHeader);
const allowed = new Set(full);
for (const row of rows) assert.ok(allowed.has(row), `Invalid case: ${row}`);

function pairs(tableRows) {
  const result = new Set();
  for (const row of tableRows) {
    const values = row.split('\t');
    for (let a = 0; a < values.length; a++) {
      for (let b = a + 1; b < values.length; b++) result.add(JSON.stringify([a, b, values[a], values[b]]));
    }
  }
  return result;
}
const expected = pairs(full);
assert.deepEqual(pairs(rows), expected);
console.log(`pict-check: ${rows.length} rows cover ${expected.size} valid pairs and ${required.length} required cases`);
