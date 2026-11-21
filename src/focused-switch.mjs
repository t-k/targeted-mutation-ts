import { dirname, posix, sep } from 'node:path';
import { tighteningEdit } from './displacement.mjs';

function runtimeModuleSyntax(node) {
  if (node.type === 'ImportDeclaration') return node.importKind !== 'type' &&
    (!node.specifiers.length || node.specifiers.some(specifier => specifier.importKind !== 'type'));
  if (!['ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration'].includes(node.type) ||
      node.exportKind === 'type') return false;
  if (node.declaration) return !node.declaration.declare && !node.declaration.type.startsWith('TS');
  return !node.specifiers?.length || node.specifiers.some(specifier => specifier.exportKind !== 'type');
}

export function printWithFocusedSwitches(file, starts, bytes, sites, runtime, focused, { types, generate }) {
  const { callExpression, identifier, importDeclaration, importSpecifier, stringLiteral, VISITOR_KEYS } = types;
  const esm = /\.m(?:ts|js)$/.test(file.originFileName) ||
    !/\.c(?:ts|js)$/.test(file.originFileName) &&
      file.root.program.body.some(runtimeModuleSyntax);
  if (!esm) return generate(file.root).code;
  const bySpan = new Map(sites.filter(site => site.operator === '<' || site.operator === '>')
    .map(site => [JSON.stringify([site.left[0], site.right[1], site.operator]), site]));
  if (!bySpan.size) return generate(file.root).code;
  const identifiers = new Set();
  const pending = [file.root];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'Identifier') identifiers.add(node.name);
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const value = node[key];
      if (Array.isArray(value)) pending.push(...value.filter(Boolean));
      else if (value) pending.push(value);
    }
  }
  let alias = '__tmtFocusedCompare';
  while (identifiers.has(alias)) alias += '_';
  const getOffset = position => bytes[starts[position.line - 1] + position.column];
  const matched = new Set();

  function replace(node) {
    if (!node || Object.isFrozen(node)) return node;
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      if (Array.isArray(node[key])) node[key] = node[key].map(replace);
      else if (node[key]) node[key] = replace(node[key]);
    }
    if (node.type !== 'BinaryExpression' || !node.loc) return node;
    const site = bySpan.get(JSON.stringify([getOffset(node.loc.start), getOffset(node.loc.end), node.operator]));
    if (!site) return node;
    matched.add(site);
    return callExpression(identifier(alias), [stringLiteral('tmt:' + site.id), stringLiteral(site.operator), node.left, node.right]);
  }

  replace(file.root);
  if (matched.size) {
    const from = dirname(file.originFileName).split(sep).join('/');
    const path = posix.relative(from, runtime);
    file.root.program.body.unshift(importDeclaration(
      [importSpecifier(identifier(alias), identifier('compareFocused'))], stringLiteral(path.startsWith('../') ? path : './' + path),
    ));
    for (const site of matched) focused.push({ id: 'tmt:' + site.id, site });
  }
  return generate(file.root).code;
}

export function focusedResult(entry, trace, statuses, subjects) {
  const { id, site } = entry;
  const { coveringTests, ...result } = statuses.get(id) ?? { status: 'unevaluated' };
  const rows = trace?.[id] ?? [];
  const source = subjects.get(site.location.file);
  const { edit, replacement, rule, adjustment } = tighteningEdit(source, site);
  const mutant = {
    id, site: site.id, location: site.location, rule, operator: site.operator, edit, replacement,
    original: source.subarray(...edit).toString(), ...result,
    evidence: ['unsupported', 'unevaluated'].includes(result.status) ? undefined : 'reexecuted',
  };
  if (result.status !== 'survived' || !rows.length) return { mutant };
  const example = rows.find(([, lhs, rhs]) => lhs === rhs + adjustment);
  const diagnosis = {
    kind: example ? 'ASSERTION GAP' : 'INPUT GAP', site: site.id, location: site.location,
    mutations: [{ rule, edit, replacement, evidence: mutant.evidence }],
  };
  if (example) {
    diagnosis.example = { operands: example.slice(1), original: true, mutant: false };
    diagnosis.tests = coveringTests?.filter(test => rows.some(([id, lhs, rhs]) => id === test.id && lhs === rhs + adjustment));
  } else {
    const rhs = rows[0][2];
    diagnosis.witness = { operands: [rhs + adjustment, rhs], original: true, mutant: false, expectation: 'hypothetical-operands' };
  }
  return { mutant, diagnosis };
}

const key = (file, start, end) => JSON.stringify([file, start, end]);
const mutantSpan = ({ location: { file, start, end } }) => key(file, start, end);
const siteSpan = ({ site }) => key(site.location.file, site.left[0], site.right[1]);

export function eligibleFocusedSites(mutants, focused) {
  const allowed = new Set(mutants.filter(mutant => mutant.mutatorName === 'EqualityOperator').map(mutantSpan));
  return focused.filter(entry => allowed.has(siteSpan(entry)));
}

export function comparisonReplays(mutants, focused, inputs) {
  const sites = new Map(focused.map(entry => [siteSpan(entry), entry]));
  return mutants.flatMap(mutant => {
    const { file, start, end } = mutant.location;
    const match = sites.get(mutantSpan(mutant));
    if (!match) return [];
    const { site } = match;
    const input = inputs.get(file);
    const boundary = input.subarray(start, site.edit[0]).toString() + site.replacement +
      input.subarray(site.edit[1], end).toString();
    const replay = mutant.mutatorName === 'EqualityOperator' && mutant.replacement === boundary ? site.replacement
      : mutant.mutatorName === 'ConditionalExpression' && mutant.replacement === 'true' ? 'true' : null;
    return replay === null ? [] : [{ id: mutant.id, candidate: match.id, original: site.operator, replacement: replay }];
  });
}
