// Mutation check for the parser's compiler records. Each mutant changes one record call in the
// generated parser: it drops the record, moves one end of the recorded span by a byte, or keeps the
// inner records that the call was meant to replace. A mutant
// is detected when the audit build reports a certified projection that V8 rejects, or when a published
// output no longer has the syntax TypeScript emits. A mutant that only moves files to a compatibility
// route or changes spacing is harmless. A surviving mutant changes the syntax of a published output
// without either check noticing, and a mutant without effect marks a record the corpora never exercise.
//
//   node --experimental-vm-modules scripts/mutate-compiler-records.mjs [--jobs 4] [--mutants 3,7] [--operators drop] corpus.json...
//
// Corpus files are read as data. Nothing they contain is executed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(import.meta.url);
const generated = 'native/compiler/generated/Custard.c';
const recorders = ['TmtPulseParser_record_jsx_span', 'TmtPulseParser_record_compiler_span'];

// Splits the arguments of the call whose opening parenthesis is at `open`.
function callArguments(source, open) {
  const parts = [];
  const ranges = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open; at < source.length; at++) {
    const byte = source[at];
    if (byte === '(' || byte === '{') depth++;
    else if (byte === ')' || byte === '}') {
      if (--depth === 0) {
        parts.push(source.slice(start, at));
        ranges.push([start, at]);
        return { parts, ranges, end: at + 1 };
      }
    } else if (byte === ',' && depth === 1) {
      parts.push(source.slice(start, at));
      ranges.push([start, at]);
      start = at + 1;
    }
  }
  throw new Error('Unbalanced record call');
}

// Every call of a record function outside the definitions of the record functions themselves.
export function recordSites(source) {
  const sites = [];
  const pattern = new RegExp('\\b(' + recorders.join('|') + ')\\(', 'g');
  for (let match; (match = pattern.exec(source));) {
    const before = source.lastIndexOf('\n', match.index);
    // A definition starts its line with the function name.
    if (before + 1 === match.index) continue;
    const { parts, ranges, end } = callArguments(source, match.index + match[1].length);
    assert.ok(parts.length === 5, 'Unexpected record call shape');
    const line = source.slice(0, match.index).split('\n').length;
    if (/return TmtPulseParser_record_compiler_span\(input, state, kind, span, span\)/.test(source.slice(match.index - 7, end))) continue;
    sites.push({ start: match.index, end, state: parts[1].trim(), kind: parts[2].trim(), line, ranges,
      spans: match[1].endsWith('compiler_span') });
  }
  return sites;
}

// The mutant returns the parser state as it was before the record.
export function dropRecord(source, site) {
  return source.slice(0, site.start) + '(' + site.state + ')' + source.slice(site.end);
}

const shiftHelper = 'static TmtGrammar_span tmt_mutant_shift(TmtGrammar_span span, int32_t first, int32_t last)\n' +
  '{ span.first += (uint32_t)first; span.last += (uint32_t)last; return span; }\n';
const shifts = { 'start-late': [1, 0], 'start-early': [-1, 0], 'end-early': [0, -1], 'end-late': [0, 1] };

// A span that starts or ends one byte off erases too little or too much.
export function shiftRecord(source, site, operator) {
  const [first, last] = shifts[operator];
  const replace = (range, text) => source.slice(0, range[0]) + text + source.slice(range[1]);
  if (site.spans) {
    const shifted = replace(site.ranges[3], ` tmt_mutant_shift(${source.slice(...site.ranges[3])}, ${first}, ${last})`);
    const include = '#include "Custard.h"\n';
    assert.ok(shifted.includes(include));
    return shifted.replace(include, include + shiftHelper);
  }
  const range = site.ranges[first ? 3 : 4];
  const delta = first || last;
  return replace(range, ` ((${source.slice(...range)}) ${delta > 0 ? '+' : '-'} 1U)`);
}

// Some calls first rewind the record count, so one record replaces everything recorded inside its span.
export function resetSource(site) {
  const count = /\.count = (\w+)\.count/.exec(site.state)?.[1];
  const origin = /\.offset = (\w+)\.offset/.exec(site.state)?.[1];
  return count && origin && count !== origin ? { count, origin } : null;
}

export function keepInnerRecords(source, site) {
  const { count, origin } = resetSource(site);
  const state = source.slice(site.ranges[1][0], site.ranges[1][1]).replace(`.count = ${count}.count`, `.count = ${origin}.count`);
  return source.slice(0, site.ranges[1][0]) + state + source.slice(site.ranges[1][1]);
}

