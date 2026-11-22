import assert from 'node:assert/strict';
import test from 'node:test';
import { byteOffsets } from '../src/source-text.mjs';

function reference(source) {
  const offsets = Array(source.length + 1).fill(0);
  let unit = 0;
  for (const point of source) {
    offsets[unit] = Buffer.byteLength(source.slice(0, unit));
    unit += point.length;
  }
  offsets[unit] = Buffer.byteLength(source);
  return offsets;
}

test('UTF-8 offset widths agree with Buffer for every UTF-16 code unit', () => {
  for (let unit = 0; unit <= 0xffff; unit++) {
    const source = String.fromCharCode(unit);
    const offsets = byteOffsets(source);
    assert.equal(offsets[0], 0);
    assert.equal(offsets[1], Buffer.byteLength(source));
  }
});

test('UTF-8 offset slots agree with Buffer across adjacent encoding boundaries', () => {
  const boundaries = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff];
  for (const left of boundaries) {
    for (const right of boundaries) {
      const source = 'aé海🧪' + String.fromCharCode(left, right) + 'z🧪';
      assert.deepEqual([...byteOffsets(source)], reference(source));
    }
  }
  assert.deepEqual([...byteOffsets('')], [0]);
});
