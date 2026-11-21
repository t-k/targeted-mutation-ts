import ts from 'typescript';
import { dirname, relative, resolve, sep } from 'node:path';
import { bare, integer } from './witness-rules.mjs';

function literal(node, shape) {
  node = bare(node);
  if (shape === 'number') {
    const value = integer(node);
    return value === undefined ? null : { node, value };
  }
  if (shape === 'array' && ts.isArrayLiteralExpression(node) && node.elements.length <= 256) {
    const items = node.elements.map(item => literal(item, 'number'));
    return items.includes(null) ? null : { node, value: items.map(item => item.value), items };
  }
  if (!Array.isArray(shape) || !ts.isObjectLiteralExpression(node)) return null;
  const fields = new Map();
  for (const field of node.properties) {
    if (!ts.isPropertyAssignment(field) || !ts.isIdentifier(field.name) || fields.has(field.name.text) ||
        field.name.text === '__proto__') return null;
    const datum = literal(field.initializer, 'number');
    if (!datum) return null;
    fields.set(field.name.text, datum);
  }
  if (shape.some(field => !fields.has(field))) return null;
  return { node, value: Object.fromEntries([...fields].map(([key, datum]) => [key, datum.value])), fields };
}

function importedBindings(tree) {
  const names = new Map();
  for (const declaration of tree.statements) {
    if (!ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier) ||
        declaration.importClause?.isTypeOnly) continue;
    const bindings = declaration.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const item of bindings.elements) {
      if (item.isTypeOnly) continue;
      names.set(item.name.text, { name: (item.propertyName ?? item.name).text, module: declaration.moduleSpecifier.text });
    }
  }
  return names;
}

export function fixtureCalls(tree, file, candidate, subject) {
  if (tree.parseDiagnostics.length) return [];
  const imports = importedBindings(tree);
  const results = [];
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const { expression, arguments: args } = statement.expression;
    const registration = ts.isIdentifier(expression) && imports.get(expression.text);
    if (registration?.module !== 'vitest' || !['it', 'test'].includes(registration.name) || args.length !== 2 ||
        !ts.isStringLiteral(args[0]) || !ts.isArrowFunction(args[1]) || args[1].parameters.length) continue;
    const body = args[1].body;
    const assertion = ts.isBlock(body) ? body.statements.length === 1 && ts.isExpressionStatement(body.statements[0])
      ? body.statements[0].expression : null : body;
    if (!assertion || !ts.isCallExpression(assertion) || assertion.arguments.length !== 1 ||
        !ts.isPropertyAccessExpression(assertion.expression) || assertion.expression.name.text !== 'toBe') continue;
    const expect = assertion.expression.expression;
    if (!ts.isCallExpression(expect) || !ts.isIdentifier(expect.expression) || expect.arguments.length !== 1) continue;
    const match = imports.get(expect.expression.text);
    if (match?.module !== 'vitest' || match.name !== 'expect') continue;
    const call = bare(expect.arguments[0]);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.arguments.length !== candidate.parameters.length) continue;
    const binding = imports.get(call.expression.text);
    if (binding?.name !== candidate.name || !binding.module.startsWith('.')) continue;
    const imported = relative('.', resolve(dirname(file), binding.module)).split(sep).join('/');
    const sourcePath = subject.split(sep).join('/');
    if (sourcePath !== imported && sourcePath !== imported + '.ts' && sourcePath !== imported.replace(/\.js$/, '.ts')) continue;
    const arguments_ = call.arguments.map((arg, index) => literal(arg, candidate.parameters[index].shape));
    if (arguments_.includes(null)) continue;
    const expected = bare(assertion.arguments[0]);
    const value = expected.kind === ts.SyntaxKind.TrueKeyword ? true
      : expected.kind === ts.SyntaxKind.FalseKeyword ? false : integer(expected);
    if (value === undefined) continue;
    results.push({ file, name: args[0].text, module: binding.module, bindingName: call.expression.text, expectEnd: expect.arguments[0].getEnd(), args: arguments_, expected: value });
  }
  return results;
}

export function witnessProposals(candidate, fixtures) {
  return fixtures.flatMap(fixture => {
    const args = fixture.args.map(datum => datum.value);
    return candidate.propose(args).flatMap(proposal => {
      if (!Object.is(proposal.original, fixture.expected)) return [];
      const [index, child] = proposal.path;
      const datum = fixture.args[index];
      const previous = child === undefined ? datum : datum.items?.[child] ?? datum.fields?.get(child);
      const arguments_ = structuredClone(args);
      if (child === undefined) arguments_[index] = proposal.next;
      else arguments_[index][child] = proposal.next;
      const node = previous?.node;
      const pos = datum.node.getEnd() - 1;
      const rewrite = node ? { start: node.getStart(), end: node.getEnd(), original: node.getText(), replacement: String(proposal.next) }
        : proposal.insert && datum.items.length && !datum.node.elements.hasTrailingComma
          ? { start: pos, end: pos, original: '', replacement: ', ' + proposal.next } : null;
      const distance = previous ? Math.abs(previous.value - proposal.next) : Infinity;
      return [{ ...proposal, fixture, arguments: arguments_, rewrite, distance }];
    });
  }).sort((a, b) => !!b.rewrite - !!a.rewrite || a.distance - b.distance);
}
