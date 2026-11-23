import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCases } from '../scripts/audit-compiler-v8.mjs';
import { certificationCases } from '../scripts/generate-compiler-validation-cases.mjs';
import { compile } from '../src/compiler.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const rows = readFileSync(new URL('../verification/pict/compiler-certified-emission.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const fixtures = certificationCases();
const byName = new Map(fixtures.map(fixture => [fixture.file, fixture]));
const certifiedShapes = new Set(['annotation', 'arguments', 'assertion', 'markers', 'erased-statement', 'overload',
  'modifiers', 'literal-enum', 'ambient-const-reference', 'ambient-class-default']);
// Parameter properties are lowered only on the TypeScript module route.
const propertyShapes = new Set(['parameter-property', 'parameter-property-derived']);
const isCertified = file => {
  const shape = file.split('/')[1];
  return certifiedShapes.has(shape) || (propertyShapes.has(shape) && file.endsWith('.ts'));
};

test('the certification matrix has one deterministic fixture for every PICT row', () => {
  assert.equal(byName.size, fixtures.length);
  assert.deepEqual(fixtures, certificationCases());
  for (const row of rows) {
    const [shape, dialect, newline, position] = row.split('\t');
    const fixture = byName.get(`certification/${shape}/${newline}/${position}.${dialect}`);
    assert.equal(fixture?.mode, 'module', row);
    const source = Buffer.from(fixture.source, 'base64').toString('utf8');
    assert.equal(source.includes('\r\n'), newline === 'crlf');
    assert.equal(source.includes('<i title='), dialect === 'tsx');
    assert.equal(source.startsWith('import '), position === 'after-import');
    assert.equal(source.startsWith('type Lead'), position === 'after-erased');
  }
});

test('every certification fixture keeps the backend, code and diagnostics of the validated compiler', () => {
  const baseline = JSON.parse(readFileSync(new URL('../verification/compiler-conformance/certified-emission-baseline.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(baseline).length, fixtures.length);
  for (const { file, source } of fixtures) {
    const result = compile(Buffer.from(source, 'base64'), { file });
    assert.deepEqual({
      backend: result.backend,
      codeSha256: result.code === null ? null : createHash('sha256').update(result.code).digest('hex'),
      diagnostics: result.diagnostics.map(diagnostic => diagnostic.code),
    }, baseline[file], file);
    if (isCertified(file)) assert.equal(result.backend, 'pulse', file);
  }
});

test('the audit build certifies exactly the expected shapes and V8 accepts every certified projection', { timeout: 120_000 }, () => {
  const built = spawnSync(process.execPath, ['scripts/build-compiler.mjs', '--audit-v8'], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const selected = rows.map(row => {
    const [shape, dialect, newline, position] = row.split('\t');
    return { shape, row, ...byName.get(`certification/${shape}/${newline}/${position}.${dialect}`) };
  });
  const report = auditCases(selected, { decisions: true });
  assert.deepEqual(report.certifiedRejections, []);
  for (const { shape, row, file } of selected) {
    const decisions = report.decisions.filter(decision => decision.file === file);
    const certified = decisions.filter(decision => decision.certified);
    if (isCertified(file)) {
      assert.equal(certified.length, 1, row);
      assert.equal(certified[0].reason, 'accepted', row);
    } else {
      assert.deepEqual(certified, [], row);
      if (shape === 'computed-enum' || shape === 'string-enum-implicit') {
        assert.deepEqual(decisions.filter(decision => decision.phase === 'ts' || decision.phase === 'tsx'), [], row);
      }
    }
  }
});
