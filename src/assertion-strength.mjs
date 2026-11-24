import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { posix, sep } from 'node:path';
import { sourceTrialsAsync } from './analysis.mjs';
import { inParallel } from './in-parallel.mjs';
import { loadTypeScript } from './typescript-compiler.mjs';
import { inside } from './vitest.mjs';

// A test can make the very call that tells an edit from the original and still pass, because its assertion does
// not pin the result down: `expect(bucket(3)).not.toBe('none')`, `expect(total(1, 2)).toBeGreaterThan(0)`, a call
// whose result is not looked at. For a finding that names such tests, the call is run where the test makes it,
// once as it is and once with the edit, and where the two values differ the report gives the value to compare with.
const pinning = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toBeNull', 'toBeUndefined', 'toBeNaN', 'toBeCloseTo',
  'toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchObject']);
const extension = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// The calls of the subject's exported functions (named, default, or namespace-imported, optionally awaited) with
// written arguments that a test of the given names makes directly in its body without pinning the result down.
export function weakCalls(text, testFile, subjectFile, testNames, ts = loadTypeScript()) {
  const tree = ts.createSourceFile(testFile, text, ts.ScriptTarget.Latest, true);
  const K = ts.SyntaxKind;
  const subject = subjectFile.split(sep).join('/').replace(extension, '');
  const imported = new Set();
  const namespaces = new Set();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = posix.join(posix.dirname(testFile.split(sep).join('/')), specifier).replace(extension, '');
    if (target !== subject && target + '/index' !== subject) continue;
    if (statement.importClause?.name) imported.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) if (!element.isTypeOnly) imported.add(element.name.text);
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  if (!imported.size && !namespaces.size) return [];
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
  function collectBindingNames(binding, out) {
    if (!binding) return;
    if (ts.isIdentifier(binding)) out.add(binding.text);
    else if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
      for (const element of binding.elements) {
        if (ts.isBindingElement(element)) collectBindingNames(element.name, out);
      }
    }
  }
  function localBindingsIn(container) {
    const names = new Set();
    const record = statement => {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) collectBindingNames(decl.name, names);
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        names.add(statement.name.text);
      }
    };
    if (ts.isBlock(container) || ts.isModuleBlock(container)) {
      for (const statement of container.statements) record(statement);
    } else if (ts.isCaseClause(container) || ts.isDefaultClause(container)) {
      for (const statement of container.statements) record(statement);
    } else if (ts.isFunctionLike(container)) {
      if (container.name && ts.isIdentifier(container.name)) names.add(container.name.text);
      for (const param of container.parameters) collectBindingNames(param.name, names);
    } else if (ts.isCatchClause(container) && container.variableDeclaration) {
      collectBindingNames(container.variableDeclaration.name, names);
    } else if ((ts.isForStatement(container) || ts.isForInStatement(container) || ts.isForOfStatement(container)) &&
        container.initializer && ts.isVariableDeclarationList(container.initializer)) {
      for (const decl of container.initializer.declarations) collectBindingNames(decl.name, names);
    }
    return names;
  }
  function isSubjectCall(node, shadowed) {
    if (!ts.isCallExpression(node) || node.questionDotToken) return false;
    if (ts.isIdentifier(node.expression)) return imported.has(node.expression.text) && !shadowed.has(node.expression.text);
    if (ts.isPropertyAccessExpression(node.expression) && !node.expression.questionDotToken &&
        ts.isIdentifier(node.expression.expression) && ts.isIdentifier(node.expression.name)) {
      return namespaces.has(node.expression.expression.text) && !shadowed.has(node.expression.expression.text);
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
      // The callback is the last argument: options may stand before it.
      if (!ts.isCallExpression(node) || !node.arguments.some(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) continue;
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
    // Options may stand before the callback and a timeout after it.
    if (!ts.isIdentifier(call.expression) || !['it', 'test'].includes(call.expression.text) || call.arguments.indexOf(callback) < 1 ||
        !title || !ts.isStringLiteralLike(title)) return undefined;
    return { title: title.text, suites: suitesOf(call) };
  }
  const found = [];
  // Every test of the file whose name is written out in full, with or without a call to take.
  const spelled = new Set();
  (function visit(node, shadowed) {
    const locals = localBindingsIn(node);
    const scope = locals.size ? new Set([...shadowed, ...locals]) : shadowed;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['it', 'test'].includes(node.expression.text) && node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])) {
      const suites = suitesOf(node);
      if (suites) spelled.add([...suites, node.arguments[0].text].join(' > '));
    }
    if (isSubjectCall(node, scope) && node.arguments.every(written)) {
      let target = node;
      let [parent, child] = up(node);
      if (ts.isAwaitExpression(parent) && parent.expression === child) {
        target = parent;
        [parent, child] = up(target);
      }
      let statement;
      let bound;
      if (ts.isExpressionStatement(parent)) statement = parent;
      else if (ts.isVariableDeclaration(parent) && parent.initializer === child && ts.isVariableStatement(parent.parent.parent)) {
        statement = parent.parent.parent;
        if (ts.isIdentifier(parent.name)) bound = parent.name.text;
      } else if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'expect' &&
          parent.arguments.length === 1 && weakExpectation(parent)) {
        let outer = parent;
        while (!ts.isExpressionStatement(outer)) outer = outer.parent;
        statement = outer;
      }
      const { title, suites } = (statement && testOf(statement)) ?? {};
      const start = target.getStart(tree);
      const call = text.slice(start, target.end);
      if (title !== undefined && !/[\n\r]/.test(call)) {
        const { line, character } = tree.getLineAndCharacterOfPosition(start);
        found.push({ start, end: target.end, text: call, test: title, full: suites && [...suites, title].join(' > '), line: line + 1, column: character + 1,
          ...(bound ? { bound } : {}) });
      }
    }
    ts.forEachChild(node, childNode => visit(childNode, scope));
  })(tree, new Set());
  // A test is named with its suites. Where a suite's title is not written out, the test's own title has to do,
  // for the names that no fully written test of the file has.
  return found.filter(call => (call.full !== undefined ? testNames.includes(call.full)
    : testNames.some(name => !spelled.has(name) && (name === call.test || name.endsWith(' > ' + call.test)))))
    .map(({ full: _full, ...call }) => call);
}

