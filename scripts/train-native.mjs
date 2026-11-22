import { globSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const addon = createRequire(import.meta.url)(process.argv[2]);
const root = fileURLToPath(new URL('../fixtures/', import.meta.url));
const files = globSync('**/*.{ts,tsx}', { cwd: root, exclude: ['**/node_modules/**'] }).sort();
if (!files.length) throw new Error('Native profile training requires the repository fixtures');

for (const file of files) {
  addon.parse(readFileSync(resolve(root, file)), file.endsWith('.tsx'), true);
}
