import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { thresholdGaps } from './threshold.mjs';
import { withTypeScriptSyntax } from './typescript-compiler.mjs';
import { inside, runVitest, withCopy } from './vitest.mjs';

function readThresholdSites(ts, source, file, operators) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) {
    return { error: ts.flattenDiagnosticMessageText(tree.parseDiagnostics[0].messageText, '\n') };
  }
  const sites = [];
  const extractBody = fn => {
    if (!fn.body) return null;
    if (!ts.isBlock(fn.body)) return fn.body;
    const [only] = fn.body.statements;
    return fn.body.statements.length === 1 && ts.isReturnStatement(only) ? only.expression : null;
  };
  const inspectFunction = (nameNode, fn) => {
    if (!ts.isIdentifier(nameNode) || fn.asteriskToken ||
        fn.modifiers?.some(modifier => ![ts.SyntaxKind.ExportKeyword].includes(modifier.kind)) ||
        fn.parameters.length !== 1) return;

    const parameter = fn.parameters[0];
    const comparison = extractBody(fn);
    if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken ||
        !comparison || !ts.isBinaryExpression(comparison) || !ts.isIdentifier(comparison.left) ||
        comparison.left.text !== parameter.name.text) return;
    const operator = comparison.operatorToken.getText(tree);
    if (!operators.has(operator)) return;

    const literal = comparison.right;
    const numeric = ts.isNumericLiteral(literal)
      ? literal : ts.isPrefixUnaryExpression(literal) && literal.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(literal.operand) ? literal.operand : undefined;
    if (!numeric) return;
    const value = Number(numeric.text);
    const threshold = numeric === literal ? value : -value;
    if (!Number.isSafeInteger(threshold)) return;
    sites.push({
      operator,
      functionName: nameNode.getText(tree),
      threshold,
      operand: comparison.left.getText(tree),
      from: comparison.getStart(tree),
      to: comparison.end,
      literalFrom: literal.getStart(tree),
      literalTo: literal.end,
    });
  };
  for (const statement of tree.statements) {
    if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      inspectFunction(statement.name, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;

    for (const declaration of statement.declarationList.declarations) {
      const arrow = declaration.initializer;
      if (arrow && ts.isArrowFunction(arrow)) inspectFunction(declaration.name, arrow);
    }
  }
  return { sites };
}

function scanThresholdSites(source, file, operators) {
  const { sites, error } = withTypeScriptSyntax(ts => readThresholdSites(ts, source, file, operators));
  if (error !== undefined) throw new Error(error);
  return sites;
}

const comparisonOperators = new Set(['<', '<=', '>', '>=']);

export function comparisonThresholdSites(source, file) {
  return scanThresholdSites(source, file, comparisonOperators);
}

export function thresholdSites(source, file, operator = '>=') {
  return scanThresholdSites(source, file, new Set([operator])).map(({ operator: _, ...site }) => site);
}

function edit(source, start, end, replacement) {
  return source.slice(0, start) + replacement + source.slice(end);
}

function moduleSpecifier(from, to) {
  const path = relative(dirname(from), to);
  return JSON.stringify(path.startsWith('../') ? path : './' + path);
}

function sourceIdentifiers(ts, source, target) {
  const tree = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true);
  const identifiers = new Set();
  function visit(node) {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return identifiers;
}

function instrument(source, sites, target, root) {
  const identifiers = withTypeScriptSyntax(ts => sourceIdentifiers(ts, source, target));
  let alias = '__tmtThreshold';
  while (identifiers.has(alias)) alias += '_';

  const runtime = resolve(root, `.tmt-observation-${randomUUID()}.mjs`);
  writeFileSync(runtime, `import { appendFileSync } from 'node:fs';
export function record(site, value, threshold) {
  const result = value >= threshold;
  appendFileSync(process.env.TMT_TRACE, JSON.stringify([site, Number.isSafeInteger(value) ? value : null]) + '\\n');
  return result;
}
`, { flag: 'wx' });
  let result = source;
  for (const site of sites.toReversed()) {
    const literal = source.slice(site.literalFrom, site.literalTo);
    result = edit(result, site.from, site.to, `${alias}(${site.from}, ${site.operand}, ${literal})`);
  }
  return result + `\nimport { record as ${alias} } from ${moduleSpecifier(target, runtime)};\n`;
}

function inventory(run, without) {
  return run.tests?.filter(test => test.file !== without).map(test => JSON.stringify([test.file, test.name, test.status])).sort().join('\n');
}

