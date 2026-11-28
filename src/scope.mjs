import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { closeSync, mkdtempSync, openSync, readSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { canonicalPath, copyPathIsExcluded, inside, resolveCopyExclusions, resolveCopyInclusions } from './vitest.mjs';

const sourceName = /(?<!\.d|\.test|\.spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const runnerConfig = /^(?:vite|vitest|playwright)(?:\.[^.]+)*\.config\.[cm]?[jt]s$/;
const EXCLUDE_GLOB_CHARS = /[*?[\]{]/;

export function normalizeExcludePattern(root, rawPattern) {
  const text = String(rawPattern ?? '').trim();
  if (!text || text.includes('\0')) {
    throw new Error(`Invalid exclude pattern: ${rawPattern}`);
  }
  const slashNorm = text.replaceAll('\\', '/');
  if (isAbsolute(text) || slashNorm.startsWith('/')) {
    throw new Error(`Exclude pattern must be inside the project: ${rawPattern}`);
  }
  const collapsed = slashNorm.replace(/\/+/g, '/');
  const stripped = collapsed.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!stripped || stripped === '.') {
    throw new Error(`Exclude pattern must be inside the project: ${rawPattern}`);
  }
  const segments = stripped.split('/');
  if (segments.some(part => part === '..')) {
    throw new Error(`Exclude pattern must be inside the project: ${rawPattern}`);
  }
  if (!EXCLUDE_GLOB_CHARS.test(stripped)) {
    const candidate = resolve(root, stripped);
    const fromRoot = relative(root, candidate);
    if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) {
      throw new Error(`Exclude pattern must be inside the project: ${rawPattern}`);
    }
    return fromRoot.replaceAll('\\', '/');
  }
  return stripped;
}

export function matchesExcludePattern(relFile, normalizedPattern) {
  const relPosix = String(relFile).replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  if (EXCLUDE_GLOB_CHARS.test(normalizedPattern)) {
    return posix.matchesGlob(relPosix, normalizedPattern);
  }
  return relPosix === normalizedPattern || relPosix.startsWith(normalizedPattern + '/');
}

export function filterExcludedFiles(root, files, excludePatterns = []) {
  if (!excludePatterns?.length) return files;
  const normalized = excludePatterns.map(pattern => normalizeExcludePattern(root, pattern));
  return files.filter(file => !normalized.some(pattern => matchesExcludePattern(file, pattern)));
}

export function listSource(root, exclusions = [], dir = root, inclusions = []) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'build', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (copyPathIsExcluded(root, path, exclusions, inclusions)) continue;
    if (entry.isDirectory()) result.push(...listSource(root, exclusions, path, inclusions));
    if (entry.isFile() && sourceName.test(entry.name) && !runnerConfig.test(entry.name)) result.push(relative(root, path));
  }
  return result;
}

function git(root, args, stdout = 'pipe') {
  return execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', stdout, 'pipe'],
  });
}

const gitEscapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\' };

