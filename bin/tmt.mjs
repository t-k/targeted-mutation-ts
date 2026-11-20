#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runPrototype } from '../src/prototype.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, options: { spec: { type: 'string' } },
  });
  if (command !== 'prototype' || positionals.length !== 2) {
    throw new Error('Usage: tmt-ts prototype PROJECT FILE [--spec FILE]');
  }
  console.log(JSON.stringify(runPrototype(...positionals, values), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
