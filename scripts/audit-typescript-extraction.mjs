import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extract, extractFallback } from '../src/extract.mjs';
import { extractTypeScript } from '../src/typescript-extraction.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  logical: { type: 'boolean' }, synthetic: { type: 'string' },
} });
if (!positionals.length && !values.synthetic) {
  throw new Error('Usage: audit-typescript-extraction [--logical] [--synthetic JSONL] [CHECKOUT...]');
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const reports = [];
let failures = 0;
function audit(name, inputs) {
  const report = { name, files: 0, native: 0, invalidEncoding: 0, accepted: 0, diagnostic: 0,
    candidates: 0, sameOrderedMessages: 0, mismatches: [] };
  for (const { source, options } of inputs) {
    report.files++;
    let text;
    try {
      text = typeof source === 'string' ? source : decoder.decode(source);
    } catch {
      report.invalidEncoding++;
      continue;
    }
    if (!text.isWellFormed()) {
      report.invalidEncoding++;
      continue;
    }
    const native = extract(text, { ...options, requireNative: true });
    if (native.path === 'fast' || native.reason === 'duplicate-lexical') {
      report.native++;
      continue;
    }
    const reference = extractFallback(text, options);
    try {
      const result = extractTypeScript(text, options);
      assert.equal(result.path, reference.path, 'Source acceptance differs');
      assert.deepEqual(result.candidates, reference.candidates, 'Candidate records differ');
      if (result.path === 'diagnostic') {
        report.diagnostic++;
        const size = Buffer.byteLength(text);
        for (const diagnostic of result.diagnostics) {
          assert.equal(diagnostic.path, options.file ?? null);
          assert.ok(diagnostic.start >= 0 && diagnostic.start <= diagnostic.end && diagnostic.end <= size);
          for (const label of diagnostic.labels) {
            assert.ok(label.start >= 0 && label.start <= label.end && label.end <= size);
          }
        }
        const messages = diagnostics => diagnostics.map(diagnostic => diagnostic.message);
        if (JSON.stringify(messages(result.diagnostics)) === JSON.stringify(messages(reference.diagnostics))) {
          report.sameOrderedMessages++;
        }
      } else {
        report.accepted++;
        report.candidates += result.candidates.length;
      }
    } catch (error) {
      failures++;
      report.mismatches.push({ input: report.files, file: options.file ?? null, message: error.message });
    }
  }
  reports.push(report);
}

for (const project of positionals) {
  const root = resolve(project);
  const paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0').filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts') && existsSync(resolve(root, file)));
  audit(root, paths.map(file => ({ source: readFileSync(resolve(root, file)), options: { file, logical: !!values.logical } })));
}
if (values.synthetic) {
  const rows = new Set(readFileSync(values.synthetic, 'utf8').trim().split('\n'));
  audit(values.synthetic, [...rows].map(row => {
    const { source, bytes, options } = JSON.parse(row);
    return { source: source ?? Buffer.from(bytes, 'base64'), options };
  }));
}

console.log(JSON.stringify({ reports, failures }, null, 2));
if (failures) process.exitCode = 1;
