import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(import.meta.url);
const auditAddon = new URL('../build/compiler-v8-audit/compiler-module.node', import.meta.url);
const ordinaryAddon = '../build/compiler-module.node';
const compilerEntry = new URL('../src/compiler.cjs', import.meta.url);
const phases = new Set(['ts', 'jsx', 'tsx', 'passthrough', 'javascript']);
const reasons = new Set(['accepted', 'unavailable', 'string-allocation', 'no-diagnostic',
  'unbound-export', 'redeclaration', 'strict-mode', 'unexpected-token', 'syntax']);

export function summarizeValidation(trace, cases) {
  const checks = {};
  const rejections = [];
  let current;
  for (const line of trace.split(/\r?\n/)) {
    const [prefix, phase, reason, position] = line.split('\t');
    if (prefix === 'TMT_V8_CASE') {
      assert.match(phase, /^(?:0|[1-9]\d*)$/);
      current = cases[Number(phase)];
      assert.ok(current, 'Unknown audit fixture');
    } else if (prefix === 'TMT_V8_AUDIT') {
      assert.ok(current && phases.has(phase) && reasons.has(reason), 'Invalid validation audit event');
      assert.match(position, /^(?:-1|0|[1-9]\d*)$/);
      const table = checks[phase] ??= {};
      table[reason] = (table[reason] ?? 0) + 1;
      if (reason !== 'accepted') rejections.push({ file: current.file, phase, reason,
        outputOffset: position === '-1' ? null : Number(position) });
    }
  }
  return { checks, rejections };
}

async function runWorker(cases, instrumented) {
  if (instrumented) assert.ok(existsSync(auditAddon), 'Build the audit addon with npm run build:compiler -- --audit-v8');
  registerHooks({ resolve(specifier, context, next) {
    if (instrumented && context.parentURL === compilerEntry.href && specifier === ordinaryAddon) {
      return next(fileURLToPath(auditAddon), context);
    }
    if (specifier === 'typescript' || /typescript-syntax\.[cm]?js$/.test(specifier)) {
      throw Object.assign(new Error(specifier), { code: 'AUDIT_TYPESCRIPT_LOAD' });
    }
    return next(specifier, context);
  } });
  const { compile } = await import(compilerEntry.href);
  return cases.map(({ file, source, options }, index) => {
    if (instrumented) writeSync(2, 'TMT_V8_CASE\t' + index + '\n');
    try {
      const result = compile(Buffer.from(source, 'base64'), { file, ...options });
      return { backend: result.backend, codeHash: result.code === null ? null :
        createHash('sha256').update(result.code).digest('hex'), diagnostics: result.diagnostics };
    } catch (error) {
      if (error.code !== 'AUDIT_TYPESCRIPT_LOAD') throw error;
      return { backend: 'typescript-required', codeHash: null, diagnostics: [] };
    }
  });
}

function worker(cases, mode) {
  const child = spawnSync(process.execPath, ['--no-compilation-cache', entry, mode], {
    encoding: 'utf8', input: JSON.stringify(cases), timeout: 90_000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  return { output: JSON.parse(child.stdout), trace: child.stderr };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--audit-worker' || args[0] === '--ordinary-worker') {
    console.log(JSON.stringify(await runWorker(JSON.parse(readFileSync(0, 'utf8')), args[0] === '--audit-worker')));
  } else {
    assert.ok(args.length, 'Pass one or more JSON corpora');
    const reports = args.map(path => {
      const raw = readFileSync(path);
      const input = JSON.parse(raw);
      const cases = (input.rows ?? input).filter(test => test.mode === 'module' &&
        /\.[cm]?[jt]sx?$/.test(test.file) && !/\.d\.[cm]?ts$/.test(test.file));
      const { output, trace } = worker(cases, '--audit-worker');
      assert.deepEqual(output, worker(cases, '--ordinary-worker').output, path);
      return { path, inputSha256: createHash('sha256').update(raw).digest('hex'), files: cases.length,
        ...summarizeValidation(trace, cases) };
    });
    console.log(JSON.stringify({ node: process.version, compilationCache: 'disabled', reports }, null, 2));
  }
}
