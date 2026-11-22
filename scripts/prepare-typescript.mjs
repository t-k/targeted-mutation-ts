import { copyFileSync, globSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrappedTypeScript, compileTypeScript, encodeTypeScriptCache, instantiateTypeScript } from '../src/typescript-compiler.mjs';
import { createTypeScriptExtractor } from '../src/typescript-extraction.mjs';

const require = createRequire(import.meta.url);
const compilerFile = require.resolve('typescript');
const compilerRoot = dirname(require.resolve('typescript/package.json'));
const output = resolve(process.argv[2] ?? 'build/typescript-cache');
const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const files = globSync('**/*.{ts,tsx}', { cwd: fixtures, exclude: ['**/node_modules/**'] }).sort();
if (!files.length) throw new Error('TypeScript preparation requires the repository fixtures');

const source = wrappedTypeScript(readFileSync(compilerFile, 'utf8'));
const script = compileTypeScript(source);
const extract = createTypeScriptExtractor(instantiateTypeScript(script, compilerFile));
for (const file of files) {
  const text = readFileSync(join(fixtures, file), 'utf8');
  const dialect = file.endsWith('.tsx') ? 'tsx' : 'ts';
  extract(text, { file, dialect, mode: 'module', logical: true });
}

mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(output, '.prepare-'));
try {
  const artifact = join(scratch, 'parser.v8');
  writeFileSync(artifact, encodeTypeScriptCache(source, script.createCachedData()));
  for (const notice of ['LICENSE.txt', 'ThirdPartyNoticeText.txt']) copyFileSync(join(compilerRoot, notice), join(output, notice));
  renameSync(artifact, join(output, 'parser.v8'));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
