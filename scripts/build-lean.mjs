import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { decisionBinaryName } from '../src/runtime-binaries.mjs';

const cwd = fileURLToPath(new URL('../proof/lean/', import.meta.url));
const elan = resolve(homedir(), '.elan/bin', process.platform === 'win32' ? 'lake.exe' : 'lake');
const lake = process.env.LAKE ?? (existsSync(elan) ? elan : 'lake');
const built = spawnSync(lake, ['build'], { cwd, stdio: 'inherit' });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);

const output = fileURLToPath(new URL('../build/', import.meta.url));
mkdirSync(output, { recursive: true });
const filename = decisionBinaryName();
copyFileSync(resolve(cwd, '.lake/build/bin', filename), resolve(output, filename));
