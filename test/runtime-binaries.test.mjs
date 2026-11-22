import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { locateBinary, platformPackage, supportedTargets } from '../src/runtime-binaries.mjs';

const scenarios = readFileSync(new URL('../verification/pict/runtime-binaries.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

for (const [platform, arch, local, installed] of scenarios) {
  test(`binary source: ${platform} ${arch} local ${local} package ${installed}`, () => {
    const requested = [];
    const found = locateBinary('tmt.node', {
      host: { platform, arch },
      version: '1.2.3',
      localRoot: '/checkout/build',
      exists: path => path === '/checkout/build/tmt.node' ? local === 'Present' : installed !== 'Absent',
      resolvePackage(name) {
        requested.push(name);
        if (installed === 'Absent') return null;
        return { root: `/modules/${name}`, version: installed === 'Matching' ? '1.2.3' : '1.2.2' };
      },
    });
    const supported = supportedTargets.includes(`${platform}-${arch}`);
    if (local === 'Present') {
      assert.deepEqual(found, { path: '/checkout/build/tmt.node', source: 'local' });
      assert.deepEqual(requested, []);
    } else if (supported && installed === 'Matching') {
      const name = `@targeted-mutation/tmt-${platform}-${arch}`;
      assert.deepEqual(found, { path: `/modules/${name}/tmt.node`, source: 'package' });
      assert.deepEqual(requested, [name]);
    } else {
      assert.equal(found, null);
      assert.deepEqual(requested, supported ? [`@targeted-mutation/tmt-${platform}-${arch}`] : []);
    }
  });
}

test('a platform package without the requested binary yields no binary', () => {
  assert.equal(locateBinary('tmt-decide', {
    host: { platform: 'linux', arch: 'x64' }, version: '1.0.0', localRoot: '/build', exists: () => false,
    resolvePackage: name => ({ root: `/modules/${name}`, version: '1.0.0' }),
  }), null);
});

test('platform packages exist only for the built targets', () => {
  assert.deepEqual(supportedTargets, ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
  assert.equal(platformPackage('darwin', 'arm64'), '@targeted-mutation/tmt-darwin-arm64');
  assert.equal(platformPackage('win32', 'x64'), null);
  assert.equal(platformPackage('linux', 'ia32'), null);
});

test('this checkout resolves its own built binaries', async () => {
  const { binaryPath } = await import('../src/runtime-binaries.mjs');
  assert.match(binaryPath('tmt.node'), /build[\\/]tmt\.node$/);
  assert.equal(binaryPath('absent-binary'), null);
});
