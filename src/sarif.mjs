import { annotateFindingIds } from './baseline.mjs';

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SARIF_VERSION = '2.1.0';

const RULES = [
  {
    id: 'input-gap',
    name: 'InputGap',
    shortDescription: { text: 'Missing test input distinguishing a targeted mutation' },
    defaultConfiguration: { level: 'warning' },
  },
  {
    id: 'assertion-gap',
    name: 'AssertionGap',
    shortDescription: { text: 'Tests execute changed behavior without asserting on it' },
    defaultConfiguration: { level: 'warning' },
  },
  {
    id: 'untested-change',
    name: 'UntestedChange',
    shortDescription: { text: 'Test suite still passes when a recent change is reverted' },
    defaultConfiguration: { level: 'warning' },
  },
  {
    id: 'weakened-test',
    name: 'WeakenedTest',
    shortDescription: { text: 'A recent test change allowed a previously caught mutation to survive' },
    defaultConfiguration: { level: 'error' },
  },
  {
    id: 'witness-gap',
    name: 'WitnessGap',
    shortDescription: { text: 'Confirmed distinguishing witness reveals a test gap' },
    defaultConfiguration: { level: 'warning' },
  },
];

function toPosixUri(file) {
  return String(file ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function ruleIdFor(diagnostic) {
  if (diagnostic.weakened) return 'weakened-test';
  switch (diagnostic.kind) {
    case 'INPUT GAP': return 'input-gap';
    case 'ASSERTION GAP': return 'assertion-gap';
    case 'UNTESTED CHANGE': return 'untested-change';
    default: return diagnostic.verification?.status === 'confirmed' ? 'witness-gap' : 'input-gap';
  }
}

function messageFor(diagnostic) {
  const parts = [];
  const kind = diagnostic.kind ?? 'GAP';
  const rule = diagnostic.rule ? ` (${diagnostic.rule})` : '';
  if (diagnostic.expression !== undefined) {
    const edit = diagnostic.mutations?.[0]?.replacement;
    parts.push(`${kind}${rule}: \`${String(diagnostic.expression).trim()}\` passes every test as \`${String(edit ?? '').trim()}\`.`);
  } else if (diagnostic.kind === 'UNTESTED CHANGE') {
    parts.push(`UNTESTED CHANGE: tests pass with this change reverted to ${String(diagnostic.since ?? '').slice(0, 12)}.`);
  } else {
    parts.push(`${kind}${rule}.`);
  }
  if (diagnostic.missing) parts.push(`Add ${diagnostic.missing}.`);
  else if (diagnostic.advice) parts.push(diagnostic.advice);
  if (diagnostic.suggestedTest) parts.push(`Suggested test: ${diagnostic.suggestedTest}`);
  if (diagnostic.weakened) {
    parts.push(`Weakened test: tests as they were at ${String(diagnostic.weakened.since).slice(0, 12)} caught this.`);
  }
  return parts.join(' ');
}

export function renderSarif(report, { version = '0.0.0' } = {}) {
  const annotated = annotateFindingIds(report.diagnostics ?? []);
  const results = annotated.map(diagnostic => {
    const ruleId = ruleIdFor(diagnostic);
    const location = diagnostic.location ?? {};
    const result = {
      ruleId,
      level: ruleId === 'weakened-test' ? 'error' : 'warning',
      message: { text: messageFor(diagnostic) },
      partialFingerprints: {
        tmtFindingId: diagnostic.findingId,
      },
      properties: {
        kind: diagnostic.kind ?? 'GAP',
        ...(diagnostic.rule ? { rule: diagnostic.rule } : {}),
        ...(diagnostic.equivalenceHint ? { equivalenceHint: diagnostic.equivalenceHint } : {}),
        ...(diagnostic.suggestedTest ? { suggestedTest: diagnostic.suggestedTest } : {}),
        ...(diagnostic.weakened ? { weakened: diagnostic.weakened } : {}),
      },
    };
    if (location.file) {
      result.locations = [{
        physicalLocation: {
          artifactLocation: { uri: toPosixUri(location.file) },
          region: {
            startLine: Math.max(1, Number(location.line) || 1),
            startColumn: Math.max(1, Number(location.column) || 1),
          },
        },
      }];
    }
    return result;
  });

  const executionSuccessful = report.evaluation !== 'baseline_error' && report.evaluation !== 'incomplete' &&
    !(report.extraction ?? []).some(entry => entry.path === 'diagnostic');

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: 'targeted-mutation',
          version,
          informationUri: 'https://github.com/t-k/targeted-mutation-ts',
          rules: RULES,
        },
      },
      invocations: [{
        executionSuccessful,
      }],
      results,
      properties: {
        analysis: {
          runner: report.runner,
          mutators: report.mutators,
          evaluation: report.evaluation,
          ...(report.suppressed ? { suppressed: report.suppressed } : {}),
          ...(report.shard ? { shard: report.shard } : {}),
        },
      },
    }],
  };
}

export function renderJsonl(report) {
  const lines = [];
  const { mutants = [], diagnostics = [], ...summary } = report;
  lines.push(JSON.stringify({ event: 'summary', ...summary }));
  for (const mutant of mutants) {
    lines.push(JSON.stringify({ event: 'mutant', ...mutant }));
  }
  for (const diagnostic of annotateFindingIds(diagnostics)) {
    lines.push(JSON.stringify({ event: 'diagnostic', ...diagnostic }));
  }
  lines.push(JSON.stringify({
    event: 'complete',
    evaluation: report.evaluation,
    mutants: mutants.length,
    diagnostics: diagnostics.length,
  }));
  return lines.join('\n');
}
