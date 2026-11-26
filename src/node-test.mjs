import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, canonicalPath } from './vitest.mjs';

const supervisor = fileURLToPath(new URL('./runner-process.mjs', import.meta.url));
const runnerScript = fileURLToPath(new URL('./node-test-runner.mjs', import.meta.url));

function toPosix(path) {
  return sep === '/' ? path : path.replaceAll(sep, '/');
}

function isSameFileName(name, relFile) {
  if (!name || !relFile) return false;
  const normName = String(name).replaceAll('\\', '/').replace(/^\.\//, '');
  const normFile = String(relFile).replaceAll('\\', '/').replace(/^\.\//, '');
  return normName === normFile || normName.endsWith('/' + normFile);
}

// Classify structured events emitted by `node:test`'s `run()` into TMT's standard run outcome shape.
export function classifyNodeTestEvents(report, exitCode, expectedFiles = []) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.events)) {
    return {
      status: 'error',
      statusReason: 'Malformed Node test report',
      tests: [],
      files: [],
      errors: ['Malformed Node test report'],
      moduleErrors: [],
      fileErrors: [],
    };
  }
  const errors = [];
  const moduleErrors = [];
  const fileErrors = [];
  const tests = [];
  const observedFiles = new Set();
  const stacks = new Map();
  const occurrences = new Map();
  const fileLeafCounts = new Map();
  let timedOut = false;

  if (report.error) errors.push(String(report.error));

  for (const event of report.events) {
    const file = event.file ? String(event.file) : '';
    if (file) observedFiles.add(file);
    if (event.type === 'test:file-summary') continue;
    let stack = stacks.get(file);
    if (!stack) stacks.set(file, stack = []);
    const nesting = Number(event.nesting ?? 0);

    if (event.type === 'test:start') {
      while (stack.length && stack.at(-1).nesting >= nesting) stack.pop();
      if (stack.length) stack.at(-1).hasChildren = true;
      stack.push({ name: String(event.name ?? ''), nesting, hasChildren: false });
      continue;
    }

    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;

    while (stack.length && stack.at(-1).nesting > nesting) stack.pop();
    const frame = stack.length && stack.at(-1).nesting === nesting ? stack.pop() : null;
    const hasChildren = Boolean(frame?.hasChildren);
    const ancestors = stack.map(entry => entry.name);
    const fullName = [...ancestors, String(event.name ?? '')].join(' > ');
    const failureType = event.error?.failureType;
    const errorMessage = event.error?.message ?? '';

    if (failureType === 'testTimeoutFailure') timedOut = true;

    // A file-level load error in `node:test` (`isolation: 'process'`) emits a top-level `test:fail`
    // named after the file at line 1, column 1 with no child tests and no assertion error code.
    const isModuleLoadFailure = event.type === 'test:fail' && nesting === 0 && !hasChildren &&
      event.testType !== 'suite' && isSameFileName(event.name, file) &&
      event.line === 1 && (event.column === 1 || event.column === undefined) && event.error?.code !== 'ERR_ASSERTION';

    if (isModuleLoadFailure) {
      const message = errorMessage || `Failed to load ${file}`;
      moduleErrors.push(message);
      fileErrors.push({ file, message });
      errors.push(message);
      continue;
    }

    if (failureType === 'hookFailed' || failureType === 'uncaughtException' || failureType === 'unhandledRejection') {
      const message = errorMessage || `${failureType} in ${fullName}`;
      if (file) fileErrors.push({ file, message });
      errors.push(message);
      if (hasChildren || event.testType === 'suite') continue;
    }

    // Parent suites / tests with subtests emit a container summary event after their children.
    if (hasChildren || event.testType === 'suite') {
      if (event.type === 'test:fail' && failureType && failureType !== 'subtestsFailed' &&
          failureType !== 'hookFailed' && failureType !== 'uncaughtException' && failureType !== 'unhandledRejection') {
        const message = errorMessage || `Suite failed: ${fullName}`;
        if (file) fileErrors.push({ file, message });
        errors.push(message);
      }
      continue;
    }

    const occKey = JSON.stringify([file, fullName]);
    const occurrence = occurrences.get(occKey) ?? 0;
    occurrences.set(occKey, occurrence + 1);
    fileLeafCounts.set(file, (fileLeafCounts.get(file) ?? 0) + 1);

    const status = event.skip !== undefined ? 'skipped'
      : event.todo !== undefined ? 'todo'
        : event.type === 'test:pass' ? 'passed'
          : 'failed';
    tests.push({
      id: JSON.stringify([file, fullName, occurrence]),
      project: '',
      file,
      name: fullName,
      status,
      failures: status === 'failed' ? [errorMessage || 'Test failed'] : [],
      timeout: failureType === 'testTimeoutFailure',
    });
  }

  const files = [...observedFiles].sort();
  if (expectedFiles.length) {
    const expected = new Set(expectedFiles.map(file => toPosix(file)));
    const missing = [...expected].filter(file => !observedFiles.has(file));
    const unexpected = files.filter(file => !expected.has(file));
    if (missing.length || unexpected.length) {
      const message = `Node test selection mismatch (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`;
      errors.push(message);
      return { status: 'error', statusReason: message, tests, files, errors, moduleErrors, fileErrors };
    }
  }

  const failed = tests.filter(test => test.status === 'failed');
  const passed = tests.filter(test => test.status === 'passed');
  const hasSummary = Boolean(report.summary);

  if (timedOut) {
    return { status: 'timeout', statusReason: 'Node test timeout', tests, files, errors, moduleErrors, fileErrors };
  }
  if (!hasSummary || errors.length || moduleErrors.length) {
    return {
      status: 'error',
      ...(errors.length ? { statusReason: errors[0] } : { statusReason: 'Node test runner did not report a final summary' }),
      tests,
      files,
      errors,
      moduleErrors,
      fileErrors,
    };
  }
  if (exitCode === 0 && report.summary.success === true && passed.length > 0 && !failed.length) {
    return { status: 'passed', tests, files, errors, moduleErrors, fileErrors };
  }
  if (exitCode === 1 && report.summary.success === false && failed.length > 0) {
    return { status: 'failed', tests, files, errors, moduleErrors, fileErrors };
  }
  return {
    status: 'error',
    statusReason: passed.length === 0 && failed.length === 0 ? 'Node test runner executed no tests' : `Unexpected Node test exit status (${exitCode})`,
    tests,
    files,
    errors,
    moduleErrors,
    fileErrors,
  };
}

