import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const entry = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const engines = ['tmt', 'oxc', 'yuku', 'swc-next'];
if (process.env.TMT_COMPARE_CURRENT_YUKU === '1') engines.push('yuku-current');
const rounds = 7;

export function benchmarkCache(args) {
  const flag = args.findLast(arg => arg === '--no-compilation-cache' || arg === '--compilation-cache');
  return flag === '--no-compilation-cache'
    ? { mode: 'disabled', flags: [flag] }
    : { mode: 'repeated', flags: [] };
}

export function comparisonCohorts(accepted, size, official) {
  const names = Object.keys(accepted);
  const maskFor = members => Array.from({ length: size }, (_, i) =>
    Number(members.every(name => accepted[name][i]))).join('');
  const participants = official ? names.filter(name => accepted[name][0]) : names;
  const common = {
    cohort: 'common', engines: participants,
    mask: official ? String(Number(participants.includes('tmt') && participants.length > 1)) : maskFor(participants),
  };
  const trio = ['tmt', 'oxc', 'swc-next'].filter(name => Object.hasOwn(accepted, name));
  if (!official && trio.length === 3) {
    const mask = maskFor(trio);
    if (mask !== common.mask) return [common, { cohort: 'tmt-oxc-swc-next', engines: trio, mask }];
  }
  return [common];
}

function isTsxCorpus(path) { return path.endsWith('.tsx.json'); }

function readCases(path) {
  if (path === 'synthetic') {
    return Array.from({ length: 256 }, (_, index) => {
      const source = `export const pick = (x: number): boolean => x >= ${index};\n`;
      return { file: 'input.ts', source, bytes: Buffer.from(source), expected: index };
    });
  }
  if (path === 'declarations') {
    const source = Array.from({ length: 256 }, (_, index) =>
      `export const item${index}: number = ${index};\n`).join('');
    return [{ file: 'declarations.ts', source, bytes: Buffer.from(source), declarations: 256 }];
  }
  if (path === 'jsx' || path === 'enum') {
    return Array.from({ length: 256 }, (_, value) => {
      const source = path === 'jsx' ? (value % 2 ?
        'export function View(n: number) { return (\n  <section data-id={n}>\n    <b>ready</b>\n    {n}\n  </section>\n); }' :
        'export const View = (n: number) => <section data-id={n}><b>ready</b>{n}</section>;') :
        `export enum Flag { Start = ${value}, Next, Off = "off" }`;
      return { file: path === 'jsx' ? 'view.tsx' : 'flags.ts', source, bytes: Buffer.from(source), lowering: path, value };
    });
  }
  const dialect = isTsxCorpus(path) ? /\.tsx$/i : path.endsWith('.js.json') ? /\.m?js$/i : /\.m?ts$/i;
  return JSON.parse(readFileSync(path, 'utf8'))
    .filter(test => dialect.test(test.file) && !/\.d\.m?ts$/i.test(test.file) && test.mode === 'module')
    .map(({ file, source }) => {
      const bytes = Buffer.from(source, 'base64');
      return { file, source: bytes.toString('utf8'), bytes };
    });
}