export function mutants(source) {
  const list = [];
  for (const [site, call] of recordSites(source).entries()) {
    list.push({ site, operator: 'drop' });
    for (const operator of Object.keys(shifts)) list.push({ site, operator });
    if (resetSource(call)) list.push({ site, operator: 'keep-inner' });
  }
  return list;
}

export function applyMutant(source, { site, operator }) {
  const call = recordSites(source)[site];
  return operator === 'drop' ? dropRecord(source, call) : operator === 'keep-inner' ? keepInnerRecords(source, call) :
    shiftRecord(source, call, operator);
}

function loadCases(paths) {
  const cases = [];
  for (const path of paths) {
    const input = JSON.parse(readFileSync(path));
    for (const test of input.rows ?? input) {
      if (test.mode === 'module' && /\.(?:tsx?|mjs)$/.test(test.file) && !/\.d\.ts$/.test(test.file)) {
        cases.push({ file: path.split('/').pop() + ':' + test.file, name: test.file, mode: 'module', source: test.source });
      }
    }
  }
  return cases;
}

// Runs in a scratch copy of the compiler: publishes every case and reports the syntax shape of each output.
async function shapes(directory, casesPath) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const { inspect } = await import('./audit-compiler-coverage.mjs');
  const { compile } = require(join(directory, 'src/compiler.cjs'));
  const cases = JSON.parse(readFileSync(casesPath));
  return cases.map(({ name, source }) => {
    let result;
    try {
      result = compile(Buffer.from(source, 'base64'), { file: name });
    } catch {
      return null;
    }
    if (result.code === null || (result.backend !== 'pulse' && result.backend !== 'javascript')) return null;
    const code = createHash('sha256').update(result.code).digest('hex').slice(0, 16);
    try {
      const { diagnostics, shape } = inspect(ts, result.code, name);
      return { code, shape: diagnostics.length ? 'invalid' : createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16) };
    } catch (error) {
      // Some conformance inputs nest deeper than the recursive comparison can follow.
      if (!(error instanceof RangeError)) throw error;
      return { code, shape: 'unreadable:' + code };
    }
  });
}

// The syntax shape TypeScript emits for each case, or null where TypeScript reports an error.
async function references(cases) {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const { inspect } = await import('./audit-compiler-coverage.mjs');
  return cases.map(({ name, source }) => {
    if (/\.mjs$/.test(name)) return null;
    const result = ts.transpileModule(Buffer.from(source, 'base64').toString(), { fileName: name, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true } });
    if (result.diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) return null;
    try {
      return createHash('sha256').update(JSON.stringify(inspect(ts, result.outputText, name).shape)).digest('hex').slice(0, 16);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return null;
    }
  });
}

function prepare(scratch, label, mutate) {
  const directory = join(scratch, label);
  mkdirSync(directory);
  for (const part of ['src', 'native', 'scripts']) cpSync(join(root, part), join(directory, part), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));
  const script = join(directory, 'scripts/build-compiler.mjs');
  // A dropped record can leave a value unused. Only the behavior of the mutant matters here.
  writeFileSync(script, readFileSync(script, 'utf8').replace("'-Werror',", '').replace("'-O3', ...inlining,", "'-O3',"));
  if (mutate) {
    const path = join(directory, generated);
    writeFileSync(path, mutate(readFileSync(path, 'utf8')));
  }
  for (const flags of [[], ['--audit-v8']]) {
    const built = spawnSync(process.execPath, ['scripts/build-compiler.mjs', ...flags], { cwd: directory, encoding: 'utf8' });
    if (built.status !== 0) return { directory, failure: built.stderr.slice(-400) };
  }
  return { directory };
}

