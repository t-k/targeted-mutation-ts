import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, runnerPackage } from './vitest.mjs';

const supervisor = fileURLToPath(new URL('./runner-process.mjs', import.meta.url));
const defaultConfigs = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(ext => 'playwright.config.' + ext);

function configuration(root, name) {
  const selected = name ?? defaultConfigs.find(file => existsSync(resolve(root, file)));
  if (!selected) throw new Error('Playwright runs require a project configuration file');
  const original = inside(root, selected);
  const wrapper = resolve(dirname(original), `.tmt-playwright-${randomUUID()}.config.mts`);
  writeFileSync(wrapper, `import imported from ${JSON.stringify('./' + basename(original))};
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const config = imported.default ?? imported;
const root = process.env.TMT_WORKSPACE;
const configDirectory = dirname(fileURLToPath(import.meta.url));
const own = directory => {
  const raw = realpathSync(resolve(configDirectory, directory ?? '.'));
  let resolved = raw;
  if (process.platform === 'win32') {
    try {
      const native = realpathSync.native(raw);
      if (raw.startsWith('\\\\\\\\') || !native.startsWith('\\\\\\\\')) resolved = native;
    } catch {}
  }
  const target = relative(root, resolved);
  if (isAbsolute(target) || target === '..' || target.startsWith('..' + sep)) {
    throw new Error('Managed webServer cwd escapes the trial workspace');
  }
  return resolved;
};
const settings = Array.isArray(config.webServer) ? config.webServer : config.webServer ? [config.webServer] : [];
if (!settings.length) throw new Error('Playwright analysis requires a managed webServer');
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const origins = new Set();
const servers = settings.map(server => {
  const url = new URL(server.url ?? ('http://localhost:' + server.port));
  if (!loopback.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The managed webServer must listen on loopback');
  }
  if (typeof server.command !== 'string' ||
      (process.env.TMT_ORIGINAL && server.command.includes(process.env.TMT_ORIGINAL))) {
    throw new Error('The managed webServer command must run the trial workspace');
  }
  origins.add(url.origin);
  return { ...server, cwd: own(server.cwd), reuseExistingServer: false };
});
for (const project of config.projects?.length ? config.projects : [config]) {
  const target = project.use?.baseURL ?? config.use?.baseURL;
  if (target && !origins.has(new URL(target).origin)) {
    throw new Error('Playwright baseURL must target a managed webServer origin');
  }
}
const browser = (project) => project.use?.browserName ?? project.use?.defaultBrowserType ?? config.use?.browserName ?? 'chromium';
const projects = config.projects?.map(project => ({ ...project,
  metadata: { ...project.metadata, tmtBrowser: browser(project) },
}));
const webServer = Array.isArray(config.webServer) ? servers : servers[0];
export default { ...config, projects, webServer,
  metadata: { ...config.metadata, tmtBrowser: browser(config) }
};
`, { flag: 'wx' });
  return wrapper;
}

export function classifyPlaywright(report, exitCode, workspace) {
  const browsers = new Map(report.config.projects.map(project => [project.name, project.metadata?.tmtBrowser]));
  const fallback = report.config.metadata?.tmtBrowser;
  const tests = [];
  let timeout = false;
  let unstable = false;
  let incomplete = false;

  function walk(suite, parents = []) {
    const headings = suite.title && !suite.file?.endsWith(suite.title) ? [...parents, suite.title] : parents;
    for (const child of suite.suites ?? []) walk(child, headings);
    for (const spec of suite.specs ?? []) {
      const seen = new Map();
      for (const test of spec.tests) {
        const count = seen.get(test.projectName) ?? 0;
        seen.set(test.projectName, count + 1);
        const last = test.results.at(-1);
        const status = test.status === 'flaky' ? 'unstable' : test.status === 'skipped' ? 'skipped'
          : test.status === 'expected' ? 'passed' : 'failed';
        if (test.results.some(attempt => attempt.status === 'timedOut')) timeout = true;
        if (test.status === 'flaky' || test.results.some(attempt => attempt.status === 'interrupted')) unstable = true;
        if (!last && status !== 'skipped') incomplete = true;
        tests.push({
          id: `${spec.id}:${count}`, file: workspace ? relative(workspace, resolve(report.config.rootDir, spec.file)) : spec.file, project: test.projectName, browser: browsers.get(test.projectName) ?? fallback,
          name: [...headings, spec.title].join(' > '), status, worker: last?.workerIndex, parallelIndex: last?.parallelIndex,
          retry: last?.retry, failures: (last?.errors ?? []).map(error => error.message),
        });
      }
    }
  }
  for (const root of report.suites) walk(root);

  const failed = tests.some(test => test.status === 'failed');
  const status = report.errors.length || incomplete || !tests.length ? 'error'
    : timeout ? 'timeout' : unstable ? 'unstable'
      : exitCode === 0 && !failed && tests.some(test => test.status === 'passed') ? 'passed'
        : exitCode === 1 && failed ? 'failed' : 'error';
  return { status, tests, errors: report.errors.map(error => error.message) };
}

// Playwright takes test files as patterns, so a path is passed with its pattern characters escaped.
export const testFilters = (root, tests = []) => [...new Set(tests.map(file => relative(root, inside(root, file))))]
  .map(file => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export function runPlaywright(root, temp, { config, projects = [], tests = [], timeout = 60_000, original } = {}) {
  const bin = resolve(dirname(runnerPackage(root, 'playwright')), 'cli.js');
  const wrapper = configuration(root, config);
  const report = resolve(temp, 'playwright.json');
  const pid = resolve(temp, 'playwright.pid');
  const server = resolve(temp, 'server.pid');
  const attempt = randomUUID();
  const child = spawnSync(process.execPath, [supervisor, pid, String(timeout), bin,
    'test', '--config', wrapper, '--workers=1', '--reporter=json', '--global-timeout', String(Math.max(100, timeout - 3000)),
    '--output', resolve(temp, 'results'),
    ...projects.flatMap(project => ['--project', project]),
    ...testFilters(root, tests),
  ], {
    cwd: root, encoding: 'utf8', timeout: timeout + 5000, maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env, CI: 'true', PLAYWRIGHT_JSON_OUTPUT_FILE: report, TMT_RUN_ID: attempt, TMT_SERVER_PID_FILE: server,
      TMT_WORKSPACE: root, TMT_ORIGINAL: original ?? '',
    },
  });
  const output = child.error?.message ?? child.stderr + child.stdout;
  const runnerPid = existsSync(pid) ? Number(readFileSync(pid, 'utf8')) : undefined;
  const serverPid = existsSync(server) ? Number(readFileSync(server, 'utf8')) : undefined;
  const metadata = { output, attempt, runnerPid, serverPid };
  if (child.status === 124 || child.error?.code === 'ETIMEDOUT') return { status: 'timeout', ...metadata };
  if (child.error || !existsSync(report)) return { status: 'error', ...metadata };
  try {
    return { ...classifyPlaywright(JSON.parse(readFileSync(report, 'utf8')), child.status, root), ...metadata };
  } catch (error) {
    return { status: 'error', ...metadata, output: output + '\n' + error.message };
  }
}
