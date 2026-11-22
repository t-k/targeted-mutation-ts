import { loadTypeScript } from './typescript-compiler.mjs';
import { bare, functionParts, integer } from './witness-rules.mjs';
import { importedBindings, importMatches, registeredTests } from './witness-fixtures.mjs';

const ts = loadTypeScript();

const named = (node, name) => !!node && ts.isIdentifier(node) && (name === undefined || node.text === name);
const property = node => !!node && ts.isPropertyAccessExpression(node) && !node.questionDotToken;
const invoked = node => !!node && ts.isCallExpression(node) && !node.questionDotToken;
const returned = statement => statement && ts.isReturnStatement(statement) ? bare(statement.expression) : null;
const expression = statement => statement && ts.isExpressionStatement(statement) ? bare(statement.expression) : null;
const modifiers = (node, kind) => node.modifiers?.some(modifier => modifier.kind === kind);

function constBinding(statement) {
  if (!statement || !ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1) return null;
  const [declaration] = statement.declarationList.declarations;
  return named(declaration.name) && declaration.initializer
    ? { name: declaration.name.text, value: bare(declaration.initializer) } : null;
}

function construct(node, name, count) {
  return !!node && ts.isNewExpression(node) && named(node.expression, name) && (node.arguments?.length ?? 0) === count;
}

function sourceEdit(tree, node, replacement, start = node.getStart(tree)) {
  const original = tree.text.slice(start, node.getEnd());
  if (/[\r\n\u2028\u2029]/.test(original)) return null;
  const { line } = tree.getLineAndCharacterOfPosition(start);
  return { file: tree.fileName, line: line + 1, start, original, replacement };
}

function endianEndpoint(tree, name, fn) {
  if (!fn.body || !ts.isBlock(fn.body) || fn.parameters.length !== 1 ||
      !named(fn.parameters[0].name) || fn.parameters[0].initializer || fn.parameters[0].dotDotDotToken ||
      fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || fn.asteriskToken) return null;
  const parameter = fn.parameters[0].name.text;
  const body = fn.body.statements;
  const allocation = body.length === 3 ? constBinding(body[0]) : null;
  const producer = !!allocation;
  const call = producer ? expression(body[1]) : body.length === 1 ? returned(body[0]) : null;
  if (!invoked(call) || !property(call.expression)) return null;
  const { expression: view, name: method } = call.expression;
  const bits = new RegExp('^' + (producer ? 'set' : 'get') + 'Uint(16|32)$').exec(method.text)?.[1];
  if (!bits || !construct(view, 'DataView', 1) || call.arguments.length !== (producer ? 3 : 2) || integer(call.arguments[0]) !== 0) return null;
  const buffer = view.arguments[0];
  if (!property(buffer) || buffer.name.text !== 'buffer' || !named(buffer.expression, producer ? allocation.name : parameter)) return null;
  if (producer && (!construct(allocation.value, 'Uint8Array', 1) || integer(allocation.value.arguments[0]) !== Number(bits) / 8 ||
      !named(returned(body[2]), allocation.name) || !named(call.arguments[1], parameter))) return null;
  const flag = call.arguments.at(-1);
  if (![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(flag.kind)) return null;
  const little = flag.kind === ts.SyntaxKind.TrueKeyword;
  const start = method.getStart(tree);
  const edit = sourceEdit(tree, call, tree.text.slice(start, flag.getStart(tree)) +
    String(!little) + tree.text.slice(flag.getEnd(), call.getEnd()), start);
  return edit && { name, kind: producer ? 'encoder' : 'decoder', bits: Number(bits), little, edit };
}

function methodName(node) {
  return ts.isMethodDeclaration(node) && named(node.name) && !node.questionToken && node.body &&
    !node.modifiers?.some(modifier => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.StaticKeyword,
      ts.SyntaxKind.AsyncKeyword, ts.SyntaxKind.AbstractKeyword].includes(modifier.kind)) ? node.name.text : null;
}

