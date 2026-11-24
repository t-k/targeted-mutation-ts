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
  // The title of the test whose body holds the statement directly.
  function testOf(statement) {
    const body = statement.parent;
    const callback = ts.isBlock(body) ? body.parent : null;
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isCallExpression(callback.parent)) return undefined;
    const call = callback.parent;
    const title = call.arguments[0];
    if (!ts.isIdentifier(call.expression) || !['it', 'test'].includes(call.expression.text) || call.arguments[1] !== callback ||
        !title || !ts.isStringLiteralLike(title)) return undefined;
    return title.text;
  }
  const found = [];
  (function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imported.has(node.expression.text) && !node.questionDotToken &&
        node.arguments.every(written)) {
      const [parent, child] = up(node);
      let statement;
      if (ts.isExpressionStatement(parent)) statement = parent;
      else if (ts.isVariableDeclaration(parent) && parent.initializer === child && ts.isVariableStatement(parent.parent.parent)) statement = parent.parent.parent;
      else if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'expect' &&
          parent.arguments.length === 1 && weakExpectation(parent)) {
        let outer = parent;
        while (!ts.isExpressionStatement(outer)) outer = outer.parent;
        statement = outer;
      }
      const title = statement && testOf(statement);
      const start = node.getStart(tree);
      const call = text.slice(start, node.end);
      if (title !== undefined && !/[\n\r]/.test(call) && testNames.some(name => name === title || name.endsWith(' > ' + title))) {
        const { line, character } = tree.getLineAndCharacterOfPosition(start);
        found.push({ start, end: node.end, text: call, test: title, line: line + 1, column: character + 1 });
      }
    }
    ts.forEachChild(node, visit);
  })(tree);
  return found;
}

// The test file with one call wrapped so that every value it gives is written beside the file.
export function recordingCall(text, call, key) {
  const name = `__tmtValue_${key}`;
  const helper = `
import { appendFileSync as __tmtAppend_${key} } from 'node:fs';
function ${name}(value) {
  var type = typeof value, shown = null;
  if (value === null || type === 'boolean' || type === 'undefined') shown = String(value);
  else if (type === 'number') shown = Object.is(value, -0) ? '-0' : String(value);
  else if (type === 'string') shown = JSON.stringify(value);
  else if (type === 'bigint') shown = value + 'n';
  __tmtAppend_${key}(new URL('./.tmt-values-${key}.jsonl', import.meta.url), JSON.stringify(shown) + '\\n');
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
    if (!gap.tests?.length || !mutation || gap.suggestedTest || !gap.location?.file || tried >= 24) continue;
    const input = readFileSync(inside(root, gap.location.file));
    const subject = { file: gap.location.file, input, digest: createHash('sha256').update(input).digest('hex'), sites: [] };
    const trial = { site: { location: gap.location }, edit: mutation.source?.edit ?? mutation.edit, replacement: mutation.source?.replacement ?? mutation.replacement };
    search: for (const testFile of [...new Set(gap.tests.map(test => test.file))].slice(0, 2)) {
      const text = readFileSync(inside(root, testFile), 'utf8');
      const names = gap.tests.filter(test => test.file === testFile).map(test => test.name);
      const attempt = run.sourceTrials(root, [subject], { ...options, test: [testFile] });
      for (const call of weakCalls(text, testFile, gap.location.file, names).slice(0, 4)) {
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
        if (JSON.stringify(edited) === JSON.stringify(original)) continue;
        const at = edited.findIndex((value, index) => value !== original[index]);
        const differs = at === -1 ? edited.length : at;
        gap.suggestedTest = `expect(${call.text}).toBe(${original[Math.min(differs, original.length - 1)]})`;
        gap.strengthens = { file: testFile, test: call.test, line: call.line, column: call.column, call: call.text,
          original: original[Math.min(differs, original.length - 1)], edited: edited[differs] ?? 'no value' };
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
