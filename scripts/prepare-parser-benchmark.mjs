import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const shards = [
  ['hono', '75ff8e3ea18485589816881c6278bc9783e56602', ['src', 'adapters']],
  ['eslint', 'ac3a60dffc29d8d4d5031621bc062e77f891532a', ['bin', 'conf', 'lib', 'messages', 'packages']],
  ['astro', 'c302892e4a2434fb4d8e66702576f5406e63d986', ['packages/astro/src']],
  ['svelte', '90ad4e870c72aa76db35ecc7e46f0b027ffe175a', ['packages/svelte/src']],
  ['vite', '572aaca4594ed2377a4f63443a449e4bf3c0468c', ['packages/vite/src']],
];
const testSource = /(?:^|\/)(?:test|tests|__tests__|__fixtures__|__snapshots__|__mocks__|test-utils|fixtures|dist|node_modules|demo|demos)\/|\.(?:test|spec|bench)(?:-d)?\.[^/]+$/;
const fileLimit = 1024 * 1024;
const commandLimit = 8 * fileLimit;

const [checkouts, output] = process.argv.slice(2);
if (!checkouts || !output) throw new Error('Usage: node scripts/prepare-parser-benchmark.mjs CHECKOUTS OUTPUT');

for (const [name, revision, paths] of shards) {
  const checkout = resolve(checkouts, name);
  const git = (args, input) => execFileSync('git', ['--no-replace-objects', '-C', checkout, ...args], {
    input, maxBuffer: commandLimit, timeout: 30_000,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
  });
  const blobs = [];
  let bytes = 0;
  for (const entry of git(['ls-tree', '-lrz', revision, '--', ...paths]).toString().split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [permissions, kind, object, size] = entry.slice(0, tab).split(/\s+/);
    const file = entry.slice(tab + 1);
    const length = Number(size);
    if (kind !== 'blob' || !['100644', '100755'].includes(permissions) || length > fileLimit ||
        !/\.(?:[jt]sx?|[cm][jt]s)$/.test(file) || /\.d\.[cm]?ts$/.test(file) || testSource.test(file)) continue;
    if (name === 'eslint' && file.startsWith('packages/js/src/configs/')) continue;
    if (name === 'hono' && !/^(?:src\/|adapters\/[^/]+\/src\/)/.test(file)) continue;
    blobs.push({ file, object, length });
    bytes += length;
  }
  if (!blobs.length || bytes > commandLimit / 2) throw new Error(`No eligible input or total input too large for ${name}`);
  const response = git(['cat-file', '--batch'], blobs.map(blob => blob.object + '\n').join(''));
  let at = 0;
  const files = blobs.map(({ file, object, length }) => {
    const newline = response.indexOf(10, at);
    const last = newline + 1 + length;
    if (newline < 0 || response.toString('ascii', at, newline) !== `${object} blob ${length}` || response[last] !== 10) {
      throw new Error(`Invalid pinned blob header for ${file}`);
    }
    const buffer = response.subarray(newline + 1, last);
    at = last + 1;
    const dialect = /\.[jt]sx$/.test(file) ? 'tsx' : 'ts';
    const lang = /\.(?:jsx?|[cm]js)$/.test(file)
      ? dialect === 'tsx' ? 'jsx' : 'js' : dialect;
    let mode = 'module';
    if (name === 'eslint' && !/\.m[jt]s$/.test(file)) {
      const scriptKind = dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const tree = ts.createSourceFile(file, buffer.toString(), ts.ScriptTarget.Latest, false, scriptKind);
      if (!ts.isExternalModule(tree)) mode = 'script';
    }
    return { file, source: buffer.toString('base64'), dialect, mode, lang };
  });
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, `input-${name}.json`), JSON.stringify(files));
}
