import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const mode = { dialect: 'tsx', ...options };
  const input = Buffer.from(source);
  const result = extract(input, { ...mode, requireNative: true });
  const reference = extractFallback(input, mode);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const tags = {
  SelfClosing: '<Widget show={count < limit} visible />',
  Paired: '<Widget title="猫 > &lt;" {...makeProps(score >= 0)}>{/* ignored */}<b>{count < limit}</b> 序 &gt;</Widget>',
  Fragment: '<>{count > limit ? <A title="ok" /> : <B>🦀</B>}{count <= limit}</>',
};
const positions = {
  Initializer: jsx => `export const count = 0; export const element = ${jsx};`,
  Arrow: jsx => `const count = 0; const element = (limit: number) => (${jsx});`,
  Return: jsx => `import Widget from "./widget"; export function show(count: number) { return ${jsx}; }`,
};
const rows = readFileSync(new URL('../verification/pict/low-jsx-tree.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [tag, position, suffix] = row.split('\t');
  test(`Low* JSX: ${tag} ${position} ${suffix}`, () => {
    const source = positions[position](tags[tag]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('JSX mode preserves operands and refuses invalid text or mismatched names', () => {
  compare('const ok = <A>{a < b}</A> <= <B>{b > c}</B>;', 'fast');
  compare('const ok = <a-b enabled data-label = ">" >{x < y}<br /></a-b>;', 'fast');
  compare('const ok = <A image=<B/>>{x < y}</A>;', 'fast');
  compare('const ok = <A active="x"test={a < b} />;', 'fast');
  for (const source of [
    'const ok = <A><B/>{a < b}</C>;',
    'const ok = <A>more } text</A>;',
    'const ok = <A>more > text</A>;',
    'const ok = <>{a<b}</A>;',
    'const ok = <A active={} show={a < b} />;',
  ]) compare(source, 'diagnostic');
  compare('const ok = <A>{a < b}</A>;', 'diagnostic', { dialect: 'ts' });
});

test('nested JSX still delegates the disabled disjunction rule', () => {
  const source = 'const view = <Tag>{count < limit && <button disabled={busy || invalid} />}</Tag>;';
  for (const logical of [false, true]) compare(source, 'fallback', { logical });
});

test('a named attribute immediately after a bare fragment preserves diagnostics', () => {
  compare('const view = <X a=<></> b={x < y}/>;', 'diagnostic');
  compare('const view = <X a={<></>} b={x < y}/>;', 'fast');
  compare('const view = <X a=<></> {...props} b={x < y}/>;', 'fast');
});