// The test file with one call wrapped so that every value it gives is written beside the file.
// Supports primitives (`toBe`) and plain, acyclic, bounded arrays and objects (`toStrictEqual`) without invoking getters or Proxy traps.
export function recordingCall(text, call, key) {
  const name = `__tmtValue_${key}`;
  // The file system and `node:util` are taken from Node itself, when the file has loaded or else at the first call: a test may
  // replace the module with a mock, or `process` with something else for a while.
  const helper = `
var __tmtFiles_${key};
var __tmtUtil_${key};
try { __tmtFiles_${key} = globalThis.process.getBuiltinModule('node:fs'); } catch (error) { /* taken at the first call */ }
try { __tmtUtil_${key} = globalThis.process.getBuiltinModule('node:util'); } catch (error) { /* taken at the first call */ }
function ${name}(value) {
  if (!__tmtUtil_${key}) {
    try { __tmtUtil_${key} = globalThis.process.getBuiltinModule('node:util'); } catch (error) { /* unavailable */ }
  }
  var isProxy = __tmtUtil_${key} && __tmtUtil_${key}.types && typeof __tmtUtil_${key}.types.isProxy === 'function' ? __tmtUtil_${key}.types.isProxy : null;
  function isPlainObjectProto(proto) {
    if (proto === Object.prototype) return true;
    if (proto === null || isProxy(proto)) return false;
    if (Object.getPrototypeOf(proto) !== null) return false;
    var ctor = Object.getOwnPropertyDescriptor(proto, 'constructor');
    var hasOwn = Object.getOwnPropertyDescriptor(proto, 'hasOwnProperty');
    if (!ctor || !('value' in ctor) || typeof ctor.value !== 'function' || isProxy(ctor.value)) return false;
    var nameDesc = Object.getOwnPropertyDescriptor(ctor.value, 'name');
    if (!nameDesc || !('value' in nameDesc) || nameDesc.value !== 'Object') return false;
    return !!(hasOwn && 'value' in hasOwn && typeof hasOwn.value === 'function');
  }
  function isPlainArrayProto(proto) {
    if (proto === Array.prototype) return true;
    if (proto === null || isProxy(proto) || !Array.isArray(proto)) return false;
    return isPlainObjectProto(Object.getPrototypeOf(proto));
  }
  function fmt(v, depth, seen) {
    var type = typeof v;
    if (v === null || type === 'boolean' || type === 'undefined') return String(v);
    if (type === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (type === 'string') return JSON.stringify(v);
    if (type === 'bigint') return v + 'n';
    if (type !== 'object' || depth >= 4 || !isProxy || isProxy(v)) return null;
    if (seen.indexOf(v) >= 0) return null;
    var nextSeen = seen.concat([v]);
    if (Array.isArray(v)) {
      if (!isPlainArrayProto(Object.getPrototypeOf(v))) return null;
      if (v.length > 20 || Object.getOwnPropertySymbols(v).length > 0 || Object.getOwnPropertyNames(v).length !== v.length + 1) return null;
      var items = [];
      for (var i = 0; i < v.length; i++) {
        var d = Object.getOwnPropertyDescriptor(v, i);
        if (!d || !('value' in d) || !d.enumerable) return null;
        var item = fmt(d.value, depth + 1, nextSeen);
        if (item === null) return null;
        items.push(item);
      }
      return '[' + items.join(', ') + ']';
    }
    if (Object.getOwnPropertySymbols(v).length > 0) return null;
    if (!isPlainObjectProto(Object.getPrototypeOf(v))) return null;
    var keys = Object.keys(v);
    if (keys.length > 20 || Object.getOwnPropertyNames(v).length !== keys.length) return null;
    keys.sort();
    var pairs = [];
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j], desc = Object.getOwnPropertyDescriptor(v, k);
      if (k === '__proto__' || !desc || !('value' in desc)) return null;
      var val = fmt(desc.value, depth + 1, nextSeen);
      if (val === null) return null;
      var label = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      pairs.push(label + ': ' + val);
    }
    return pairs.length ? '{ ' + pairs.join(', ') + ' }' : '{}';
  }
  var shown = null;
  try { shown = fmt(value, 0, []); } catch (error) { shown = null; }
  (__tmtFiles_${key} || (__tmtFiles_${key} = globalThis.process.getBuiltinModule('node:fs'))).appendFileSync(new URL('./.tmt-values-${key}.jsonl', import.meta.url), JSON.stringify(shown) + '\\n');
  return value;
}
`;
  return text.slice(0, call.start) + `${name}(${call.text})` + text.slice(call.end) + helper;
}

