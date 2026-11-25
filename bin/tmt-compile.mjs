#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compile } from '../src/compiler.mjs';

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      target: { type: 'string' },
      module: { type: 'string' },
      jsx: { type: 'string' },
      'source-map': { type: 'boolean' },
      strip: { type: 'boolean' },
      'experimental-decorators': { type: 'boolean' },
      'emit-decorator-metadata': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('Usage: tmt-compile [--target esnext|es2018|...] [--module preserve|esm|cjs] [--jsx automatic|classic|preserve] [--source-map] [--strip] [--experimental-decorators [--emit-decorator-metadata]] [--file NAME] <file|->');
  } else {
    if (positionals.length !== 1) throw new Error('Expected one source filename or - for stdin');
    const [input] = positionals;
    const file = values.file ?? (input === '-' ? 'stdin.ts' : input);
    const result = compile(readFileSync(input === '-' ? 0 : input), {
      file, target: values.target, module: values.module, jsx: values.jsx,
      mode: values.strip ? 'strip' : 'transform', sourceMap: values['source-map'],
      experimentalDecorators: values['experimental-decorators'], emitDecoratorMetadata: values['emit-decorator-metadata'],
    });
    if (result.code === null) {
      for (const diagnostic of result.diagnostics) {
        console.error(`${diagnostic.file} [${diagnostic.start}..${diagnostic.end}] ${diagnostic.message}`);
      }
      process.exitCode = 1;
    } else {
      process.stdout.write(result.code);
      if (result.sourceMap) {
        const map = Buffer.from(JSON.stringify(result.sourceMap)).toString('base64');
        process.stdout.write(`\n//# sourceMappingURL=data:application/json;base64,${map}\n`);
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
