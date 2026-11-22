import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mainManifest, platformManifest } from './release-manifests.mjs';

const { values } = parseArgs({ options: { only: { type: 'string' } } });
if (values.only && !['main', 'platform'].includes(values.only)) throw new Error('Expected --only main|platform');

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const output = resolve('build/packages');
const syntax = 'build/typescript-syntax/';
mkdirSync(output, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.error?.message ?? result.stderr + result.stdout}`);
  return result.stdout;
}

function pack(staging, manifest) {
  writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const [{ filename }] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json'], { cwd: staging }));
  const archive = join(output, filename);
  renameSync(join(staging, filename), archive);
  console.log(archive);
}

function staged(build) {
  const staging = mkdtempSync(join(resolve('build'), '.tmt-pack-'));
  try {
    build(staging);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function packMain() {
  staged(staging => {
    const manifest = mainManifest(root);
    run(process.execPath, ['scripts/build-typescript-syntax.mjs', join(staging, syntax)]);
    for (const file of manifest.files) {
      if (file === syntax) continue;
      const target = join(staging, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(resolve(file), target, { recursive: true });
    }
    pack(staging, manifest);
  });
}

// The Lean toolchain ships the licenses of the libraries linked into the decision executable.
function leanLicenses(target) {
  const elan = resolve(homedir(), '.elan/bin/lake');
  const lake = process.env.LAKE ?? (existsSync(elan) ? elan : 'lake');
  const prefix = run(lake, ['env', 'lean', '--print-prefix'], { cwd: resolve('proof/lean') }).trim();
  mkdirSync(target, { recursive: true });
  for (const file of ['LICENSE', 'LICENSES']) copyFileSync(join(prefix, file), join(target, file));
}

function packPlatform() {
  staged(staging => {
    const manifest = platformManifest(root, process.platform, process.arch);
    const built = spawnSync(process.execPath, ['scripts/build-native.mjs', '--pgo', '--output', join(staging, 'tmt.node')],
      { stdio: ['ignore', 2, 2] });
    if (built.status !== 0) throw new Error('The native extractor build failed');
    if (!existsSync('build/tmt-decide')) throw new Error('Run npm run build:lean before packing the platform package');
    const decide = join(staging, 'tmt-decide');
    copyFileSync('build/tmt-decide', decide);
    chmodSync(decide, 0o755);
    const stripped = spawnSync('strip', [decide], { encoding: 'utf8' });
    if (stripped.status !== 0) console.warn(`strip was not applied: ${stripped.error?.message ?? stripped.stderr}`);
    const answer = run(decide, [], { input: '[]', timeout: 15_000 });
    if (answer.trim() !== '[]') throw new Error(`The packed decision executable answered ${answer}`);
    leanLicenses(join(staging, 'lean'));
    for (const file of ['LICENSE', 'NOTICE']) copyFileSync(file, join(staging, file));
    writeFileSync(join(staging, 'README.md'), `# ${manifest.name}

Native parser and Lean decision executable of [${root.name}](${root.homepage}) for ${process.platform} ${process.arch}.

Install \`${root.name}\`. npm selects this package for a matching machine.
`);
    pack(staging, manifest);
  });
}

if (values.only !== 'platform') packMain();
if (values.only !== 'main') packPlatform();
