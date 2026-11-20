#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { analyze } from '../src/analysis.mjs';
import { extract } from '../src/extract.mjs';
import { parseArgs } from 'node:util';
import { runPrototype } from '../src/prototype.mjs';

const usage = 'Usage: tmt-ts extract FILE [--mode script|module] [--dialect ts|tsx]\n' +
  '       tmt-ts analyze [PROJECT] [FILE...] [--lines FILE:FROM-TO] [--since REV] [--mutators focused|standard|all] [--spec FILE] [--deterministic] [--audit] [--displace-thresholds] [--runner vitest|playwright] [--project NAME] [--config FILE] [--test FILE] [--copy-exclude PATH]\n' +
  '       tmt-ts prototype PROJECT FILE [--spec FILE]';

try {
  const [command, ...args] = process.argv.slice(2);
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, options: {
      spec: { type: 'string' }, mode: { type: 'string' }, dialect: { type: 'string' },
      lines: { type: 'string', multiple: true }, since: { type: 'string' },
      deterministic: { type: 'boolean' }, audit: { type: 'boolean' },
      'displace-thresholds': { type: 'boolean' },
      mutators: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, runner: { type: 'string' }, project: { type: 'string', multiple: true }, config: { type: 'string' },
      test: { type: 'string', multiple: true }, 'copy-exclude': { type: 'string', multiple: true },
    },
  });
  if (!command || ['help', '--help', '-h'].includes(command) || values.help) {
    console.log(usage);
  } else if (command === 'extract' && positionals.length === 1) {
    const [file] = positionals;
    const result = extract(readFileSync(file), { file, mode: values.mode, dialect: values.dialect });
    console.log(JSON.stringify(result, null, 2));
    if (result.path === 'diagnostic') process.exitCode = 1;
  } else if (command === 'analyze') {
    const [project = '.', ...files] = positionals;
    if (values.runner && !['vitest', 'playwright'].includes(values.runner)) throw new Error('Expected --runner vitest|playwright');
    if (values.runner === 'playwright' && values.test?.length) throw new Error('--test selects Vitest files');
    if (values.runner === 'playwright' && values['displace-thresholds']) throw new Error('--displace-thresholds requires Vitest');
    if (values.mutators && !['focused', 'standard', 'all'].includes(values.mutators)) throw new Error('Expected --mutators focused|standard|all');
    let result;
    if (['standard', 'all'].includes(values.mutators)) {
      if (values.runner === 'playwright' || values.audit || values.spec || values['displace-thresholds'] ||
          values.mutators === 'standard' && values.deterministic) {
        throw new Error(`--mutators ${values.mutators} requires Vitest and excludes focused diagnostic options`);
      }
      const { analyzeConventional } = await import('../src/conventional.mjs');
      result = await analyzeConventional(project, files, values);
    } else {
      result = analyze(project, files, values);
    }
    console.log(JSON.stringify(result, null, 2));
    if (['baseline_error', 'incomplete'].includes(result.evaluation) || result.extraction.some(file => file.path === 'diagnostic')) process.exitCode = 1;
  } else if (command === 'prototype' && positionals.length === 2) {
    console.log(JSON.stringify(runPrototype(...positionals, values), null, 2));
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
