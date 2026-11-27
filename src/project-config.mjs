import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listSource } from './scope.mjs';
import { canonicalPath, inside } from './vitest.mjs';

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

  const expandedFiles = [];
  for (const entry of files) {
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
        const matched = listSource(root, [], targetDirOrFile).sort();
        if (!matched.length) {
          throw new Error(`No source files found in directory: ${entry}`);
        }
        expandedFiles.push(...matched);
      } else {
        expandedFiles.push(entry);
      }
    }
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
    files: [...new Set(expandedFiles)],
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
  'runner', 'files', 'tests', 'projects', 'mutators', 'timeout', 'baselineTimeout', 'baselineWorkers',
  'concurrency', 'config', 'tsconfig', 'spec', 'baseline', 'related', 'copyExclude', 'copyExcludeGitignore',
  'excludeRules', 'typeCheck', 'deterministic', 'displaceThresholds', 'isolatedTrials', 'verifyTrials',
  'progress', 'failOnGaps', 'verbose', 'onlyGaps',
]);

const CONFIG_KEY_HINTS = {
  test: 'did you mean "tests"?',
  include: 'did you mean "files"?',
  project: 'did you mean "projects"?',
  excludeRule: 'did you mean "excludeRules"?',
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
  if (values['copy-exclude-gitignore'] === undefined && values['no-copy-exclude-gitignore'] !== true && typeof configObj.copyExcludeGitignore === 'boolean') {
    values['copy-exclude-gitignore'] = configObj.copyExcludeGitignore;
  }
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
  if (values.verbose === undefined && values['only-gaps'] !== true && configObj.verbose === true) values.verbose = true;
  if (values['only-gaps'] === undefined && values.verbose !== true && configObj.onlyGaps === true) values['only-gaps'] = true;
  const files = cliFiles.length ? cliFiles : (Array.isArray(configObj.files) ? configObj.files.map(String) : []);
  return { files, values };
}