function storeEndpoint(tree, node) {
  if (!ts.isClassDeclaration(node) || !node.name || !modifiers(node, ts.SyntaxKind.ExportKeyword) ||
      modifiers(node, ts.SyntaxKind.DefaultKeyword) || node.heritageClauses?.length ||
      node.members.some(member => ts.isConstructorDeclaration(member))) return null;
  const writes = new Map(), reads = new Set();
  for (const method of node.members) {
    const name = methodName(method);
    if (!name || method.parameters.length !== 1 || !named(method.parameters[0].name)) continue;
    const parameter = method.parameters[0].name.text;
    const statements = method.body.statements;
    const read = statements.length === 1 ? returned(statements[0]) : null;
    if (invoked(read) && property(read.expression) && read.expression.name.text === 'get' &&
        property(read.expression.expression) && read.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        read.arguments.length === 1 && named(read.arguments[0], parameter)) reads.add(name);
    const first = statements[0], next = statements[1];
    if (!first || !ts.isIfStatement(first) || first.elseStatement || !next || !ts.isForOfStatement(next) ||
        !named(next.expression, parameter) || returned(first.thenStatement)?.kind !== ts.SyntaxKind.FalseKeyword) continue;
    const check = bare(first.expression);
    if (!invoked(check) || !property(check.expression) || check.expression.name.text !== 'some' ||
        !named(check.expression.expression, parameter) || check.arguments.length !== 1) continue;
    const edit = sourceEdit(tree, first, '');
    if (edit) writes.set(name, edit);
  }
  return writes.size && reads.size ? { file: tree.fileName, name: node.name.text, writes, reads } : null;
}

export function discoverySources(tree, selected) {
  if (tree.parseDiagnostics.length) return { endpoints: [], stores: [] };
  const endpoints = [], stores = [];
  for (const statement of tree.statements) {
    for (const [name, fn] of functionParts(statement)) {
      const endpoint = endianEndpoint(tree, name.text, fn);
      if (endpoint && selected(endpoint.edit.line)) endpoints.push(endpoint);
    }
    const store = storeEndpoint(tree, statement);
    if (store) {
      for (const [name, edit] of store.writes) if (!selected(edit.line)) store.writes.delete(name);
      if (store.writes.size) stores.push(store);
    }
  }
  return { endpoints, stores };
}

function scalar(node) {
  return ts.isStringLiteral(node) ? node.text : integer(node);
}

function assertion(node, imports) {
  if (!invoked(node) || !property(node.expression) || node.expression.name.text !== 'toBe' || node.arguments.length !== 1) return null;
  const expect = node.expression.expression;
  if (!invoked(expect) || !named(expect.expression) || expect.arguments.length !== 1) return null;
  const binding = imports.get(expect.expression.text);
  return binding?.name === 'expect' && binding.module === 'vitest'
    ? { value: bare(expect.arguments[0]), expected: bare(node.arguments[0]) } : null;
}

function testCases(fixtures, baseline, project) {
  const result = [];
  const inventory = new Map();
  for (const test of baseline.tests) {
    const key = JSON.stringify([test.file, test.name]);
    inventory.set(key, inventory.has(key) ? null : test);
  }
  for (const { file, tree } of fixtures) {
    if (tree.parseDiagnostics.length) continue;
    for (const { name, callback, imports } of registeredTests(tree.statements, importedBindings(tree))) {
      if (callback.modifiers?.length) continue;
      const known = inventory.get(JSON.stringify([file, name]));
      if (known?.status !== 'passed' || known.retry || known.repeats || known.concurrent) continue;
      const statements = ts.isBlock(callback.body) ? [...callback.body.statements] : null;
      result.push({ file, title: name, imports, statements, concise: statements ? null : callback.body, project });
    }
  }
  return result;
}

function matchesBinding(test, expression, candidates, file) {
  if (!named(expression)) return null;
  const binding = test.imports.get(expression.text);
  if (!binding) return null;
  const matches = candidates.filter(candidate => binding.name === candidate.name && importMatches(test.file, binding.module, file(candidate), test.project));
  return matches.length === 1 ? matches[0] : null;
}

function pairPlan(test, sources) {
  if (test.statements && (test.statements.length > 2 || !test.statements.length)) return null;
  const observed = assertion(test.concise ?? expression(test.statements?.at(-1)), test.imports);
  const outer = observed?.value;
  if (!invoked(outer) || outer.arguments.length !== 1) return null;
  const variable = test.statements?.length === 2 ? constBinding(test.statements[0]) : null;
  if (test.statements?.length === 2 && (!variable || !named(outer.arguments[0], variable.name))) return null;
  const inner = variable?.value ?? bare(outer.arguments[0]);
  if (!invoked(inner) || inner.arguments.length !== 1) return null;
  const file = endpoint => endpoint.edit.file;
  const decoder = matchesBinding(test, outer.expression, sources.filter(item => item.kind === 'decoder'), file);
  const encoder = matchesBinding(test, inner.expression, sources.filter(item => item.kind === 'encoder'), file);
  const input = integer(inner.arguments[0]);
  if (!encoder || !decoder || encoder.bits !== decoder.bits || encoder.little !== decoder.little ||
      input === undefined || input < 0 || input >= 2 ** encoder.bits || input !== integer(observed.expected)) return null;
  const bytes = new Uint8Array(encoder.bits / 8);
  const data = new DataView(bytes.buffer);
  (encoder.bits === 16 ? data.setUint16 : data.setUint32).call(data, 0, input, encoder.little);
  const expected = bytes.join(',');
  const alternate = [...bytes].reverse().join(',');
  if (alternate === expected) return null;
  return { name: `Automatic byte order through ${encoder.name} and ${decoder.name} in ${test.file} / ${test.title}`,
    requirement: 'The observed round trip passes the producer output to the decoder. The wire assertion preserves the original representation.',
    testFile: test.file, seedTest: test.title, edits: [encoder.edit, decoder.edit],
    observe: `${inner.expression.text}(${inner.arguments[0].getText()}).join(',')`, expected, alternate,
    expectation: 'original', connection: { producer: encoder.name, consumer: decoder.name } };
}

