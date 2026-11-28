import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { filterExcludedFiles, listSource, normalizeExcludePattern } from './scope.mjs';
import { canonicalPath, inside, resolveCopyExclusions, resolveCopyInclusions } from './vitest.mjs';

const GLOB_CHARS = /[*?[\]{]/;
const CONFIG_JSON = 'targeted-mutation.config.json';
const CONFIG_MJS = 'targeted-mutation.config.mjs';

export function hasGlobPattern(pattern) {
  return GLOB_CHARS.test(String(pattern ?? ''));
}

// Expand a project-relative glob pattern using Node's built-in fs.globSync.
export function expandProjectGlob(root, pattern) {
  if (!hasGlobPattern(pattern)) return [pattern];
  const matches = globSync(pattern, {
    cwd: root,
    exclude: ['node_modules/**', '.git/**', '.worktree/**', '.worktrees/**'],
  })
    .filter(match => {
      const full = resolve(root, match);
      return statSync(full, { throwIfNoEntry: false })?.isFile();
    })
    .map(match => (sep === '/' ? match : match.replaceAll('/', sep)))
    .sort();
  return matches;
}

const SOURCE_FILE_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const SHELL_SPECIAL = /[\s*?[\]{}"'`$\\|&;<>()!#~]/;

const sanitizeText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
const formatCliArg = value => {
  const clean = sanitizeText(value);
  if (!clean) return process.platform === 'win32' ? '""' : "''";
  if (!SHELL_SPECIAL.test(clean)) return clean;
  if (process.platform === 'win32') return JSON.stringify(clean);
  return `'${clean.replaceAll("'", "'\\''")}'`;
};
const formatCurrentProjectHint = (firstArg, extraFiles = []) => {
  const fileArgs = [firstArg, ...extraFiles];
  const needsDoubleDash = fileArgs.some(arg => String(arg ?? '').startsWith('-'));
  const allArgs = needsDoubleDash ? ['.', '--', ...fileArgs] : ['.', ...fileArgs];
  return `targeted-mutation analyze ${allArgs.map(formatCliArg).join(' ')}`;
};

function isRelativeInsideCurrentDir(rawPath) {
  const text = String(rawPath ?? '');
  if (!text || isAbsolute(text)) return false;
  const rel = relative(resolve('.'), resolve('.', text));
  return Boolean(rel) && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

const PROJECT_CONFIG_FILE_RE = /^(?:vite|vitest|playwright|stryker)(?:\.[^.]+)*\.config\.[cm]?[jt]s$/i;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function hasProjectMarkers(dir) {
  for (const marker of ['package.json', 'tsconfig.json', CONFIG_JSON, CONFIG_MJS, 'test', 'tests', 'e2e', '__tests__']) {
    if (existsSync(resolve(dir, marker))) return true;
  }
  try {
    for (const entry of readdirSync(dir)) {
      if (PROJECT_CONFIG_FILE_RE.test(entry) || TEST_FILE_RE.test(entry)) return true;
    }
  } catch {}
  return false;
}

function lexicalRelativeInsideRoot(root, rawPath) {
  const abs = resolve(root, rawPath);
  const parent = dirname(abs);
  const parentCanonical = existsSync(parent) ? canonicalPath(parent) : parent;
  const candidate = join(parentCanonical, basename(abs));
  const rel = relative(root, candidate);
  if (Boolean(rel) && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) {
    return rel;
  }
  return null;
}

// Resolve `analyze [PROJECT] [FILE...]` positionals so file paths, globs, negated patterns,
// and non-project subdirectories inside the current project automatically default PROJECT to ".".
export function resolveAnalyzePositionals(positionals = [], cwd = '.') {
  if (!positionals.length) return { project: '.', files: [] };
  const [first, ...rest] = positionals;
  if (first === '.' || first === './' || first === '.\\') {
    return { project: first, files: rest };
  }
  const cwdRoot = canonicalPath(cwd);
  const isInsideCwd = rawPath => {
    const text = String(rawPath ?? '');
    if (!text || isAbsolute(text)) return false;
    const rel = relative(cwdRoot, resolve(cwdRoot, text));
    return Boolean(rel) && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
  };
  if (first.startsWith('!') && first.length > 1 && isInsideCwd(first.slice(1))) {
    return { project: '.', files: positionals };
  }
  const firstCandidate = resolve(cwdRoot, first);
  const st = statSync(firstCandidate, { throwIfNoEntry: false });
  if (st) {
    if (!st.isDirectory()) {
      const targetAbs = canonicalPath(firstCandidate);
      const relFromCwd = relative(cwdRoot, targetAbs);
      const insideCwd = Boolean(relFromCwd) && !isAbsolute(relFromCwd) && relFromCwd !== '..' && !relFromCwd.startsWith('..' + sep);
      if (insideCwd) {
        const lexicalRel = isAbsolute(first) ? lexicalRelativeInsideRoot(cwdRoot, first) : null;
        const preserved = isAbsolute(first) ? (lexicalRel ?? relFromCwd) : first;
        return { project: '.', files: [preserved, ...rest] };
      }
      return { project: first, files: rest };
    }
    // Existing directory: if it is a subdirectory inside cwd without its own project markers
    // while cwd itself is a project root, treat it as a FILE/directory target inside "."
    // unless trailing args explicitly resolve inside that directory (preserving `analyze DIR FILE|GLOB`).
    if (isInsideCwd(first) && !hasProjectMarkers(canonicalPath(firstCandidate)) && hasProjectMarkers(cwdRoot)) {
      const restResolvesInsideFirst = rest.length > 0 && rest.some(arg => {
        const clean = typeof arg === 'string' && arg.startsWith('!') && arg.length > 1 ? arg.slice(1) : String(arg ?? '');
        if (!clean || isAbsolute(clean)) return false;
        return hasGlobPattern(clean)
          ? expandProjectGlob(firstCandidate, clean).length > 0
          : existsSync(resolve(firstCandidate, clean));
      });
      if (!restResolvesInsideFirst) {
        return { project: '.', files: positionals };
      }
    }
    return { project: first, files: rest };
  }
  if (isInsideCwd(first) && (hasGlobPattern(first) || (SOURCE_FILE_EXT.test(first) && hasProjectMarkers(cwdRoot)))) {
    return { project: '.', files: positionals };
  }
  return { project: first, files: rest };
}

const IMPORT_RESOLUTION_RE = [
  /Failed to resolve import\s+["']([^"']+)["']/gi,
  /Cannot find (?:module|package)\s+["']([^"']+)["']/gi,
  /Could not resolve\s+["']([^"']+)["']/gi,
  /ENOENT:[^'"\n]*["']([^"']+)["']/gi,
];

function stripSpecifierPrefix(specifier) {
  let clean = String(specifier ?? '').trim().replaceAll('\\', '/').replace(/\?.*$/, '').replace(/(?!^)#.*$/, '');
  if (!clean) return '';
  // Strip alias prefixes like `@/`, `~/`, `#` (Node subpath imports), or relative `./` / `../`.
  clean = clean.replace(/^(?:[@~][^/]*\/|#|(?:(?:\.\.?)\/)+)/, '');
  clean = clean.replace(/^\/+/, '');
  return clean;
}

function stripKnownExtension(path) {
  return path.replace(/\.(?:[cm]?[jt]sx?|json)$/i, '');
}

function importMatchesExcludedPath(specifier, excludedPath, { requireFullSuffix = false } = {}) {
  const normSpec = stripSpecifierPrefix(specifier);
  if (!normSpec) return false;
  const normExcluded = String(excludedPath ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normExcluded) return false;
  const specNoExt = stripKnownExtension(normSpec);
  const exclNoExt = stripKnownExtension(normExcluded);
  const parts = normExcluded.split('/');
  const candidates = new Set();
  const maxStart = requireFullSuffix ? Math.max(0, parts.length - 2) : parts.length - 1;
  for (let i = 0; i <= maxStart; i++) {
    const suffix = parts.slice(i).join('/');
    if (suffix && suffix !== '.' && suffix !== '..') {
      candidates.add(suffix);
      candidates.add(stripKnownExtension(suffix));
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (normSpec === candidate || normSpec.startsWith(candidate + '/') ||
        specNoExt === candidate || specNoExt.startsWith(candidate + '/')) {
      return true;
    }
  }
  if (normSpec.endsWith('/' + normExcluded) || specNoExt.endsWith('/' + exclNoExt) ||
      normSpec.includes('/' + normExcluded + '/') || specNoExt.includes('/' + exclNoExt + '/')) {
    return true;
  }
  return false;
}

// Check baseline failure messages for unresolved imports that match paths excluded by copyExcludeGitignore.
export function detectGitignoreBaselineHints(baseline, gitignoredExclusions = [], copyInclusions = []) {
  if (!baseline || !gitignoredExclusions?.length) return [];
  const texts = [];
  for (const err of baseline.fileErrors ?? []) {
    if (err?.message) texts.push(String(err.message));
  }
  for (const err of baseline.errors ?? []) {
    if (err) texts.push(String(err));
  }
  for (const failed of baseline.failedTests ?? []) {
    for (const failure of failed?.failures ?? []) {
      if (failure) texts.push(String(failure));
    }
  }
  if (baseline.output) texts.push(String(baseline.output));
  if (!texts.length) return [];

  const specifiers = new Set();
  for (const text of texts) {
    for (const re of IMPORT_RESOLUTION_RE) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match[1]) specifiers.add(match[1]);
      }
    }
  }
  if (!specifiers.size) return [];

  const normalizedInclusions = (copyInclusions ?? []).map(p => String(p).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const hints = [];
  const seenPaths = new Set();
  for (const ignoredPath of gitignoredExclusions) {
    const cleanPath = String(ignoredPath).replaceAll('\\', '/');
    if (seenPaths.has(cleanPath)) continue;
    for (const spec of specifiers) {
      if (normalizedInclusions.some(inc => importMatchesExcludedPath(spec, inc, { requireFullSuffix: true }))) continue;
      if (importMatchesExcludedPath(spec, cleanPath)) {
        seenPaths.add(cleanPath);
        hints.push(
          `"${sanitizeText(cleanPath)}" was excluded by --copy-exclude-gitignore ("copyExcludeGitignore": true) and matches unresolved import "${sanitizeText(spec)}". ` +
          `Keep it in temporary copies with --copy-include ${formatCliArg(cleanPath)} (or "copyInclude": [${JSON.stringify(cleanPath)}]).`,
        );
        break;
      }
    }
  }
  return hints;
}

// Validate CLI/config source, test, config, and spec paths on the real project root
// BEFORE copying the project to a temporary directory.
export function validateAndExpandInputs(project, files = [], options = {}) {
  const projectStat = statSync(project, { throwIfNoEntry: false });
  if (!projectStat) {
    const cleanProject = sanitizeText(project);
    if (hasGlobPattern(project) || SOURCE_FILE_EXT.test(project)) {
      if (isRelativeInsideCurrentDir(project)) {
        const verb = hasGlobPattern(project) ? 'select source files' : 'analyze files';
        throw new Error(
          `Project directory not found: ${cleanProject}\n` +
          `To ${verb} in the current project, pass "." first: ${formatCurrentProjectHint(project, files)}`,
        );
      }
      throw new Error(
        `Project directory not found: ${cleanProject}\n` +
        'Pass the project root directory first: targeted-mutation analyze <PROJECT> <FILE...>',
      );
    }
    throw new Error(`Project directory not found: ${cleanProject}`);
  }
  if (!projectStat.isDirectory()) {
    const cleanProject = sanitizeText(project);
    const cwd = canonicalPath('.');
    const targetAbs = canonicalPath(project);
    const relFromCwd = relative(cwd, targetAbs);
    const insideCwd = Boolean(relFromCwd) && !isAbsolute(relFromCwd) && relFromCwd !== '..' && !relFromCwd.startsWith('..' + sep);
    if (insideCwd) {
      const displayFile = isAbsolute(project) ? relFromCwd : project;
      throw new Error(
        `Project path is a file, not a directory: ${cleanProject}\n` +
        `To analyze files in the current project, pass "." first: ${formatCurrentProjectHint(displayFile, files)}`,
      );
    }
    throw new Error(
      `Project path is a file, not a directory: ${cleanProject}\n` +
      'Pass the project root directory first: targeted-mutation analyze <PROJECT> <FILE...>',
    );
  }
  const root = canonicalPath(project);
  if (!files.length && isRelativeInsideCurrentDir(project) && !hasProjectMarkers(root) && hasProjectMarkers(canonicalPath('.'))) {
    const cleanProject = sanitizeText(project);
    throw new Error(
      `Directory "${cleanProject}" has no package.json, runner config, or test directory.\n` +
      `To analyze files in "${cleanProject}" within the current project, pass "." first: ${formatCurrentProjectHint(project)}`,
    );
  }

  const hintDash = p => (String(p).startsWith('-') ? ' (did an extra "--" treat an option as a file path?)' : '');

  if (options.config !== undefined) {
    const candidate = resolve(root, options.config);
    if (!existsSync(candidate)) {
      throw new Error(`Config file not found: ${options.config}`);
    }
    inside(root, options.config);
  }

  if (options.spec !== undefined) {
    const candidate = resolve(root, options.spec);
    if (!existsSync(candidate)) {
      throw new Error(`Spec file not found: ${options.spec}`);
    }
    inside(root, options.spec);
  }

  let dirExclusions = null;
  let dirInclusions = null;
  const getDirFilters = () => {
    if (dirExclusions !== null) return { exclusions: dirExclusions, inclusions: dirInclusions };
    const rawExcludes = [
      ...(options['copy-exclude'] ?? []),
      ...(options['copy-exclude-gitignore'] ? gitignoredCopyExclusions(root) : []),
    ];
    dirExclusions = rawExcludes.length
      ? resolveCopyExclusions(root, [...new Set(rawExcludes)], { onMissing: () => {} })
      : [];
    const rawIncludes = options['copy-include'] ?? [];
    dirInclusions = rawIncludes.length
      ? resolveCopyInclusions(root, [...new Set(rawIncludes)], { onMissing: () => {} })
      : [];
    return { exclusions: dirExclusions, inclusions: dirInclusions };
  };

  const positiveFiles = [];
  const negatedExcludes = [];
  for (const entry of files) {
    if (typeof entry === 'string' && entry.startsWith('!') && entry.length > 1) {
      negatedExcludes.push(entry.slice(1));
    } else {
      positiveFiles.push(entry);
    }
  }
  const combinedExcludes = [...new Set([...(options.exclude ?? []), ...negatedExcludes])];
  for (const pattern of combinedExcludes) {
    normalizeExcludePattern(root, pattern);
  }

  const expandedFiles = [];
  for (const entry of positiveFiles) {
    if (hasGlobPattern(entry)) {
      const matched = expandProjectGlob(root, entry);
      if (!matched.length) throw new Error(`Source file pattern matched no files: ${entry}`);
      for (const m of matched) inside(root, m);
      expandedFiles.push(...matched);
    } else {
      const candidate = resolve(root, entry);
      const st = statSync(candidate, { throwIfNoEntry: false });
      if (!st) {
        throw new Error(`Source file not found: ${entry}${hintDash(entry)}`);
      }
      const targetDirOrFile = inside(root, entry);
      if (st.isDirectory()) {
        const { exclusions, inclusions } = getDirFilters();
        const matched = listSource(root, exclusions, targetDirOrFile, inclusions).sort();
        if (!matched.length) {
          throw new Error(`No source files found in directory: ${entry}`);
        }
        expandedFiles.push(...matched);
      } else {
        const normalizedEntry = isAbsolute(entry) ? (lexicalRelativeInsideRoot(root, entry) ?? relative(root, targetDirOrFile)) : entry;
        expandedFiles.push(normalizedEntry);
      }
    }
  }

  const filteredFiles = filterExcludedFiles(root, [...new Set(expandedFiles)], combinedExcludes);
  if (positiveFiles.length > 0 && expandedFiles.length > 0 && filteredFiles.length === 0) {
    throw new Error('All selected source files were excluded by exclude patterns');
  }

  let expandedTests;
  if (options.test?.length) {
    expandedTests = [];
    for (const entry of options.test) {
      if (hasGlobPattern(entry)) {
        const matched = expandProjectGlob(root, entry);
        if (!matched.length) throw new Error(`Test file pattern matched no files: ${entry}`);
        for (const m of matched) inside(root, m);
        expandedTests.push(...matched);
      } else {
        const candidate = resolve(root, entry);
        if (!existsSync(candidate)) {
          throw new Error(`Test file not found: ${entry}${hintDash(entry)}`);
        }
        inside(root, entry);
        expandedTests.push(entry);
      }
    }
    expandedTests = [...new Set(expandedTests)];
  }

  return {
    root,
    files: filteredFiles,
    exclude: combinedExcludes,
    tests: expandedTests,
  };
}

// Discover top-level gitignored paths (excluding node_modules and already-excluded dirs)
// so temporary project copies skip build outputs and test artifacts like dist/ or test-results/.
export function gitignoredCopyExclusions(root) {
  try {
    const raw = execFileSync('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
    const skipBuiltIn = new Set(['.git', '.worktree', '.worktrees', 'docs.local', 'node_modules', 'reports', '.stryker-tmp']);
    const out = [];
    for (const entry of raw.split('\0')) {
      if (!entry) continue;
      const cleaned = entry.replace(/\/+$/, '');
      if (!cleaned) continue;
      const firstPart = cleaned.split('/')[0];
      if (skipBuiltIn.has(firstPart)) continue;
      if (cleaned.split('/').includes('node_modules')) continue;
      const candidate = resolve(root, cleaned);
      if (!existsSync(candidate)) continue;
      // Only include entries inside root without symlink parent traversal.
      const rel = relative(root, candidate);
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) continue;
      out.push(sep === '/' ? cleaned : cleaned.replaceAll('/', sep));
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

// Load project defaults from `targeted-mutation.config.json`, `targeted-mutation.config.mjs`,
// or `package.json`'s `targetedMutation` field.
// When `allowCodeConfig` is false (e.g. `--list`), only data-only JSON configs are loaded.
export async function loadProjectConfig(project, { allowCodeConfig = true } = {}) {
  const st = statSync(project, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return null;
  const root = canonicalPath(project);
  const jsonPath = resolve(root, CONFIG_JSON);
  if (existsSync(jsonPath)) {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Invalid configuration in ${CONFIG_JSON}: expected a JSON object`);
    }
    return { source: CONFIG_JSON, config: data };
  }
  const mjsPath = resolve(root, CONFIG_MJS);
  if (allowCodeConfig && existsSync(mjsPath)) {
    const mod = await import(pathToFileURL(mjsPath).href);
    const data = mod.default;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Invalid configuration in ${CONFIG_MJS}: expected default export object`);
    }
    return { source: CONFIG_MJS, config: data };
  }
  const pkgPath = resolve(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg?.targetedMutation && typeof pkg.targetedMutation === 'object' && !Array.isArray(pkg.targetedMutation)) {
        return { source: 'package.json#targetedMutation', config: pkg.targetedMutation };
      }
    } catch {
      // Ignore invalid package.json here; downstream runner will report if needed.
    }
  }
  return null;
}

const KNOWN_CONFIG_KEYS = new Set([
  'runner', 'files', 'exclude', 'tests', 'projects', 'mutators', 'timeout', 'baselineTimeout', 'baselineWorkers',
  'concurrency', 'config', 'tsconfig', 'spec', 'baseline', 'related', 'copyExclude', 'copyInclude', 'copyExcludeGitignore',
  'excludeRules', 'typeCheck', 'deterministic', 'displaceThresholds', 'isolatedTrials', 'verifyTrials',
  'progress', 'failOnGaps', 'requireExercised', 'verbose', 'onlyGaps',
]);

const CONFIG_KEY_HINTS = {
  test: 'did you mean "tests"?',
  include: 'did you mean "files"?',
  excludes: 'did you mean "exclude"?',
  project: 'did you mean "projects"?',
  excludeRule: 'did you mean "excludeRules"?',
  copyIncludes: 'did you mean "copyInclude"?',
};

export function mergeProjectConfig(configObj, cliValues, cliFiles, { sourceName = CONFIG_JSON, onWarning } = {}) {
  if (!configObj) return { files: cliFiles, values: cliValues };
  if (onWarning) {
    for (const key of Object.keys(configObj)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        const cleanKey = sanitizeText(key);
        const hint = Object.hasOwn(CONFIG_KEY_HINTS, key) ? ` (${CONFIG_KEY_HINTS[key]})` : '';
        onWarning(`Unknown key "${cleanKey}" in ${sourceName} is ignored${hint}`);
      }
    }
  }
  const values = { ...cliValues };
  if (values.runner === undefined && typeof configObj.runner === 'string') values.runner = configObj.runner;
  if (values.mutators === undefined && typeof configObj.mutators === 'string') values.mutators = configObj.mutators;
  if (values.timeout === undefined && configObj.timeout !== undefined) values.timeout = String(configObj.timeout);
  if (values['baseline-timeout'] === undefined && configObj.baselineTimeout !== undefined) values['baseline-timeout'] = String(configObj.baselineTimeout);
  if (values['baseline-workers'] === undefined && configObj.baselineWorkers !== undefined) values['baseline-workers'] = String(configObj.baselineWorkers);
  if (values.concurrency === undefined && configObj.concurrency !== undefined) values.concurrency = String(configObj.concurrency);
  if (values.config === undefined && typeof configObj.config === 'string') values.config = configObj.config;
  if (values.tsconfig === undefined && typeof configObj.tsconfig === 'string') values.tsconfig = configObj.tsconfig;
  if (values.spec === undefined && typeof configObj.spec === 'string') values.spec = configObj.spec;
  if (values.baseline === undefined && typeof configObj.baseline === 'string') values.baseline = configObj.baseline;
  if (!values.project?.length && Array.isArray(configObj.projects)) values.project = configObj.projects.map(String);
  if (values.related === undefined && !values.test?.length && configObj.related === true) values.related = true;
  if (!values.test?.length && !values.related && Array.isArray(configObj.tests)) values.test = configObj.tests.map(String);
  if (!values['copy-exclude']?.length && Array.isArray(configObj.copyExclude)) values['copy-exclude'] = configObj.copyExclude.map(String);
  if (!values['copy-include']?.length && Array.isArray(configObj.copyInclude)) values['copy-include'] = configObj.copyInclude.map(String);
  if (values['copy-exclude-gitignore'] === undefined && values['no-copy-exclude-gitignore'] !== true && typeof configObj.copyExcludeGitignore === 'boolean') {
    values['copy-exclude-gitignore'] = configObj.copyExcludeGitignore;
  }
  if (!values.exclude?.length && Array.isArray(configObj.exclude)) values.exclude = configObj.exclude.map(String);
  if (!values['exclude-rule']?.length && Array.isArray(configObj.excludeRules)) values['exclude-rule'] = configObj.excludeRules.map(String);
  if (values['type-check'] === undefined && values['no-type-check'] !== true && typeof configObj.typeCheck === 'boolean') {
    values['type-check'] = configObj.typeCheck;
  }
  if (values.deterministic === undefined && configObj.deterministic === true) values.deterministic = true;
  if (values['displace-thresholds'] === undefined && configObj.displaceThresholds === true) values['displace-thresholds'] = true;
  if (values['isolated-trials'] === undefined && configObj.isolatedTrials === true) values['isolated-trials'] = true;
  if (values['verify-trials'] === undefined && configObj.verifyTrials !== undefined) values['verify-trials'] = String(configObj.verifyTrials);
  if (values.progress === undefined && configObj.progress === true) values.progress = true;
  if (values['fail-on-gaps'] === undefined && configObj.failOnGaps === true) values['fail-on-gaps'] = true;
  if (values['require-exercised'] === undefined && configObj.requireExercised === true) values['require-exercised'] = true;
  if (values.verbose === undefined && values['only-gaps'] !== true && configObj.verbose === true) values.verbose = true;
  if (values['only-gaps'] === undefined && values.verbose !== true && configObj.onlyGaps === true) values['only-gaps'] = true;
  const configFiles = Array.isArray(configObj.files) ? configObj.files.map(String) : [];
  const hasPositiveCliFile = cliFiles.some(entry => !(typeof entry === 'string' && entry.startsWith('!') && entry.length > 1));
  const files = hasPositiveCliFile ? cliFiles : [...configFiles, ...cliFiles];
  return { files, values };
}
