import ts from 'typescript';
import { realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { bare, integer } from './witness-rules.mjs';
import { orderProjection } from './witness-order.mjs';

function literal(node, shape) {
  node = bare(node);
  if (shape === 'string') return ts.isStringLiteral(node) ? { node, value: node.text } : null;
  if (shape === 'number') {
    const value = integer(node);
    return value === undefined ? null : { node, value };
  }
  if ((shape === 'array' || shape.items) && ts.isArrayLiteralExpression(node) && node.elements.length <= 256) {
    const items = node.elements.map(item => literal(item, shape.items ?? 'number'));
    return items.includes(null) ? null : { node, value: items.map(item => item.value), items };
  }
  if ((!Array.isArray(shape) && !shape.record) || !ts.isObjectLiteralExpression(node)) return null;
  const fields = new Map();
  for (const field of node.properties) {
    if (!ts.isPropertyAssignment(field) || !ts.isIdentifier(field.name) || fields.has(field.name.text) ||
        field.name.text === '__proto__') return null;
    const type = shape.record ? Object.hasOwn(shape.record, field.name.text) && shape.record[field.name.text] : 'number';
    if (!type) return null;
    const datum = literal(field.initializer, type);
    if (!datum) return null;
    fields.set(field.name.text, datum);
  }
  if ((shape.record ? Object.keys(shape.record) : shape).some(field => !fields.has(field))) return null;
  return { node, value: Object.fromEntries([...fields].map(([key, datum]) => [key, datum.value])), fields };
}

export function importedBindings(tree) {
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

const moduleExtensions = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

export function importMatches(file, specifier, subject, project) {
  if (!specifier.startsWith('.')) return false;
  const root = project ?? '.';
  const path = resolve(root, dirname(file), specifier);
  const source = resolve(root, subject);
  if (project && statSync(path, { throwIfNoEntry: false })?.isFile()) return realpathSync(path) === source;
  const extension = extname(path);
  const substitutes = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
  const candidates = Object.hasOwn(substitutes, extension)
    ? substitutes[extension].map(ext => path.slice(0, -extension.length) + ext)
    : moduleExtensions.includes(extension) || extension === '.cts' ? []
      : [...moduleExtensions.map(ext => path + ext), ...moduleExtensions.map(ext => resolve(path, 'index' + ext))];
  if (!project) return source === path || candidates.includes(source);
  const existing = new Set(candidates.filter(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile())
    .map(candidate => realpathSync(candidate)));
  return existing.size === 1 && existing.has(source);
}

export function fixtureCalls(tree, file, candidate, subject, project) {
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
    const root = bare(expect.arguments[0]);
    const projection = candidate.order ? orderProjection(root) : null;
    if (candidate.order && !projection) continue;
    const call = projection?.call ?? root;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.arguments.length !== candidate.parameters.length) continue;
    const binding = imports.get(call.expression.text);
    if (binding?.name !== candidate.name || !importMatches(file, binding.module, subject, project)) continue;
    const arguments_ = call.arguments.map((arg, index) => literal(arg, candidate.parameters[index].shape));
    if (arguments_.includes(null)) continue;
    const expected = bare(assertion.arguments[0]);
    const value = expected.kind === ts.SyntaxKind.TrueKeyword ? true
      : expected.kind === ts.SyntaxKind.FalseKeyword ? false : ts.isStringLiteral(expected) ? expected.text : integer(expected);
    if (value === undefined) continue;
    results.push({ file, name: args[0].text, module: binding.module, bindingName: call.expression.text,
      expectEnd: expect.arguments[0].getEnd(), args: arguments_, expected: value, projection,
      suffix: projection ? `.map(row => row.${projection.field}).join(${JSON.stringify(projection.separator)})` : '' });
  }
  return results;
}

export function witnessProposals(candidate, fixtures) {
  return fixtures.flatMap(fixture => {
    const args = fixture.args.map(datum => datum.value);
    return candidate.propose(args, fixture).flatMap(proposal => {
      if (!proposal.append && !Object.is(proposal.original, fixture.expected)) return [];
      const datum = fixture.args[proposal.path[0]];
      const previous = proposal.path.slice(1).reduce((current, item) => current?.items?.[item] ?? current?.fields?.get(item), datum);
      const arguments_ = structuredClone(args);
      const parent = proposal.path.slice(0, -1).reduce((value, index) => value[index], arguments_);
      parent[proposal.path.at(-1)] = proposal.next;
      const node = previous?.node;
      const pos = datum.node.getEnd() - 1;
      const rewrite = proposal.append ? null
        : node ? { start: node.getStart(), end: node.getEnd(), original: node.getText(), replacement: JSON.stringify(proposal.next) }
        : proposal.insert && datum.items.length && !datum.node.elements.hasTrailingComma
          ? { start: pos, end: pos, original: '', replacement: ', ' + proposal.next } : null;
      const distance = previous && typeof proposal.next === 'number' ? Math.abs(previous.value - proposal.next) : previous ? 1 : Infinity;
      return [{ ...proposal, fixture, arguments: arguments_, rewrite, distance }];
    });
  }).sort((a, b) => !!b.rewrite - !!a.rewrite || a.distance - b.distance);
}
