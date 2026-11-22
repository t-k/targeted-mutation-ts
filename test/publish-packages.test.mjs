import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { mainManifest, platformManifest, tarballName } from '../scripts/release-manifests.mjs';

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const targets = [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64']];
const supported = process.platform !== 'win32';

// A stand-in registry client: `view` answers from a list of published names, `publish` can be told to fail.
const fakeNpm = `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_NPM_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify([command, ...args]) + '\\n');
if (command === 'view') {
  if (state.viewError) { console.error('npm error code E500'); process.exit(1); }
  const name = args[0].slice(0, args[0].lastIndexOf('@'));
  if (state.published.includes(name)) { console.log(JSON.stringify(args[0].slice(args[0].lastIndexOf('@') + 1))); process.exit(0); }
  console.error('npm error code E404'); process.exit(1);
}
if (command === 'publish') {
  if (state.failing && args[0].includes(state.failing)) process.exit(1);
  process.exit(0);
}
process.exit(2);
`;

function release(state, args, { omit, environment = {} } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-publish-'));
  try {
    const packages = join(scratch, 'packages');
    const bin = join(scratch, 'bin');
    mkdirSync(packages);
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), fakeNpm, { mode: 0o755 });
    const manifests = [mainManifest(root), ...targets.map(([platform, arch]) => platformManifest(root, platform, arch))];
    for (const manifest of manifests) {
      if (manifest.name === omit) continue;
      const staging = join(scratch, 'staging', tarballName(manifest), 'package');
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest));
      const packed = spawnSync('tar', ['-czf', join(packages, tarballName(manifest)), '-C', resolve(staging, '..'), 'package']);
      assert.equal(packed.status, 0);
    }
    const log = join(scratch, 'log.jsonl');
    writeFileSync(log, '');
    writeFileSync(join(scratch, 'state.json'), JSON.stringify(state));
    const run = spawnSync(process.execPath, [resolve('scripts/publish-packages.mjs'), packages, ...args], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, GITHUB_ACTIONS: '', ...environment, PATH: bin + delimiter + process.env.PATH,
        FAKE_NPM_STATE: join(scratch, 'state.json'), FAKE_NPM_LOG: log },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { run, published: calls.filter(call => call[0] === 'publish'), calls, packages };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('a release publishes four platform packages and then the main package', { skip: !supported }, () => {
  const { run, published, packages } = release({ published: [] }, ['--tag', `v${root.version}`]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(published.map(call => call[1]), [
    ...targets.map(([platform, arch]) => join(packages, `targeted-mutation-tmt-${platform}-${arch}-${root.version}.tgz`)),
    join(packages, `targeted-mutation-${root.version}.tgz`),
  ]);
  for (const call of published) assert.deepEqual(call.slice(2), ['--access', 'public']);
  assert.match(run.stdout, new RegExp(`published targeted-mutation@${root.version.replaceAll('.', '\\.')}\n$`));
});

test('a workflow run attests provenance and a dry run passes the flag through', { skip: !supported }, () => {
  const { run, published } = release({ published: [] }, ['--dry-run'], { environment: { GITHUB_ACTIONS: 'true' } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(published.length, 5);
  for (const call of published) assert.deepEqual(call.slice(2), ['--access', 'public', '--provenance', '--dry-run']);
});

test('a re-run skips published versions', { skip: !supported }, () => {
  const { run, published } = release({ published: ['@targeted-mutation/tmt-darwin-arm64', '@targeted-mutation/tmt-linux-x64'] }, []);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(published.length, 3);
  assert.match(run.stdout, /^skip @targeted-mutation\/tmt-darwin-arm64@.*: already published$/m);
  const done = release({ published: ['targeted-mutation', ...targets.map(([platform, arch]) => `@targeted-mutation/tmt-${platform}-${arch}`)] }, []);
  assert.equal(done.run.status, 0, done.run.stderr);
  assert.deepEqual(done.published, []);
});

test('a refused platform package stops the release before the main package', { skip: !supported }, () => {
  const { run, published } = release({ published: [], failing: 'tmt-darwin-x64' }, []);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /npm publish failed for @targeted-mutation\/tmt-darwin-x64@/);
  assert.equal(published.length, 2);
  assert.equal(published.some(call => /targeted-mutation-\d/.test(call[1])), false);
});

test('a tag that differs from the version, a missing package or an unreadable registry publishes nothing', { skip: !supported }, () => {
  const tagged = release({ published: [] }, ['--tag', 'v9.9.9']);
  assert.equal(tagged.run.status, 1);
  assert.match(tagged.run.stderr, /Tag v9\.9\.9 does not match package version/);
  assert.deepEqual(tagged.calls, []);
  const partial = release({ published: [] }, [], { omit: '@targeted-mutation/tmt-linux-arm64' });
  assert.equal(partial.run.status, 1);
  assert.match(partial.run.stderr, /Platform packages do not match the main package/);
  assert.deepEqual(partial.calls, []);
  const offline = release({ published: [], viewError: true }, []);
  assert.equal(offline.run.status, 1);
  assert.match(offline.run.stderr, /Cannot read the registry state of @targeted-mutation\/tmt-darwin-arm64@/);
  assert.deepEqual(offline.published, []);
});
