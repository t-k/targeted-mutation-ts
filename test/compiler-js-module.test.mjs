import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = {
  StaticImport: '#!/usr/bin/env node\n/** @type {string} */\nimport /* still static */ { value } from "./dependency.js";\nexport { value };',
  StaticExport: '\uFEFF/* licenses */\nexport/* a comment */{ };',
  LateExport: 'const local = 12;\nexport { local };',
  DynamicImport: '// stays a script\nimport // not static\n/* or here */ ("./dependency.js");',
  UnicodeIdentifier: 'exportπ: for (;;) break exportπ;\nimportπ: for (;;) break importπ;',
  Directive: '/// <reference types="types" />\nexport const value = 0;',
  UnicodeDirective: '\uFEFF/// <reference path= />\nexport const value = 0;',
  Invalid: 'export const value = ;',
};
const rows = readFileSync(new URL('../verification/pict/compiler-js-module.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of rows) {
  test('JavaScript module routing ' + row.replaceAll('\t', ' '), () => {
    const [kind, input, output] = row.split('\t');
    const source = cases[kind];
    const options = { file: 'entry.js', module: output === 'CommonJS' ? 'cjs' : 'preserve', sourceMap: output === 'Map' };
    const result = compile(input === 'Bytes' ? Buffer.from(source) : source, options);
    if (kind === 'UnicodeDirective') {
      assert.equal(result.backend, 'typescript');
      assert.equal(result.code, null);
      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 1084));
    } else if (kind === 'Invalid') {
      assert.equal(result.code, null);
      assert.ok(result.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
    } else if (output === 'Preserve' && ['StaticImport', 'StaticExport', 'LateExport'].includes(kind)) {
      assert.equal(result.backend, 'javascript');
      assert.equal(result.code, source);
    } else if (output === 'Preserve' && (kind === 'DynamicImport' || kind === 'UnicodeIdentifier')) {
      assert.equal(result.backend, 'javascript');
      assert.equal(result.code, '"use strict";\n' + source);
    } else if (output === 'Map' && ['LateExport', 'DynamicImport', 'UnicodeIdentifier'].includes(kind)) {
      // Text that is published as written keeps that route with a map, which leads every token to itself.
      assert.equal(result.backend, 'javascript');
      assert.equal(result.code, (kind === 'LateExport' ? '' : '"use strict";\n') + source);
      assert.deepEqual(result.sourceMap.sourcesContent, [source]);
      assert.equal(result.sourceMap.mappings.startsWith(';'), kind !== 'LateExport');
    } else {
      assert.equal(result.backend, 'typescript');
      if (output === 'Map') assert.ok(result.sourceMap);
    }
  });
}

const moduleEdges = [
  'import { value as π } from "./dependency.js"; export { π };',
  'import { value as \\u03c0 } from "./dependency.js"; export { π };',
  '#!fixture\u2028import { value } from "./dependency.js"; export { value };',
  '#!fixture\u2029export const value = 42;',
];

test('static JavaScript modules use only the text validator', {
  skip: !existsSync(new URL('../build/compiler-js.node', import.meta.url)),
}, () => {
  const program = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const fullCompiler = /compiler(?:-module)?\\.node$/;
    const open = process.dlopen;
    process.dlopen = (module, filename, ...flags) => {
      assert.doesNotMatch(filename, fullCompiler);
      return open(module, filename, ...flags);
    };
    registerHooks({ resolve(specifier, context, next) {
      assert.doesNotMatch(specifier, fullCompiler);
      assert.notEqual(specifier, 'typescript');
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    for (const text of ${JSON.stringify([cases.StaticImport, cases.StaticExport, ...moduleEdges])}) {
      assert.deepEqual(compile(Buffer.from(text), { file: 'entry.js' }),
        { backend: 'javascript', code: text, sourceMap: null, diagnostics: [] });
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test('static JavaScript modules still diagnose unbound exports', () => {
  for (const text of ['export { missing };', 'const local = 1;\nexport { missing };']) {
    const result = compile(text, { file: 'entry.js' });
    assert.equal(result.code, null);
    assert.equal(result.diagnostics[0].code, 'UNBOUND_RUNTIME_EXPORT');
  }
});

test('late static exports avoid initializing the TypeScript eraser', {
  skip: !existsSync(new URL('../build/compiler-js.node', import.meta.url)),
}, () => {
  const program = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    require('node:module').stripTypeScriptTypes = () => { throw new Error('Type erasure invoked'); };
    const { compile } = await import('./src/compiler.mjs');
    const text = ${JSON.stringify(cases.LateExport)};
    for (const module of ['preserve', 'esm']) {
      assert.deepEqual(compile(text, { file: 'entry.js', module }), {
        backend: 'javascript', code: text, sourceMap: null, diagnostics: [],
      });
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test('import.meta without a static module item retains its compatibility behavior', () => {
  assert.deepEqual(compile('import /* dot */ .meta.url;', { file: 'entry.js' }), {
    backend: 'typescript', code: 'import.meta.url;\n', sourceMap: null, diagnostics: [],
  });
  const late = compile('const marker = "export"; const word = { export: marker }; /* export */ import.meta.url;',
    { file: 'entry.js' });
  assert.equal(late.backend, 'typescript');
  assert.match(late.code, /import\.meta\.url/);
  assert.deepEqual(late.diagnostics, []);
});

test('contiguous Unicode and escaped export labels are not module markers', () => {
  for (const name of ['exportπ', 'export\\u03c0']) {
    const script = 'let value = 0; ' + name + ': for (;;) break ' + name + ';';
    const explicit = compile(script, { file: 'entry.js', module: 'esm' });
    assert.equal(explicit.backend, 'typescript');
    assert.match(explicit.code, /^"use strict";/);
    assert.deepEqual(explicit.diagnostics, []);
    const implicit = compile(script + ' import.meta.url;', { file: 'entry.js' });
    assert.equal(implicit.backend, 'typescript');
    assert.match(implicit.code, /import\.meta\.url/);
    assert.deepEqual(implicit.diagnostics, []);
  }
});
