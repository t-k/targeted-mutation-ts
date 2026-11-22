import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const replacements = new Map([['<', '<='], ['<=', '<'], ['>', '>='], ['>=', '>']]);
const file = fileURLToPath(import.meta.url);
const rounds = 7;
const names = ['tmt', 'yuku', 'swc-next', 'oxc', 'oxc-lazy'];
const inputs = process.env.TMT_BENCH_INPUTS;
const baseline = process.env.TMT_BENCH_BASELINE;
const inputPath = name => resolve(inputs, `input-${name}.json`);
const input = name => JSON.parse(readFileSync(inputPath(name), 'utf8')).map(({ source, ...options }) => {
  const buffer = Buffer.from(source, 'base64');
  const text = buffer.toString();
  return { ...options, buffer, text };
});

async function load(name) {
  if (name === 'tmt' || name === 'tmt-baseline') {
    const { extract } = await import(name === 'tmt' ? '../src/extract.mjs' : pathToFileURL(resolve(baseline)));
    const run = ({ buffer, file, dialect, mode }) => extract(buffer, { file, dialect, mode, requireNative: true });
    return { extract: entry => {
      const result = run(entry);
      return result.path === 'diagnostic' ? null : result.candidates;
    }, native: entry => run(entry).path === 'fast' };
  }
  const { byteOffsets } = await import('../src/source-text.mjs');
  let parse, visit;
  if (name === 'yuku') {
    const yuku = await import('yuku-parser');
    parse = ({ text, file, lang, mode }) => yuku.parse(text, { path: file, lang, sourceType: mode,
      preserveParens: true, semanticErrors: true });
  } else if (name === 'swc-next') {
    const swc = await import('@swc-next/parser');
    parse = ({ text, lang, mode }) => swc.parseSync(text, { lang, sourceType: mode, preserveParens: true,
      semanticErrors: true, errorRecovery: true, comments: 'none' });
  } else {
    const oxc = await import('oxc-parser');
    if (name === 'oxc-lazy') assert.ok(oxc.rawTransferSupported(), 'Oxc lazy transfer is required');
    parse = ({ text, file, lang, mode }) => oxc.parseSync(file, text, { lang, sourceType: mode,
      preserveParens: true, showSemanticErrors: true, experimentalLazy: name === 'oxc-lazy' });
    const lazy = name === 'oxc-lazy';
    const Visitor = lazy ? oxc.experimentalGetLazyVisitor() : oxc.Visitor;
    let binary;
    const visitor = new Visitor({ BinaryExpression: node => binary(node) });
    visit = (result, listener) => {
      binary = listener;
      try {
        if (lazy) result.visit(visitor);
        else visitor.visit(result.program);
      } finally {
        binary = undefined;
      }
    };
  }
  const errors = parsed => (parsed.diagnostics ?? parsed.errors).some(diag => {
    const severity = diag.severity;
    return severity === undefined || severity === 'Error' || severity === 'error';
  });
  return { parse: entry => {
    const result = parse(entry);
    try {
      return errors(result) ? -1 : result.program.body.length;
    } finally {
      result.dispose?.();
    }
  }, extract: entry => {
    const result = parse(entry);
    try {
      return extractAst(entry, result);
    } finally {
      result.dispose?.();
    }
  } };

  function extractAst(entry, result) {
    if (errors(result)) return null;
    const { text, buffer } = entry;
    let offsets;
    const byte = at => {
      if (offsets === undefined) offsets = text.length === buffer.length ? null : byteOffsets(text);
      return offsets === null ? at : offsets[at];
    };
    const operators = /\s+|\/\/[^\r\n\u2028\u2029]*|\/\*[^]*?\*\/|<=|>=|<|>/gy;
    const candidates = [];
    function binary(node) {
      const { operator, left, right } = node;
      const replacement = replacements.get(operator);
      if (!replacement) return;
      operators.lastIndex = left.end;
      while (operators.lastIndex < right.start) {
        const start = operators.lastIndex;
        const token = operators.exec(text);
        if (!token) break;
        if (token[0] === operator) {
          candidates.push({ rule: 'comparison-boundary/v1', operator, replacement,
            edit: [byte(start), byte(operators.lastIndex)], left: [byte(left.start), byte(left.end)],
            right: [byte(right.start), byte(right.end)] });
          return;
        }
      }
      throw new Error('No matching operator between AST operands');
    }
    if (visit) visit(result, binary);
    else {
      const pending = [result.program];
      while (pending.length) {
        const node = pending.pop();
        if (node.type === 'BinaryExpression') binary(node);
        for (const child of Object.values(node)) {
          if (Array.isArray(child)) {
            for (const item of child) if (item && typeof item.type === 'string') pending.push(item);
          } else if (child && typeof child.type === 'string') pending.push(child);
        }
      }
    }
    return candidates.sort((a, b) => a.edit[0] - b.edit[0]);
  }
}

