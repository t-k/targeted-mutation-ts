import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-mjs.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const sources = {
  ImportExport: '#!/usr/bin/env node\nimport { name } from "./unused.js";\nexport const value = `π:${name}`;',
  TopLevelAwait: 'await Promise.resolve();\nconsole.log(import.meta.url);',
  Directive: '/// <reference path="./unused.d.ts" />\nexport const value = 42;',
  Invalid: 'export const value = ;',
  BOM: '\uFEFFexport const value = "π";',
};

for (const row of rows) {
  test('ESNext .mjs ' + row.replaceAll('\t', ' '), () => {
    const [kind, representation, output] = row.split('\t');
    const source = sources[kind];
    const input = representation === 'Bytes' ? Buffer.from(source) : source;
    const options = { file: 'entry.MJS' };
    if (output === 'CommonJS') options.module = 'cjs';
    if (output === 'Map') options.sourceMap = true;
    const result = compile(input, options);
    if (output === 'ESM' && ['ImportExport', 'TopLevelAwait', 'BOM'].includes(kind)) {
      assert.deepEqual(result, { backend: 'javascript', code: source, sourceMap: null, diagnostics: [] });
    } else {
      assert.equal(result.backend, 'typescript');
      if (kind === 'Invalid') {
        assert.equal(result.code, null);
        assert.ok(result.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
      } else if (output === 'Map') {
        assert.ok(result.sourceMap);
      } else if (output === 'CommonJS' && kind === 'ImportExport') {
        assert.match(result.code, /require\(["']\.\/unused\.js/);
      }
    }
  });
}

test('invalid encoding and unbound runtime exports still receive diagnostics', () => {
  const encoding = compile(Buffer.from([0xc0, 0x80]), { file: 'entry.mjs' });
  assert.equal(encoding.code, null);
  assert.equal(encoding.diagnostics[0].code, 'INVALID_ENCODING');
  const binding = compile('export { missing };', { file: 'entry.mjs' });
  assert.equal(binding.code, null);
  assert.equal(binding.diagnostics[0].code, 'UNBOUND_RUNTIME_EXPORT');
});

test('plain ESNext modules validate without loading the full compiler addon', {
  skip: !existsSync(new URL('../build/compiler-js.node', import.meta.url)),
}, () => {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const fullAddon = /compiler-module\\.node$/;
    const open = process.dlopen;
    process.dlopen = (module, filename, ...flags) => {
      assert.doesNotMatch(filename, fullAddon);
      return open(module, filename, ...flags);
    };
    registerHooks({ resolve(specifier, context, next) {
      assert.doesNotMatch(specifier, fullAddon);
      assert.notEqual(specifier, 'typescript');
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    const module = '\\uFEFFexport const unicode = "π😀";';
    for (const input of [module, Buffer.from(module)]) {
      assert.deepEqual(compile(input, { file: 'input.mjs' }),
        { backend: 'javascript', code: module, diagnostics: [], sourceMap: null });
    }
    assert.equal(compile('\\ud800', { file: 'input.mjs' }).diagnostics[0].code, 'INVALID_ENCODING');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

for (const failure of ['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED']) {
  test('optional text validation falls back after ' + failure, () => {
    const source = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const textAddon = /compiler-js\\.node$/;
      const error = code => Object.assign(new Error('Optional addon unavailable'), { code });
      const open = process.dlopen;
      process.dlopen = (module, filename, ...flags) => {
        if (textAddon.test(filename)) throw error('ERR_DLOPEN_FAILED');
        return open(module, filename, ...flags);
      };
      registerHooks({ resolve(specifier, context, next) {
        if ('${failure}' === 'MODULE_NOT_FOUND' && textAddon.test(specifier)) throw error('MODULE_NOT_FOUND');
        return next(specifier, context);
      } });
      const { compile } = await import('./src/compiler.mjs');
      const module = 'export const unicode = "π😀";';
      const result = compile(Buffer.from(module), { file: 'input.mjs' });
      assert.equal(result.code, module);
      assert.deepEqual(result.diagnostics, []);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  });
}
