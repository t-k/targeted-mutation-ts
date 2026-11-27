export const usage = `Usage: targeted-mutation <command> [options]   (alias: tmts)

Commands:
  analyze [PROJECT] [FILE...]   Run the project's tests against targeted source edits and report test gaps.
  extract FILE                  Print the comparison candidates found in one source file as JSON.
  prototype PROJECT FILE        Run the original threshold experiment on one file.

Scope (analyze):
  --lines FILE:FROM-TO          Limit to a line range. FILE:N selects one line. Repeatable.
  --since REV                   Limit to lines added or changed since a Git revision.
  --suggest-assertions          For a survivor whose tests had the input: run the calls those tests make
                                without pinning the result, and give the value to compare with (Vitest).
  --undo-changes                With --since: also put each change back as it was at REV and run the suite.
                                A change the tests pass without is reported as UNTESTED CHANGE.
  --copy-exclude PATH           Leave a project path out of the temporary copies (warns and skips if missing). Repeatable.
                                Also configurable via "copyExclude" in targeted-mutation.config.json.
  --copy-exclude-gitignore      Also exclude gitignored paths (except node_modules) from temporary copies.
                                Also configurable via "copyExcludeGitignore": true in targeted-mutation.config.json.
  --no-copy-exclude-gitignore   Disable gitignore copy exclusion even when enabled in project configuration.
  --exclude-rule RULE           Exclude a mutation rule (e.g. nullish-equality/v1). Repeatable.
  --type-check                  Force TypeScript type checking (warns if tsconfig.json or strictNullChecks is missing).
                                Enabled automatically when strictNullChecks is active; use --no-type-check to disable.
  --no-type-check               Disable automatic TypeScript type-based nullish suppression (or "typeCheck": false).
  --tsconfig FILE               Explicit tsconfig.json path for --type-check (defaults to nearest per file / references).
  --no-config                   Ignore targeted-mutation.config.{json,mjs} and package.json#targetedMutation.
  --progress                    Print progress updates (copying, baseline, mutant completion) to stderr.

Profiles (analyze):
  --mutators targeted|full      targeted (default) edits comparison boundaries and integer thresholds
                                across <, <=, >, >=, plus value-aware targeted rules: an equality that
                                is always true or false, an operand of && || ?? that never decides,
                                ?? for ||, == null for === null, another arithmetic operator, rounding or
                                end of a list, a sort without its comparison, a dropped await or copy.
                                Each survivor names the missing input or what to assert.
                                full adds the complete built-in mutation set (the StrykerJS mutators)
                                without requiring any external instrumenter package.
  --witnesses                   Search for edits that survive and confirm a distinguishing test.
  --spec FILE                   Specification with expected thresholds or witness plans.
  --list                        Preview scoped mutation candidates without running tests.
  --shard K/N                   Run zero-based shard K of N total shards.
  --sharding slice|round-robin  Candidate distribution across shards (default: slice).
  --checkpoint [FILE]           Record and resume completed mutant outcomes via a JSONL checkpoint file.
  --deterministic               Declare a deterministic suite so recorded comparisons can decide a trial.
  --audit                       Re-run predicted trials against the rewritten source.
  --displace-thresholds         Also try displaced thresholds (Vitest only).
  --concurrency N               Vitest workers that share the mutations (default: CPU count minus one).
                                With --runner node: concurrent mutant processes (default: up to 4).
                                With --witnesses: suite runs side by side (default: up to 8).
  --verify-trials N             Run N of the mutations decided inside workers again in fresh Vitest runs and
                                report any verdict that differs.
  --isolated-trials             Start a fresh Vitest run for every mutation instead of switching mutations
                                inside a running worker. Slower; for suites that leave state behind.

Runner (analyze):
  --runner vitest|playwright|node
                                Test runner (default: vitest).
  --config FILE                 Runner configuration file inside the project.
  --test FILE                   Run only this test file or glob. Repeatable. With --related, narrows related tests.
  --related                     Select only Vitest test files related to the target source files.
  --timeout SECONDS             Time limit for one run of the suite (default: 60).
  --baseline-timeout SECONDS    Time limit for the baseline suite run (defaults to --timeout).
  --baseline-workers N          Vitest workers for the baseline run (default: 1 for focused trace; --concurrency for session).
  --project NAME                Playwright project. Repeatable.

Output & Baselines:
  --format text|json|jsonl|sarif
                                Output format (analyze defaults to text on a terminal and json otherwise).
  --verbose                     Include killed edits in text output (hidden by default).
  --only-gaps                   Show only test gaps and summary in text output.
  --fail-on-gaps                Exit with code 2 when one or more test gaps are reported.
  --json-out FILE               Also write the JSON report to FILE (can be combined with --format text).
  --sarif-out FILE              Also write the SARIF report to FILE (can be combined with --format text).
  --baseline FILE               Suppress findings already recorded in FILE.
  --write-baseline FILE         Write this run's findings to FILE for future --baseline runs.
  --mode script|module          extract: parse goal.
  --dialect ts|tsx              extract: source dialect.
  -h, --help                    Show this help.
  -v, --version                 Show the version.`;

