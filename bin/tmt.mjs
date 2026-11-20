#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { analyze } from '../src/analysis.mjs';
import { extract } from '../src/extract.mjs';
import { parseArgs } from 'node:util';
import { runPrototype } from '../src/prototype.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, options: {
      spec: { type: 'string' }, mode: { type: 'string' }, dialect: { type: 'string' },
      lines: { type: 'string', multiple: true }, since: { type: 'string' },
      deterministic: { type: 'boolean' }, audit: { type: 'boolean' },
    },
  });
  if (command === 'extract' && positionals.length === 1) {
    const [file] = positionals;
    const result = extract(readFileSync(file), { file, mode: values.mode, dialect: values.dialect });
    console.log(JSON.stringify(result, null, 2));
    if (result.path === 'diagnostic') process.exitCode = 1;
  } else if (command === 'analyze') {
    const [project = '.', ...files] = positionals;
    const result = analyze(project, files, values);
    console.log(JSON.stringify(result, null, 2));
    if (result.evaluation === 'baseline_error' || result.extraction.some(file => file.path === 'diagnostic')) process.exitCode = 1;
  } else if (command === 'prototype' && positionals.length === 2) {
    console.log(JSON.stringify(runPrototype(...positionals, values), null, 2));
  } else {
    throw new Error('Usage: tmt-ts extract FILE [--mode script|module] [--dialect ts|tsx]\n' +
      '       tmt-ts analyze [PROJECT] [FILE...] [--lines FILE:FROM-TO] [--since REV] [--spec FILE] [--deterministic] [--audit]\n' +
      '       tmt-ts prototype PROJECT FILE [--spec FILE]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