export function nodeTestCommand(rawRoot, temp, { testFiles = [], timeout = 60_000 } = {}) {
  const root = canonicalPath(rawRoot);
  const testsToRun = [...new Set(testFiles.map(file => inside(root, file)))];
  const expectedFiles = testsToRun.map(file => toPosix(relative(root, file)));
  const manifest = resolve(temp, 'node-test-manifest.json');
  const report = resolve(temp, 'node-test-report.json');
  const pid = resolve(temp, 'node-test.pid');
  rmSync(report, { force: true });
  writeFileSync(manifest, JSON.stringify({
    workspace: root,
    files: testsToRun,
    report,
    timeout: Math.max(100, timeout - 1_000),
  }), 'utf8');
  const env = { ...process.env, CI: 'true', NODE_ENV: 'test' };
  delete env.NODE_TEST_CONTEXT;
  return {
    report,
    expectedFiles,
    timeout,
    args: [supervisor, pid, String(timeout), runnerScript, manifest],
    options: {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: timeout + 5_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  };
}

function nodeTestOutcome({ report, expectedFiles, timeout }, result) {
  const output = result.error?.message ?? ((result.stderr ?? '') + (result.stdout ?? ''));
  if (result.status === 124 || result.error?.code === 'ETIMEDOUT') {
    return {
      status: 'timeout',
      statusReason: `Node test runner timed out after ${Math.round(timeout / 1000)}s`,
      output,
      tests: [],
      files: expectedFiles,
      errors: [],
      moduleErrors: [],
      fileErrors: [],
    };
  }
  if (result.error || !existsSync(report)) {
    return {
      status: 'error',
      statusReason: result.error?.message ?? 'Node test runner did not produce a report',
      output,
      tests: [],
      files: expectedFiles,
      errors: [],
      moduleErrors: [],
      fileErrors: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    return { ...classifyNodeTestEvents(parsed, result.status, expectedFiles), output };
  } catch (error) {
    return {
      status: 'error',
      statusReason: `Invalid Node test report JSON: ${error.message}`,
      output: output + '\n' + error.message,
      tests: [],
      files: expectedFiles,
      errors: [error.message],
      moduleErrors: [],
      fileErrors: [],
    };
  }
}

export function runNodeTest(root, temp, settings) {
  const command = nodeTestCommand(root, temp, settings);
  return nodeTestOutcome(command, spawnSync(process.execPath, command.args, command.options));
}

export async function runNodeTestAsync(root, temp, settings) {
  const command = nodeTestCommand(root, temp, settings);
  const result = await new Promise(settle => {
    const child = spawn(process.execPath, command.args, { ...command.options, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', chunk => { if (output[stream].length < command.options.maxBuffer) output[stream] += chunk; });
    }
    let failure;
    child.once('error', error => { failure = error; });
    child.once('close', (status, signal) => settle({
      status,
      signal,
      ...output,
      error: failure ?? (signal && status === null ? Object.assign(new Error('Node test runner did not finish in time'), { code: 'ETIMEDOUT' }) : undefined),
    }));
  });
  return nodeTestOutcome(command, result);
}
