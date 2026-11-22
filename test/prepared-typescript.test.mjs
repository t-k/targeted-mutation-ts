import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { extract } from '../src/extract.mjs';

const require = createRequire(import.meta.url);
const matrix = readFileSync(new URL('../verification/pict/prepared-typescript.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const native = 'const keep = value < limit;';
const fallback = '/* 🧪 */ const item = <T>(value:T) => <div disabled={value < cutoff || wait} />; class C { #a = 1; }';
const opts = { file: 'subject.tsx', logical: true, requireNative: true };
const [nodeMajor, nodeMinor] = process.versions.node.split('.', 2).map(Number);

function isolatedEnvironment() {
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_READONLY', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_V8_COVERAGE']) delete env[key];
  return env;
}

test('prepared CLI code uses ordinary CommonJS loading for every cache variant',
  { skip: nodeMajor === 24 && nodeMinor < 12 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-prepared-typescript-'));
  try {
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

    const cache = join(root, 'build/typescript-cache');
    const metadata = join(cache, 'engine.json');
    const build = spawnSync(process.execPath, ['scripts/prepare-typescript.mjs', cache], {
      encoding: 'utf8', timeout: 20_000, env: isolatedEnvironment(),
    });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const bytecode = join(cache, 'bytecode');
    const settings = readFileSync(metadata, 'utf8');
    const entries = globSync('**/*', { cwd: bytecode }).map(file => join(bytecode, file)).filter(file => statSync(file).isFile());
    assert.ok(entries.length > 0);
    const saved = join(root, 'saved-cache');
    cpSync(bytecode, saved, { recursive: true });
    assert.match(readFileSync(join(cache, 'LICENSE.txt'), 'utf8'), /Apache License/);
    assert.ok(readFileSync(join(cache, 'ThirdPartyNoticeText.txt')).length);

    const preload = join(root, 'consumer-preload.mjs');
    writeFileSync(preload, 'export {};');
    const program = join(root, 'extract-probe.mjs');
    writeFileSync(program, `import { createRequire, getCompileCacheDir, registerHooks } from 'node:module';
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
const compiler = result.path === 'fallback' ? loadTypeScript() : undefined;
const shared = !compiler || compiler === createRequire(import.meta.url)('typescript');
console.log(JSON.stringify({ result, afterExtraction, compilerLoads, shared, active: Boolean(getCompileCacheDir()),
  staleMarker: compiler?.tmtCacheSourceMarker === 'updated' }));
`);

    for (const [variant, route, policy] of matrix) await t.test(`${variant} ${route} ${policy}`, () => {
      const source = route === 'Native' ? native : fallback;
      writeFileSync(sourceFile, variant === 'StaleSource' ? rawSource + '\nmodule.exports = { ...module.exports, tmtCacheSourceMarker: "updated" };\n' : rawSource);
      writeFileSync(metadata, variant === 'WrongMetadata' ? JSON.stringify({ node: 'v0.0.0' }) : settings);
      rmSync(bytecode, { recursive: true, force: true });
      if (variant !== 'Missing') cpSync(saved, bytecode, { recursive: true });
      if (variant === 'Truncated' || variant === 'Corrupted') for (const file of entries) {
        const content = readFileSync(file);
        content[content.length - 1] ^= 1;
        writeFileSync(file, variant === 'Truncated' ? content.subarray(0, 3) : content);
      }
      const flags = variant === 'WrongEngine' ? ['--jitless'] : [];
      if (policy === 'Preloaded') flags.push('--import', preload);
      if (policy === 'ExternalLoader') flags.push('--experimental_loader', preload);
      if (policy === 'Restricted') flags.push('--permission', '--allow-addons', '--allow-worker', '--allow-fs-read=*');
      const env = isolatedEnvironment();
      if (policy === 'Disabled') env.NODE_DISABLE_COMPILE_CACHE = '';
      const child = spawnSync(process.execPath, [...flags, program, source, policy], {
        cwd: root, encoding: 'utf8', timeout: 15_000, env,
      });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const { result, afterExtraction, compilerLoads, shared, active, staleMarker } = JSON.parse(child.stdout);
      assert.deepEqual(result, extract(source, opts));
      assert.equal(afterExtraction, Number(route === 'Fallback'));
      assert.equal(compilerLoads, afterExtraction);
      assert.equal(shared, true);
      assert.equal(active, route === 'Fallback' && policy === 'Enabled' && variant !== 'Missing' && variant !== 'WrongMetadata');
      assert.equal(staleMarker, route === 'Fallback' && variant === 'StaleSource');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