async function load(name) {
  if (name === 'tmt') {
    if (process.env.TMT_BENCH_NO_TYPESCRIPT === '1') {
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'typescript' || /typescript-syntax\.[cm]?js$/.test(specifier)) {
          throw Object.assign(new Error(specifier), { code: 'BENCH_TYPESCRIPT_LOAD' });
        }
        return next(specifier, context);
      } });
    }
    const { compile } = require('../src/compiler.cjs');
    return test => {
      try {
        return compile(test.bytes, { file: test.file });
      } catch (error) {
        if (error.code !== 'BENCH_TYPESCRIPT_LOAD') throw error;
        return { backend: 'typescript-required', code: null };
      }
    };
  }
  if (name === 'node-strip') {
    return test => ({ code: stripTypeScriptTypes(test.source) });
  }
  if (name === 'oxc') {
    const { transformSync } = await import('oxc-transform');
    return test => {
      const result = transformSync(test.file, test.source, {
        target: 'esnext', sourceType: 'module', typescript: { onlyRemoveTypeImports: true },
        jsx: /\.tsx$/.test(test.file) ? { runtime: 'automatic' } : undefined,
      });
      return { code: result.errors.length ? null : result.code };
    };
  }
  if (name === 'yuku') {
    const [{ parse }, { generate }] = await Promise.all([import('yuku-parser'), import('yuku-codegen')]);
    return test => {
      const parsed = parse(test.source, { path: test.file, lang: /\.m?js$/i.test(test.file) ? 'js' : 'ts', sourceType: 'module',
        preserveParens: true, semanticErrors: true });
      if (parsed.diagnostics.length) return { code: null };
      const result = generate(parsed.program, { strip: true, comments: 'all' });
      return { code: result.diagnostics.length ? null : result.code };
    };
  }
  if (name === 'yuku-current') {
    const { parse, print } = await import('yuku');
    return test => {
      const source = parse(test.bytes, { filename: test.file, lang: /\.m?js$/i.test(test.file) ? 'js' : 'ts',
        sourceType: 'module', preserveParens: true });
      if (source.diagnostics.length) return { code: null };
      const result = print(source, { strip: true, comments: 'all' });
      return { code: result.diagnostics.length ? null : result.code };
    };
  }
  if (name === 'swc-next') {
    const addon = require(resolve(process.env.TMT_SWC_NEXT_ADDON ?? 'build/swc-next.node'));
    return test => ({ code: addon.compile(test.bytes, test.file) });
  }
  throw new Error(`Unknown engine: ${name}`);
}

function sample(run, cases, iterations) {
  const start = performance.now();
  let sum = 0;
  for (let turn = 0; turn < iterations; turn++) {
    for (const test of cases) {
      const { code } = run(test);
      if (typeof code !== 'string') throw new Error(`A selected fixture was declined: ${test.file}`);
      sum += code.length;
    }
  }
  return { ms: (performance.now() - start) / iterations, sum };
}

async function compareLowered(code, test) {
  const context = vm.createContext();
  const runtime = new vm.SourceTextModule(
    'export const Fragment = "fragment"; export function jsx(type, props) { return {type, props}; } export function jsxs(type, props) { return {type, props, multiple: true}; }',
    { context },
  );
  await runtime.link(() => { throw new Error('Unexpected JSX runtime import'); });
  await runtime.evaluate();
  const module = new vm.SourceTextModule(code, { context });
  await module.link(specifier => {
    assert.equal(specifier, 'react/jsx-runtime');
    return runtime;
  });
  await module.evaluate({ timeout: 1000 });
  if (test.lowering === 'jsx') {
    const expected = { type: 'section', props: { 'data-id': test.value,
      children: [{type: 'b', props: { children: 'ready' }}, test.value] }, multiple: true };
    assert.deepEqual(JSON.parse(JSON.stringify(module.namespace.View(test.value))), expected);
  } else {
    const expected = { [test.value]: 'Start', [test.value + 1]: 'Next',
      Start: test.value, Next: test.value + 1, Off: 'off' };
    assert.deepEqual(JSON.parse(JSON.stringify(module.namespace.Flag)), expected);
  }
}

