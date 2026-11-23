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
    const mapped = compile('export const answer: number = 42;', { sourceMap: true });
    assert.equal(mapped.backend, 'typescript');
    assert.ok(mapped.sourceMap);
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
