import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix, sep } from 'node:path';
import { sourceTrials } from './analysis.mjs';
import { loadTypeScript } from './typescript-compiler.mjs';
import { inside } from './vitest.mjs';

// A test can make the very call that tells an edit from the original and still pass, because its assertion does
// not pin the result down: `expect(bucket(3)).not.toBe('none')`, `expect(total(1, 2)).toBeGreaterThan(0)`, a call
// whose result is not looked at. For a finding that names such tests, the call is run where the test makes it,
// once as it is and once with the edit, and where the two values differ the report gives the value to compare with.
const pinning = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toBeNull', 'toBeUndefined', 'toBeNaN', 'toBeCloseTo',
  'toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchObject']);
const extension = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// The calls of the subject's exported functions with written arguments that a test of the given names makes
// directly in its body without pinning the result down.
export function weakCalls(text, testFile, subjectFile, testNames, ts = loadTypeScript()) {
  const tree = ts.createSourceFile(testFile, text, ts.ScriptTarget.Latest, true);
  const K = ts.SyntaxKind;
  const subject = subjectFile.split(sep).join('/').replace(extension, '');
  const imported = new Map();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = posix.join(posix.dirname(testFile.split(sep).join('/')), specifier).replace(extension, '');
    if (target !== subject && target + '/index' !== subject) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if (!element.isTypeOnly) imported.set(element.name.text, true);
  }
  if (!imported.size) return [];
  const strip = node => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  const up = node => {
    let child = node;
    while (ts.isParenthesizedExpression(child.parent)) child = child.parent;
    return [child.parent, child];
  };
  function written(node) {
    const inner = strip(node);
    if (ts.isNumericLiteral(inner) || ts.isBigIntLiteral(inner) || ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ||
        [K.TrueKeyword, K.FalseKeyword, K.NullKeyword].includes(inner.kind) || (ts.isIdentifier(inner) && inner.text === 'undefined')) return true;
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === K.MinusToken) return ts.isNumericLiteral(inner.operand) || ts.isBigIntLiteral(inner.operand);
    if (ts.isArrayLiteralExpression(inner)) return inner.elements.every(written);
    if (ts.isObjectLiteralExpression(inner)) {
      return inner.properties.every(property => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && written(property.initializer));
    }
    return false;
  }
  // The matcher an `expect(call)` is checked with, or nothing when the chain is not a plain matcher call.
  function weakExpectation(expectCall) {
    const names = [];
    let [parent, child] = up(expectCall);
    while (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
      names.push(parent.name.text);
      [parent, child] = up(parent);
    }
    if (!names.length || !ts.isCallExpression(parent) || parent.expression !== child || names.includes('resolves') || names.includes('rejects')) return false;
    if (!ts.isExpressionStatement(up(parent)[0])) return false;
    return names.includes('not') || !pinning.has(names.at(-1));
  }
  // The titles of the suites around a test, outermost first, or nothing where one of them is not written out.
  function suitesOf(call) {
    const titles = [];
    for (let node = call.parent; node; node = node.parent) {
      if (!ts.isCallExpression(node) || !(ts.isArrowFunction(node.arguments[1] ?? node) || ts.isFunctionExpression(node.arguments[1] ?? node))) continue;
      // `describe.skip(...)`, and `describe.each(rows)(...)`, whose title is a pattern filled in per row.
      let callee = node.expression;
      let each = false;
      while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
        each ||= ts.isCallExpression(callee);
        callee = callee.expression;
      }
      if (!ts.isIdentifier(callee) || !['describe', 'suite'].includes(callee.text)) continue;
      if (each || !node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) return undefined;
      titles.unshift(node.arguments[0].text);
    }
    return titles;
  }

  // The title of the test whose body holds the statement directly, with the suites around it.
  function testOf(statement) {
    const body = statement.parent;
    const callback = ts.isBlock(body) ? body.parent : null;
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isCallExpression(callback.parent)) return undefined;
    const call = callback.parent;
    const title = call.arguments[0];
    if (!ts.isIdentifier(call.expression) || !['it', 'test'].includes(call.expression.text) || call.arguments[1] !== callback ||
        !title || !ts.isStringLiteralLike(title)) return undefined;
    return { title: title.text, suites: suitesOf(call) };
  }
  const found = [];
  (function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imported.has(node.expression.text) && !node.questionDotToken &&
        node.arguments.every(written)) {
      const [parent, child] = up(node);
      let statement;
      let bound;
      if (ts.isExpressionStatement(parent)) statement = parent;
      else if (ts.isVariableDeclaration(parent) && parent.initializer === child && ts.isVariableStatement(parent.parent.parent)) {
        statement = parent.parent.parent;
        if (ts.isIdentifier(parent.name)) bound = parent.name.text;
      }
      else if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'expect' &&
          parent.arguments.length === 1 && weakExpectation(parent)) {
        let outer = parent;
        while (!ts.isExpressionStatement(outer)) outer = outer.parent;
        statement = outer;
      }
      const { title, suites } = (statement && testOf(statement)) ?? {};
      const start = node.getStart(tree);
      const call = text.slice(start, node.end);
      // A test is named with its suites. Where a suite's title is not written out, the test's own title must do.
      const named = name => (suites ? name === [...suites, title].join(' > ') : name === title || name.endsWith(' > ' + title));
      if (title !== undefined && !/[\n\r]/.test(call) && testNames.some(named)) {
        const { line, character } = tree.getLineAndCharacterOfPosition(start);
        found.push({ start, end: node.end, text: call, test: title, line: line + 1, column: character + 1, ...(bound ? { bound } : {}) });
      }
    }
    ts.forEachChild(node, visit);
  })(tree);
  return found;
}