export function chooseFormat(requested, terminal) {
  if (requested === undefined) return terminal ? 'text' : 'json';
  if (!['text', 'json', 'jsonl', 'sarif'].includes(requested)) {
    throw new Error('Expected --format text|json|jsonl|sarif');
  }
  return requested;
}

// Test names and runner output come from the analyzed project and can carry terminal control sequences.
const printable = value => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');
const firstLine = value => printable(value).split('\n').find(line => line.trim())?.trim() ?? '';
const compactSnippet = (value, maxLength = 48) => {
  const flat = printable(value).replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? flat.slice(0, maxLength - 3) + '...' : flat;
};
const STUB_REPLACEMENTS = new Set(['() => undefined', '{}', '[]', '""', "''", '``', 'true', 'false']);

function countLeadingChar(text, ch) {
  let i = 0;
  while (i < text.length && text[i] === ch) i++;
  return i;
}

function countTrailingChar(text, ch) {
  let i = 0;
  while (i < text.length && text[text.length - 1 - i] === ch) i++;
  return i;
}

function commonPrefixLength(a, aOffset, b, bOffset) {
  const limit = Math.min(a.length - aOffset, b.length - bOffset);
  let i = 0;
  while (i < limit && a[aOffset + i] === b[bOffset + i]) i++;
  return i;
}

function commonSuffixLength(a, aMin, aEnd, b, bMin, bEnd) {
  const limit = Math.min(aEnd - aMin, bEnd - bMin);
  let i = 0;
  while (i < limit && a[aEnd - 1 - i] === b[bEnd - 1 - i]) i++;
  return i;
}

function middleClip(text, maxLength = 68) {
  if (text.length <= maxLength) return text;
  const keepEnd = Math.max(12, Math.floor((maxLength - 3) * 0.45));
  const keepStart = Math.max(12, maxLength - 3 - keepEnd);
  return text.slice(0, keepStart).trimEnd() + '...' + text.slice(text.length - keepEnd).trimStart();
}

