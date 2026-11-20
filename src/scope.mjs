import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { inside } from './vitest.mjs';

function listSource(root, dir = root) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'build', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...listSource(root, path));
    if (entry.isFile() && /(?<!\.d|\.test|\.spec)\.tsx?$/.test(entry.name)) result.push(relative(root, path));
  }
  return result;
}

function git(root, args) {
  return execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function selectScope(root, files, { lines = [], since } = {}) {
  const ranges = new Map();
  for (const entry of lines) {
    const match = /^(.*):(\d+)-(\d+)$/.exec(entry);
    if (!match || !Number.isSafeInteger(+match[2]) || !Number.isSafeInteger(+match[3]) || +match[2] < 1 || +match[2] > +match[3]) {
      throw new Error('Expected --lines FILE:FROM-TO');
    }
    const file = relative(root, inside(root, match[1]));
    ranges.set(file, [...(ranges.get(file) ?? []), [+match[2], +match[3]]]);
  }

  const selection = files.length ? files : lines.length ? [...ranges.keys()] : listSource(root);
  const paths = [...new Set(selection.map(file => relative(root, inside(root, file))))].sort();
  let revision;
  if (since !== undefined) {
    try {
      revision = git(root, ['rev-parse', '--verify', '--end-of-options', since + '^{commit}']).trim();
    } catch {
      throw new Error(`Cannot resolve Git revision: ${since}`);
    }
  }
  return paths.filter(file => !lines.length || ranges.has(file)).map(file => {
    let changed;
    if (revision) {
      const tracked = git(root, ['ls-files', '-z', '--', file]).length !== 0;
      if (tracked) {
        const patch = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', revision, '--', file]);
        changed = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
          .map(([, first, length]) => [+first, +first + (length === undefined ? 1 : +length) - 1]);
      }
    }
    return { file, selected: line =>
      (!changed || changed.some(([a, b]) => a <= line && line <= b)) &&
      (!ranges.has(file) || ranges.get(file).some(([a, b]) => a <= line && line <= b)), changed,
    };
  }).filter(({ changed }) => changed?.length !== 0);
}
