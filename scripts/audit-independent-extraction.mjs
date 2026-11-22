import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { extract } from '../src/extract.mjs';
import { byteOffsets, normalize, sourceDialect } from '../src/source-text.mjs';
import { createTypeScriptExtractor } from '../src/typescript-extraction.mjs';
import { extractYuku } from '../test/support/yuku-extraction.mjs';

const established = [
  ['react', 'react/react', 'ae74234eae6ebd62f19190731278e20bc1c37d51',
    ['compiler/packages', 'compiler/apps/playground', 'packages/react', 'packages/react-dom', 'packages/scheduler'],
    /^(?:compiler\/packages\/[^/]+\/src\/|compiler\/apps\/playground\/|packages\/(?:react|react-dom|scheduler)\/)/],
  ['vue', 'vuejs/core', '5a8aa0b2ba575e098cbb63b396e9bcb751eb3a0f', ['packages'], /^packages\/[^/]+\/src\//],
  ['fastify', 'fastify/fastify', '91414fecaa0ad383c7f97c91f86bee87bf4f06c0', ['fastify.js', 'lib', 'types']],
  ['zod', 'colinhacks/zod', '3b946107b6c94b2ac8ff9fb451160c34dc4dd794',
    ['packages/zod/src', 'packages/docs/app', 'packages/docs/components']],
  ['rxjs', 'ReactiveX/rxjs', 'e5351d02e225e275ac0e497c7b66eaa5f0c88791', ['src']],
  ['esbuild', 'evanw/esbuild', '609683d892977362a0f99026cb74b96263d728a9', ['lib', 'scripts', 'compat-table/src']],
  ['antd', 'ant-design/ant-design', 'a31d11d8a7ea7dbb54199975c48bfa246ac8b354', ['components']],
  ['material-ui', 'mui/material-ui', '28eadba9ec2899226ecbf4058b8fba1ddeab9e6d', ['packages/mui-material/src']],
];
const server = [
  ['express', 'expressjs/express', 'cd7d4397c398a3f3ecadeaf9ef6ac1377bd414c4', ['index.js', 'lib']],
  ['commander', 'tj/commander.js', '395cf7145fe28122f5a69026b310e02df114f907', ['index.js', 'esm.mjs', 'lib', 'typings']],
  ['undici', 'nodejs/undici', '7392d6f9f565e550e9047458c275ae77aeaefbb9', ['index.js', 'index-fetch.js', 'index.d.ts', 'lib', 'types']],
  ['eslint', 'eslint/eslint', 'ac3a60dffc29d8d4d5031621bc062e77f891532a', ['bin', 'conf', 'lib', 'messages', 'packages']],
  ['lodash', 'lodash/lodash', 'f299b52f39486275a9e6483b60a410e06520c538', ['lodash.js', 'fp']],
  ['prettier', 'prettier/prettier', '7a8b05f41574633fd3af5298f3eeaf33567ad3d3', ['index.js', 'standalone.js', 'bin', 'src']],
];
const typed = [
  ['hono', 'honojs/hono', '75ff8e3ea18485589816881c6278bc9783e56602',
    ['src', 'adapters'], /^(?:src\/|adapters\/[^/]+\/src\/)/],
  ['trpc', 'trpc/trpc', '0813cebf5c04e692e93f9cbc01b7f8678faa53b3', ['packages'], /^packages\/[^/]+\/src\//],
  ['solid', 'solidjs/solid', 'da28cd5b0653d402defff26c3f4513f6503caedf',
    ['packages'], /^packages\/[^/]+\/src\//],
  ['tanstack-query', 'TanStack/query', '0827cf2cb22e2c81ef210271c25fc50e9f1e7328',
    ['packages'], /^packages\/(?!query-test-utils\/)[^/]+\/src\//],
  ['zustand', 'pmndrs/zustand', '9fed2eb2f3af672da9f7bf694b996df3831fc207', ['src']],
  ['date-fns', 'date-fns/date-fns', 'a9739fb3e5384a810e90d7376446f6d84ecc5029',
    ['pkgs/core/src', 'pkgs/tz/src', 'pkgs/utc/src']],
];
const ui = [
  ['astro', 'withastro/astro', 'c302892e4a2434fb4d8e66702576f5406e63d986', ['packages/astro/src']],
  ['svelte', 'sveltejs/svelte', '90ad4e870c72aa76db35ecc7e46f0b027ffe175a', ['packages/svelte/src']],
];
const ecosystem = [
  ['htmx', 'bigskysoftware/htmx', '51c3e67bcedc5568b2a968b079888f13aedf4eb7', ['src']],
  ['alpine', 'alpinejs/alpine', '8d3d9a2f98385d4c879f4b5be080a0221279ed4d',
    ['packages'], /^packages\/[^/]+\/src\//],
  ['redux-toolkit', 'reduxjs/redux-toolkit', '4a3ad9ab235a09420dc923f3325f813b11eecb0c', ['packages/toolkit/src']],
];
const frameworks = [
  ['react-router', 'remix-run/react-router', '9916920a490c018eb78d7cc8c55a0efd6e9feac9',
    ['packages/react-router/lib', 'packages/react-router-dom']],
  ['immer', 'immerjs/immer', '784c86bb234e805566481c9425fcb2a3897e8bcc', ['src']],
  ['lit', 'lit/lit', 'b17fb14470c69a68205c10b69451883da07f4dde',
    ['packages/lit/src', 'packages/lit-html/src', 'packages/lit-element/src', 'packages/reactive-element/src',
      'packages/task/src', 'packages/context/src', 'packages/react/src']],
];
const buildtools = [
  ['vitest', 'vitest-dev/vitest', '8b0ca603a8342aff1851a37ce0c0ae8cf4fa6b56',
    ['packages'], /^packages\/[^/]+\/src\//],
  ['rollup', 'rollup/rollup', '173cfd3ac9f35acd1defc2b2dfe075b9c2759df0', ['src']],
  ['tailwindcss', 'tailwindlabs/tailwindcss', '511c82a2ce4431b16fc72cd0580da9964497a2f1',
    ['packages'], /^packages\/[^/]+\/src\//],
];
const suites = new Map(Object.entries({ established, server, typed, ui, ecosystem, frameworks, buildtools }));
const swr = ['swr-firestore', 't-k/swr-firestore', '25e295e6150025bc9b234eea5119589dee473ded', ['src']];
const extension = /\.(?:[jt]sx?|[cm][jt]s)$/;
const testsAndFixtures = /(?:^|\/)(?:__tests__|__fixtures__|__snapshots__|__test-utils__|__mocks__|test|tests|spec|fixtures|dist|node_modules|demo|demos)\/|(?:^|\/)(?:test|tests)(?:\.tp)?\.[^/]+$|\.(?:test|spec|bench)(?:-d)?\.[^/]+$/;
const flowDirective = /\/\*[^]*?@(?:no)?flow\b[^]*?\*\/|\/\/[^\n]*@(?:no)?flow\b/;
const conformanceHarness = /^scripts\/(?:browser\/)?(?:[\w-]+-tests?|test[\w-]+|destructuring-fuzzer|parse-ts-files|verify-source-map)\.[jt]s$/;
const maximumBlob = 2 * 1024 * 1024;
const maximumBatch = 2 * maximumBlob;
const replacements = new Map([['<', '<='], ['<=', '<'], ['>', '>='], ['>=', '>']]);
const require = createRequire(import.meta.url);
const usage = `Usage: node --max-old-space-size=512 scripts/audit-independent-extraction.mjs --checkouts PATH [--suite ${[...suites.keys()].join('|')}] [--comparisons-only] [--swr-firestore PATH]
Use directory names matching the selected cohort's pinned repositories. Checkouts may be bare or cloned without checkout.
The established cohort includes an existing PATH/swr-firestore by default.
Build the native addon and install this project's development dependencies before running.
The audit writes JSON to stdout and exits 1 if it finds any disagreements.`;

function git(checkout, args, input) {
  const result = spawnSync('git', ['--no-replace-objects', '-C', checkout, ...args], {
    input, timeout: 30_000, maxBuffer: maximumBatch,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${checkout}: git ${args[0]} failed: ${result.error?.message ?? result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

function* blobs(checkout, revision, paths, include, excluded) {
  const tree = git(checkout, ['ls-tree', '-lrz', revision, '--', ...paths]).toString();
  let batch = [];
  let batchBytes = 0;
  for (const entry of tree.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const file = entry.slice(tab + 1);
    if (!extension.test(file) || (include && !include.test(file))) continue;
    if (testsAndFixtures.test(file)) {
      increment(excluded, 'tests-fixtures-distribution');
      continue;
    }
    const [mode, kind, object, size] = entry.slice(0, tab).split(/\s+/);
    if (kind !== 'blob' || !['100644', '100755'].includes(mode) || Number(size) > maximumBlob) {
      increment(excluded, 'large-or-non-regular');
      continue;
    }
    if (batch.length >= 256 || batchBytes + Number(size) > maximumBlob) {
      yield* readBatch(checkout, batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push({ file, object, size: Number(size) });
    batchBytes += Number(size);
  }
  if (batch.length) yield* readBatch(checkout, batch);
}

function* readBatch(checkout, batch) {
  const input = batch.map(({ object }) => object + '\n').join('');
  const buffer = git(checkout, ['cat-file', '--batch'], input);
  let cursor = 0;
  for (const { file, object, size } of batch) {
    const headerEnd = buffer.indexOf(10, cursor);
    const header = buffer.toString('ascii', cursor, headerEnd);
    const end = headerEnd + 1 + size;
    if (headerEnd < 0 || header !== `${object} blob ${size}` || buffer[end] !== 10) {
      throw new Error(`${checkout}: invalid pinned blob response for ${file}`);
    }
    yield { file, source: buffer.subarray(headerEnd + 1, end) };
    cursor = end + 1;
  }
}

function classify(project, file, text, declarationFile) {
  if (project === 'undici' && /^lib\/llhttp\/llhttp(?:_simd)?-wasm\.js$/.test(file)) return 'excluded-generated';
  if (project === 'eslint' && /^packages\/js\/src\/configs\//.test(file)) return 'excluded-generated';
  if (project === 'date-fns' && /^\s*\/\/ This file is generated automatically by /.test(text)) return 'generated';
  if (project === 'esbuild' && conformanceHarness.test(file)) return 'conformance-harness';
  if (project === 'fastify' && file === 'lib/configValidator.js') return 'generated';
  return declarationFile ? 'declaration' : 'source';
}

const commonJSCohort = new Set(server.map(([name]) => name).filter(name => name !== 'prettier'));

function parseInput(ts, project, file, text, logical) {
  const originalDialect = sourceDialect(file);
  let dialect = originalDialect;
  const parse = kind => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  let tree = parse(dialect === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (dialect === 'ts' && /\.[cm]?js$/.test(file) && tree.parseDiagnostics.length && /<\/?[A-Za-z]|<>/.test(text)) {
    const jsx = parse(ts.ScriptKind.TSX);
    if (!jsx.parseDiagnostics.length) {
      tree = jsx;
      dialect = 'tsx';
    }
  }
  const commonJS = /(?:^|\/)npm\/|^packages\/[^/]+\/index\.js$/.test(file);
  const external = ts.isExternalModule(tree);
  const commonJSExtension = /\.cjs$/.test(file) || (/\.cts$/.test(file) && !external);
  const script = commonJSExtension || (!/\.m[jt]s$/.test(file) && !external &&
    (commonJS || commonJSCohort.has(project) || project === 'fastify' || project === 'esbuild' || project === 'htmx'));
  return { tree, file, dialect, originalDialect, mode: script ? 'script' : 'module', logical, requireNative: true };
}

function rawCandidates(ts, tree, text, logical) {
  const offsets = byteOffsets(text);
  const span = node => [offsets[node.getStart(tree)], offsets[node.end]];
  const candidates = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.getText(tree);
      const replacement = replacements.get(operator);
      if (replacement) candidates.push({ rule: 'comparison-boundary/v1', operator, replacement,
        edit: span(node.operatorToken), left: span(node.left), right: span(node.right) });
    } else if (logical && ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'disabled') {
      const attribute = node.initializer;
      const value = attribute && ts.isJsxExpression(attribute) && attribute.expression;
      if (value && ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        candidates.push({ rule: 'jsx-disabled-drop-left/v1', operator: '||', operatorEdit: span(value.operatorToken),
          replacement: '(' + value.right.getText(tree) + ')', edit: span(value), left: span(value.left), right: span(value.right) });
      }
    }
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return candidates.sort((a, b) => (a.operatorEdit ?? a.edit)[0] - (b.operatorEdit ?? b.edit)[0]);
}

function validCandidate(source, candidate) {
  const boundary = value => Number.isInteger(value) && value >= 0 && value <= source.length && (source[value] & 0xc0) !== 0x80;
  const operator = candidate.operatorEdit ?? candidate.edit;
  return [candidate.edit, operator, candidate.left, candidate.right].every(([first, last]) => boundary(first) && boundary(last) && first <= last) &&
    candidate.left[1] <= operator[0] && operator[1] <= candidate.right[0] && source.toString('utf8', ...operator) === candidate.operator;
}

function compare(mismatches, context, pair, actual, expected, exactDiagnostics = false) {
  if ((actual.path === 'diagnostic') !== (expected.path === 'diagnostic')) {
    mismatches.push({ ...context, check: pair + ' acceptance', actual: actual.path, expected: expected.path,
      actualDiagnostic: actual.diagnostics?.[0], expectedDiagnostic: expected.diagnostics?.[0] });
  } else if (exactDiagnostics && actual.path === 'diagnostic' && !isDeepStrictEqual(actual.diagnostics, expected.diagnostics)) {
    mismatches.push({ ...context, check: pair + ' diagnostics', actual: actual.diagnostics, expected: expected.diagnostics });
  } else if (!isDeepStrictEqual(actual.candidates, expected.candidates)) {
    const index = actual.candidates.findIndex((item, i) => !isDeepStrictEqual(item, expected.candidates[i]));
    const firstDifference = index < 0 ? actual.candidates.length : index;
    mismatches.push({ ...context, check: pair + ' candidates', firstDifference,
      actualCount: actual.candidates.length, expectedCount: expected.candidates.length,
      actual: actual.candidates[firstDifference], expected: expected.candidates[firstDifference] });
  }
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function audit(shard, checkout, ts, extractFull, logical) {
  const [name, upstream, revision, paths, include] = shard;
  const report = { name, upstream, revision, paths, include: include?.source, excluded: {}, classes: {}, fallbackReasons: {}, mismatches: [] };
  for (const { file, source } of blobs(checkout, revision, paths, include, report.excluded)) {
    const text = normalize(source);
    if (text === null || (/\.[cm]?jsx?$/.test(file) && flowDirective.test(text.slice(0, 4096)))) {
      increment(report.excluded, text === null ? 'invalid-utf8' : 'flow');
      continue;
    }
    const { tree, originalDialect, ...options } = parseInput(ts, name, file, text, logical);
    const kind = classify(name, file, text, tree.isDeclarationFile);
    if (kind === 'excluded-generated') {
      increment(report.excluded, 'generated');
      continue;
    }
    const actual = extract(source, options);
    const full = extractFull(text, options);
    const yuku = extractYuku(source, { ...options, declarationFile: tree.isDeclarationFile });
    const native = actual.path === 'fast';
    const logicalCandidates = actual.candidates.filter(candidate => candidate.operator === '||').length;
    const context = { file, class: kind, mode: options.mode, dialect: options.dialect };
    compare(report.mismatches, context, 'shipped/TypeScript', actual, full, true);
    compare(report.mismatches, context, 'TypeScript/Yuku', full, yuku);
    if (!tree.parseDiagnostics.length && full.path !== 'diagnostic') {
      compare(report.mismatches, context, 'TypeScript/raw AST', full, { candidates: rawCandidates(ts, tree, text, logical) });
    }
    for (const [parser, result] of [['shipped', actual], ['TypeScript', full], ['Yuku', yuku]]) {
      const bad = result.candidates.find(candidate => !validCandidate(source, candidate));
      if (bad) report.mismatches.push({ ...context, check: parser + ' byte ranges', candidate: bad });
    }
    const stats = report.classes[kind] ??= { files: 0, bytes: 0, nativeFiles: 0, nativeBytes: 0, candidates: 0,
      nativeCandidates: 0, tsxFiles: 0, nativeTsxFiles: 0, dialectOverrides: 0, unicodeFiles: 0,
      diagnostics: 0, logicalCandidates: 0, nativeLogicalCandidates: 0 };
    stats.files++;
    stats.bytes += source.length;
    stats.candidates += actual.candidates.length;
    stats.logicalCandidates += logicalCandidates;
    if (text.length !== source.length) stats.unicodeFiles++;
    if (actual.path === 'diagnostic') stats.diagnostics++;
    if (options.dialect === 'tsx') stats.tsxFiles++;
    if (originalDialect !== options.dialect) stats.dialectOverrides++;
    if (native) {
      stats.nativeFiles++;
      stats.nativeBytes += source.length;
      stats.nativeCandidates += actual.candidates.length;
      stats.nativeLogicalCandidates += logicalCandidates;
      if (options.dialect === 'tsx') stats.nativeTsxFiles++;
    } else increment(report.fallbackReasons, actual.reason ?? actual.path);
  }
  if (!Object.keys(report.classes).length) throw new Error(`${checkout}: no source blobs selected at ${revision}`);
  return report;
}

function main() {
  const { values } = parseArgs({ options: {
    checkouts: { type: 'string' }, suite: { type: 'string', default: 'established' },
    'comparisons-only': { type: 'boolean' }, 'swr-firestore': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(usage);
    return;
  }
  const shards = suites.get(values.suite);
  if (!values.checkouts || !shards || values['swr-firestore'] === '') throw new Error(usage);
  if (values.suite !== 'established' && values['swr-firestore']) throw new Error(usage);
  const checkoutRoot = resolve(values.checkouts);
  const inputs = shards.map(shard => [shard, resolve(checkoutRoot, shard[0])]);
  if (values.suite === 'established') {
    const swrCheckout = resolve(values['swr-firestore'] ?? resolve(checkoutRoot, swr[0]));
    if (values['swr-firestore'] || existsSync(swrCheckout)) inputs.push([swr, swrCheckout]);
  }
  for (const [shard, checkout] of inputs) git(checkout, ['cat-file', '-e', shard[2] + '^{tree}']);
  const compiler = require.resolve('typescript');
  const alreadyLoaded = !!require.cache[compiler];
  const ts = require(compiler);
  // Keep the oracle's compiler load from disabling the shipped syntax projection.
  if (!alreadyLoaded) delete require.cache[compiler];
  const extractFull = createTypeScriptExtractor(ts);
  const addon = readFileSync(new URL('../build/tmt.node', import.meta.url));
  const revision = git(fileURLToPath(new URL('..', import.meta.url)), ['rev-parse', 'HEAD']).toString().trim();
  const logical = !values['comparisons-only'];
  const reports = inputs.map(([shard, checkout]) => audit(shard, checkout, ts, extractFull, logical));
  const result = { revision, suite: values.suite, logical, nativeSha256: createHash('sha256').update(addon).digest('hex'), node: process.version,
    typescript: ts.version, yuku: require('yuku-parser/package.json').version, reports };
  console.log(JSON.stringify(result, null, 2));
  if (reports.some(report => report.mismatches.length)) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
}
