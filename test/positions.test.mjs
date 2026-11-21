import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { byteLocations } from '../src/extract.mjs';

function expected(source, offsets) {
  return offsets.flatMap(offset => {
    const lines = source.toString('utf8', 0, offset).split(/\r\n|[\n\r\u2028\u2029]/);
    return [lines.length, lines.at(-1).length + 1];
  });
}

const samples = { Plain: 'a', LF: '\n', CR: '\r', CRLF: '\r\n', LS: '\u2028', PS: '\u2029', BMP: 'é', Astral: '🐈' };
const rows = readFileSync(new URL('../verification/pict/candidate-positions.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [marker, width, buffer] = row.split('\t');
  test(`positions: ${marker} ${width} ${buffer}`, () => {
    const text = 'x'.repeat(Number(width)) + samples[marker] + 'y'.repeat(21) + samples[marker] + 'z';
    const source = buffer === 'Aligned' ? Buffer.from(text) : Buffer.from('!' + text + '?').subarray(1, -1);
    let offset = 0;
    const offsets = [0];
    for (const character of text) {
      offset += Buffer.byteLength(character);
      offsets.push(offset);
    }
    const sparse = [0, Number(width), Number(width) + Buffer.byteLength(samples[marker]), source.length];
    for (const requested of [offsets, sparse, [source.length]]) {
      assert.deepEqual([...byteLocations(source, requested)], expected(source, requested));
    }
  });
}

test('positions agree across every ASCII byte and vector lane', () => {
  for (let lane = 0; lane < 16; lane++) {
    for (let code = 0; code < 128; code++) {
      const source = Buffer.from('a'.repeat(lane) + String.fromCharCode(code) + 'b'.repeat(64) + '\r\n');
      const offsets = [40, source.length - 1, source.length];
      assert.deepEqual([...byteLocations(source, offsets)], expected(source, offsets));
    }
  }
});
