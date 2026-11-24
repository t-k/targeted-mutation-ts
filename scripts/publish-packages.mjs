import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { publishAll, publishOrder } from './release-manifests.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'dry-run': { type: 'boolean' }, tag: { type: 'string' },
} });
const directory = resolve(positionals[0] ?? 'build/packages');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const archives = readdirSync(directory).filter(file => file.endsWith('.tgz')).map(file => {
  const tarball = join(directory, file);
  const read = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (read.status !== 0) throw new Error(`Cannot read ${file}: ${read.error?.message ?? read.stderr}`);
  return { tarball, manifest: JSON.parse(read.stdout) };
});
const ordered = publishOrder(archives.map(archive => archive.manifest))
  .map(manifest => archives.find(archive => archive.manifest === manifest));
const version = ordered.at(-1).manifest.version;
if (values.tag !== undefined && values.tag !== `v${version}`) {
  throw new Error(`Tag ${values.tag} does not match package version ${version}`);
}

function isPublished({ name, version }) {
  const view = spawnSync(npm, ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8', timeout: 60_000 });
  if (view.status === 0) return view.stdout.trim() !== '';
  if (/E404/.test(view.stderr + view.stdout)) return false;
  throw new Error(`Cannot read the registry state of ${name}@${version}: ${view.error?.message ?? view.stderr}`);
}

function publish({ tarball, manifest }) {
  const args = ['publish', tarball, '--access', 'public'];
  if (process.env.GITHUB_ACTIONS === 'true') args.push('--provenance');
  if (values['dry-run']) args.push('--dry-run');
  const sent = spawnSync(npm, args, { stdio: 'inherit', timeout: 600_000 });
  if (sent.status !== 0) throw new Error(`npm publish failed for ${manifest.name}@${manifest.version}`);
}

publishAll(ordered, { isPublished, publish, log: console.log });