function verifyWitness(root, temp, target, site, gap, source, mutant, baseline) {
  const dir = resolve(root, 'test');
  mkdirSync(dir, { recursive: true });
  const witnessFile = resolve(inside(root, dir), `tmt-witness-${randomUUID()}.test.ts`);
  const file = relative(root, witnessFile);
  const name = 'TMT generated threshold witness';
  writeFileSync(witnessFile, `import { it, expect } from 'vitest';
import { ${site.functionName} as subject } from ${moduleSpecifier(witnessFile, target)};
it(${JSON.stringify(name)}, () => expect(subject(${gap.witness})).toBe(${gap.expected}));
`, { flag: 'wx' });
  try {
    writeFileSync(target, source);
    const original = runVitest(root, temp);
    writeFileSync(target, mutant);
    const rewritten = runVitest(root, temp);
    function outcome(run, expected) {
      const tests = run.tests?.filter(test => test.file === file);
      if (run.status === expected && tests?.length === 1 && tests[0].name === name && tests[0].status === expected &&
          inventory(run, file) === inventory(baseline)) return expected;
      return 'unconfirmed';
    }
    return { baselineWithWitness: outcome(original, 'passed'), rewriteWithWitness: outcome(rewritten, 'failed') };
  } finally {
    rmSync(witnessFile);
  }
}

function expectPassing(run, phase) {
  if (run.status !== 'passed') throw new Error(`${phase} Vitest run: ${run.status}\n${run.output}`);
}

function location(source, file, site) {
  const before = source.slice(0, site.literalFrom);
  const lines = before.split(/\r\n|[\n\r\u2028\u2029]/);
  return { file, line: lines.length, column: lines.at(-1).length + 1,
    start: Buffer.byteLength(before), end: Buffer.byteLength(source.slice(0, site.literalTo)) };
}

function readTrace(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function runPrototype(project, file, { spec } = {}) {
  return withCopy(project, (root, temp) => {
    const target = inside(root, file);
    const name = relative(root, target);
    const source = readFileSync(target, 'utf8');
    const sites = thresholdSites(source, name);
    if (!sites.length) return { diagnostics: [] };

    const specification = spec ? JSON.parse(readFileSync(inside(root, spec), 'utf8')) : {};
    const baseline = runVitest(root, temp);
    expectPassing(baseline, 'Baseline');

    const trace = resolve(temp, 'trace.jsonl');
    writeFileSync(target, instrument(source, sites, target, root));
    const instrumented = runVitest(root, temp, { trace });
    expectPassing(instrumented, 'Instrumented baseline');
    if (inventory(instrumented) !== inventory(baseline)) throw new Error('Instrumented baseline changed the test inventory');
    const observations = readTrace(trace);
    const diagnostics = [];

    const candidates = sites.map(site => {
      const observed = observations.filter(([id]) => id === site.from).map(([, value]) => value);
      const contract = Object.hasOwn(specification, site.functionName) ? specification[site.functionName] : null;
      const specified = contract?.operator === '>=' && contract.threshold === site.threshold && Boolean(contract.rationale?.trim());
      return { site, specified, observed, request: {
        threshold: site.threshold, observations: observed,
        min: specified ? contract.min : undefined, max: specified ? contract.max : undefined,
      } };
    });
    const gaps = thresholdGaps(candidates.map(candidate => candidate.request));
    for (const [index, { site, specified, observed }] of candidates.entries()) {
      const gap = gaps[index];
      if (!gap) continue;

      const mutant = edit(source, site.literalFrom, site.literalTo, String(gap.alternate));
      writeFileSync(target, mutant);
      const rewrite = runVitest(root, temp);
      if (rewrite.status !== 'passed' || inventory(rewrite) !== inventory(baseline)) continue;

      const verification = {
        baseline: 'passed', instrumented: 'passed', rewrite: 'passed',
        ...verifyWitness(root, temp, target, site, gap, source, mutant, baseline),
      };

      diagnostics.push({
        kind: 'INPUT GAP',
        location: location(source, name, site),
        mutation: { original: source.slice(site.from, site.to), source: mutant.slice(site.from, site.to + String(gap.alternate).length - (site.literalTo - site.literalFrom)) },
        observedInputs: [...new Set(observed)].sort((a, b) => a - b),
        feasibleThresholds: gap.interval,
        witness: { input: gap.witness, original: gap.expected, mutant: gap.mutant, expectation: specified ? 'specification' : 'original' },
        suggestedTest: `expect(${site.functionName}(${gap.witness})).toBe(${gap.expected})`,
        verification,
      });
    }

    return { diagnostics };
  });
}
