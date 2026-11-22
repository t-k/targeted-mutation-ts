import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mainManifest, platformManifest, publishAll, publishOrder, tarballName } from '../scripts/release-manifests.mjs';

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const targets = [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64']];
const platforms = () => targets.map(([platform, arch]) => platformManifest(root, platform, arch));

test('the checkout manifest cannot be published by accident', () => {
  assert.equal(root.private, true);
});

test('the main manifest is public and depends on every platform package at its own version', () => {
  const main = mainManifest(root);
  for (const field of ['private', 'scripts', 'devDependencies']) assert.equal(Object.hasOwn(main, field), false, field);
  assert.equal(main.name, 'targeted-mutation');
  assert.equal(main.license, 'Apache-2.0');
  assert.deepEqual(main.bin, { 'targeted-mutation': 'bin/tmt.mjs', tmts: 'bin/tmt.mjs' });
  assert.deepEqual(main.optionalDependencies, {
    '@targeted-mutation/tmt-darwin-arm64': root.version, '@targeted-mutation/tmt-darwin-x64': root.version,
    '@targeted-mutation/tmt-linux-arm64': root.version, '@targeted-mutation/tmt-linux-x64': root.version,
  });
  assert.deepEqual(main.dependencies, root.dependencies);
  assert.deepEqual(main.peerDependenciesMeta, { '@stryker-mutator/instrumenter': { optional: true } });
  assert.ok(main.files.includes('LICENSE') && main.files.includes('NOTICE'));
  assert.equal(main.files.some(file => /tmt\.node|tmt-decide|evidence/.test(file)), false);
  assert.match(main.repository.url, /^git\+https:\/\/github\.com\//);
  assert.ok(main.description.length > 20);
});

test('a platform manifest restricts installation to its OS, CPU and C library', () => {
  const linux = platformManifest(root, 'linux', 'x64');
  assert.equal(linux.name, '@targeted-mutation/tmt-linux-x64');
  assert.equal(linux.version, root.version);
  assert.deepEqual([linux.os, linux.cpu, linux.libc], [['linux'], ['x64'], ['glibc']]);
  assert.deepEqual(linux.files, ['tmt.node', 'tmt-decide', 'lean/', 'LICENSE', 'NOTICE', 'README.md']);
  assert.equal(linux.license, 'Apache-2.0');
  assert.deepEqual(linux.repository, root.repository);
  const mac = platformManifest(root, 'darwin', 'arm64');
  assert.deepEqual([mac.os, mac.cpu], [['darwin'], ['arm64']]);
  assert.equal(Object.hasOwn(mac, 'libc'), false);
  for (const field of ['bin', 'dependencies', 'scripts', 'private']) assert.equal(Object.hasOwn(mac, field), false, field);
  assert.throws(() => platformManifest(root, 'win32', 'x64'), /No platform package is built for win32-x64/);
});

test('tarball names follow npm pack', () => {
  assert.equal(tarballName(mainManifest(root)), `targeted-mutation-${root.version}.tgz`);
  assert.equal(tarballName(platformManifest(root, 'linux', 'arm64')), `targeted-mutation-tmt-linux-arm64-${root.version}.tgz`);
});

test('publish order puts every platform package before the main package', () => {
  const ordered = publishOrder([mainManifest(root), ...platforms().reverse()]);
  assert.deepEqual(ordered.map(manifest => manifest.name), [
    '@targeted-mutation/tmt-darwin-arm64', '@targeted-mutation/tmt-darwin-x64',
    '@targeted-mutation/tmt-linux-arm64', '@targeted-mutation/tmt-linux-x64', 'targeted-mutation',
  ]);
});

test('an incomplete or inconsistent set is refused before anything is published', () => {
  const main = mainManifest(root);
  assert.throws(() => publishOrder(platforms()), /Expected one main package, found 0/);
  assert.throws(() => publishOrder([main, main, ...platforms()]), /Expected one main package, found 2/);
  assert.throws(() => publishOrder([main, ...platforms().slice(1)]), /Platform packages do not match the main package: expected .*found @targeted-mutation\/tmt-darwin-x64/);
  assert.throws(() => publishOrder([main]), /found none/);
  const stale = platforms();
  stale[2] = { ...stale[2], version: '0.0.9' };
  assert.throws(() => publishOrder([main, ...stale]), /tmt-linux-arm64@0\.0\.9 does not match targeted-mutation@/);
  const drifted = { ...main, optionalDependencies: { ...main.optionalDependencies, '@targeted-mutation/tmt-linux-x64': '9.9.9' } };
  assert.throws(() => publishOrder([drifted, ...platforms()]), /tmt-linux-x64@.* does not match/);
});

function registry(published = [], failing) {
  const calls = [];
  return { calls, published, hooks: {
    isPublished: manifest => published.includes(manifest.name),
    publish({ manifest }) {
      calls.push(manifest.name);
      if (manifest.name === failing) throw new Error(`registry refused ${manifest.name}`);
      published.push(manifest.name);
    },
  } };
}
const entries = () => publishOrder([mainManifest(root), ...platforms()]).map(manifest => ({ manifest, tarball: tarballName(manifest) }));

test('a first run publishes all five packages with the main package last', () => {
  const npm = registry();
  const log = [];
  const done = publishAll(entries(), { ...npm.hooks, log: line => log.push(line) });
  assert.equal(npm.calls.length, 5);
  assert.equal(npm.calls.at(-1), 'targeted-mutation');
  assert.deepEqual(done, npm.calls.map(name => `${name}@${root.version}`));
  assert.equal(log.at(-1), `published targeted-mutation@${root.version}`);
});

test('a platform failure stops the run before the main package and a re-run finishes it', () => {
  const npm = registry([], '@targeted-mutation/tmt-linux-arm64');
  assert.throws(() => publishAll(entries(), npm.hooks), /registry refused @targeted-mutation\/tmt-linux-arm64/);
  assert.deepEqual(npm.published, ['@targeted-mutation/tmt-darwin-arm64', '@targeted-mutation/tmt-darwin-x64']);
  const retry = registry(npm.published);
  const log = [];
  publishAll(entries(), { ...retry.hooks, log: line => log.push(line) });
  assert.deepEqual(retry.calls, ['@targeted-mutation/tmt-linux-arm64', '@targeted-mutation/tmt-linux-x64', 'targeted-mutation']);
  assert.equal(log[0], `skip @targeted-mutation/tmt-darwin-arm64@${root.version}: already published`);
  const again = registry(retry.published);
  assert.deepEqual(publishAll(entries(), again.hooks), []);
  assert.deepEqual(again.calls, []);
});
