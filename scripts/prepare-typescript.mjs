import { spawnSync } from 'node:child_process';
import { copyFileSync, globSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants, createRequire, enableCompileCache, flushCompileCache } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { supportsPortableCompileCache } from '../src/typescript-compiler.mjs';
import { createTypeScriptExtractor } from '../src/typescript-extraction.mjs';

const { positionals: [destination, bytecode], values } = parseArgs({ allowPositionals: true,
  options: { train: { type: 'boolean' } } });
const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const require = createRequire(import.meta.url);

function train(root, bytecode) {
  const selected = enableCompileCache({ directory: bytecode, portable: true, readOnly: false });
  if (selected.status !== constants.compileCacheStatus.ENABLED) {
    throw new Error(selected.message ?? 'Cannot isolate the TypeScript build-time compile cache');
  }
  const load = createRequire(join(root, 'package.json'));
  const extract = createTypeScriptExtractor(load('typescript'));
  const files = globSync('**/*.{ts,tsx}', { cwd: fixtures, exclude: ['**/node_modules/**'] }).sort();
  if (!files.length) throw new Error('TypeScript preparation requires the repository fixtures');
  for (const file of files) {
    const source = readFileSync(join(fixtures, file), 'utf8');
    const dialect = file.endsWith('.tsx') ? 'tsx' : 'ts';
    extract(source, { file, dialect, mode: 'module', logical: true });
  }
  flushCompileCache();
}

function prepare(output) {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-typescript-cache-'));
  try {
    // Node's portable cache keys include the module path relative to the cache directory.
    const dependencies = join(scratch, 'node_modules');
    const app = join(dependencies, 'targeted-mutation-ts');
    const stagedCompiler = join(app, 'node_modules/typescript');
    const bytecode = join(app, 'build/typescript-cache/bytecode');
    const compilerManifest = require.resolve('typescript/package.json');
    mkdirSync(join(stagedCompiler, 'lib'), { recursive: true });
    mkdirSync(bytecode, { recursive: true });
    copyFileSync(compilerManifest, join(stagedCompiler, 'package.json'));
    copyFileSync(require.resolve('typescript'), join(stagedCompiler, 'lib/typescript.js'));
    const env = { ...process.env };
    for (const key of ['NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_READONLY']) delete env[key];
    const result = spawnSync(process.execPath, [import.meta.filename, '--train', app, bytecode], { encoding: 'utf8', env });
    if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr + result.stdout);
    const files = globSync('**/*', { cwd: bytecode }).filter(file => statSync(join(bytecode, file)).isFile());
    if (!files.length) throw new Error('Node did not produce prepared TypeScript bytecode');
    mkdirSync(output, { recursive: true });
    const staging = mkdtempSync(join(output, '.prepare-'));
    try {
      for (const notice of ['LICENSE.txt', 'ThirdPartyNoticeText.txt']) {
        copyFileSync(join(dirname(compilerManifest), notice), join(output, notice));
      }
      for (const file of files) {
        const target = join(output, 'bytecode', file);
        const pending = join(staging, 'entry');
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(bytecode, file), pending);
        renameSync(pending, target);
      }
      const pending = join(staging, 'engine.json');
      writeFileSync(pending, JSON.stringify({ node: process.version }) + '\n');
      renameSync(pending, join(output, 'engine.json'));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (values.train) train(destination, bytecode);
else if (supportsPortableCompileCache) prepare(resolve(destination ?? 'build/typescript-cache'));