function patchFile(header) {
  // Renames and copies are disabled, so the two names differ only in their prefixes.
  const middle = (header.length - 1) / 2;
  if (!Number.isInteger(middle) || header[middle] !== ' ') return;
  const left = header.slice(0, middle);
  const right = header.slice(middle + 1);
  if (left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) return left.slice(2);
  if (!left.startsWith('"a/') || !right.startsWith('"b/') || !left.endsWith('"') || left.slice(3) !== right.slice(3)) return;
  const path = left.slice(3, -1);
  const octets = path.replace(/\\([abfnrtv"\\]|[0-3][0-7]{2})/g, (_, escape) =>
    gitEscapes[escape] ?? String.fromCharCode(Number.parseInt(escape, 8)));
  const bytes = Buffer.from(octets, 'latin1');
  if (isUtf8(bytes)) return bytes.toString('utf8');
}

function fromGitPath(file) {
  return sep === '/' ? file : file.replaceAll('/', sep);
}

function readPatchRanges(chunks, files) {
  const ranges = new Map(files.map(file => [file, []]));
  const seen = new Set();
  let current = files.length === 1 ? ranges.get(files[0]) : null;
  for (const chunk of chunks) {
    for (const [, header, start, count] of chunk.matchAll(/(?:^|\n)(?:diff --git ([^\n]*)|@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@)/g)) {
      if (header !== undefined) {
        if (files.length === 1) continue;
        const path = patchFile(header);
        if (path === undefined) return;
        const file = fromGitPath(path);
        if (!ranges.has(file) || seen.has(file)) return;
        seen.add(file);
        current = ranges.get(file);
      } else {
        if (current === null) return;
        const first = Number(start);
        const length = count === undefined ? 1 : Number(count);
        if (length) current.push([first, first + length - 1]);
      }
    }
  }
  return ranges;
}

function* patchLines(fd) {
  const block = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let prefix = '';
  for (;;) {
    const length = readSync(fd, block, 0, block.length, position);
    if (!length) break;
    position += length;
    let from = 0;
    while (from < length) {
      const next = block.subarray(from, length).indexOf(10);
      const end = next === -1 ? length : from + next;
      // Git quotes non-ASCII paths. Line headers fit inside this prefix even in
      // patches with source lines larger than the in-memory output limit.
      if (prefix.length < block.length) {
        prefix += block.toString('latin1', from, Math.min(end, from + block.length - prefix.length));
      }
      if (next === -1) break;
      yield prefix;
      prefix = '';
      from = end + 1;
    }
  }
  if (prefix) yield prefix;
}

function diffRanges(root, revision, files) {
  const pathspecs = sep === '/' ? files : files.map(file => file.replaceAll(sep, '/'));
  const args = ['-c', 'core.quotePath=true', 'diff', '--relative', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', revision, '--', ...pathspecs];
  try {
    return readPatchRanges([git(root, args)], files);
  } catch (error) {
    if (error.code !== 'ENOBUFS') throw error;
  }
  const directory = mkdtempSync(resolve(tmpdir(), 'tmt-diff-'));
  try {
    const fd = openSync(resolve(directory, 'patch'), 'wx+');
    try {
      git(root, args, fd);
      return readPatchRanges(patchLines(fd), files);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function changedRanges(root, revision, files) {
  const ranges = new Map();
  // Leave room for Git's fixed arguments, workspace path and quoting on Windows.
  const pathBudget = process.platform === 'win32' ? Math.min(16 * 1024, Math.max(0, 30_000 - root.length)) : 32 * 1024;
  let batch = [];
  let bytes = 0;
  function readBatch() {
    if (!batch.length) return;
    const result = diffRanges(root, revision, batch);
    if (result) {
      for (const [file, lines] of result) ranges.set(file, lines);
    } else {
      // Custom submodule diff formats can interleave nested file headers.
      for (const file of batch) ranges.set(file, diffRanges(root, revision, [file]).get(file));
    }
    batch = [];
    bytes = 0;
  }
  for (const file of files) {
    const size = Buffer.byteLength(file) + 3;
    if (bytes + size > pathBudget) readBatch();
    batch.push(file);
    bytes += size;
  }
  readBatch();
  return ranges;
}

export function selectScope(rawRoot, files, { lines = [], since, 'copy-exclude': copyExclude, 'copy-include': copyInclude, exclude = [] } = {}) {
  const root = canonicalPath(rawRoot);
  const exclusions = resolveCopyExclusions(root, copyExclude);
  const inclusions = resolveCopyInclusions(root, copyInclude);
  function sourceFile(file) {
    const path = inside(root, file);
    if (copyPathIsExcluded(root, resolve(root, file), exclusions, inclusions) || copyPathIsExcluded(root, path, exclusions, inclusions)) {
      throw new Error(`Source is excluded from trial copies: ${file}`);
    }
    return relative(root, path);
  }

  const ranges = new Map();
  for (const entry of lines) {
    const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(entry);
    if (match) match[3] ??= match[2];
    if (!match || !Number.isSafeInteger(+match[2]) || !Number.isSafeInteger(+match[3]) || +match[2] < 1 || +match[2] > +match[3]) {
      throw new Error('Expected --lines FILE:FROM-TO');
    }
    const file = sourceFile(match[1]);
    ranges.set(file, [...(ranges.get(file) ?? []), [+match[2], +match[3]]]);
  }

  const selection = files.length ? files : lines.length ? [...ranges.keys()] : listSource(root, exclusions, root, inclusions);
  const filteredSelection = filterExcludedFiles(root, [...new Set(selection.map(sourceFile))].sort(), exclude);
  const paths = filteredSelection.filter(file => !lines.length || ranges.has(file));
  let tracked;
  let patches;
  let discovered;
  if (since !== undefined) {
    let revision;
    try {
      revision = git(root, ['rev-parse', '--verify', '--end-of-options', since + '^{commit}']).trim();
    } catch {
      throw new Error(`Cannot resolve Git revision: ${since}`);
    }
    tracked = new Set(git(root, ['ls-files', '-z']).split('\0').map(fromGitPath));
    const changedPaths = new Set(git(root, ['diff', '--name-only', '-z', '--relative', '--no-ext-diff', '--no-renames', revision, '--']).split('\0').map(fromGitPath));
    patches = changedRanges(root, revision, paths.filter(file => tracked.has(file) && changedPaths.has(file)));
    // A new file counts as changed. A file Git ignores (generated code, build output) is not new work, so
    // discovery leaves it out; naming it on the command line still selects it.
    if (!files.length && !lines.length) {
      const added = new Set(git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').map(fromGitPath));
      discovered = file => tracked.has(file) || added.has(file);
    }
  }
  return paths.filter(file => !discovered || discovered(file)).map(file => {
    const changed = tracked?.has(file) ? patches.get(file) ?? [] : undefined;
    return { file, selected: line =>
      (!changed || changed.some(([a, b]) => a <= line && line <= b)) &&
      (!ranges.has(file) || ranges.get(file).some(([a, b]) => a <= line && line <= b)), changed,
    };
  }).filter(({ changed }) => changed?.length !== 0);
}
