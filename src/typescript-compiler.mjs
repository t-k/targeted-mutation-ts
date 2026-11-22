import { existsSync, readFileSync } from 'node:fs';
import { createRequire, enableCompileCache, getCompileCacheDir } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cacheRoot = new URL('../build/typescript-cache/', import.meta.url);
const bytecode = fileURLToPath(new URL('bytecode/', cacheRoot));
const [major, minor] = process.versions.node.split('.', 2).map(Number);
export const supportsPortableCompileCache = major >= 25 || (major === 24 && minor >= 12);
const preload = /^(?:-r.*|--(?:require|import|loader|experimental-loader|experimental-config-file|experimental-default-config-file)(?:=.*)?)$/;
let prepareOnLoad = false;

export function enablePreparedTypeScript() {
  const environment = (process.env.NODE_OPTIONS ?? '').split(/\s+/).map(flag => flag.replace(/^["']|["']$/g, ''));
  prepareOnLoad = supportsPortableCompileCache && !Object.hasOwn(process.env, 'NODE_DISABLE_COMPILE_CACHE') &&
    !process.env.NODE_V8_COVERAGE && !process.permission && !getCompileCacheDir() &&
    ![...process.execArgv, ...environment].some(flag => preload.test(flag.replaceAll('_', '-')));
}

function activateCompileCache() {
  if (!existsSync(bytecode) || getCompileCacheDir() || require.cache[require.resolve('typescript')]) return;
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(new URL('engine.json', cacheRoot), 'utf8'));
  } catch {
    return;
  }
  if (metadata?.node !== process.version) return;
  enableCompileCache({ directory: bytecode, portable: true });
}

export function loadTypeScript() {
  if (prepareOnLoad) {
    prepareOnLoad = false;
    activateCompileCache();
  }
  return require('typescript');
}
