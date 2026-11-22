import { readFileSync } from 'node:fs';
import Module, { createRequire, getCompileCacheDir } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const artifactPath = new URL('../build/typescript-cache/parser.v8', import.meta.url);
const magic = Buffer.from('TMT-TypeScript-V8-1\n');
const engineOffset = magic.length;
const sourceOffset = engineOffset + 4;
const dataOffset = sourceOffset + 32;
const payloadOffset = dataOffset + 32;
const preload = /^(?:-r.*|--(?:require|import|loader|experimental-loader|experimental-config-file|experimental-default-config-file)(?:=.*)?)$/;
let preparedEnabled = false;

export function enablePreparedTypeScript() {
  const environment = (process.env.NODE_OPTIONS ?? '').split(/\s+/).map(flag => flag.replace(/^["']|["']$/g, ''));
  preparedEnabled = !Object.hasOwn(process.env, 'NODE_DISABLE_COMPILE_CACHE') && !process.env.NODE_V8_COVERAGE &&
    !process.permission && !getCompileCacheDir() &&
    ![...process.execArgv, ...environment].some(flag => preload.test(flag.replaceAll('_', '-')));
}

function engineTag() {
  return require('node:v8').cachedDataVersionTag();
}

function digest(input) {
  return require('node:crypto').createHash('sha256').update(input).digest();
}

export function wrappedTypeScript(source) {
  return Module.wrap(source);
}

export function compileTypeScript(source, cachedData, filename = 'typescript.js') {
  const { Script } = require('node:vm');
  return new Script(source, { filename, cachedData });
}

export function instantiateTypeScript(script, file, publish = false) {
  const record = new Module(file);
  record.filename = file;
  record.require = createRequire(file);
  const factory = script.runInThisContext();
  if (publish) require.cache[file] = record;
  try {
    factory.call(record.exports, record.exports, record.require, record, file, dirname(file));
    record.loaded = true;
    return record.exports;
  } catch (error) {
    if (publish && require.cache[file] === record) delete require.cache[file];
    throw error;
  }
}

export function encodeTypeScriptCache(source, cachedData) {
  const header = Buffer.alloc(payloadOffset);
  magic.copy(header);
  header.writeUInt32LE(engineTag(), engineOffset);
  digest(source).copy(header, sourceOffset);
  digest(cachedData).copy(header, dataOffset);
  return Buffer.concat([header, cachedData]);
}

function loadPrepared(file) {
  let artifact;
  try {
    artifact = readFileSync(artifactPath);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ERR_ACCESS_DENIED'].includes(error.code)) return;
    throw error;
  }
  if (artifact.length <= payloadOffset || !artifact.subarray(0, magic.length).equals(magic) ||
      artifact.readUInt32LE(engineOffset) !== engineTag()) return;
  const cachedData = artifact.subarray(payloadOffset);
  if (!artifact.subarray(dataOffset, payloadOffset).equals(digest(cachedData))) return;
  const source = wrappedTypeScript(readFileSync(file, 'utf8'));
  if (!artifact.subarray(sourceOffset, dataOffset).equals(digest(source))) return;
  const script = compileTypeScript(source, cachedData, file);
  if (!script.cachedDataRejected) return instantiateTypeScript(script, file, true);
}

export function loadTypeScript() {
  if (preparedEnabled) {
    const file = require.resolve('typescript');
    if (!require.cache[file]) return loadPrepared(file) ?? require('typescript');
  }
  return require('typescript');
}
