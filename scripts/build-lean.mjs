import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const cwd = fileURLToPath(new URL('../proof/lean/', import.meta.url));
const elan = resolve(homedir(), '.elan/bin/lake');
const lake = process.env.LAKE ?? (existsSync(elan) ? elan : 'lake');
const built = spawnSync(lake, ['build'], { cwd, stdio: 'inherit' });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);

const output = fileURLToPath(new URL('../build/', import.meta.url));
mkdirSync(output, { recursive: true });
copyFileSync(resolve(cwd, '.lake/build/bin/tmt-decide'), resolve(output, 'tmt-decide'));
