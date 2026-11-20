import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const output = resolve('build');
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(output, '.tmt-runtime-'));
try {
  for (const file of manifest.files) {
    const target = join(staging, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(file), target, { recursive: true });
  }
  const { scripts, devDependencies, ...runtime } = manifest;
  writeFileSync(join(staging, 'package.json'), JSON.stringify({
    ...runtime, os: [process.platform], cpu: [process.arch],
  }, null, 2) + '\n');

  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json'], { cwd: staging, encoding: 'utf8', timeout: 60_000 });
  if (packed.status !== 0) throw new Error(packed.error?.message ?? packed.stderr + packed.stdout);
  const [{ filename }] = JSON.parse(packed.stdout);
  const archive = resolve(output, filename.replace(/\.tgz$/, `-${process.platform}-${process.arch}.tgz`));
  renameSync(join(staging, filename), archive);
  console.log(archive);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
