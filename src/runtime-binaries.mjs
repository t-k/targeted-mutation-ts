import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scope = '@targeted-mutation';
export const supportedTargets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

export function platformPackage(platform, arch) {
  const target = `${platform}-${arch}`;
  return supportedTargets.includes(target) ? `${scope}/tmt-${target}` : null;
}

// A checkout's own build wins. An installed platform package must match this release exactly.
export function locateBinary(name, { host, version, localRoot, exists, resolvePackage }) {
  const local = join(localRoot, name);
  if (exists(local)) return { path: local, source: 'local' };
  const packageName = platformPackage(host.platform, host.arch);
  if (!packageName) return null;
  const installed = resolvePackage(packageName);
  if (!installed || installed.version !== version) return null;
  const path = join(installed.root, name);
  return exists(path) ? { path, source: 'package' } : null;
}

const require = createRequire(import.meta.url);
const localRoot = fileURLToPath(new URL('../build/', import.meta.url));
let ownVersion;

function resolvePackage(name) {
  try {
    const manifest = require.resolve(`${name}/package.json`);
    return { root: dirname(manifest), version: JSON.parse(readFileSync(manifest, 'utf8')).version };
  } catch {
    return null;
  }
}

export function packageVersion() {
  ownVersion ??= JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  return ownVersion;
}

export function binaryPath(name) {
  return locateBinary(name, {
    host: process, get version() { return packageVersion(); }, localRoot, exists: existsSync, resolvePackage,
  })?.path ?? null;
}
