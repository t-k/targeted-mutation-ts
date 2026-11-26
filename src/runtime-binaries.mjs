import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scope = '@targeted-mutation';
export const supportedTargets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];

export function decisionBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'tmt-decide.exe' : 'tmt-decide';
}

export function platformPackage(platform, arch) {
  const target = `${platform}-${arch}`;
  return supportedTargets.includes(target) ? `${scope}/tmt-${target}` : null;
}

// A checkout's own build wins. An installed platform package must match this release exactly.
// `context.version` is read only when a platform package is installed: a bare copy of bin/ and src/ has no manifest.
export function locateBinary(name, context) {
  const { host, localRoot, exists, resolvePackage } = context;
  const filename = name === 'tmt-decide' ? decisionBinaryName(host.platform) : name;
  const local = join(localRoot, filename);
  if (exists(local)) return { path: local, source: 'local' };
  const packageName = platformPackage(host.platform, host.arch);
  if (!packageName) return null;
  const installed = resolvePackage(packageName);
  if (!installed || installed.version !== context.version) return null;
  const path = join(installed.root, filename);
  return exists(path) ? { path, source: 'package' } : null;
}

const require = createRequire(import.meta.url);
const localRoot = fileURLToPath(new URL('../build/', import.meta.url));
let ownVersion;

export function installedPackage(name, resolver = require) {
  try {
    const manifest = resolver.resolve(`${name}/package.json`);
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
    host: process, get version() { return packageVersion(); }, localRoot, exists: existsSync, resolvePackage: installedPackage,
  })?.path ?? null;
}
