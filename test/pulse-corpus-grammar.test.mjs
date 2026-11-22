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

for (const [directive, form, mode] of rows('pulse-strict-script')) {
  test(`Pulse nested functions: ${directive} ${form} ${mode}`, () => {
    const prefix = {
      Semicolon: "/* before */ 'use strict';\n",
      ASI: '"use strict" /* newline\n */\n',
      Absent: '',
      Extended: "'use strict'\n+ value;\n",
      Escaped: String.raw`'use\x20strict';` + '\n',
    }[directive];
    const nested = 'function compare() { return value >= limit; }';
    const body = {
      FunctionBody: nested,
      NestedBlock: 'if (flag) { ' + nested + ' }',
      WhileBody: 'while (flag) ' + nested,
    }[form];
    const source = prefix + 'const limit = 18; function main(value) { ' + body + ' }';
    const actual = compare(source, { file: 'nested.js', mode: mode.toLowerCase() });
    const strict = ['Semicolon', 'ASI'].includes(directive);
    assert.equal(actual.path, form === 'WhileBody' ? 'diagnostic' : mode === 'Module' || strict ? 'fast' : 'fallback');
    assert.equal(actual.candidates.length, Number(form !== 'WhileBody'));
  });
}

for (const [pattern, mode, tail] of rows('pulse-legacy-regex')) {
  test(`Pulse regex: ${pattern} ${mode} ${tail}`, () => {
    const regex = {
      IdentityColon: String.raw`^\:`,
      BareBrace: String.raw`^\s*{`,
      Counted: '^x{1,3}$',
      Backwards: '^x{3,1}$',
    }[pattern];
    const source = 'const keep = a > b; const pattern = /' + regex + '/' + (mode === 'Unicode' ? 'u' : '') + ';' +
      (tail === 'Invalid' ? '\nconst =' : '');
    const actual = compare(source, { file: 'regex.js', mode: 'script' });
    const allowed = tail === 'Complete' && pattern !== 'Backwards' &&
      (mode === 'Legacy' || pattern === 'Counted');
    if (allowed) {
      assert.doesNotThrow(() => new RegExp(regex, mode === 'Unicode' ? 'u' : ''));
      assert.equal(actual.path, 'fast');
      assert.equal(actual.candidates.length, 1);
    } else if (tail === 'Invalid') {
      assert.equal(actual.path, 'diagnostic');
      assert.equal(actual.candidates.length, 0);
    } else {
      assert.throws(() => new RegExp(regex, mode === 'Unicode' ? 'u' : ''), SyntaxError);
      assert.notEqual(actual.path, 'fast');
    }
  });
}

for (const [pattern, mode, tail] of rows('pulse-regex-bmp')) {
  test(`Pulse BMP regex: ${pattern} ${mode} ${tail}`, () => {
    const body = {
      TwoBytes: '[á]', ThreeBytes: '[海]', MixedRange: '[é-海]', ReversedRange: '[海-é]',
      Separator: '[\u2028]', Astral: '[🧪]', Outside: '海+', Invisible: '[\u0085\u202a]',
    }[pattern];
    const flags = { Legacy: '', Unicode: 'u', Sets: 'v' }[mode];
    const source = `const emoji = '🧪'; const r = /${body}/${flags}; const keep = a > b;` +
      (tail === 'Truncated' ? ' const =' : '');
    const options = { file: 'regex.js', mode: 'script', requireNative: true };
    const allowed = !['Separator', 'ReversedRange', 'Astral'].includes(pattern) && mode !== 'Sets' && tail === 'Complete';
    if (allowed) {
      assert.doesNotThrow(() => new RegExp(body, flags));
      const actual = compare(source, options);
      assert.equal(actual.path, 'fast');
      assert.equal(actual.candidates.length, 1);
    } else {
      const actual = extract(source, options);
      assert.notEqual(actual.path, 'fast');
      if (tail === 'Truncated') assert.equal(actual.candidates.length, 0);
    }
  });
}
