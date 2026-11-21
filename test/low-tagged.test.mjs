import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const result = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  if (path) assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const tags = { Name: 'tag', Member: 'String.raw', Call: 'factory(x > min)', LineBreak: 'tag\n' };
const contents = { Plain: 'field < limit', Substitution: 'prefix ${a >= b} suffix', RawEscape: String.raw`\d+\xZ\u{}\08` };
const rows = readFileSync(new URL('../verification/pict/low-tagged.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [tag, content, suffix] = row.split('\t');
  test(`Low* tagged template: ${tag} ${content} ${suffix}`, () => {
    const source = 'const value = ' + tags[tag] + '`' + contents[content] + '` < limit;' +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('tagged templates distinguish raw delimiters, chaining, and optional calls', () => {
  compare('const ok = (maybe?.tag)`x ${count >= max}``second`.length < limit;', 'fast');
  compare('const ok = String.raw`escaped \\`${left < right} \\${raw > text} ` <= max;', 'fast');
  compare('const node = <Widget value={String.raw`x ${amount < min}` > max} />;', 'fast', { file: 'view.tsx' });
  compare('const ok = maybe?.tag`x ${count >= max}` < limit;', 'diagnostic');
  compare('const ok = maybe?.`x ${count >= max}` < limit;', 'diagnostic');
  compare('const ok = tag`x ${count >= max` < limit;', 'diagnostic');
  compare('const ok = tag`x ${count >= max}\\', 'diagnostic');
  compare('const ok = `\\xZ` < limit;', 'diagnostic');
});

test('type arguments before templates keep their TypeScript interpretation', () => {
  for (const source of [
    'const r = tag < T > `raw` < limit;',
    'const r = tag<T>`raw ${a < b}` < limit;',
    'const r = (fn())<T>`raw` < limit;',
    'const r = tag<T, U>`raw` < limit;',
  ]) compare(source);
});
