import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { binaryPath, installedPackage, locateBinary, packageVersion, platformPackage, supportedTargets } from '../src/runtime-binaries.mjs';

const scenarios = readFileSync(new URL('../verification/pict/runtime-binaries.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

for (const [platform, arch, artifact, local, installed] of scenarios) {
  test(`binary source: ${platform} ${arch} ${artifact} local ${local} package ${installed}`, () => {
    const requested = [];
    const binary = artifact === 'Extractor' ? 'tmt.node' : 'tmt-decide';
    const filename = artifact === 'Decision' && platform === 'win32' ? 'tmt-decide.exe' : binary;
    const localRoot = join('checkout', 'build');
    const localPath = join(localRoot, filename);
    const packageName = `@targeted-mutation/tmt-${platform}-${arch}`;
    const packageRoot = join('modules', packageName);
    const packagePath = join(packageRoot, filename);
    const hasPackagedBinary = installed === 'Matching' || installed === 'Mismatched';
    const found = locateBinary(binary, {
      host: { platform, arch },
      version: '1.2.3',
      localRoot,
      exists: path => (path === localPath && local === 'Present') || (path === packagePath && hasPackagedBinary),
      resolvePackage(name) {
        requested.push(name);
        if (installed === 'Absent') return null;
        return { root: packageRoot, version: installed === 'Mismatched' ? '1.2.2' : '1.2.3' };
      },
    });
    const supported = arch === 'x64' || (arch === 'arm64' && platform !== 'win32');
    if (local === 'Present') {
      assert.deepEqual(found, { path: localPath, source: 'local' });
      assert.deepEqual(requested, []);
    } else if (supported && installed === 'Matching') {
      assert.deepEqual(found, { path: packagePath, source: 'package' });
      assert.deepEqual(requested, [packageName]);
    } else {
      assert.equal(found, null);
      assert.deepEqual(requested, supported ? [packageName] : []);
    }
  });
}

test('platform packages exist only for the built targets', () => {
  assert.deepEqual(supportedTargets, ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  assert.equal(platformPackage('darwin', 'arm64'), '@targeted-mutation/tmt-darwin-arm64');
  assert.equal(platformPackage('win32', 'x64'), '@targeted-mutation/tmt-win32-x64');
  assert.equal(platformPackage('win32', 'arm64'), null);
  assert.equal(platformPackage('linux', 'ia32'), null);
});

test('this checkout resolves its own built binaries and version', () => {
  assert.match(binaryPath('tmt.node'), /build[\\/]tmt\.node$/);
  assert.equal(binaryPath('absent-binary'), null);
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageVersion(), version);
  assert.equal(packageVersion(), version);
});

test('an installed platform package is read from node_modules and a missing one is absent', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-platform-package-')));
  try {
    const name = '@targeted-mutation/tmt-linux-x64';
    const root = join(scratch, 'node_modules', name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '4.5.6' }));
    const resolver = createRequire(join(scratch, 'entry.js'));
    assert.deepEqual(installedPackage(name, resolver), { root, version: '4.5.6' });
    assert.equal(installedPackage('@targeted-mutation/tmt-darwin-x64', resolver), null);
    writeFileSync(join(root, 'package.json'), 'not json');
    assert.equal(installedPackage(name, resolver), null);
    assert.equal(installedPackage('@targeted-mutation/tmt-absent-target'), null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
