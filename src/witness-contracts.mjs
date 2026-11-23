import { createHash, randomUUID } from 'node:crypto';
import { verdict } from './analysis.mjs';
import { inParallel } from './in-parallel.mjs';

const isValue = value => value === null || ['string', 'boolean'].includes(typeof value) || (Number.isFinite(value) && !Object.is(value, -0));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function prepareContracts(specification, selection, snapshots, { discovered = false } = {}) {
  if (specification === null || typeof specification !== 'object' || !Array.isArray(specification.witnessPlans)) {
    throw new Error('Expected a specification with a witnessPlans array');
  }
  if (specification.witnessPlans.length > 32) throw new Error('At most 32 witness plans can be verified in one run');
  const names = new Set();
  return specification.witnessPlans.flatMap((plan, index) => {
    if (!plan || ![plan.name, plan.requirement, plan.testFile, plan.seedTest, plan.observe].every(nonempty) ||
        !isValue(plan.expected) || !isValue(plan.alternate) || Object.is(plan.expected, plan.alternate) ||
        !Array.isArray(plan.edits) || ![1, 2].includes(plan.edits.length) || names.has(plan.name)) {
      throw new Error(`Invalid witness plan ${index + 1}`);
    }
    names.add(plan.name);
    for (const edit of plan.edits) {
      if (!edit || !nonempty(edit.file) || !Number.isSafeInteger(edit.line) || edit.line < 1 ||
          !nonempty(edit.original) || /[\r\n\u2028\u2029]/.test(edit.original) ||
          typeof edit.replacement !== 'string' || edit.replacement === edit.original) {
        throw new Error(`Invalid source edit in witness plan ${plan.name}`);
      }
    }
    if (!plan.edits.every(edit => selection.get(edit.file)?.(edit.line))) return [];
    const edits = plan.edits.map(edit => {
      const file = snapshots.get(edit.file);
      if (file === undefined) throw new Error(`Source unavailable for witness plan ${plan.name}: ${edit.file}`);
      const lines = file.split(/(\r\n|[\r\n\u2028\u2029])/);
      const line = lines[(edit.line - 1) * 2];
      const lineStart = lines.slice(0, (edit.line - 1) * 2).join('').length;
      const first = discovered ? edit.start - lineStart : line?.indexOf(edit.original) ?? -1;
      if (first < 0 || (discovered ? !Number.isSafeInteger(first) || line?.slice(first, first + edit.original.length) !== edit.original
        : first !== line.lastIndexOf(edit.original))) {
        throw new Error(`Expected one exact source edit match in ${edit.file}:${edit.line}`);
      }
      const start = lineStart + first;
      return { ...edit, start, end: start + edit.original.length };
    });
    if (edits.length === 2 && edits[0].file === edits[1].file &&
        edits[0].start < edits[1].end && edits[1].start < edits[0].end) {
      throw new Error(`Overlapping source edits in witness plan ${plan.name}`);
    }
    const id = createHash('sha256').update(JSON.stringify([plan.name, edits])).digest('hex');
    return [{ ...plan, id, edits }];
  });
}

export function confirmsContract(status, seedPassed, singletons, checked) {
  return status === 'survived' && seedPassed && singletons.every(result => result.status === 'killed' && result.seedFailed) && checked;
}

export async function evaluateContracts(plans, attempt, baseline, snapshots, verifyAppend, report, concurrency = 1) {
  const testFiles = new Set(baseline.tests.map(test => test.file));
  const evaluated = await inParallel(plans, concurrency, async plan => {
    const { id, edits, name, seedTest, testFile, expected, alternate, requirement, observe, expectation, borrowedFrom, observation, connection } = plan;
    const rule = edits.length === 2 ? 'paired-source/v1' : 'contract-source/v1';
    const scope = edits.map(edit => {
      const source = snapshots.get(edit.file);
      return { ...edit, start: Buffer.byteLength(source.slice(0, edit.start)), end: Buffer.byteLength(source.slice(0, edit.end)) };
    });
    const seeds = baseline.tests.filter(test => test.file === testFile && test.name === seedTest);
    const seed = seeds.length === 1 && seeds[0].status === 'passed' && !seeds[0].retry && !seeds[0].repeats ? seeds[0] : null;
    const result = { id, rule, name, edits: scope, location: { file: scope[0].file, line: scope[0].line,
      start: scope[0].start, end: scope[0].end }, status: 'unevaluated' };
    if (!seed || edits.some(edit => testFiles.has(edit.file)) || !snapshots.has(testFile)) {
      result.statusReason = 'Expected one passing, unmodified seed test';
      return { result };
    }
    const raw = await attempt(edits);
    result.status = verdict(raw, baseline);
    result.evidence = 'reexecuted';
    if (result.status !== 'survived') return { result };
    const singletons = edits.length === 2 ? await Promise.all(edits.map(async edit => {
      const single = await attempt([edit]);
      return { status: verdict(single, baseline), seedFailed: !!single.tests?.some(test => test.file === seed.file &&
        test.project === seed.project && test.id === seed.id && test.name === seed.name && test.status === 'failed') };
    })) : [];
    if (edits.length === 2) result.singletons = singletons;
    if (!confirmsContract(result.status, true, singletons, true)) return { result };

    const suffix = randomUUID().replaceAll('-', '');
    const marker = 'TMT witness ' + suffix;
    const append = { file: testFile, source: `
import { expect as __tmtExpect_${suffix}, it as __tmtIt_${suffix} } from 'vitest';
__tmtIt_${suffix}(${JSON.stringify(marker)}, async () => {
  const actual = await (${observe});
  const isExpected = Object.is(actual, ${JSON.stringify(expected)});
  if (!isExpected && !Object.is(actual, ${JSON.stringify(alternate)})) throw new Error('Unexpected witness result');
  __tmtExpect_${suffix}(isExpected, ${JSON.stringify(marker)}).toBe(true);
});
` };
    if (!await verifyAppend(attempt, baseline, edits, append, marker, true, false)) return { result };
    return { result, diagnostic: {
      kind: edits.length === 2 ? 'PAIRED MUTATION GAP' : 'STATE ASSERTION GAP',
      site: id, rule, location: result.location, requirement, seed: { file: testFile, test: seedTest },
      borrowedFrom, observation, connection,
      witness: { expression: observe, original: expected, mutant: alternate, expectation: expectation === 'original' ? 'original' : 'specification' },
      suggestedTest: `expect(await (${observe})).toBe(${JSON.stringify(expected)})`,
      verification: { status: 'confirmed', original: 'passed', rewrite: 'failed' },
    } };
  });
  for (const { result, diagnostic } of evaluated) {
    report.mutants.push(result);
    if (diagnostic) report.diagnostics.push(diagnostic);
  }
}
