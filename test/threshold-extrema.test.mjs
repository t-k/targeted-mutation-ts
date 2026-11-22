import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runDecisionBatch } from '../src/lean-replay.mjs';
import { thresholdGap } from '../src/threshold.mjs';

const matrix = readFileSync(new URL('../verification/pict/threshold-extrema.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

test('Lean threshold calls transmit only the extremal observations and preserve every interval', () => {
  const requests = matrix.map(([shape, position, domain]) => {
    const min = domain === 'Safe' ? Number.MIN_SAFE_INTEGER : -5;
    const max = domain === 'Safe' ? Number.MAX_SAFE_INTEGER : 15;
    const threshold = { Lower: min, Interior: 5, Upper: max }[position];
    const lower = Math.max(min, threshold - 2);
    const upper = Math.min(max, threshold + 2);
    const longer = [
      min, max, lower, upper, lower, min, max, upper, lower,
    ];
    const observations = {
      Both: longer, Below: [min, lower, lower, min], Above: [max, upper, upper, max],
      Exact: [threshold, threshold, threshold, threshold], Empty: [],
      InvalidTail: [...longer, 1.5],
    }[shape];
    if (domain === 'Outside' && observations.length) observations.push(min - 1);
    return { threshold, min, max, observations };
  });
  const module = new URL('../src/threshold.mjs', import.meta.url).href;
  const program = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
const native = createRequire(process.cwd() + '/package.json')('node:child_process');
const delegate = native.spawnSync;
let observed;
native.spawnSync = (command, args, options) => {
  if (args[0] === 'thresholds') observed = JSON.parse(options.input);
  return delegate(command, args, options);
};
syncBuiltinESMExports();
const { checkedThresholdGaps } = await import(${JSON.stringify(module)});
const answers = checkedThresholdGaps(JSON.parse(readFileSync(0, 'utf8')));
console.log(JSON.stringify({ answers, observed }));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    input: JSON.stringify(requests), encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const { answers, observed } = JSON.parse(result.stdout);
  assert.deepEqual(answers, runDecisionBatch(requests, ['thresholds']));
  assert.deepEqual(answers, requests.map(({ threshold, observations, min, max }) =>
    thresholdGap(threshold, observations, min, max)));
  assert.deepEqual(observed, requests.map(({ threshold, observations, min, max }) => {
    const invalid = observations.some(x => !Number.isSafeInteger(x) || x < min || x > max);
    const below = observations.filter(x => x < threshold);
    const above = observations.filter(x => x >= threshold);
    const extrema = invalid ? [] : [
      ...(below.length ? [Math.max(...below)] : []),
      ...(above.length ? [Math.min(...above)] : []),
    ];
    return { threshold, min, max, observations: extrema };
  }));
});