function formatEditPair(original, replacement, maxLength = 68) {
  const origStr = String(original ?? '');
  const replStr = String(replacement ?? '');
  const origFirst = firstLine(origStr);
  const replFirst = firstLine(replStr);
  const rawOrig = printable(origStr).replace(/\s+/g, ' ').trim();
  const rawRepl = printable(replStr).replace(/\s+/g, ' ').trim();

  if (origFirst === replFirst && rawOrig !== rawRepl && /:\s*$/.test(rawRepl) && rawOrig.length > rawRepl.length) {
    const origFlat = compactSnippet(origStr);
    const shownRepl = `${compactSnippet(replStr, 40)} (empty)`;
    if (origFlat !== shownRepl) return [origFlat, shownRepl];
  }

  const multiline = origStr.includes('\n') || replStr.includes('\n');
  if (multiline && origFirst !== replFirst && STUB_REPLACEMENTS.has(rawRepl)) {
    return [origFirst, replFirst];
  }

  if (rawOrig === rawRepl) return [origFirst, replFirst];
  if (rawOrig.length <= maxLength && rawRepl.length <= maxLength) {
    return [rawOrig, rawRepl];
  }

  let aStart = 0;
  let bStart = 0;
  let prefixLen = commonPrefixLength(rawOrig, 0, rawRepl, 0);
  const openOrig = countLeadingChar(rawOrig, '(');
  const openRepl = countLeadingChar(rawRepl, '(');
  if (openRepl > openOrig) {
    const extra = openRepl - openOrig;
    const shifted = commonPrefixLength(rawOrig, 0, rawRepl, extra);
    if (shifted > prefixLen) {
      bStart = extra;
      prefixLen = shifted;
    }
  } else if (openOrig > openRepl) {
    const extra = openOrig - openRepl;
    const shifted = commonPrefixLength(rawOrig, extra, rawRepl, 0);
    if (shifted > prefixLen) {
      aStart = extra;
      prefixLen = shifted;
    }
  }

  let cutHead = 0;
  if (prefixLen > 20) {
    const target = Math.max(8, prefixLen - 16);
    const beforeSpace = rawOrig.lastIndexOf(' ', aStart + target);
    if (beforeSpace > aStart + 6) {
      cutHead = beforeSpace + 1 - aStart;
    } else {
      const afterSpace = rawOrig.indexOf(' ', aStart + target);
      if (afterSpace !== -1 && afterSpace < aStart + prefixLen - 4) {
        cutHead = afterSpace + 1 - aStart;
      } else {
        cutHead = prefixLen - 12;
      }
    }
  }

  let aEnd = rawOrig.length;
  let bEnd = rawRepl.length;
  let suffixLen = commonSuffixLength(rawOrig, aStart + prefixLen, aEnd, rawRepl, bStart + prefixLen, bEnd);
  const closeOrig = countTrailingChar(rawOrig, ')');
  const closeRepl = countTrailingChar(rawRepl, ')');
  if (closeRepl > closeOrig) {
    const extra = closeRepl - closeOrig;
    if (bEnd - extra >= bStart + prefixLen) {
      const shifted = commonSuffixLength(rawOrig, aStart + prefixLen, aEnd, rawRepl, bStart + prefixLen, bEnd - extra);
      if (shifted > suffixLen) {
        bEnd -= extra;
        suffixLen = shifted;
      }
    }
  } else if (closeOrig > closeRepl) {
    const extra = closeOrig - closeRepl;
    if (aEnd - extra >= aStart + prefixLen) {
      const shifted = commonSuffixLength(rawOrig, aStart + prefixLen, aEnd - extra, rawRepl, bStart + prefixLen, bEnd);
      if (shifted > suffixLen) {
        aEnd -= extra;
        suffixLen = shifted;
      }
    }
  }

  const buildWithHead = headCut => [
    headCut > 0 ? `${rawOrig.slice(0, aStart)}...${rawOrig.slice(aStart + headCut)}` : rawOrig,
    headCut > 0 ? `${rawRepl.slice(0, bStart)}...${rawRepl.slice(bStart + headCut)}` : rawRepl,
  ];

  let [shownOrig, shownRepl] = buildWithHead(cutHead);
  if ((shownOrig.length > maxLength || shownRepl.length > maxLength) && suffixLen > 24) {
    const keepSuffix = 14;
    const spaceOffset = rawOrig.indexOf(' ', aEnd - suffixLen + keepSuffix);
    if (spaceOffset !== -1 && spaceOffset < aEnd - 6) {
      const dropTail = aEnd - spaceOffset;
      const origCore = headCutSlice(rawOrig, aStart, cutHead, aEnd - dropTail);
      const replCore = headCutSlice(rawRepl, bStart, cutHead, bEnd - dropTail);
      shownOrig = `${origCore}...${rawOrig.slice(aEnd)}`;
      shownRepl = `${replCore}...${rawRepl.slice(bEnd)}`;
    }
  }

  return [middleClip(shownOrig, maxLength), middleClip(shownRepl, maxLength)];
}

function headCutSlice(text, wrapperStart, cutHead, end) {
  if (cutHead > 0) return `${text.slice(0, wrapperStart)}...${text.slice(wrapperStart + cutHead, end)}`;
  return text.slice(0, end);
}

const at = location => location ? `${printable(location.file)}:${location.line}:${location.column}` : '(unknown location)';

