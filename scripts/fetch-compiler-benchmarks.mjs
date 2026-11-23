import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const manifest = JSON.parse(readFileSync(new URL('../verification/compiler-comparison/upstream.json', import.meta.url)));
const root = resolve(process.argv[2] ?? 'build/compiler-upstream');
const digest = input => createHash('sha256').update(input).digest('hex');
for (const suite of manifest.suites) {
  const directory = join(root, suite.id);
  mkdirSync(directory, { recursive: true });
  for (const file of suite.files) {
    const name = basename(file.path);
    const target = join(directory, name);
    let bytes = existsSync(target) ? readFileSync(target) : null;
    if (!bytes || digest(bytes) !== file.sha256) {
      const url = new URL(suite.repository + '/' + suite.revision + '/' + file.path, 'https://raw.githubusercontent.com/');
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      assert.ok(response.ok, url.href);
      bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(digest(bytes), file.sha256, url.href);
      writeFileSync(target, bytes);
    }
    if (file.emit) {
      const fixture = { file: name, mode: 'module', source: bytes.toString('base64') };
      writeFileSync(join(root, 'official-' + suite.id + '-' + name + '.json'), JSON.stringify([fixture]) + '\n');
    }
  }
}
