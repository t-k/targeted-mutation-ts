import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Script } from 'node:vm';
import test from 'node:test';
import { extract } from '../src/extract.mjs';

const require = createRequire(import.meta.url);
const matrix = readFileSync(new URL('../verification/pict/prepared-typescript.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const native = 'const keep = value < limit;';
const fallback = '/* 🧪 */ const item = <T>(value:T) => <div disabled={value < cutoff || wait} />; class C { #a = 1; }';
const opts = { file: 'subject.tsx', logical: true, requireNative: true };

test('prepared CLI bytecode preserves exact output and CommonJS identity in fresh processes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-prepared-typescript-'));
  try {
    const { encodeTypeScriptCache, wrappedTypeScript } = await import('../src/typescript-compiler.mjs');
    cpSync(resolve('src'), join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'build'));
    cpSync(resolve('build/tmt.node'), join(root, 'build/tmt.node'));

    const packageRoot = dirname(require.resolve('typescript/package.json'));
    const typescript = join(root, 'node_modules/typescript');
    mkdirSync(join(typescript, 'lib'), { recursive: true });
    cpSync(join(packageRoot, 'package.json'), join(typescript, 'package.json'));
    const sourceFile = join(typescript, 'lib/typescript.js');
    const rawSource = readFileSync(require.resolve('typescript'), 'utf8');
    writeFileSync(sourceFile, rawSource);

    const directory = join(root, 'build/typescript-cache');
    const build = spawnSync(process.execPath, ['scripts/prepare-typescript.mjs', directory], {
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const artifact = join(directory, 'parser.v8');
    const prepared = readFileSync(artifact);
    assert.match(readFileSync(join(directory, 'LICENSE.txt'), 'utf8'), /Apache License/);
    assert.ok(readFileSync(join(directory, 'ThirdPartyNoticeText.txt')).length);

    const rejected = encodeTypeScriptCache(wrappedTypeScript(rawSource), new Script('42').createCachedData());
    const corrupted = Buffer.from(prepared);
    corrupted[corrupted.length - 1] ^= 1;
    const preload = join(root, 'consumer-preload.mjs');
    writeFileSync(preload, 'export {};');
    const program = join(root, 'extract-probe.mjs');
    writeFileSync(program, `import { createRequire, registerHooks } from 'node:module';
let compilerLoads = 0;
registerHooks({ load(url, context, next) {
  if (url.endsWith('/node_modules/typescript/lib/typescript.js')) compilerLoads++;
  return next(url, context);
} });
const { enablePreparedTypeScript, loadTypeScript } = await import('./src/typescript-compiler.mjs');
if (process.argv[3] !== 'Library') enablePreparedTypeScript();
const { extract } = await import('./src/extract.mjs');
const result = extract(process.argv[2], ${JSON.stringify(opts)});
const afterExtraction = compilerLoads;
const shared = result.path !== 'fallback' || loadTypeScript() === createRequire(import.meta.url)('typescript');
console.log(JSON.stringify({ result, afterExtraction, compilerLoads, shared }));
`);

    for (const [variant, route, policy] of matrix) await t.test(`${variant} ${route} ${policy}`, () => {
      const source = route === 'Native' ? native : fallback;
      writeFileSync(sourceFile, variant === 'StaleSource' ? rawSource + '\n' : rawSource);
      if (variant === 'Missing') rmSync(artifact, { force: true });
      else writeFileSync(artifact, { Truncated: prepared.subarray(0, 9), Corrupted: corrupted, Rejected: rejected }[variant] ?? prepared);
      const flags = variant === 'WrongEngine' ? ['--jitless'] : [];
      if (policy === 'Preloaded') flags.push('--import', preload);
      if (policy === 'ExternalLoader') flags.push('--experimental_loader', preload);
      if (policy === 'Restricted') flags.push('--permission', '--allow-addons', '--allow-worker', '--allow-fs-read=*');
      const env = { ...process.env };
      delete env.NODE_COMPILE_CACHE;
      delete env.NODE_V8_COVERAGE;
      delete env.NODE_OPTIONS;
      if (policy === 'Disabled') env.NODE_DISABLE_COMPILE_CACHE = '';
      else delete env.NODE_DISABLE_COMPILE_CACHE;
      const child = spawnSync(process.execPath, [...flags, program, source, policy], {
        cwd: root, encoding: 'utf8', timeout: 15_000, env,
      });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const { result, afterExtraction, compilerLoads, shared } = JSON.parse(child.stdout);
      assert.deepEqual(result, extract(source, opts));
      assert.equal(afterExtraction, Number(route === 'Fallback' && (variant !== 'Ready' || policy !== 'Enabled')));
      assert.equal(compilerLoads, afterExtraction);
      assert.equal(shared, true);
    });

    writeFileSync(artifact, prepared);
    writeFileSync(sourceFile, rawSource);
    await t.test('probe and witness commands share the prepared compiler', () => {
      const program = `
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (url.endsWith('/node_modules/typescript/lib/typescript.js')) throw new Error('Unexpected ordinary TypeScript load');
  return next(url, context);
} });
const { enablePreparedTypeScript, loadTypeScript } = await import('./src/typescript-compiler.mjs');
enablePreparedTypeScript();
const { needsProbePreload } = await import('./src/probe.mjs');
assert.equal(needsProbePreload(process.cwd(), './subject.ts', Buffer.from('module.exports = () => 1;')), true);
const { parseSource } = await import('./src/witness-rules.mjs');
assert.equal(parseSource('source.ts', 'const x = a < 1;').statements.length, 1);
assert.equal(loadTypeScript(), createRequire(import.meta.url)('typescript'));
`;
      const env = { ...process.env };
      for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_V8_COVERAGE']) delete env[key];
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: root, encoding: 'utf8', timeout: 15_000, env });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
