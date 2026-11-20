#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { extract } from '../src/extract.mjs';
import { parseArgs } from 'node:util';
import { runPrototype } from '../src/prototype.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, options: { spec: { type: 'string' }, mode: { type: 'string' }, dialect: { type: 'string' } },
  });
  if (command === 'extract' && positionals.length === 1) {
    const [file] = positionals;
    const result = extract(readFileSync(file), { file, mode: values.mode, dialect: values.dialect });
    console.log(JSON.stringify(result, null, 2));
    if (result.path === 'diagnostic') process.exitCode = 1;
  } else if (command === 'prototype' && positionals.length === 2) {
    console.log(JSON.stringify(runPrototype(...positionals, values), null, 2));
  } else {
    throw new Error('Usage: tmt-ts extract FILE [--mode script|module] [--dialect ts|tsx]\n' +
      '       tmt-ts prototype PROJECT FILE [--spec FILE]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
