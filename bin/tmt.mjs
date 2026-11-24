#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
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
      'undo-changes': { type: 'boolean' },
      'suggest-assertions': { type: 'boolean' },
      witnesses: { type: 'boolean' },
      mutators: { type: 'string' },
      concurrency: { type: 'string' },
      'isolated-trials': { type: 'boolean' },
      'verify-trials': { type: 'string' },
      timeout: { type: 'string' },
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
    if (values.runner !== undefined && !['vitest', 'playwright'].includes(values.runner)) throw new Error('Expected --runner vitest|playwright');
    if (values.runner === 'playwright' && values['displace-thresholds']) throw new Error('--displace-thresholds requires Vitest');
    if (values.mutators !== undefined && !['targeted', 'full'].includes(values.mutators)) throw new Error('Expected --mutators targeted|full');
    const session = values.runner !== 'playwright' && !values.witnesses && !values.audit;
    if ((values['isolated-trials'] || values['verify-trials'] !== undefined) && !session) {
      throw new Error('--isolated-trials and --verify-trials apply to Vitest sessions, which --witnesses, --audit and Playwright do not use');
    }
    if (values.concurrency !== undefined && !session && !values.witnesses) {
      throw new Error('--concurrency applies to Vitest sessions and to --witnesses, not to --audit or Playwright');
    }
    if (values['undo-changes'] && (values.since === undefined || values.witnesses)) {
      throw new Error('--undo-changes requires --since REV and does not apply to --witnesses');
    }
    if (values['suggest-assertions'] && (values.runner === 'playwright' || values.witnesses)) {
      throw new Error('--suggest-assertions applies to the targeted and full profiles on Vitest');
    }
    if (values.timeout !== undefined) {
      if (!/^[1-9]\d{0,4}$/.test(values.timeout)) throw new Error('Expected --timeout to be a number of seconds');
      values.timeout = Number(values.timeout);
    }
    if (values['verify-trials'] !== undefined) {
      if (!/^\d{1,6}$/.test(values['verify-trials'])) throw new Error('Expected --verify-trials to be a count');
      values['verify-trials'] = Number(values['verify-trials']);
    }
    if (values.concurrency !== undefined) {
      if (!/^[1-9]\d{0,3}$/.test(values.concurrency)) throw new Error('Expected --concurrency to be a positive integer');
      values.concurrency = Number(values.concurrency);
    }
    const format = chooseFormat(values.format, process.stdout.isTTY === true);
    enablePreparedTypeScript();
    let result;
    if (values.witnesses) {
      if (values.runner === 'playwright' || values.mutators !== undefined ||
          values.deterministic || values.project || values.audit || values['displace-thresholds']) throw new Error('--witnesses runs its own Vitest source trials');
      const { analyzeWitnesses } = await import('../src/witness-analysis.mjs');
      result = await analyzeWitnesses(project, files, values);
    } else {
      const { analyzeOperators } = await import('../src/operator-analysis.mjs');
      result = await analyzeOperators(project, files, { ...values, mutators: values.mutators ?? 'targeted' });
    }
    if (!values.witnesses) {
      const { strengthenAssertions, withoutSourceEdits } = await import('../src/assertion-strength.mjs');
      if (values['suggest-assertions'] && result.evaluation === 'evaluated') result = await strengthenAssertions(realpathSync(project), result, values);
      withoutSourceEdits(result);
    }
    if (values['undo-changes']) {
      const { analyzeUndoneChangesAsync, withUndoneChanges } = await import('../src/change-undone.mjs');
      const { baselineRunSymbol } = await import('../src/analysis.mjs');
      if (result.evaluation !== 'baseline_error') {
        result = withUndoneChanges(result, await analyzeUndoneChangesAsync(project, files, { ...values, existingBaseline: result[baselineRunSymbol] }));
      }
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