function time(run, selected, batches) {
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < batches; i++) for (const entry of selected) {
    const result = run(entry);
    checksum += typeof result === 'number' ? result : (result?.length ?? -1);
  }
  return { ms: (performance.now() - start) / batches, checksum };
}

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const [mode, first, second, third] = process.argv.slice(2);
if (mode === 'cold') {
  const selected = input(first).filter((_, index) => second[index] === '1');
  const start = performance.now();
  const engine = await load(third);
  const sample = time(engine.extract, selected, 1);
  console.log(JSON.stringify({ ms: performance.now() - start, checksum: sample.checksum }));
} else {
  const nativeOnly = mode === '--native-only';
  const cohorts = process.argv.slice(nativeOnly ? 3 : 2);
  if (!inputs || !baseline || !cohorts.length || cohorts.some(cohort => !/^[\w-]+$/.test(cohort))) {
    throw new Error('Set TMT_BENCH_INPUTS and TMT_BENCH_BASELINE, then pass cohort names (optionally preceded by --native-only)');
  }
  const { spawnSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const active = {};
  for (const name of ['tmt-baseline', ...names]) active[name] = await load(name);
  const results = [];
  for (const cohort of cohorts) {
    const entries = input(cohort);
    const mismatches = Object.fromEntries(Object.keys(active).map(name => [name, []]));
    const included = [];
    let candidates = 0;
    for (const entry of entries) {
      const expected = active.tmt.extract(entry);
      const record = JSON.stringify(expected);
      let same = true;
      for (const [name, engine] of Object.entries(active)) {
        if (name === 'tmt') continue;
        try {
          const actual = engine.extract(entry);
          if (JSON.stringify(actual) === record) continue;
          mismatches[name].push({ file: entry.file, expected: expected?.length ?? 'diagnostic', actual: actual?.length ?? 'diagnostic' });
        } catch (e) {
          mismatches[name].push({ file: entry.file, error: e.message.split('\n')[0].slice(0, 300) });
        }
        same = false;
      }
      const matched = same && expected !== null && (!nativeOnly || active.tmt.native(entry));
      included.push(Number(matched));
      if (matched) candidates += expected.length;
    }
    assert.ok(Object.values(mismatches).every(list => !list.length), JSON.stringify(mismatches));
    assert.ok(included.some(Boolean));
    if (!nativeOnly) assert.equal(included.filter(Boolean).length, entries.length, cohort);
    const selected = entries.filter((_, index) => included[index]);
    const samples = Object.fromEntries(Object.keys(active).map(name => [name, { warm: [], cold: [], ast: [] }]));
    const order = Object.keys(active);
    if (process.env.TMT_COMPARE_TRACE) console.error(cohort, { files: selected.length, candidates, examples: Object.fromEntries(Object.entries(mismatches).map(([n, a]) => [n, a.slice(0, 2)])) });
    for (const engine of Object.values(active)) time(engine.extract, selected, 1);
    for (let turn = 0; turn < rounds; turn++) {
      const rotated = [...order.slice(turn % order.length), ...order.slice(0, turn % order.length)];
      for (const name of rotated) {
        const sample = time(active[name].extract, selected, 2);
        assert.equal(sample.checksum, candidates * 2);
        samples[name].warm.push(sample.ms);
        if (active[name].parse) samples[name].ast.push(time(active[name].parse, selected, 2).ms);
      }
    }
    for (let turn = 0; turn < rounds; turn++) for (const name of (turn % 2 ? [...order].reverse() : order)) {
      const result = spawnSync(process.execPath, [file, 'cold', cohort, included.join(''), name],
        { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } });
      assert.equal(result.status, 0, `${cohort} ${name}: ${result.signal ?? result.error?.message ?? ''} ${result.stderr}`);
      const sample = JSON.parse(result.stdout);
      assert.equal(sample.checksum, candidates);
      samples[name].cold.push(sample.ms);
    }
    results.push({ cohort, files: entries.length, matchingFiles: selected.length, candidates, mismatches,
      inputSha256: createHash('sha256').update(readFileSync(inputPath(cohort))).digest('hex'),
      samples, medians: Object.fromEntries(Object.entries(samples).map(([name, timings]) => [name,
        Object.fromEntries(Object.entries(timings).filter(([, values]) => values.length).map(([metric, values]) => [metric, median(values)]))])) });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, rounds, nativeOnly, results }, null, 2));
}
