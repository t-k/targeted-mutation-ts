import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const result = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  if (path) assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  return result;
}

const patterns = {
  Class: String.raw`/^[A-Z_\d-]+[<>/]$/`,
  Group: String.raw`/\.(?:html|json|xhtml)$/`,
  Lookaround: String.raw`/(?<![\w$.])(?=key)(key)(?!word)/`,
  Quantified: String.raw`/^\.{1,2}?\/[a-z]{2,}a+?$/`,
};
const flags = { None: '', Multiple: 'dgi', Unicode: 'u' };
const rows = readFileSync(new URL('../verification/pict/low-regex.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [pattern, flag, suffix] = row.split('\t');
  test(`Low* regex: ${pattern} ${flag} ${suffix}`, () => {
    const source = `const ok = ${patterns[pattern]}${flags[flag]}.test(value) && value.length >= limit;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('regex tokens retain complete operands and separate division from literal syntax', () => {
  for (const source of [
    String.raw`const ok = /^#!.*\n/.test(source) && total / count >= limit;`,
    String.raw`const ok = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i < target;`,
    String.raw`const ok = handle(/[^<>{}]/gu, /[\-\]/]/y) > target;`,
    String.raw`const ok = a < /foo(?:bar|$)/ms;`,
    String.raw`const ok = /^[\x61-\x7a]+$/u.test(value) && value < other;`,
  ]) compare(source, 'fast');
  compare(String.raw`const view = <A>{/[:<>]/.test(value) && amount < max}</A>;`, 'fast', { dialect: 'tsx' });
});

test('unsupported or invalid regex grammar cannot suppress diagnostics or emit extra candidates', () => {
  for (const regex of [
    '/[z-a]/', '/[a-\\d]/u', '/(/', '/foo)/u', '/foo/**', '/a++/', '/^*/u',
    '/a{5,3}/', '/a{1,2}?*/', '/a/uu', '/a/gz', '/[a]/uv', '/a\\z/u',
    '/(?<letter>a)\\k<letter>/u', '/\\p{Letter}/u', '/[a-z&&[^x]]/v',
  ]) assert.notEqual(compare(`const earlier = a < b; const value = ${regex};`).path, 'fast', regex);
});

test('long flat regex patterns and character classes do not grow the native stack', () => {
  const module = new URL('../src/extract.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import { extract } from ${JSON.stringify(module)};
    for (const pattern of ['a'.repeat(100_000), '[' + 'a'.repeat(100_000) + ']', '(?:' + 'a'.repeat(100_000) + ')']) {
      const source = 'const ok = /' + pattern + '/ < limit;';
      const result = extract(source, { requireNative: true });
      assert.equal(result.path, 'fast');
      assert.deepEqual(result.candidates.map(site => source.slice(...site.left)), ['/' + pattern + '/']);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.signal ?? result.stderr);
});
