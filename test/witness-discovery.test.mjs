import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { discoverContracts, discoverySources } from '../src/witness-discovery.mjs';
import { discoverWitnessRules, parseSource } from '../src/witness-rules.mjs';
import { fixtureCalls, witnessProposals } from '../src/witness-fixtures.mjs';

const fixture = path => readFileSync(new URL('../fixtures/witnesses/' + path, import.meta.url), 'utf8');
const rows = readFileSync(new URL('../verification/pict/witness-expansion.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(line => line.trim().split('\t'));
const contractSource = 'src/contracts.ts';
const contractTest = 'test/contracts.test.ts';
const titles = ['round-trips a nonpalindromic value', 'rejects an invalid batch', 'reads a successful write'];
const baseline = { tests: titles.map((name, index) => ({ id: String(index), file: contractTest, name, status: 'passed' })) };

for (const [rule, seed, scope] of rows) {
  test(`witness expansion matrix: ${rule} ${seed} ${scope}`, () => {
    const linked = seed !== 'Detached', selected = scope === 'Full';
    if (rule === 'Pair' || rule === 'State') {
      let source = fixture(contractTest);
      if (seed === 'Alias') source = source.replace('expect(decode(encode(0x0102)))', 'const packet = encode(0x0102);\n  expect(decode(packet))');
      if (!linked && rule === 'Pair') source = source.replace('decode(encode(0x0102))', 'decode(new Uint8Array([2, 1]))');
      if (!linked && rule === 'State') source = source.replace("expect(store.get('a')).toBe('1');", '');
      const target = parseSource(contractSource, fixture(contractSource));
      const sources = discoverySources(target, line => selected || line === 3);
      const plans = discoverContracts([{ file: contractTest, tree: parseSource(contractTest, source) }], baseline, [sources]);
      assert.equal(plans.some(plan => plan.edits.length === (rule === 'Pair' ? 2 : 1)), linked && selected);
      return;
    }

    const file = 'src/text-order.ts', fileName = 'test/text-order.test.ts';
    let source = fixture(fileName);
    if (!linked) source = rule === 'Unicode' ? source.replace("scalarCount('a')", "scalarCount('é')")
      : source.replace('createdAt: 10, updatedAt: 20', 'createdAt: 30, updatedAt: 20');
    const tree = parseSource(file, fixture(file));
    const seeds = parseSource(fileName, source);
    const candidates = discoverWitnessRules(tree, [{ function: 'byCreated', before: 'createdAt', after: 'updatedAt' }])
      .filter(candidate => selected && candidate.name === (rule === 'Unicode' ? 'scalarCount' : 'byCreated'));
    const proposals = candidates.flatMap(candidate => witnessProposals(candidate, fixtureCalls(seeds, fileName, candidate, file)));
    assert.equal(proposals.length > 0, linked && selected);
  });
}

test('rejects mismatched endian flags and ambiguous or failed seed identities', () => {
  const source = fixture(contractSource).replace('getUint16(0, true)', 'getUint16(0, false)');
  const tests = [{ file: contractTest, tree: parseSource(contractTest, fixture(contractTest)) }];
  const targets = input => [discoverySources(parseSource(contractSource, input), () => true)];
  assert.ok(!discoverContracts(tests, baseline, targets(source)).some(plan => plan.edits.length === 2));
  assert.ok(!discoverContracts(tests, { tests: [...baseline.tests, { ...baseline.tests[0], id: 'duplicate' }] },
    targets(fixture(contractSource))).some(plan => plan.edits.length === 2));
});

test('uses the AST offset when a neighboring comment repeats an endian call', async () => {
  const { prepareContracts } = await import('../src/witness-contracts.mjs');
  const source = fixture(contractSource).replace('getUint16(0, true);', 'getUint16(0, true); // getUint16(0, true)');
  const sources = discoverySources(parseSource(contractSource, source), () => true);
  const tests = [{ file: contractTest, tree: parseSource(contractTest, fixture(contractTest)) }];
  const plans = discoverContracts(tests, baseline, [sources]);
  const [pair] = prepareContracts({ witnessPlans: plans.filter(plan => plan.edits.length === 2) },
    new Map([[contractSource, () => true]]), new Map([[contractSource, source]]), { discovered: true });
  assert.equal(pair.edits[1].start, source.indexOf('getUint16(0, true)'));
});

test('attributes the actual donor key and declines unreachable donor reads', () => {
  const sources = [discoverySources(parseSource(contractSource, fixture(contractSource)), () => true)];
  const testWithKey = fixture(contractTest).replace("store.get('a')", "store.get('elsewhere')");
  const plans = input => discoverContracts([{ file: contractTest, tree: parseSource(contractTest, input) }], baseline, sources);
  const state = plans(testWithKey).find(plan => plan.edits.length === 1);
  assert.equal(state.borrowedFrom.argument, 'elsewhere');
  assert.equal(state.observation.argument, 'a');
  assert.ok(!plans(testWithKey.replace("  expect(store.get('elsewhere'))", "  return;\n  expect(store.get('elsewhere'))"))
    .some(plan => plan.edits.length === 1));
});

test('keeps the donor class alias and models four-byte wire observations', () => {
  const source = fixture(contractSource).replace('new Uint8Array(2)', 'new Uint8Array(4)').replaceAll('Uint16', 'Uint32');
  const input = fixture(contractTest).replace('encode, Store }', 'encode, Store as __tmtInstance }')
    .replaceAll('new Store()', 'new __tmtInstance()').replaceAll('0x0102', '0x01020304');
  const plans = discoverContracts([{ file: contractTest, tree: parseSource(contractTest, input) }], baseline,
    [discoverySources(parseSource(contractSource, source), () => true)]);
  assert.deepEqual(plans.filter(plan => plan.edits.length === 2).map(plan => [plan.expected, plan.alternate]), [['4,3,2,1', '1,2,3,4']]);
  const state = plans.find(plan => plan.edits.length === 1);
  assert.match(state.observe, /const __tmtInstance_ = new __tmtInstance\(\)/);
});
