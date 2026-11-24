import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { compile } = require('../src/compiler.cjs');
const router = require('../src/compiler-routes.cjs').compile;
const rows = readFileSync(new URL('../verification/pict/compiler-entry-options.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const typed = 'import { x } from "./x.js";\ntype T = number;\nexport const n: T = x;\n';
const plain = 'import { x } from "./x.js";\nexport const n = x;\n';
// The second source of each kind has no module syntax, so an explicit module format decides its route.
const sources = {
  TS: [typed, 'const n: number = 1;\n', 'export type T = number;\n'], MTS: [typed, 'const n: number = 1;\n'],
  TSX: ['export const View = (n: number) => <i title="a">{n}</i>;\n', 'const view = <i/>;\n'],
  MJS: [plain, 'var x = 1;\n'], JS: [plain, 'var x = 1;\n'],
};
const values = {
  Omitted: undefined, Transform: 'transform', Strip: 'strip', ESNext: 'esnext', ES2020: 'es2020', Preserve: 'preserve',
  ESM: 'esm', CJS: 'cjs', False: false, True: true, Automatic: 'automatic', Classic: 'classic',
};

// The thin entry may answer natively or defer. Either way the result is the router's.
for (const row of rows) {
  test('compiler entry options ' + row.replaceAll('\t', ' '), () => {
    const [name, mode, target, module, sourceMap, jsx] = row.split('\t');
    const options = { file: 'a.' + name.toLowerCase() };
    for (const [key, value] of Object.entries({ mode, target, module, sourceMap, jsx })) {
      if (value !== 'Omitted') options[key] = values[value];
    }
    for (const input of sources[name].flatMap(text => [Buffer.from(text), text])) {
      let expected, failure;
      try { expected = router(input, options); } catch (error) { failure = error; }
      if (failure) assert.throws(() => compile(input, options), { name: failure.name, message: failure.message });
      else assert.deepEqual(compile(input, options), expected);
    }
  });
}

test('the command line stays on the native entry for a default compile', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const probe = 'data:text/javascript,' + encodeURIComponent(
    "import{createRequire}from'node:module';const r=createRequire(process.cwd()+'/x.js');" +
    "process.on('exit',()=>{if(Object.keys(r.cache).some(k=>k.endsWith('compiler-routes.cjs')))process.exitCode=9});");
  const run = flags => spawnSync(process.execPath, ['--import', probe, fileURLToPath(new URL('../bin/tmt-compile.mjs', import.meta.url)),
    ...flags, '--file', 'a.ts', '-'], { input: typed, encoding: 'utf8' });
  const direct = run([]);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, compile(Buffer.from(typed), { file: 'a.ts' }).code);
  // The probe sees the router once an option needs it.
  assert.equal(run(['--strip']).status, 9);
});

test('a declaration name is refused with every option the entry handles itself', () => {
  for (const file of ['index.d.ts', 'index.d.mts', 'INDEX.D.TS']) {
    for (const options of [{}, { sourceMap: true }, { sourceMap: false }, { module: 'esm' }, { mode: 'transform', target: 'esnext' },
      { module: 'esm', sourceMap: true }]) {
      const expected = router(typed, { file, ...options });
      assert.equal(expected.code, null);
      assert.deepEqual(compile(typed, { file, ...options }), expected, file + JSON.stringify(options));
      assert.deepEqual(compile(Buffer.from(typed), { file, ...options }), expected, file + JSON.stringify(options));
    }
  }
});

test('a JavaScript source that the parser must reject is refused with spelled-out default options too', () => {
  const source = Buffer.from('export class Widget extends Base++ {}');
  for (const options of [{ file: 'widget.js' }, { file: 'widget.mjs' }, { file: 'widget.ts' },
    { file: 'widget.js', mode: 'transform', target: 'esnext', module: 'preserve', sourceMap: false }]) {
    const expected = router(source, options);
    assert.equal(expected.code, null, JSON.stringify(options));
    assert.deepEqual(compile(source, options), expected, JSON.stringify(options));
  }
});
