import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inside } from './vitest.mjs';

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

// Validate CLI/config source, test, config, and spec paths on the real project root
// BEFORE copying the project to a temporary directory.
export function validateAndExpandInputs(project, files = [], options = {}) {
  if (!existsSync(project)) {
    throw new Error(`Project directory not found: ${project}`);
  }
  const root = realpathSync(project);

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
      if (!existsSync(candidate)) {
        throw new Error(`Source file not found: ${entry}${hintDash(entry)}`);
      }
      inside(root, entry);
      expandedFiles.push(entry);
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
  if (!existsSync(project)) return null;
  const root = realpathSync(project);
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

export function mergeProjectConfig(configObj, cliValues, cliFiles) {
  if (!configObj) return { files: cliFiles, values: cliValues };
  const values = { ...cliValues };
  if (values.mutators === undefined && typeof configObj.mutators === 'string') values.mutators = configObj.mutators;
  if (values.timeout === undefined && configObj.timeout !== undefined) values.timeout = String(configObj.timeout);
  if (values.concurrency === undefined && configObj.concurrency !== undefined) values.concurrency = String(configObj.concurrency);
  if (values.config === undefined && typeof configObj.config === 'string') values.config = configObj.config;
  if (values.baseline === undefined && typeof configObj.baseline === 'string') values.baseline = configObj.baseline;
  if (values.related === undefined && !values.test?.length && configObj.related === true) values.related = true;
  if (!values.test?.length && !values.related && Array.isArray(configObj.tests)) values.test = configObj.tests.map(String);
  if (!values['copy-exclude']?.length && Array.isArray(configObj.copyExclude)) values['copy-exclude'] = configObj.copyExclude.map(String);
  if (values['copy-exclude-gitignore'] === undefined && configObj.copyExcludeGitignore === true) values['copy-exclude-gitignore'] = true;
  if (!values['exclude-rule']?.length && Array.isArray(configObj.excludeRules)) values['exclude-rule'] = configObj.excludeRules.map(String);
  if (values['type-check'] === undefined && configObj.typeCheck === true) values['type-check'] = true;
  const files = cliFiles.length ? cliFiles : (Array.isArray(configObj.files) ? configObj.files.map(String) : []);
  return { files, values };
}