async function evaluate(scratch, label, mutate, casesPath) {
  const { directory, failure } = prepare(scratch, label, mutate);
  if (failure) return { build: failure };
  const audit = spawnSync(process.execPath, ['--experimental-vm-modules', 'scripts/audit-compiler-v8.mjs', casesPath],
    { cwd: directory, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, timeout: 600_000 });
  let certifiedRejections = null;
  try {
    certifiedRejections = JSON.parse(audit.stdout).reports[0].certifiedRejections.length;
  } catch {
    // An audit that cannot finish counts as a detection below and keeps its message.
  }
  return { certifiedRejections, auditStatus: audit.status, auditError: audit.status === 0 || certifiedRejections !== null ? undefined :
    audit.stderr.split('\n').find(line => /Error/.test(line))?.slice(0, 160), outputs: await shapes(directory, casesPath) };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    jobs: { type: 'string', default: '4' }, mutants: { type: 'string' }, operators: { type: 'string' }, worker: { type: 'string' },
    scratch: { type: 'string' }, cases: { type: 'string' }, output: { type: 'string' },
  } });
  const source = readFileSync(join(root, generated), 'utf8');
  const sites = recordSites(source);
  const candidates = mutants(source);
  if (values.worker !== undefined) {
    const index = Number(values.worker);
    const result = await evaluate(values.scratch, 'mutant-' + index, text => applyMutant(text, candidates[index]), values.cases);
    rmSync(join(values.scratch, 'mutant-' + index), { recursive: true, force: true });
    console.log(JSON.stringify(result));
  } else {
    assert.ok(positionals.length, 'Pass one or more JSON corpora');
    const { ambiguityCases, certificationCases, denseCases, generatedCases } = await import('./generate-compiler-validation-cases.mjs');
    const cases = [...certificationCases(), ...denseCases(), ...generatedCases(), ...ambiguityCases()]
      .map(test => ({ ...test, name: test.file })).concat(loadCases(positionals));
    mkdirSync(join(root, 'build'), { recursive: true });
    const scratch = mkdtempSync(join(root, 'build/.record-mutation-'));
    try {
      const casesPath = join(scratch, 'cases.json');
      writeFileSync(casesPath, JSON.stringify(cases));
      const expected = await references(cases);
      const baseline = await evaluate(scratch, 'baseline', null, casesPath);
      assert.equal(baseline.build, undefined, baseline.build);
      assert.equal(baseline.certifiedRejections, 0, 'The unmutated compiler has certified rejections');
      const differs = (outputs, index) => outputs[index] !== null && expected[index] !== null && outputs[index].shape !== expected[index];
      const operators = values.operators?.split(',');
      const selected = values.mutants ? values.mutants.split(',').map(Number) :
        candidates.map((_, index) => index).filter(index => !operators || operators.includes(candidates[index].operator));
      const results = [];
      const queue = [...selected];
      const run = () => new Promise(done => {
        const index = queue.shift();
        if (index === undefined) return done();
        const child = spawn(process.execPath, ['--experimental-vm-modules', entry, '--worker', String(index),
          '--scratch', scratch, '--cases', casesPath], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
        let text = '';
        child.stdout.on('data', chunk => { text += chunk; });
        child.on('close', () => {
          let result;
          try { result = JSON.parse(text.trim().split('\n').at(-1)); } catch { result = { build: 'worker failed' }; }
          const site = sites[candidates[index].site];
          const row = { mutant: index, site: candidates[index].site, operator: candidates[index].operator, line: site.line, kind: site.kind };
          if (result.build) Object.assign(row, { outcome: 'build-failed' });
          else {
            // A mutant may also push a file to a compatibility route, which is safe, or change only spacing.
            const pairs = result.outputs.map((output, at) => [output, baseline.outputs[at], at]);
            const declined = pairs.filter(([output, before]) => output === null && before !== null).length;
            // A dropped kind 29 mark publishes a file that the unmutated compiler declines.
            const published = pairs.filter(([output, before]) => output !== null && output.code !== before?.code);
            const reshaped = published.filter(([output, before]) => output.shape !== before?.shape);
            const reference = reshaped.filter(([, , at]) => differs(result.outputs, at) && !differs(baseline.outputs, at)).length;
            const unjudged = reshaped.filter(([, , at]) => expected[at] === null).length;
            const audit = result.certifiedRejections ?? (result.auditStatus === 0 ? 0 : 1);
            Object.assign(row, { declined, changedPublished: published.length, reshaped: reshaped.length,
              certifiedRejections: result.certifiedRejections, auditError: result.auditError, referenceMismatches: reference, unjudged,
              outcome: audit > 0 && reference > 0 ? 'both' : audit > 0 ? 'audit' : reference > 0 ? 'reference' :
                reshaped.length ? 'SURVIVED' : published.length ? 'spacing-only' : declined ? 'declined-only' : 'no-effect' });
          }
          results.push(row);
          console.error(JSON.stringify(row));
          run().then(done);
        });
      });
      await Promise.all(Array.from({ length: Number(values.jobs) }, run));
      results.sort((a, b) => a.mutant - b.mutant);
      const tally = {};
      for (const row of results) tally[row.outcome] = (tally[row.outcome] ?? 0) + 1;
      const report = { node: process.version, cases: cases.length, sites: sites.length, mutants: candidates.length,
        evaluated: results.length, tally, results };
      if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 1) + '\n');
      console.log(JSON.stringify({ cases: cases.length, sites: sites.length, mutants: candidates.length, evaluated: results.length, tally }));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
