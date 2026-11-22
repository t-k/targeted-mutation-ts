#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chooseFormat, renderText, usage } from '../src/cli-output.mjs';
import { enablePreparedTypeScript } from '../src/typescript-compiler.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, options: {
      spec: { type: 'string' },
      mode: { type: 'string' },
      dialect: { type: 'string' },
      lines: { type: 'string', multiple: true },
      since: { type: 'string' },
      deterministic: { type: 'boolean' },
      audit: { type: 'boolean' },
      'displace-thresholds': { type: 'boolean' },
      witnesses: { type: 'boolean' },
      mutators: { type: 'string' },
      runner: { type: 'string' },
      project: { type: 'string', multiple: true },
      config: { type: 'string' },
      test: { type: 'string', multiple: true },
      'copy-exclude': { type: 'string', multiple: true },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (['--version', '-v'].includes(command) || values.version) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else if (!command || ['help', '--help', '-h'].includes(command) || values.help) {
    console.log(usage);
  } else if (command === 'extract' && positionals.length === 1) {
    enablePreparedTypeScript();
    const { extract } = await import('../src/extract.mjs');
    const [file] = positionals;
    const result = extract(readFileSync(file), { file, mode: values.mode, dialect: values.dialect });
    console.log(JSON.stringify(result, null, 2));
    if (result.path === 'diagnostic') process.exitCode = 1;
  } else if (command === 'analyze') {
    const [project = '.', ...files] = positionals;
    if (values.runner && !['vitest', 'playwright'].includes(values.runner)) throw new Error('Expected --runner vitest|playwright');
    if (values.runner === 'playwright' && values.test?.length) throw new Error('--test selects Vitest files');
    if (values.runner === 'playwright' && values['displace-thresholds']) throw new Error('--displace-thresholds requires Vitest');
    if (values.mutators && !['focused', 'operators', 'standard', 'all'].includes(values.mutators)) throw new Error('Expected --mutators focused|operators|standard|all');
    const format = chooseFormat(values.format, process.stdout.isTTY === true);
    enablePreparedTypeScript();
    let result;
    if (values.witnesses) {
      if (values.runner === 'playwright' || ['operators', 'standard', 'all'].includes(values.mutators) ||
          values.deterministic || values.project || values.audit || values['displace-thresholds']) throw new Error('--witnesses runs its own Vitest source trials');
      const { analyzeWitnesses } = await import('../src/witness-analysis.mjs');
      result = analyzeWitnesses(project, files, values);
    } else if (['standard', 'all'].includes(values.mutators)) {
      if (values.runner === 'playwright' || values.audit || values.spec || values['displace-thresholds'] ||
          values.mutators === 'standard' && values.deterministic) {
        throw new Error(`--mutators ${values.mutators} requires Vitest and excludes focused diagnostic options`);
      }
      const { analyzeConventional } = await import('../src/conventional.mjs');
      result = await analyzeConventional(project, files, values);
    } else if (values.mutators === 'operators') {
      const { analyzeOperators } = await import('../src/operator-analysis.mjs');
      result = await analyzeOperators(project, files, values);
    } else {
      const { analyze } = await import('../src/analysis.mjs');
      result = analyze(project, files, values);
    }
    if (format === 'json') console.log(JSON.stringify(result, null, 2));
    else console.log(renderText(result));
    if (['baseline_error', 'incomplete'].includes(result.evaluation) || result.extraction.some(file => file.path === 'diagnostic')) process.exitCode = 1;
  } else if (command === 'prototype' && positionals.length === 2) {
    enablePreparedTypeScript();
    const { runPrototype } = await import('../src/prototype.mjs');
    console.log(JSON.stringify(runPrototype(...positionals, values), null, 2));
  } else if (['extract', 'analyze', 'prototype'].includes(command)) {
    throw new Error(`Unexpected arguments for ${command}.\n\n${usage}`);
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
