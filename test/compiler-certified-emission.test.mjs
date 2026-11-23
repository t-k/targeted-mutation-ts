import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCases, referenceObjections } from '../scripts/audit-compiler-v8.mjs';
import { ambiguityCases, certificationCases } from '../scripts/generate-compiler-validation-cases.mjs';
import { compile } from '../src/compiler.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const rows = readFileSync(new URL('../verification/pict/compiler-certified-emission.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const fixtures = certificationCases();
const byName = new Map(fixtures.map(fixture => [fixture.file, fixture]));
const certifiedShapes = new Set(['annotation', 'arguments', 'assertion', 'markers', 'erased-statement', 'overload',
  'modifiers', 'literal-enum', 'ambient-const-reference', 'ambient-class-default',
  'local-overload', 'optional-field-line', 'optional-method-signature', 'default-overload']);
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

test('published projections the retired guard objects to have the syntax TypeScript emits', { timeout: 180_000 }, async () => {
  const built = spawnSync(process.execPath, ['scripts/build-compiler.mjs', '--audit-v8'], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const cases = ambiguityCases();
  assert.deepEqual(cases, ambiguityCases());
  const report = auditCases(cases);
  assert.deepEqual(report.certifiedRejections, []);
  // The scan was conservative: it objects to hundreds of projections that are correct.
  assert.ok(report.guardObjections.length > 100, String(report.guardObjections.length));
  const reference = await referenceObjections(cases, report.guardObjections);
  assert.deepEqual(reference.mismatches, []);
  assert.ok(reference.matched > 100, JSON.stringify(reference));
});

test('a JavaScript module is published from the certified parse and other JavaScript still asks V8', { timeout: 120_000 }, () => {
  const built = spawnSync(process.execPath, ['scripts/build-compiler.mjs', '--audit-v8'], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const source = text => Buffer.from(text).toString('base64');
  const module = 'import { x } from "./x.js";\n/** doc */\nexport const n = x < 1 ? [x] : `${x}`;\n';
  const cases = [
    { file: 'module.mjs', mode: 'module', source: source(module) },
    { file: 'module.js', mode: 'module', source: source(module) },
    { file: 'late.mjs', mode: 'module', source: source('const n = 1;\nexport { n };\n') },
    { file: 'late.js', mode: 'module', source: source('const n = 1;\nexport { n };\n') },
    { file: 'typed.mjs', mode: 'module', source: source('export const n: number = 1;\n') },
    { file: 'enum.mjs', mode: 'module', source: source('export enum E { A }\n') },
    { file: 'field.mjs', mode: 'module', source: source('export class C { private x = 1; }\n') },
    { file: 'script.js', mode: 'module', source: source('const n = 42;\n') },
    { file: 'effects.mjs', mode: 'module', source: source('globalThis.n = 42;\n') },
    { file: 'directive.mjs', mode: 'module', source: source('export const n = 1; /// <reference path="x" />\n') },
  ];
  const report = auditCases(cases, { decisions: true });
  assert.deepEqual(report.certifiedRejections, []);
  const decisions = file => report.decisions.filter(decision => decision.file === file);
  // A .js name is tried only when it begins with a static import or export.
  assert.deepEqual(decisions('late.js').filter(decision => decision.certified), []);
  assert.equal(compile(Buffer.from('const n = 1;\nexport { n };\n'), { file: 'late.js' }).backend, 'javascript');
  for (const file of ['module.mjs', 'module.js', 'late.mjs']) {
    assert.deepEqual(decisions(file), [{ file, phase: 'ts', certified: true, reason: 'accepted' }], file);
    const { source: encoded } = cases.find(test => test.file === file);
    const result = compile(Buffer.from(encoded, 'base64'), { file });
    assert.deepEqual([result.backend, result.code], ['javascript', Buffer.from(encoded, 'base64').toString()], file);
  }
  // TypeScript syntax in a JavaScript file is never accepted by the parse alone.
  for (const file of ['typed.mjs', 'enum.mjs', 'field.mjs']) {
    const result = compile(Buffer.from(cases.find(test => test.file === file).source, 'base64'), { file });
    assert.notEqual(result.backend, 'javascript', file);
    assert.equal(result.code, null, file);
  }
  for (const file of ['script.js', 'effects.mjs', 'directive.mjs']) {
    assert.deepEqual(decisions(file).filter(decision => decision.certified), [], file);
  }
  assert.equal(compile(Buffer.from('const n = 42;\n'), { file: 'script.js' }).code, '"use strict";\nconst n = 42;\n');
  assert.equal(compile(Buffer.from('globalThis.n = 42;\n'), { file: 'effects.mjs' }).backend, 'javascript');
});
