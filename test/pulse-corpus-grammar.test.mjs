import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractTypeScript } from '../src/typescript-extraction.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function rows(matrix) {
  return readFileSync(new URL('../verification/pict/' + matrix + '.tsv', import.meta.url), 'utf8')
    .trim().split(/\r?\n/).slice(1).map(line => line.split('\t'));
}

function compare(source, options) {
  const actual = extract(source, { ...options, requireNative: true });
  for (const reference of [extractTypeScript(source, options), extractYuku(source, options)]) {
    assert.equal(actual.path === 'diagnostic', reference.path === 'diagnostic', source);
    assert.deepEqual(actual.candidates, reference.candidates, source);
  }
  return actual;
}

for (const [mode, directive, shape] of rows('pulse-script-sequence')) {
  test(`Pulse statement sequence: ${mode} ${directive} ${shape}`, () => {
    const suffix = {
      CommonJS: 'function eligible(age) { return age >= limit; }\nmodule.exports = eligible;',
      DynamicImport: 'void import("./helper.js");\nconst selected = left > right;',
      StaticImport: 'import "./helper.js";\nconst selected = left > right;',
      Export: 'export const selected = left > right;',
      Broken: 'const before = left <= right;\nconst =',
    }[shape];
    const input = (directive === 'Strict' ? "'use strict'\n\n" : '') + 'const limit = 18;\n' + suffix;
    const actual = compare(input, { file: 'logic.js', mode: mode.toLowerCase() });
    const allowed = shape !== 'Broken' && (mode === 'Module' || !['Export', 'StaticImport'].includes(shape));
    assert.equal(actual.path, allowed ? 'fast' : 'diagnostic');
    assert.equal(actual.candidates.length, Number(allowed));
  });
}

for (const [form, member, tail] of rows('pulse-enum')) {
  test(`Pulse enum: ${form} ${member} ${tail}`, () => {
    const prefix = { Regular: '', Exported: 'export ', Const: 'const ' }[form];
    const body = { Empty: '', Quoted: '"Open" = 1,', Comparison: 'Open = Number(left >= right), Closed = 1,' }[member];
    const input = `/* 🧪 */ ${prefix}enum Mode { ${body} }\nconst flag = item > limit;` +
      (tail === 'Invalid' ? '\nconst =' : '');
    const actual = compare(input, { file: 'enum.ts', mode: 'module' });
    assert.equal(actual.path, tail === 'Invalid' ? 'diagnostic' : 'fast');
    assert.equal(actual.candidates.length, tail === 'Invalid' ? 0 : member === 'Comparison' ? 2 : 1);
  });
}
