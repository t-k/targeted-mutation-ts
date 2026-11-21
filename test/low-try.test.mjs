import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const result = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const endings = {
  Bound: 'catch (error: unknown) { if (status(error) >= 400) report(error); }',
  Pattern: 'catch ({ code: error, kind }) { if (error <= 10) report(kind); }',
  Unbound: 'catch { if (failures > 2) report(); }',
  Finally: 'finally { const done = count >= 2; finish(done); }',
  Both: 'catch (error) { report(error < 1); } finally { finish(count > 2); }',
};
const wrap = {
  Module: body => body,
  Function: body => `function scan(data: Item[]) { ${body} return count > 0; }`,
  AsyncLoop: body => `async function scan() { for (const item of items) { ${body} if (await cost(item) > max) break; } }`,
};
const rows = readFileSync(new URL('../verification/pict/low-try.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [handler, context, suffix] = row.split('\t');
  test(`Low* try: ${handler} ${context} ${suffix}`, () => {
    const source = wrap[context](`try { const ok = count < limit; run(ok); } ${endings[handler]}`) +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('try handlers share the surrounding control permissions and restore scratch bindings', () => {
  compare('while (i < max) { try { continue; } catch (e) { break; } finally { finish(i > 0); } }', 'fast');
  compare('function scan(error) { try { const error = 1; use(error); } catch (error) { { const error = 2; use(error > 0); } } finally { let error; } return error < 3; }', 'fast');
  compare('try { const ok = value < limit; } catch { const ok = left >= right; }', 'fast', { mode: 'script' });
  compare('if (x < y) try { run(); } catch { report(); } else recover();', 'fast');
  for (const source of [
    'try { run(a < b); }',
    'try run(a < b); finally {}',
    'try { run(a < b); } catch () {}',
    'try { run(a < b); } catch ({ a: x, b: x }) {}',
    'try { run(a < b); } catch (x) { const x = 0; }',
    'try { run(a < b); } catch (x) { { const x = 1; } const x = 0; }',
    'try { run(a < b); } catch { return true; }',
    'try { run(a < b); } finally { continue; }',
    'try { run(a < b); } finally {} catch {}',
  ]) compare(source, 'diagnostic');
});

test('nested try blocks complete or delegate at the existing depth boundary', () => {
  for (const depth of [64, 65]) {
    const source = 'try { '.repeat(depth) + 'a < b;' + ' } finally {} '.repeat(depth);
    compare(source, depth === 64 ? 'fast' : 'fallback');
  }
});