// The test file with one call wrapped so that every value it gives is written beside the file.
export function recordingCall(text, call, key) {
  const name = `__tmtValue_${key}`;
  // The file system is taken from Node itself: the test may have replaced the module with a mock.
  const helper = `
function ${name}(value) {
  var type = typeof value, shown = null;
  if (value === null || type === 'boolean' || type === 'undefined') shown = String(value);
  else if (type === 'number') shown = Object.is(value, -0) ? '-0' : String(value);
  else if (type === 'string') shown = JSON.stringify(value);
  else if (type === 'bigint') shown = value + 'n';
  globalThis.process.getBuiltinModule('node:fs').appendFileSync(new URL('./.tmt-values-${key}.jsonl', import.meta.url), JSON.stringify(shown) + '\\n');
  return value;
}
`;
  return text.slice(0, call.start) + `${name}(${call.text})` + text.slice(call.end) + helper;
}

const valuesOf = run => (run.collected ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));

export function strengthenAssertions(root, report, options, run = { sourceTrials }) {
  const originals = new Map();
  let tried = 0;
  for (const gap of report.diagnostics ?? []) {
    const mutation = gap.mutations?.[0];
    if (!gap.tests?.length || !mutation || gap.suggestedTest || !gap.location?.file) continue;
    const input = readFileSync(inside(root, gap.location.file));
    const subject = { file: gap.location.file, input, digest: createHash('sha256').update(input).digest('hex'), sites: [] };
    const trial = { site: { location: gap.location }, edit: mutation.source?.edit ?? mutation.edit, replacement: mutation.source?.replacement ?? mutation.replacement };
    let calls = 0;
    search: for (const testFile of [...new Set(gap.tests.map(test => test.file))].slice(0, 2)) {
      const text = readFileSync(inside(root, testFile), 'utf8');
      const names = gap.tests.filter(test => test.file === testFile).map(test => test.name);
      const attempt = run.sourceTrials(root, [subject], { ...options, test: [testFile] });
      for (const call of weakCalls(text, testFile, gap.location.file, names)) {
        // At most four calls for a finding and 24 runs with an edit in all.
        if (calls >= 4 || tried >= 24) break search;
        calls++;
        const key = randomUUID().replaceAll('-', '');
        const collect = posix.join(posix.dirname(testFile.split(sep).join('/')), `.tmt-values-${key}.jsonl`);
        const witness = { rewrite: { file: testFile, content: recordingCall(text, call, key) } };
        const id = `${testFile}:${call.start}`;
        // The values of the call as it is are the same for every finding that names this call.
        if (!originals.has(id)) originals.set(id, valuesOf(attempt({ witness, collect })));
        const original = originals.get(id);
        if (!original.length || original.includes(null)) continue;
        tried++;
        const edited = valuesOf(attempt({ witness, collect, trial }));
        // The first time the call gives another value with the edit. Where the edit keeps the test from making
        // the call at all, an assertion at that place would not run either.
        const at = original.findIndex((value, index) => index < edited.length && edited[index] !== value);
        if (at === -1) continue;
        // A result the test keeps is compared where it is kept: calling again may give another value.
        gap.suggestedTest = `expect(${call.bound ?? call.text}).toBe(${original[at]})`;
        gap.strengthens = { file: testFile, test: call.test, line: call.line, column: call.column, call: call.text, original: original[at], edited: edited[at] };
        break search;
      }
    }
  }
  return report;
}

// The plain source edits are for the runs above and are not part of the report.
export function withoutSourceEdits(report) {
  for (const gap of report.diagnostics ?? []) for (const mutation of gap.mutations ?? []) delete mutation.source;
  return report;
}
