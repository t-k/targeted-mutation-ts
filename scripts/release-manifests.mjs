import { decisionBinaryName, platformPackage, supportedTargets } from '../src/runtime-binaries.mjs';

// The checkout manifest stays private. Only these generated manifests are published.
export function mainManifest(root) {
  const { private: _private, scripts: _scripts, devDependencies: _development, ...published } = root;
  return {
    ...published,
    optionalDependencies: Object.fromEntries(supportedTargets.map(target => {
      const [platform, arch] = target.split('-');
      return [platformPackage(platform, arch), root.version];
    })),
  };
}

export function platformManifest(root, platform, arch) {
  const name = platformPackage(platform, arch);
  if (!name) throw new Error(`No platform package is built for ${platform}-${arch}`);
  return {
    name,
    version: root.version,
    description: `Native parser and decision executable of ${root.name} for ${platform} ${arch}.`,
    license: root.license,
    homepage: root.homepage,
    repository: root.repository,
    bugs: root.bugs,
    os: [platform],
    cpu: [arch],
    ...(platform === 'linux' ? { libc: ['glibc'] } : {}),
    files: ['tmt.node', decisionBinaryName(platform), 'lean/', 'LICENSE', 'NOTICE', 'README.md'],
  };
}

export function tarballName(manifest) {
  return `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
}

// Platform packages first: an installable main package always finds its binaries.
export function publishOrder(manifests) {
  const main = manifests.filter(manifest => manifest.optionalDependencies);
  if (main.length !== 1) throw new Error(`Expected one main package, found ${main.length}`);
  const platforms = manifests.filter(manifest => !manifest.optionalDependencies);
  const expected = Object.keys(main[0].optionalDependencies).sort();
  const found = platforms.map(manifest => manifest.name).sort();
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    throw new Error(`Platform packages do not match the main package: expected ${expected.join(', ')}; found ${found.join(', ') || 'none'}`);
  }
  for (const manifest of platforms) {
    if (manifest.version !== main[0].version || main[0].optionalDependencies[manifest.name] !== manifest.version) {
      throw new Error(`${manifest.name}@${manifest.version} does not match ${main[0].name}@${main[0].version}`);
    }
  }
  return [...platforms.sort((a, b) => a.name.localeCompare(b.name)), main[0]];
}

// A re-run publishes what the registry lacks and stops before the main package on any failure.
export function publishAll(ordered, { isPublished, publish, log = () => {} }) {
  const done = [];
  for (const entry of ordered) {
    const id = `${entry.manifest.name}@${entry.manifest.version}`;
    if (isPublished(entry.manifest)) {
      log(`skip ${id}: already published`);
      continue;
    }
    publish(entry);
    log(`published ${id}`);
    done.push(id);
  }
  return done;
}