async function inspect(name, run, test) {
  let result;
  try {
    result = run(test);
    if (result.code === null) return { accepted: false, native: false, backend: result.backend };
    const module = new vm.SourceTextModule(result.code);
    if (test.expected !== undefined) {
      assert.match(result.code, new RegExp(`^export\\s+const\\s+pick\\s*=\\s*(?:\\(\\s*x\\s*\\)|x)\\s*=>\\s*x\\s*>=\\s*${test.expected}\\s*;?\\s*$`));
      if (name === 'tmt' || name === 'node-strip') assert.equal(result.code, stripTypeScriptTypes(test.source));
      assert.ok(module);
    }
    if (test.declarations) {
      await module.link(() => { throw new Error('Unexpected declaration dependency'); });
      await module.evaluate({ timeout: 1000 });
      for (let index = 0; index < test.declarations; index++) assert.equal(module.namespace['item' + index], index);
    }
    if (test.lowering) await compareLowered(result.code, test);
    return { accepted: true, native: result.backend === 'pulse', backend: result.backend };
  } catch (error) {
    if (test.expected !== undefined || test.declarations || test.lowering) throw error;
    if (error instanceof SyntaxError || error.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' ||
        error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') return { accepted: false, native: false };
    throw error;
  }
}

async function measure(path, cases, active, plan, metadata, cache) {
  const { cohort, engines: measured, mask } = plan;
  const selected = cases.filter((_, index) => mask[index] === '1');
  const result = { ...metadata, cohort, selected: selected.length,
    samples: Object.fromEntries(measured.map(name => [name, { warm: [], first: [] }])) };
  if (!selected.length) return { ...result, medians: {} };

  const { generated, official } = metadata;
  const iterations = generated ? 25 : official ? 5 : 1;
  const expected = Object.fromEntries(measured.map(name => [name, sample(active[name], selected, 1).sum]));
  for (let turn = 0; turn < rounds; turn++) {
    const order = [...measured.slice(turn % measured.length), ...measured.slice(0, turn % measured.length)];
    for (const name of order) {
      const warm = sample(active[name], selected, iterations);
      assert.equal(warm.sum, iterations * expected[name]);
      result.samples[name].warm.push(warm.ms);
      const child = spawnSync(process.execPath, [...cache.flags, entry, '--first', name, path, mask], {
        encoding: 'utf8', env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
        timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const cold = JSON.parse(child.stdout);
      assert.equal(cold.sum, expected[name]);
      result.samples[name].first.push(cold.ms);
    }
  }
  result.medians = Object.fromEntries(measured.map(name => [name, Object.fromEntries(
    Object.entries(result.samples[name]).map(([mode, list]) => [
      mode, list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)],
    ]))]));
  return result;
}

async function main(args) {
  const [first, second, third, fourth] = args;
  if (first === '--first') {
    const cases = readCases(third).filter((_, index) => fourth[index] === '1');
    const start = performance.now();
    const run = await load(second);
    const { sum } = sample(run, cases, 1);
    console.log(JSON.stringify({ ms: performance.now() - start, sum }));
    return;
  }

  const cache = benchmarkCache(process.execArgv);
  const reports = [];
  assert.ok(args.length, 'Pass synthetic or one or more corpus JSON files');
  const active = Object.fromEntries(await Promise.all([...engines, 'node-strip'].map(async name => [name, await load(name)])));
  for (const path of args) {
    const cases = readCases(path);
    const generated = ['synthetic', 'declarations', 'jsx', 'enum'].includes(path);
    const official = path.includes('/official-');
    if (official) assert.equal(cases.length, 1, path);
    const names = path === 'synthetic' || path === 'declarations' ? [...engines, 'node-strip'] :
      generated || isTsxCorpus(path) ? engines.filter(name => !name.startsWith('yuku')) : engines;
    const coverage = Object.fromEntries(names.map(name => [name, { accepted: 0, native: 0 }]));
    const accepted = Object.fromEntries(names.map(name => [name, []]));
    coverage.tmt.backends = {};
    for (const test of cases) {
      for (const name of names) {
        const result = await inspect(name, active[name], test);
        accepted[name].push(result.accepted);
        coverage[name].accepted += Number(result.accepted);
        coverage[name].native += Number(result.native);
        if (name === 'tmt' && result.backend) {
          const backends = coverage.tmt.backends;
          backends[result.backend] = (backends[result.backend] ?? 0) + 1;
        }
      }
    }
    const metadata = { name: path, cases: cases.length, coverage, generated, official,
      inputSha256: generated ? null : createHash('sha256').update(readFileSync(path)).digest('hex') };
    for (const cohort of comparisonCohorts(accepted, cases.length, official)) {
      const result = await measure(path, cases, active, cohort, metadata, cache);
      if (generated) assert.equal(result.selected, cases.length);
      reports.push(result);
      console.error(path, JSON.stringify({ cohort: result.cohort, selected: result.selected, coverage, medians: result.medians }));
    }
  }
  console.log(JSON.stringify({ node: process.version, os: process.platform, arch: process.arch, rounds,
    compilationCache: cache.mode, reports }, null, 2));
}

if (import.meta.main) await main(process.argv.slice(2));