const valuesOf = run => (run.collected ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));
const matcherFor = formatted => (formatted.startsWith('[') || formatted.startsWith('{')) ? 'toStrictEqual' : 'toBe';

export async function strengthenAssertions(root, report, options, run = { sourceTrialsAsync }) {
  const runnerFactory = run.sourceTrialsAsync ?? run.sourceTrials;
  const concurrency = options.concurrency ?? Math.max(1, Math.min(8, availableParallelism() - 1));
  const candidates = [];
  for (const gap of report.diagnostics ?? []) {
    const mutation = gap.mutations?.[0];
    if (!gap.tests?.length || !mutation || gap.suggestedTest || !gap.location?.file) continue;
    const input = readFileSync(inside(root, gap.location.file));
    const subject = { file: gap.location.file, input, digest: createHash('sha256').update(input).digest('hex'), sites: [] };
    const trial = { site: { location: gap.location }, edit: mutation.source?.edit ?? mutation.edit, replacement: mutation.source?.replacement ?? mutation.replacement };
    const calls = [];
    for (const testFile of [...new Set(gap.tests.map(test => test.file))].slice(0, 2)) {
      const text = readFileSync(inside(root, testFile), 'utf8');
      const names = gap.tests.filter(test => test.file === testFile).map(test => test.name);
      const attempt = runnerFactory(root, [subject], { ...options, test: [testFile] });
      for (const call of weakCalls(text, testFile, gap.location.file, names)) {
        if (calls.length >= 4) break;
        const id = `${testFile}:${call.start}`;
        calls.push({ id, testFile, text, call, attempt });
      }
      if (calls.length >= 4) break;
    }
    if (calls.length) candidates.push({ gap, trial, calls });
  }
  const originalPromises = new Map();
  let tried = 0;
  // Run candidates in deterministic order while parallelizing safe batches whose worst-case cost fits the remaining budget.
  let cursor = 0;
  while (cursor < candidates.length && tried < 24) {
    const remaining = 24 - tried;
    const batch = [];
    let reserved = 0;
    while (cursor < candidates.length && batch.length < concurrency) {
      const worstCase = candidates[cursor].calls.length;
      if (batch.length > 0 && reserved + worstCase > remaining) break;
      batch.push(candidates[cursor++]);
      reserved += worstCase;
      if (reserved >= remaining) break;
    }
    await inParallel(batch, batch.length, async ({ gap, trial, calls }) => {
      for (const { id, testFile, text, call, attempt } of calls) {
        if (tried >= 24) break;
        let originalPromise = originalPromises.get(id);
        if (!originalPromise) {
          originalPromise = (async () => {
            const key = randomUUID().replaceAll('-', '');
            const collect = posix.join(posix.dirname(testFile.split(sep).join('/')), `.tmt-values-${key}.jsonl`);
            const witness = { rewrite: { file: testFile, content: recordingCall(text, call, key) } };
            return valuesOf(await attempt({ witness, collect }));
          })();
          originalPromises.set(id, originalPromise);
        }
        const original = await originalPromise;
        if (!original?.length || original.includes(null)) continue;
        if (tried >= 24) break;
        tried++;
        const key = randomUUID().replaceAll('-', '');
        const collect = posix.join(posix.dirname(testFile.split(sep).join('/')), `.tmt-values-${key}.jsonl`);
        const witness = { rewrite: { file: testFile, content: recordingCall(text, call, key) } };
        const edited = valuesOf(await attempt({ witness, collect, trial }));
        // The first time the call gives another comparable value with the edit. Where the edit keeps a test from making
        // the call, or returns an unformattable value, nothing is suggested.
        // The values are matched by their order, so the call has to be made as often with the edit as without.
        const at = edited.length === original.length
          ? original.findIndex((value, index) => edited[index] !== null && edited[index] !== value)
          : -1;
        if (at === -1) continue;
        // A result the test keeps is compared where it is kept: calling again may give another value.
        gap.suggestedTest = `expect(${call.bound ?? call.text}).${matcherFor(original[at])}(${original[at]})`;
        gap.strengthens = { file: testFile, test: call.test, line: call.line, column: call.column, call: call.text, original: original[at], edited: edited[at] };
        break;
      }
    });
  }
  return report;
}

// The plain source edits are for the runs above and are not part of the report.
export function withoutSourceEdits(report) {
  for (const gap of report.diagnostics ?? []) for (const mutation of gap.mutations ?? []) delete mutation.source;
  return report;
}
