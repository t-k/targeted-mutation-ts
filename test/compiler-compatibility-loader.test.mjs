import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('native calls do not initialize the general compatibility emitter', () => {
  const result = spawnSync(process.execPath, ['--no-compilation-cache', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    let compatibilityLoads = 0;
    let nativeResolutions = 0;
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './compiler-compat.cjs') compatibilityLoads++;
      if (/compiler(?:-module)?\\.node$/.test(specifier)) nativeResolutions++;
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    for (const [source, file, backend] of [
      ['export const answer: number = 42;', 'a.ts', 'pulse'],
      ['import { x } from "./unused.js"; export const answer: number = x;', 'a.ts', 'pulse'],
      ['export const View = () => <i/>;', 'a.tsx', 'pulse'],
      ['export const answer = 42;', 'a.mjs', 'javascript'],
    ]) {
      assert.equal(compile(Buffer.from(source), { file }).backend, backend);
    }
    assert.equal(compatibilityLoads, 0);
    assert.equal(nativeResolutions, 0);
    const native = compile('export const answer: number = 42;', { sourceMap: true });
    assert.equal(native.backend, 'pulse');
    assert.ok(native.sourceMap.mappings);
    assert.equal(compatibilityLoads, 0);
    const keptMapped = compile('export const View = () => <i/>;', { file: 'a.tsx', sourceMap: true, jsx: 'preserve' });
    assert.equal(keptMapped.backend, 'pulse');
    assert.ok(keptMapped.sourceMap);
    assert.equal(compatibilityLoads, 0);
    const downlevel = compile('export async function f() { return await 1; }', { file: 'a.ts', target: 'es2015' });
    assert.equal(downlevel.backend, 'typescript');
    assert.equal(compatibilityLoads, 1);
  `], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('missing native compiler binaries still use the regular resolver and compatibility emitter', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const dlopen = process.dlopen;
    process.dlopen = (module, filename, ...flags) => {
      if (/compiler(?:-module)?\\.node$/.test(filename)) {
        throw Object.assign(new Error('missing native binary'), { code: 'ERR_DLOPEN_FAILED' });
      }
      return dlopen(module, filename, ...flags);
    };
    registerHooks({ resolve(specifier, context, next) {
      if (/compiler(?:-module)?\\.node$/.test(specifier)) {
        throw Object.assign(new Error(specifier), { code: 'MODULE_NOT_FOUND' });
      }
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    const result = compile('export const answer: number = 42;');
    assert.equal(result.backend, 'typescript');
    assert.match(result.code, /answer = 42/);
  `], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('explicit default options and the command line stay on the native entry', () => {
  const result = spawnSync(process.execPath, ['--no-compilation-cache', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { createRequire } from 'node:module';
    let routerLoads = 0;
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './compiler-routes.cjs') routerLoads++;
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    const router = createRequire(import.meta.url)('./src/compiler-routes.cjs').compile;
    const typed = Buffer.from('import { x } from "./x.js";\\ntype T = number;\\nexport const n: T = x;\\n');
    const view = Buffer.from('export const View = (n: number) => <i title="a">{n}</i>;\\n');
    const module = Buffer.from('import { x } from "./x.js";\\nexport const n = x;\\n');
    const cases = [
      [typed, { file: 'a.ts', mode: 'transform', target: 'esnext', module: 'preserve', sourceMap: false, jsx: undefined }],
      [typed, { file: 'a.ts', module: 'esm' }],
      [typed, { file: 'a.mts', module: 'preserve', target: 'esnext' }],
      [Buffer.from('export type T = number;\\n'), { file: 'types.ts', module: 'esm' }],
      [view, { file: 'a.tsx', mode: 'transform', jsx: 'classic', module: 'esm' }],
      [view, { file: 'a.tsx', mode: 'transform', jsx: 'automatic', sourceMap: false }],
      [module, { file: 'a.mjs', mode: 'transform', module: 'esm' }],
      [module, { file: 'a.js', mode: 'transform', module: 'preserve', target: 'esnext' }],
    ];
    const expected = cases.map(([input, options]) => router(input, options));
    assert.equal(routerLoads, 0);
    for (const [index, [input, options]] of cases.entries()) {
      assert.deepEqual(compile(input, options), expected[index], JSON.stringify(options));
      assert.notEqual(expected[index].code, null, JSON.stringify(options));
    }
    assert.equal(routerLoads, 0);
    // Every other explicit value still takes the router.
    for (const options of [{ file: 'a.ts', mode: 'strip' }, { file: 'a.ts', target: 'es2020' }, { file: 'a.ts', module: 'cjs' },
      { file: 'a.ts', sourceMap: true }, { file: 'a.js', module: 'esm' }, { file: 'a.tsx', jsx: 'preserve' }]) {
      const input = options.file === 'a.js' ? module : options.file === 'a.tsx' ? view : typed;
      assert.deepEqual(compile(input, options), router(input, options), JSON.stringify(options));
      // The entry resolves the router once and keeps it.
      assert.equal(routerLoads, 1, JSON.stringify(options));
    }
    assert.throws(() => compile(typed, { file: 'a.ts', target: 'ESNext' }), TypeError);
    assert.throws(() => compile(typed, { file: 'a.ts', sourceMap: 0 }), TypeError);
  `], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr.slice(-1500));
});
