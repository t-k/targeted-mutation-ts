import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const scenarios = readFileSync(new URL('../verification/pict/cold-command.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

for (const [command, addon, input] of scenarios) {
  test(`cold command ${command} ${addon} ${input}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tmt-cold-command-'));
    try {
      cpSync(resolve('bin'), join(root, 'bin'), { recursive: true });
      cpSync(resolve('src'), join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'build'));
      const native = join(root, 'build/tmt.node');
      if (addon === 'Present') cpSync(resolve('build/tmt.node'), native);
      else writeFileSync(native, 'Broken addon');
      symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction');
      writeFileSync(join(root, 'subject.ts'), command === 'Extract' ? 'const keep = a < b;' : 'export const keep = 1;');

      const hook = join(root, 'hook.mjs');
      const blocked = ['analysis', 'prototype', 'extract'].filter(module => {
        if (input === 'Invalid' || command === 'Help') return true;
        if (command === 'Analyze') return false;
        return module !== command.toLowerCase();
      });
      const allowsFallback = addon === 'Broken' && input === 'Valid' && (command === 'Extract' || command === 'Analyze');
      if (!allowsFallback) blocked.push('typescript-extraction', 'typescript-grammar', 'typescript-bindings');
      writeFileSync(hook, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (${JSON.stringify(blocked)}.some(name => specifier.endsWith('/' + name + '.mjs'))) {
    throw new Error('Unexpected module during command dispatch: ' + specifier);
  }
  return next(specifier, context);
} });
`);
      const args = {
        Help: ['--help'], Extract: ['extract', 'subject.ts'], Analyze: ['analyze', '.', 'subject.ts'],
        Prototype: ['prototype', '.', 'subject.ts'],
      }[command];
      if (input === 'Invalid') args.push(command === 'Analyze' ? '--runner=invalid' : '--unrecognized');
      const run = spawnSync(process.execPath, ['--import', hook, 'bin/tmt.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 15_000 });
      const fail = input === 'Invalid';
      assert.equal(run.status, fail ? 1 : 0, run.error?.message ?? run.stderr);
      assert.doesNotMatch(run.stderr, /Unexpected module during command dispatch|^Error:/m);
      if (input === 'Invalid') assert.match(run.stderr, /Unknown option|Expected --runner/);
      else if (command === 'Help') assert.match(run.stdout, /^Usage:/);
      else if (!fail) {
        const result = JSON.parse(run.stdout);
        if (command === 'Extract') {
          assert.equal(result.candidates[0].operator, '<');
          if (addon === 'Broken') assert.equal(result.reason, 'native-unavailable');
        } else if (command === 'Analyze') assert.equal(result.evaluation, 'no_sites');
        else assert.deepEqual(result, { diagnostics: [] });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
