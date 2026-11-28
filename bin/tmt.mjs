#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chooseFormat, formatProgressSummary, renderText, usage } from '../src/cli-output.mjs';
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
      'baseline-timeout': { type: 'string' },
      'baseline-workers': { type: 'string' },
      runner: { type: 'string' },
      project: { type: 'string', multiple: true },
      config: { type: 'string' },
      test: { type: 'string', multiple: true },
      related: { type: 'boolean' },
      exclude: { type: 'string', multiple: true },
      'copy-exclude': { type: 'string', multiple: true },
      'copy-include': { type: 'string', multiple: true },
      'copy-exclude-gitignore': { type: 'boolean' },
      'no-copy-exclude-gitignore': { type: 'boolean' },
      'exclude-rule': { type: 'string', multiple: true },
      'type-check': { type: 'boolean' },
      'no-type-check': { type: 'boolean' },
      tsconfig: { type: 'string' },
      'no-config': { type: 'boolean' },
      progress: { type: 'boolean' },
      format: { type: 'string' },
      verbose: { type: 'boolean' },
      'only-gaps': { type: 'boolean' },
      'fail-on-gaps': { type: 'boolean' },
      'json-out': { type: 'string' },
      'sarif-out': { type: 'string' },
      baseline: { type: 'string' },
      'write-baseline': { type: 'string' },
      list: { type: 'boolean' },
      shard: { type: 'string' },
      sharding: { type: 'string' },
      checkpoint: { type: 'string' },
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
    const {
      detectGitignoreBaselineHints,
      gitignoredCopyExclusions,
      loadProjectConfig,
      mergeProjectConfig,
      resolveAnalyzePositionals,
      validateAndExpandInputs,
    } = await import('../src/project-config.mjs');
    const { project, files: rawFiles } = resolveAnalyzePositionals(positionals);
    if (values['type-check'] && values['no-type-check']) throw new Error('--type-check cannot be combined with --no-type-check');
    if (values['copy-exclude-gitignore'] && values['no-copy-exclude-gitignore']) {
      throw new Error('--copy-exclude-gitignore cannot be combined with --no-copy-exclude-gitignore');
    }
    const loadedConfig = values['no-config'] ? null : await loadProjectConfig(project, { allowCodeConfig: !values.list });
    const merged = mergeProjectConfig(loadedConfig?.config, values, rawFiles, {
      sourceName: loadedConfig?.source,
      onWarning: msg => process.stderr.write(`Warning: ${msg}\n`),
    });
    const runValues = merged.values;
    if (runValues['no-copy-exclude-gitignore']) runValues['copy-exclude-gitignore'] = false;
    if (runValues['no-type-check']) {
      runValues['type-check'] = false;
    } else if (runValues['type-check'] === true || runValues.tsconfig !== undefined) {
      runValues['type-check'] = true;
    } else if (runValues['type-check'] === false) {
      runValues['type-check'] = false;
    } else {
      runValues['type-check'] = 'auto';
    }
    if (runValues.runner !== undefined && !['vitest', 'playwright', 'node'].includes(runValues.runner)) throw new Error('Expected --runner vitest|playwright|node');
    if (runValues.runner === 'node' && runValues.config !== undefined) throw new Error('--config does not apply to --runner node');
    if (runValues.runner === 'node' && runValues.audit) throw new Error('--audit does not apply to --runner node');
    if (runValues.runner === 'node' && runValues['displace-thresholds']) throw new Error('--displace-thresholds does not apply to --runner node');
    if (runValues.related && (runValues.runner === 'playwright' || runValues.runner === 'node')) throw new Error('--related requires Vitest');
    if (runValues.verbose && runValues['only-gaps']) throw new Error('--verbose cannot be combined with --only-gaps');
    if (runValues.mutators !== undefined && !['targeted', 'full'].includes(runValues.mutators)) throw new Error('Expected --mutators targeted|full');
    const session = runValues.runner !== 'node' && !runValues.witnesses && !runValues.audit;
    const vitestSession = session && runValues.runner !== 'playwright';
    if ((runValues['isolated-trials'] || runValues['verify-trials'] !== undefined) && !session) {
      throw new Error('--isolated-trials and --verify-trials apply to Vitest and Playwright sessions, which --witnesses, --audit, and Node do not use');
    }
    if (runValues.concurrency !== undefined && !vitestSession && !runValues.witnesses && runValues.runner !== 'node') {
      throw new Error('--concurrency applies to Vitest sessions, --runner node, and --witnesses, not to --audit or Playwright');
    }
    if (runValues['undo-changes'] && (runValues.since === undefined || runValues.witnesses)) {
      throw new Error('--undo-changes requires --since REV and does not apply to --witnesses');
    }
    if (runValues['suggest-assertions'] && (runValues.runner === 'playwright' || runValues.runner === 'node' || runValues.witnesses)) {
      throw new Error('--suggest-assertions applies to the targeted and full profiles on Vitest');
    }
    if (runValues.timeout !== undefined) {
      if (!/^[1-9]\d{0,4}$/.test(runValues.timeout)) throw new Error('Expected --timeout to be a number of seconds');
      runValues.timeout = Number(runValues.timeout);
    }
    if (runValues['baseline-timeout'] !== undefined) {
      if (!/^[1-9]\d{0,4}$/.test(runValues['baseline-timeout'])) throw new Error('Expected --baseline-timeout to be a number of seconds');
      runValues['baseline-timeout'] = Number(runValues['baseline-timeout']);
    }
    if (runValues['baseline-workers'] !== undefined) {
      if (!/^[1-9]\d{0,3}$/.test(runValues['baseline-workers'])) throw new Error('Expected --baseline-workers to be a positive integer');
      runValues['baseline-workers'] = Number(runValues['baseline-workers']);
    }
    if (runValues['verify-trials'] !== undefined) {
      if (!/^\d{1,6}$/.test(runValues['verify-trials'])) throw new Error('Expected --verify-trials to be a count');
      runValues['verify-trials'] = Number(runValues['verify-trials']);
    }
    if (runValues.concurrency !== undefined) {
      if (!/^[1-9]\d{0,3}$/.test(runValues.concurrency)) throw new Error('Expected --concurrency to be a positive integer');
      runValues.concurrency = Number(runValues.concurrency);
    }
    if (runValues['exclude-rule']?.length) {
      runValues['exclude-rule'] = runValues['exclude-rule'].flatMap(entry => entry.split(',')).map(s => s.trim()).filter(Boolean);
    }
    const format = chooseFormat(runValues.format, process.stdout.isTTY === true);
    const canonicalOutputKeys = filePath => {
      const abs = resolve(filePath);
      const keys = [];
      // Walk up to the nearest existing ancestor so symlinks above uncreated subdirectories resolve identically.
      const tail = [];
      let cursor = abs;
      while (!existsSync(cursor)) {
        const parent = dirname(cursor);
        if (parent === cursor) break;
        tail.unshift(basename(cursor));
        cursor = parent;
      }
      const resolvedPath = existsSync(cursor) ? resolve(realpathSync(cursor), ...tail) : abs;
      const normPath = process.platform === 'win32' || process.platform === 'darwin' ? resolvedPath.toLowerCase() : resolvedPath;
      keys.push(`path:${normPath}`);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (st?.isFile()) keys.push(`ino:${st.dev}:${st.ino}`);
      return keys;
    };
    const seenOutputs = new Map();
    for (const flag of ['json-out', 'sarif-out', 'write-baseline', 'checkpoint']) {
      if (runValues[flag] === undefined) continue;
      if (!runValues[flag].trim() || runValues[flag].includes('\0')) {
        throw new Error(`Expected --${flag} to be a valid file path`);
      }
      for (const key of canonicalOutputKeys(runValues[flag])) {
        if (seenOutputs.has(key)) {
          throw new Error(`Output paths must be distinct: --${seenOutputs.get(key)} and --${flag} resolve to the same file`);
        }
        seenOutputs.set(key, flag);
      }
    }
    const { parseShard, parseShardingStrategy, listCandidates } = await import('../src/shard.mjs');
    const shard = parseShard(runValues.shard);
    const sharding = parseShardingStrategy(runValues.sharding);
    const { loadBaselineWithReasons, writeBaseline, applyBaseline } = await import('../src/baseline.mjs');
    const baselineData = runValues.baseline ? loadBaselineWithReasons(runValues.baseline) : null;
    // Validate project paths and expand any globs before copying the project to a temporary directory.
    const validated = validateAndExpandInputs(project, merged.files, runValues);
    const files = validated.files;
    if (validated.exclude?.length) runValues.exclude = validated.exclude;
    if (validated.tests) runValues.test = validated.tests;
    let gitignoredExclusions = [];
    if (runValues['copy-exclude-gitignore']) {
      gitignoredExclusions = gitignoredCopyExclusions(validated.root);
      if (gitignoredExclusions.length) {
        runValues['copy-exclude'] = [...new Set([...(runValues['copy-exclude'] ?? []), ...gitignoredExclusions])];
      }
    }
    if (runValues['copy-exclude']?.length || runValues['copy-include']?.length) {
      const { resolveCopyExclusions, resolveCopyInclusions } = await import('../src/vitest.mjs');
      if (runValues['copy-include']?.length) {
        const activeInclusions = resolveCopyInclusions(validated.root, runValues['copy-include'], {
          onMissing: path => {
            const safePath = /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;
            process.stderr.write(`Warning: Copy inclusion does not exist, skipping: ${safePath}\n`);
          },
        });
        runValues['copy-include'] = activeInclusions.map(entry => relative(validated.root, entry));
      }
      if (runValues['copy-exclude']?.length) {
        const activeExclusions = resolveCopyExclusions(validated.root, runValues['copy-exclude'], {
          onMissing: path => {
            const safePath = /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;
            process.stderr.write(`Warning: Copy exclusion does not exist, skipping: ${safePath}\n`);
          },
        });
        runValues['copy-exclude'] = activeExclusions.map(entry => relative(validated.root, entry));
      }
      if (gitignoredExclusions.length && runValues['copy-include']?.length) {
        const activeInclusions = resolveCopyInclusions(validated.root, runValues['copy-include']);
        const normKey = value => (process.platform === 'win32' ? value.toLowerCase() : value);
        gitignoredExclusions = gitignoredExclusions.filter(entry => {
          const entryAbs = normKey(resolve(validated.root, entry));
          // Only drop a gitignored entry from hint candidates when it is itself fully re-included,
          // not when only a nested child inside it was re-included.
          return !activeInclusions.some(inc => {
            const incAbs = normKey(inc);
            return entryAbs === incAbs || entryAbs.startsWith(incAbs + (process.platform === 'win32' ? '\\' : '/'));
          });
        });
      }
    }
    const logProgress = runValues.progress ? message => process.stderr.write(`[tmt] ${message}\n`) : () => {};
    const seenTypeCheckWarnings = new Set();
    const onTypeCheckWarning = message => {
      const safe = String(message).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');
      if (seenTypeCheckWarnings.has(safe)) return;
      seenTypeCheckWarnings.add(safe);
      process.stderr.write(`Warning: ${safe}\n`);
    };
    runValues.onTypeCheckWarning = onTypeCheckWarning;
    if (runValues.progress) runValues.onProgress = logProgress;
    let relatedCopy = null;
    let result;
    try {
      if (runValues.related && !runValues.list) {
        const { selectScope } = await import('../src/scope.mjs');
        const relatedTargets = selectScope(validated.root, files, runValues).map(subject => subject.file);
        if (relatedTargets.length) {
          const { createCopy, inside, resolveRelatedVitestSpecs, runnerPackage } = await import('../src/vitest.mjs');
          const relatedTimeoutSeconds = runValues['baseline-timeout'] ?? runValues.timeout;
          runnerPackage(validated.root, 'vitest');
          relatedCopy = createCopy(validated.root, {
            exclude: runValues['copy-exclude'],
            include: runValues['copy-include'],
            onProgress: runValues.onProgress,
          });
          const resolved = await resolveRelatedVitestSpecs(validated.root, relatedTargets, {
            config: runValues.config,
            copyExclude: runValues['copy-exclude'],
            copyInclude: runValues['copy-include'],
            onProgress: runValues.onProgress,
            copy: relatedCopy,
            ...(relatedTimeoutSeconds ? { timeout: relatedTimeoutSeconds * 1000 } : {}),
          });
          let selectedTests = resolved.tests;
          let selectedSpecs = resolved.specs;
          if (runValues.test?.length) {
            const allowedTests = new Set(runValues.test.map(file => relative(validated.root, inside(validated.root, file))));
            selectedTests = resolved.tests.filter(file => allowedTests.has(file));
            selectedSpecs = resolved.specs.filter(spec => allowedTests.has(spec.file));
            if (!selectedTests.length) {
              throw new Error(`No Vitest test files matched both --related (${resolved.tests.length} related) and --test. Widen --test <file|glob> or omit --related.`);
            }
          }
          runValues.test = selectedTests;
          runValues.testSpecs = selectedSpecs;
          const allNamedProjects = selectedSpecs.length > 0 && selectedSpecs.every(spec => Boolean(spec.project));
          if (allNamedProjects) {
            runValues.testProjects = [...new Set(selectedSpecs.map(spec => spec.project))];
          }
          logProgress(`Selected ${selectedTests.length} related test ${selectedTests.length === 1 ? 'file' : 'files'}.`);
          if (selectedTests.length > 20) {
            const tuningHint = runValues.witnesses
              ? 'or tuning --timeout <seconds>'
              : runValues.audit
                ? 'or tuning --baseline-timeout <seconds>'
                : 'or tuning --baseline-timeout <seconds> and --baseline-workers <N>';
            process.stderr.write(`Warning: --related selected ${selectedTests.length} test files. Consider narrowing with --test <glob>, ${tuningHint}.\n`);
          }
        }
      }
      enablePreparedTypeScript();
      if (runValues.list) {
        result = listCandidates(project, files, { ...runValues, mutators: runValues.mutators ?? 'targeted', shard: runValues.shard, sharding });
      } else if (runValues.witnesses) {
        if (runValues.runner === 'playwright' || runValues.runner === 'node' || runValues.mutators !== undefined ||
            runValues.deterministic || runValues.project || runValues.audit || runValues['displace-thresholds']) throw new Error('--witnesses runs its own Vitest source trials');
        logProgress('Running witness analysis...');
        const { analyzeWitnesses } = await import('../src/witness-analysis.mjs');
        result = await analyzeWitnesses(project, files, runValues);
      } else {
        logProgress(`Analyzing ${files.length ? `${files.length} file(s)` : 'project'} (${runValues.mutators ?? 'targeted'})...`);
        const { analyzeOperators } = await import('../src/operator-analysis.mjs');
        result = await analyzeOperators(project, files, {
          ...runValues,
          ...(relatedCopy ? { reusableCopy: relatedCopy } : {}),
          mutators: runValues.mutators ?? 'targeted',
          shard,
          sharding,
        });
      }
    } finally {
      relatedCopy?.dispose();
    }
    if (!runValues.witnesses && !runValues.list) {
      const { strengthenAssertions, withoutSourceEdits } = await import('../src/assertion-strength.mjs');
      if (runValues['suggest-assertions'] && result.evaluation === 'evaluated') result = await strengthenAssertions(realpathSync(project), result, runValues);
      withoutSourceEdits(result);
    }
    if (runValues['undo-changes'] && !runValues.list) {
      const { analyzeUndoneChangesAsync, withUndoneChanges } = await import('../src/change-undone.mjs');
      const { baselineRunSymbol } = await import('../src/analysis.mjs');
      if (result.evaluation !== 'baseline_error') {
        result = withUndoneChanges(result, await analyzeUndoneChangesAsync(project, files, { ...runValues, existingBaseline: result[baselineRunSymbol] }));
      }
    }
    if (runValues.since && !runValues.list && !runValues.witnesses && result.evaluation === 'evaluated') {
      const { detectWeakenedTests } = await import('../src/weakened-tests.mjs');
      result = await detectWeakenedTests(project, result, runValues);
    }
    if (result.evaluation === 'baseline_error' && gitignoredExclusions.length) {
      const hints = detectGitignoreBaselineHints(result.baseline, gitignoredExclusions, runValues['copy-include'] ?? []);
      if (hints.length) {
        result = { ...result, baseline: { ...result.baseline, hints } };
      }
    }
    if (!runValues.list && runValues['write-baseline'] && result.evaluation !== 'baseline_error') {
      writeBaseline(runValues['write-baseline'], result.diagnostics ?? []);
    }
    if (!runValues.list && baselineData) {
      result = applyBaseline(result, baselineData);
    }
    logProgress(formatProgressSummary(result));
    const jsonPayload = (format === 'json' || runValues['json-out']) ? JSON.stringify(result, null, 2) : null;
    let sarifPayload = null;
    if (format === 'sarif' || runValues['sarif-out']) {
      const { renderSarif } = await import('../src/sarif.mjs');
      const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
      sarifPayload = JSON.stringify(renderSarif(result, { version }), null, 2);
    }
    if (runValues['json-out']) {
      mkdirSync(dirname(runValues['json-out']), { recursive: true });
      writeFileSync(runValues['json-out'], jsonPayload + '\n', 'utf8');
    }
    if (runValues['sarif-out']) {
      mkdirSync(dirname(runValues['sarif-out']), { recursive: true });
      writeFileSync(runValues['sarif-out'], sarifPayload + '\n', 'utf8');
    }
    if (format === 'json') {
      console.log(jsonPayload);
    } else if (format === 'jsonl') {
      const { renderJsonl } = await import('../src/sarif.mjs');
      console.log(renderJsonl(result));
    } else if (format === 'sarif') {
      console.log(sarifPayload);
    } else {
      console.log(renderText(result, { verbose: runValues.verbose === true, onlyGaps: runValues['only-gaps'] === true }));
    }
    if (['baseline_error', 'incomplete'].includes(result.evaluation) || result.extraction.some(file => file.path === 'diagnostic')) {
      process.exitCode = 1;
    } else if (runValues['fail-on-gaps'] && (result.diagnostics?.length ?? 0) > 0) {
      process.exitCode = 2;
    }
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