function describeEdit(mutant) {
  const name = mutant.mutatorName ?? mutant.rule ?? 'edit';
  if (mutant.since !== undefined) return `${name}: ${mutant.together ? 'the changes of the file together' : firstLine(mutant.original) || '(removed lines)'} as it was at ${printable(mutant.since.slice(0, 12))}`;
  if (mutant.original !== undefined) {
    const [shownOrig, shownRepl] = formatEditPair(mutant.original, mutant.replacement);
    return `${name}: ${shownOrig} -> ${shownRepl}`;
  }
  const operator = String(mutant.replacement).trim();
  if (mutant.operator !== undefined && /^[<>=!&|?+*\/%-]+$/.test(operator)) return `${name}: ${printable(mutant.operator)} -> ${operator}`;
  return `${name}: replace with ${firstLine(mutant.replacement)}`;
}

function formatCollectedFiles(files, limit = 10) {
  if (!Array.isArray(files) || !files.length) return null;
  const shown = files.slice(0, limit).map(printable);
  const more = files.length - shown.length;
  return `  Collected test files (${files.length}): ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

function describeBaseline(baseline = {}) {
  const collectedLine = formatCollectedFiles(baseline.files);
  if (baseline.status === 'timeout') {
    const limit = baseline.timeoutSeconds !== undefined ? ` after ${baseline.timeoutSeconds}s` : '';
    const lines = [
      `The baseline test suite timed out${limit} before any edit.`,
      ...(collectedLine ? [collectedLine] : []),
      '  Try increasing the limit with --baseline-timeout <seconds> (or --timeout <seconds>), enabling --baseline-workers <N>, or narrowing the suite with --test <file|glob>.',
    ];
    if (baseline.output?.trim()) {
      lines.push(...printable(baseline.output).trim().split('\n').slice(-10).map(line => `  ${line}`));
    }
    return lines;
  }
  const lines = [`The test suite did not pass before any edit (baseline ${baseline.status ?? 'unknown'}). Fix it and run again.`];
  if (collectedLine) lines.push(collectedLine);
  for (const failed of baseline.failedTests ?? []) {
    lines.push(`  FAILED ${printable(failed.file)} > ${printable(failed.name)}`);
    for (const failure of failed.failures ?? []) lines.push(`    ${firstLine(failure)}`);
  }
  const seenFileErrorMessages = new Set();
  for (const entry of baseline.fileErrors ?? []) {
    const msg = firstLine(entry.message);
    seenFileErrorMessages.add(msg);
    lines.push(`  ERROR ${printable(entry.file)}: ${msg}`);
  }
  for (const error of baseline.errors ?? []) {
    const msg = firstLine(error);
    if (seenFileErrorMessages.has(msg)) continue;
    lines.push(`  ERROR ${msg}`);
  }
  if (!baseline.failedTests?.length && !baseline.fileErrors?.length && !baseline.errors?.length && baseline.output?.trim()) {
    lines.push(...printable(baseline.output).trim().split('\n').slice(-20).map(line => `  ${line}`));
  }
  return lines;
}

function formatAssertionDetails(gap) {
  const lines = [];
  const shown = (gap.tests ?? []).slice(0, 3).map(test => `${printable(test.file)} > ${printable(test.name)}`);
  const more = (gap.tests?.length ?? 0) - shown.length;
  const where = [...shown, ...(more > 0 ? [`${more} more`] : []), ...(gap.outsideTests ? ['code outside the tests'] : [])].join('; ');
  const operands = gap.example?.operands ? ` (operands ${gap.example.operands.map(printable).join(', ')})` : '';
  if (where || operands) {
    lines.push(`  the edit gives another value in: ${where || '(unknown test)'}${operands}`);
  }
  lines.push('  add an assertion on what this value decides');
  return lines;
}

function describeGap(gap) {
  const lines = [`${gap.kind ?? 'GAP'} ${at(gap.location)}${gap.rule ? `  ${gap.rule}` : ''}`];
  const witness = gap.witness;
  const inputs = witness?.arguments ?? witness?.operands;
  if (inputs) {
    lines.push(`  ${witness.arguments ? 'arguments' : 'operands'} (${inputs.map(printable).join(', ')}): ` +
      `original ${printable(witness.original)}, edited ${printable(witness.mutant)}`);
  }
  if (gap.expression !== undefined) {
    const edit = gap.mutations?.[0]?.replacement;
    const [shownExpr, shownEdit] = edit !== undefined
      ? formatEditPair(gap.expression, edit)
      : [firstLine(gap.expression), ''];
    lines.push(`  \`${shownExpr}\` passes every test as \`${shownEdit}\`` +
      (gap.reachedBy === undefined ? '' : ` (${gap.reachedBy} ${gap.reachedBy === 1 ? 'test reaches' : 'tests reach'} it)`));
    if (gap.advice) lines.push(`  ${printable(gap.advice)}`);
    else if (gap.missing && gap.uncertain) {
      lines.push(`  add ${printable(gap.missing)}, or an assertion that tells them apart: the recording cannot tell whether a test has such an input`);
    } else if (gap.missing) lines.push(`  add ${printable(gap.missing)}`);
    else if (gap.kind !== 'SURVIVED') lines.push(...formatAssertionDetails(gap));
  } else if (gap.kind === 'ASSERTION GAP') {
    const edit = gap.mutations?.[0];
    if (edit) {
      const replacement = String(edit.replacement ?? '').trim();
      let detail;
      if (gap.operator !== undefined && /^[<>=!&|?+*\/%-]+$/.test(replacement)) {
        detail = `\`${printable(gap.operator)} -> ${printable(replacement)}\``;
      } else if (edit.original !== undefined) {
        const [shownOrig, shownRepl] = formatEditPair(edit.original, edit.replacement);
        detail = `\`${shownOrig}\` -> \`${shownRepl}\``;
      } else {
        detail = `replace with \`${firstLine(edit.replacement)}\``;
      }
      lines.push(`  edit ${detail} survived`);
    }
    if (gap.advice) lines.push(`  ${printable(gap.advice)}`);
    else lines.push(...formatAssertionDetails(gap));
  }
  if (gap.kind === 'UNTESTED CHANGE') {
    lines.push(`  the tests pass with ${gap.together ? 'these changes of the file put back together as they were' : 'this change put back as it was'} at ${printable(String(gap.since).slice(0, 12))}`,
      '  add a test that fails without the change');
  }
  for (const [label, list] of [['also evaluates', gap.effects?.nowRuns], ['no longer evaluates', gap.effects?.noLongerRuns]]) {
    for (const entry of list ?? []) {
      lines.push(`  with the edit, ${entry.test === undefined ? 'loading the file' : `\`${printable(entry.test)}\``} ${label} ` +
        `\`${firstLine(entry.expression)}\` (${printable(entry.location.file)}:${entry.location.line})`);
    }
  }
  if (gap.strengthens) {
    if (gap.strengthens.kind === 'state') {
      lines.push(`  ${printable(gap.strengthens.file)} > ${printable(gap.strengthens.test)} leaves \`${printable(gap.strengthens.expression)}\` unasserted: ` +
        `it is ${printable(gap.strengthens.original)}, and ${printable(gap.strengthens.edited)} with the edit`);
    } else {
      lines.push(`  ${printable(gap.strengthens.file)} > ${printable(gap.strengthens.test)} calls \`${printable(gap.strengthens.call)}\` without pinning its result: ` +
        `it gives ${printable(gap.strengthens.original)}, and ${printable(gap.strengthens.edited)} with the edit`);
    }
  }
  if (gap.equivalenceHint) {
    lines.push(`  note: ${printable(gap.equivalenceReason ?? gap.equivalenceHint)}`);
  }
  if (gap.suggestedTest) lines.push(`  suggested test: ${printable(gap.suggestedTest)}`);
  if (gap.weakened) {
    lines.push(`  the tests as they were at ${printable(String(gap.weakened.since).slice(0, 12))} caught this: a change to the tests lets it through`);
  }
  if (gap.seed) lines.push(`  based on: ${printable(gap.seed.file)} > ${printable(gap.seed.test)}`);
  if (gap.requirement) lines.push(`  requirement: ${firstLine(gap.requirement)}`);
  if (gap.suggestedTestFile) lines.push(`  suggested test file: ${printable(gap.suggestedTestFile)}`);
  if (gap.verification?.status) lines.push(`  verification: ${printable(gap.verification.status)}`);
  if (gap.verification?.baselineWithWitness) {
    lines.push(`  verification: original ${printable(gap.verification.baselineWithWitness)}, edited ${printable(gap.verification.rewriteWithWitness)}`);
  }
  return lines;
}

