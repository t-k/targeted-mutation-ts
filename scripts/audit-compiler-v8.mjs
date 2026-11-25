import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(import.meta.url);
const addons = ['compiler-module.node', 'compiler-js.node'].map(name => {
  const specifier = '../build/' + name;
  return {
    specifier, ordinary: fileURLToPath(new URL(specifier, import.meta.url)),
    audit: fileURLToPath(new URL('../build/compiler-v8-audit/' + name, import.meta.url)),
  };
});
const compilerEntry = new URL('../src/compiler.cjs', import.meta.url);
const compilerRoutes = new URL('../src/compiler-routes.cjs', import.meta.url);
const phases = new Set(['ts', 'jsx', 'tsx', 'passthrough', 'javascript']);
const reasons = new Set(['accepted', 'unavailable', 'string-allocation', 'no-diagnostic',
  'unbound-export', 'redeclaration', 'strict-mode', 'unexpected-token', 'syntax']);

export function summarizeValidation(trace, cases, options = {}) {
  const checks = {};
  const certified = {};
  const rejections = [];
  const certifiedRejections = [];
  const decisions = [];
  const guardObjections = [];
  let current;
  let pending;
  let guard;
  for (const line of trace.split(/\r?\n/)) {
    const [prefix, phase, reason, position] = line.split('\t');
    if (prefix === 'TMT_V8_CASE') {
      assert.match(phase, /^(?:0|[1-9]\d*)$/);
      assert.equal(pending, undefined, 'A certification decision has no validation verdict');
      // A projection can be declined after the scan and before the certification decision.
      guard = undefined;
      current = cases[Number(phase)];
      assert.ok(current, 'Unknown audit fixture');
    } else if (prefix === 'TMT_V8_GUARD') {
      // The audit build still runs the retired projection guard and reports its verdict.
      assert.ok(current && (phase === 'ts' || phase === 'tsx') && (reason === '0' || reason === '1') &&
        pending === undefined, 'Invalid guard audit event');
      guard = { phase, accepts: reason === '1' };
    } else if (prefix === 'TMT_V8_CERTIFIED') {
      // The audit build reports the emitter's decision before it asks V8.
      assert.ok(current && (phase === 'ts' || phase === 'tsx') && (reason === '0' || reason === '1') &&
        pending === undefined && (guard === undefined || guard.phase === phase), 'Invalid certification audit event');
      pending = { phase, certified: reason === '1', objected: guard?.accepts === false };
      guard = undefined;
    } else if (prefix === 'TMT_V8_AUDIT') {
      assert.ok(current && phases.has(phase) && reasons.has(reason), 'Invalid validation audit event');
      assert.match(position, /^(?:-1|0|[1-9]\d*)$/);
      assert.ok(pending === undefined || pending.phase === phase, 'A certification decision names another phase');
      const table = checks[phase] ??= {};
      table[reason] = (table[reason] ?? 0) + 1;
      const rejection = { file: current.file, phase, reason, outputOffset: position === '-1' ? null : Number(position) };
      if (reason !== 'accepted') rejections.push(rejection);
      const decided = pending?.certified === true;
      if (decided) {
        certified[phase] = (certified[phase] ?? 0) + 1;
        if (reason !== 'accepted') certifiedRejections.push(rejection);
        if (pending.objected) guardObjections.push({ file: current.file, phase });
      }
      if (options.decisions) decisions.push({ file: current.file, phase, certified: decided, reason });
      pending = undefined;
    }
  }
  assert.equal(pending, undefined, 'A certification decision has no validation verdict');
  return { checks, rejections, certified, certifiedRejections, guardObjections,
    ...(options.decisions ? { decisions } : {}) };
}

async function runWorker(cases, instrumented) {
  if (instrumented) {
    for (const { audit } of addons) {
      assert.ok(existsSync(audit), 'Build the audit addons with npm run build:compiler -- --audit-v8');
    }
    const dlopen = process.dlopen;
    process.dlopen = (module, filename, ...flags) => {
      const addon = addons.find(({ ordinary }) => ordinary === resolve(filename));
      return dlopen(module, addon?.audit ?? filename, ...flags);
    };
  }
  registerHooks({ resolve(specifier, context, next) {
    if (instrumented && (context.parentURL === compilerEntry.href || context.parentURL === compilerRoutes.href)) {
      const addon = addons.find(entry => entry.specifier === specifier);
      if (addon) return next(addon.audit, context);
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
    encoding: 'utf8', input: JSON.stringify(cases), timeout: 300_000, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  return { output: JSON.parse(child.stdout), trace: child.stderr };
}

// Compare the audit build with the ordinary build and summarize every validation event.
export function auditCases(allCases, options = {}) {
  // V8 does not parse accessor fields yet, so it cannot judge a source that holds one: the audit build would
  // refuse what the certified parse accepts. Such a source rests on that parse alone, as one with decorators does.
  const cases = allCases.filter(test => !/\baccessor[ \t]+[#\w$\["']/.test(Buffer.from(test.source, 'base64').toString()));
  const { output, trace } = worker(cases, '--audit-worker');
  assert.deepEqual(output, worker(cases, '--ordinary-worker').output, 'The audit and ordinary builds disagree');
  return summarizeValidation(trace, cases, options);
}

// The guard objected to these published projections. Each must have the syntax TypeScript emits,
// unless TypeScript itself reports the source as invalid.
export async function referenceObjections(cases, objections) {
  const { inspect } = await import('./audit-compiler-coverage.mjs');
  const { compile } = await import(compilerEntry.href);
  const { createRequire } = await import('node:module');
  const ts = createRequire(import.meta.url)('typescript');
  const report = { matched: 0, invalidReference: 0, mismatches: [] };
  const sources = new Map(cases.map(test => [test.file, test]));
  for (const { file } of objections) {
    const test = sources.get(file);
    const source = Buffer.from(test.source, 'base64');
    const emitted = compile(source, { file, ...test.options });
    const reference = ts.transpileModule(source.toString(), { fileName: file, reportDiagnostics: true, compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true,
    } });
    if (reference.diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
      report.invalidReference++;
    } else if (emitted.code !== null && JSON.stringify(inspect(ts, emitted.code, file).shape) ===
        JSON.stringify(inspect(ts, reference.outputText, file).shape)) {
      report.matched++;
    } else report.mismatches.push(file);
  }
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--audit-worker' || args[0] === '--ordinary-worker') {
    console.log(JSON.stringify(await runWorker(JSON.parse(readFileSync(0, 'utf8')), args[0] === '--audit-worker')));
  } else {
    assert.ok(args.length, 'Pass one or more JSON corpora');
    const reports = [];
    for (const path of args) {
      const raw = readFileSync(path);
      const input = JSON.parse(raw);
      const cases = (input.rows ?? input).filter(test => test.mode === 'module' &&
        /\.[cm]?[jt]sx?$/.test(test.file) && !/\.d\.[cm]?ts$/.test(test.file));
      const summary = auditCases(cases);
      reports.push({ path, inputSha256: createHash('sha256').update(raw).digest('hex'), files: cases.length,
        ...summary, guardReference: await referenceObjections(cases, summary.guardObjections) });
    }
    console.log(JSON.stringify({ node: process.version, compilationCache: 'disabled', reports }, null, 2));
    // A certified projection that V8 rejects, or a guard objection that differs from TypeScript, is a defect.
    if (reports.some(report => report.certifiedRejections.length || report.guardReference.mismatches.length)) {
      process.exitCode = 1;
    }
  }
}
