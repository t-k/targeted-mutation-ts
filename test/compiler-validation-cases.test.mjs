import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { generatedCases, mutateCases } from '../scripts/generate-compiler-validation-cases.mjs';

test('generated validation inputs include every required syntax and trivia combination', () => {
  const fixtures = generatedCases();
  assert.equal(fixtures.length, 252);
  assert.deepEqual(fixtures, generatedCases());
  const byName = new Map(fixtures.map(fixture => [fixture.file, fixture]));
  assert.equal(byName.size, fixtures.length);
  const cases = readFileSync(new URL('../verification/pict/compiler-validation-cases.tsv', import.meta.url), 'utf8')
    .trimEnd().split(/\r?\n/).slice(1);
  for (const row of cases) {
    const [shape, newline, prologue, dialect] = row.split('\t');
    const fixture = byName.get(`generated/${shape}/${newline}/${prologue}.${dialect}`);
    assert.equal(fixture?.mode, 'module');
    const source = Buffer.from(fixture.source, 'base64').toString('utf8');
    assert.match(source, /export const output = result/);
    assert.ok(source.includes({ lf: '\n', crlf: '\r\n', unicode: '\u2028' }[newline]));
    assert.equal(source.includes('<i title='), dialect === 'tsx');
    if (prologue === 'comment') assert.match(source, /^\/\* prefix/);
    if (prologue === 'directive') assert.match(source, /^"use strict"/);
  }
});

test('mutations select bounded, eligible module fixtures and preserve the original source prefix', () => {
  const source = Buffer.from('export const value = "日本語";').toString('base64');
  const corpus = Array.from({ length: 200 }, (_, index) => ({ file: `${index}.ts`, source, mode: 'module' }));
  const script = [{ file: 'ignored.ts', source, mode: 'script' }, { file: 'declarations.d.ts', source, mode: 'module' }];
  const variants = mutateCases('local.json', script.concat(corpus));
  assert.equal(variants.length, 36);
  for (const variant of variants) {
    assert.match(variant.file, /^mutation\/local\/[0-3]\/\d+\.ts$/);
    assert.match(Buffer.from(variant.source, 'base64').toString('utf8'), /^export const value = "日本語";\n/);
  }
});