const plural = (count, singular, pluralForm = singular + 's') => `${count} ${count === 1 ? singular : pluralForm}`;

export function summarizeReport(report) {
  const mutants = report?.mutants ?? [];
  const gaps = report?.diagnostics ?? [];
  const gapSites = new Set(gaps.map(gap => gap.site).filter(Boolean));
  const otherSurvivors = report?.mutators === 'full'
    ? mutants.filter(mutant =>
      mutant.status === 'survived' &&
      !gapSites.has(mutant.id ?? mutant.site) &&
      !String(mutant.mutatorName ?? mutant.rule ?? '').includes('/'))
      .length
    : 0;
  return { edits: mutants.length, gaps: gaps.length, otherSurvivors };
}

export function formatProgressSummary(report) {
  const { edits, gaps, otherSurvivors } = summarizeReport(report);
  const gapPart = otherSurvivors > 0
    ? `${plural(gaps, 'targeted gap')}, ${plural(otherSurvivors, 'other survivor')}`
    : plural(gaps, 'gap');
  return `Completed (${report.evaluation}, ${plural(edits, 'edit')}, ${gapPart}).`;
}

export function renderText(report, { verbose = false, onlyGaps = false } = {}) {
  const lines = [];
  for (const file of report.extraction ?? []) {
    if (file.path !== 'diagnostic') continue;
    lines.push(`SKIPPED ${printable(file.file)}: ${file.reason ?? 'not analyzed'}`);
    for (const diagnostic of file.diagnostics ?? []) lines.push(`  ${firstLine(diagnostic.message)}`);
  }
  if (report.evaluation === 'baseline_error') {
    lines.push(...describeBaseline(report.baseline));
    return lines.join('\n');
  }
  const mutants = report.mutants ?? [];
  const isListed = report.evaluation === 'listed';
  if (!onlyGaps || isListed) {
    for (const mutant of mutants) {
      if (!verbose && !isListed && mutant.status === 'killed') continue;
      const reason = mutant.statusReason && ['timeout', 'error', 'unstable', 'ignored', 'load_error', 'unsupported'].includes(mutant.status)
        ? `  (${firstLine(mutant.statusReason)})`
        : '';
      lines.push(`${at(mutant.location)}  ${mutant.status}  ${describeEdit(mutant)}${reason}`);
    }
  }
  const gaps = report.diagnostics ?? [];
  if (gaps.length) {
    if (lines.length) lines.push('');
    lines.push('Test gaps:');
  }
  for (const gap of gaps) lines.push(...describeGap(gap));
  if (lines.length) lines.push('');
  if (report.evaluation === 'no_sites') {
    lines.push('No edit sites in the selected scope.');
    return lines.join('\n');
  }
  const counts = new Map();
  for (const mutant of mutants) counts.set(mutant.status, (counts.get(mutant.status) ?? 0) + 1);
  const tally = [...counts].map(([status, count]) => `${count} ${status}`).join(', ') || 'none';
  const tests = report.baseline?.tests;
  const size = Array.isArray(tests) ? tests.length : tests;
  const { otherSurvivors } = summarizeReport(report);
  const gapSummary = otherSurvivors > 0
    ? `${plural(gaps.length, 'targeted gap')} (${plural(otherSurvivors, 'other survivor')})`
    : plural(gaps.length, 'test gap');
  lines.push(`${report.runner}${size === undefined ? '' : `, ${plural(size, 'baseline test')}`}: ` +
    `${plural(mutants.length, 'edit')} (${tally}), ${gapSummary}` +
    (report.suppressed?.baseline ? `, ${report.suppressed.baseline} suppressed by baseline` : '') +
    (report.shard ? `, shard ${report.shard.index}/${report.shard.total}` : '') +
    (report.evaluation === 'evaluated' ? '' : `, evaluation ${report.evaluation}`));
  return lines.join('\n');
}