function storeTest(test, stores) {
  const binding = constBinding(test.statements?.[0]);
  if (!binding || !construct(binding.value, undefined, 0)) return null;
  const store = matchesBinding(test, binding.value.expression, stores, candidate => candidate.file);
  return store && { test, store, binding };
}

function instanceCall(node, receiver) {
  return invoked(node) && property(node.expression) && named(node.expression.expression, receiver) ? node : null;
}

function* statePlans(tests, stores) {
  const cases = tests.map(test => storeTest(test, stores)).filter(Boolean);
  for (const { test, store, binding } of cases) {
    if (test.statements.length !== 2) continue;
    const observed = assertion(expression(test.statements[1]), test.imports);
    const operation = instanceCall(observed?.value, binding.name);
    if (!operation || observed.expected.kind !== ts.SyntaxKind.FalseKeyword || operation.arguments.length !== 1) continue;
    const edit = store.writes.get(operation.expression.name.text);
    const entries = operation.arguments[0];
    if (!edit || !ts.isArrayLiteralExpression(entries) || !entries.elements.length || entries.elements.length > 8 ||
        entries.elements.some(entry => !ts.isArrayLiteralExpression(entry) || entry.elements.length !== 2 ||
          !ts.isStringLiteral(entry.elements[0]) || scalar(entry.elements[1]) === undefined)) continue;
    for (const donor of cases) {
      if (donor.store !== store || donor.test.file !== test.file || donor.test === test ||
          !donor.test.statements.slice(1).every(statement => ts.isExpressionStatement(statement))) continue;
      for (const statement of donor.test.statements.slice(1)) {
        const verified = assertion(expression(statement), donor.test.imports);
        const read = instanceCall(verified?.value, donor.binding.name);
        if (!read || read.arguments.length !== 1 || !ts.isStringLiteral(read.arguments[0]) || !store.reads.has(read.expression.name.text)) continue;
        const method = read.expression.name.text;
        const constructor = binding.value.expression.text;
        const instance = constructor === '__tmtInstance' ? '__tmtInstance_' : '__tmtInstance';
        for (const entry of entries.elements) {
          const [keyNode, valueNode] = entry.elements;
          const key = keyNode.text;
          const alternate = scalar(valueNode);
          if (alternate === '' || Object.is(alternate, -0)) continue;
          yield { name: `Automatic batch read ${method}(${JSON.stringify(key)}) in ${test.file} / ${test.title}`,
            requirement: 'Read the key attempted by the rejected batch through a public reader used in a passing test.',
            testFile: test.file, seedTest: test.title, edits: [edit], expected: null, alternate, expectation: 'original',
            borrowedFrom: { file: donor.test.file, test: donor.test.title, method, argument: read.arguments[0].text },
            observation: { method, argument: key },
            observe: `(() => { const ${instance} = new ${constructor}(); ${instance}.${operation.expression.name.text}(${entries.getText()}); return ${instance}.${method}(${JSON.stringify(key)}) ?? null; })()` };
        }
      }
    }
  }
}

export function discoverContracts(fixtures, baseline, sources, { limit = 32, project } = {}) {
  const tests = testCases(fixtures, baseline, project);
  const endpoints = sources.flatMap(source => source.endpoints);
  const stores = sources.flatMap(source => source.stores);
  const plans = new Map();
  for (const drafts of [tests.values().map(test => pairPlan(test, endpoints)), statePlans(tests, stores)]) {
    for (const plan of drafts) {
      if (plan && !plans.has(plan.name)) plans.set(plan.name, plan);
      if (plans.size >= limit) return [...plans.values()];
    }
  }
  return [...plans.values()];
}
