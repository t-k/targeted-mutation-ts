// Differential fuzzing of certified emission. Each mutated source is compiled by the audit build, which
// asks V8 about every projection, and by the ordinary build. A certified projection that V8 rejects, or
// any difference between the two builds, is reported with the mutated source.
//
//   node --experimental-vm-modules scripts/fuzz-compiler-certification.mjs --seed 1 --count 20000 corpus.json...
//
// Corpus files are read as data. Nothing they contain is executed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { summarizeValidation } from './audit-compiler-v8.mjs';

const audit = fileURLToPath(new URL('./audit-compiler-v8.mjs', import.meta.url));

// TypeScript-only fragments, plus JavaScript fragments whose meaning changes next to an erased range.
export const fragments = [
  '?', '!', ': T', ': number', '<T>', '<T,>', ' as T', ' as const', ' satisfies T', 'declare ', 'abstract ', 'public ',
  'private ', 'protected ', 'readonly ', 'override ', 'static ', 'accessor ', 'enum E { A }', 'enum E { A = f() }',
  'const enum E { A }', 'this: T, ', 'this: T', '@dec ', 'import x = require("y");', 'export = x;', 'export as namespace N;',
  'namespace N {}', 'namespace N { export const a = 1; }', 'module M {}', 'unique symbol', 'interface I {}', 'type A = B;',
  'export { T };', 'export type { T };', 'import type { T } from "t";', 'import { type T } from "t";', 'declare const d: T;',
  'declare class D {}', 'declare function f(): void;', 'declare global {}', 'implements I', 'extends B<T>', 'in ', 'out ',
  'keyof ', 'typeof ', 'infer U', 'is T', 'asserts x', '?.', '!.', '?:', '!:', '=>', '<', '>', '>>', '(', ')', '{', '}', '[', ']',
  ';', ',', '\n', '\r\n', ' ', '`', '${', '"', "'", '/', '/*', '*/', '//', '\\', '#p', 'await ', 'yield ', 'super', 'super()',
  'new.target', 'import.meta', 'return ', 'break;', 'continue;', 'let ', 'const ', 'var ', 'function ', 'class ', 'async ',
  'get ', 'set ', 'constructor', 'constructor(public p: T) {}', 'f(): void;', 'm?(): void', '[k: string]: T;', 'x = 1',
  'delete x', 'with (x) {}', '0777', 'arguments', 'eval', 'static {}', 'default', 'export default ', 'export * from "m";',
  'import "m";', 'label: ', 'of ', 'instanceof ', 'void ', 'null', 'undefined', '...', '??', '||=', '**', '<div/>', '<>x</>',
];

function generator(seed) {
  let state = seed >>> 0 || 1;
  return bound => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state % bound;
  };
}

const boundary = /[A-Za-z_$][\w$]*|\d+|\s+|[^\w\s]/g;

export function mutate(source, random) {
  const tokens = source.match(boundary) ?? [''];
  const edits = 1 + random(3);
  for (let edit = 0; edit < edits; edit++) {
    const at = random(tokens.length + 1);
    switch (random(6)) {
      case 0: tokens.splice(at, 0, fragments[random(fragments.length)]); break;
      case 1: tokens.splice(at, 1); break;
      case 2: tokens.splice(at, 0, tokens[random(tokens.length)] ?? ''); break;
      case 3: if (at + 1 < tokens.length) [tokens[at], tokens[at + 1]] = [tokens[at + 1], tokens[at]]; break;
      case 4: tokens.splice(at, 1, fragments[random(fragments.length)]); break;
      default: tokens.splice(at, 0, ' ' + fragments[random(fragments.length)] + ' ');
    }
  }
  return tokens.join('');
}

function run(cases, mode) {
  const child = spawnSync(process.execPath, ['--no-compilation-cache', '--experimental-vm-modules', audit, mode], {
    encoding: 'utf8', input: JSON.stringify(cases), timeout: 600_000, maxBuffer: 1024 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr.slice(-2000));
  return { output: JSON.parse(child.stdout), trace: child.stderr };
}

export function fuzz(corpus, seed, count, batch = 4000) {
  const random = generator(seed);
  const findings = [];
  const totals = { cases: 0, published: 0, certified: 0, validated: 0 };
  for (let done = 0; done < count; done += batch) {
    const cases = Array.from({ length: Math.min(batch, count - done) }, (_, index) => {
      const base = corpus[random(corpus.length)];
      const text = mutate(Buffer.from(base.source, 'base64').toString('utf8'), random);
      const exported = random(4) === 0 || /\b(?:import|export)\b/.test(text) ? text : text + '\nexport {};\n';
      return { file: `fuzz/${seed}/${done + index}${/\.tsx$/.test(base.file) ? '.tsx' : '.ts'}`, mode: 'module',
        source: Buffer.from(exported).toString('base64') };
    });
    const audited = run(cases, '--audit-worker');
    const ordinary = run(cases, '--ordinary-worker').output;
    const report = summarizeValidation(audited.trace, cases);
    for (const rejection of report.certifiedRejections) findings.push({ kind: 'certified-rejection', ...rejection });
    for (const [index, result] of audited.output.entries()) {
      if (JSON.stringify(result) !== JSON.stringify(ordinary[index])) {
        findings.push({ kind: 'build-difference', file: cases[index].file, audit: result, ordinary: ordinary[index] });
      }
      if (result.codeHash !== null) totals.published++;
    }
    for (const finding of findings) finding.source ??= cases.find(test => test.file === finding.file)?.source;
    totals.cases += cases.length;
    for (const table of Object.values(report.certified)) totals.certified += table;
    for (const table of Object.values(report.checks)) for (const amount of Object.values(table)) totals.validated += amount;
  }
  return { seed, ...totals, findings };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    seed: { type: 'string', default: '1' }, count: { type: 'string', default: '20000' },
    'max-bytes': { type: 'string', default: '4096' }, output: { type: 'string' },
  } });
  assert.ok(positionals.length, 'Pass one or more JSON corpora');
  const limit = Number(values['max-bytes']);
  const corpus = positionals.flatMap(path => {
    const input = JSON.parse(readFileSync(path));
    return (input.rows ?? input).filter(test => /\.tsx?$/.test(test.file) && !/\.d\.ts$/.test(test.file) &&
      test.source.length * 3 / 4 <= limit);
  });
  const report = fuzz(corpus, Number(values.seed), Number(values.count));
  const text = JSON.stringify({ node: process.version, corpus: corpus.length, ...report }, null, 2);
  if (values.output) writeFileSync(values.output, text + '\n');
  console.log(JSON.stringify({ ...report, findings: report.findings.length }));
  if (report.findings.length) process.exitCode = 1;
}
