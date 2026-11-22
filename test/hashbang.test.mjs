import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

const matrix = readFileSync(new URL('../verification/pict/hashbang.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const endings = { LF: '\n', CRLF: '\r\n', CR: '\r', LS: '\u2028', PS: '\u2029' };

for (const [dialect, line, variant] of matrix) {
  test(`Low* hashbang: ${dialect} ${line} ${variant}`, () => {
    const prefix = variant === 'Misplaced' ? ' ' : '';
    const tail = variant === 'Broken' ? 'const ok = a < b; const =' : 'const ok = a < b;';
    const source = prefix + '#!/usr/bin/env node 🧪 < ignored' + (line === 'EOF' ? '' : endings[line] + tail);
    const options = { dialect: dialect.toLowerCase(), requireNative: true };
    const result = extract(source, options);
    const reference = line === 'LS' || line === 'PS' ? extractFallback(source, options) : extractYuku(source, options);
    assert.equal(result.path, variant === 'Valid' ? 'fast' : 'diagnostic');
    assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
  });
}
