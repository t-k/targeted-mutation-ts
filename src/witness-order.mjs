import { loadTypeScript } from './typescript-compiler.mjs';

const ts = loadTypeScript();

export function parseSortConstraints(specification) {
  const entries = specification?.sortConstraints ?? [];
  if (!Array.isArray(entries) || entries.some(entry => !entry ||
      ![entry.file, entry.function, entry.before, entry.after].every(value => typeof value === 'string' && value.length) ||
      entry.before === entry.after)) throw new Error('Invalid sortConstraints entry');
  return entries;
}

function member(node, receiver) {
  return ts.isPropertyAccessExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression) &&
    node.expression.text === receiver ? node.name.text : null;
}

export function orderRules(parameters, expression, constraints) {
  if (!ts.isCallExpression(expression) || expression.questionDotToken || expression.arguments.length !== 1) return [];
  const method = expression.expression;
  if (!ts.isPropertyAccessExpression(method) || method.questionDotToken) return [];
  let array = method.expression;
  if (method.name.text === 'sort' && ts.isArrayLiteralExpression(array) && array.elements.length === 1 &&
      ts.isSpreadElement(array.elements[0])) array = array.elements[0].expression;
  else if (method.name.text !== 'toSorted') return [];
  if (!ts.isIdentifier(array)) return [];
  const index = parameters.findIndex(parameter => parameter.name === array.text && parameter.shape.items?.record);
  if (index < 0) return [];
  const fields = parameters[index].shape.items.record;
  if (constraints.some(({ before, after }) => fields[before] !== 'number' || fields[after] !== 'number')) {
    throw new Error('Sort constraints must name numeric fields of the sorted records');
  }
  const comparator = expression.arguments[0];
  if (!ts.isArrowFunction(comparator) || comparator.modifiers?.length || comparator.parameters.length !== 2 ||
      comparator.parameters.some(param => !ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken)) return [];
  const [left, right] = comparator.parameters.map(param => param.name.text);
  const body = comparator.body;
  if (!ts.isBinaryExpression(body) || body.operatorToken.kind !== ts.SyntaxKind.MinusToken) return [];
  const originalKey = member(body.left, left);
  if (originalKey === null || fields[originalKey] !== 'number' || member(body.right, right) !== originalKey) return [];
  return Object.keys(fields).filter(field => fields[field] === 'number' && field !== originalKey).map(alternate => ({
    rule: 'substitute-sort-key/v1', node: body, replacement: `${left}.${alternate} - ${right}.${alternate}`,
    order: true, constraints,
    propose(args, fixture) {
      const rows = args[index];
      const { field, separator } = fixture.projection ?? {};
      if (!Object.hasOwn(fields, field) || field === originalKey || field === alternate || rows.length < 2 || rows.length > 16 ||
          new Set(rows.map(row => String(row[field]))).size !== rows.length ||
          rows.some(row => constraints.some(({ before, after }) => row[before] > row[after]))) return [];
      const output = (key, records) => records.toSorted((a, b) => a[key] - b[key]).map(row => row[field]).join(separator);
      const seed = output(originalKey, rows);
      const proposals = [];
      for (const [at, row] of rows.entries()) {
        for (const other of rows) {
          if (other === row || other[originalKey] === row[originalKey]) continue;
          const next = other[alternate] + Math.sign(other[originalKey] - row[originalKey]);
          if (!Number.isSafeInteger(next) || next === row[alternate]) continue;
          const modified = { ...row, [alternate]: next };
          if (constraints.some(({ before, after }) => modified[before] > modified[after])) continue;
          const changed = rows.with(at, modified);
          const mutant = output(alternate, changed);
          if (mutant !== seed) proposals.push({ path: [index, at, alternate], next, original: seed, mutant });
        }
      }
      return proposals;
    },
  }));
}

export function orderProjection(node) {
  if (!ts.isCallExpression(node) || node.questionDotToken || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) return null;
  const join = node.expression;
  if (!ts.isPropertyAccessExpression(join) || join.questionDotToken || join.name.text !== 'join' || !ts.isCallExpression(join.expression)) return null;
  const map = join.expression;
  if (map.questionDotToken || !ts.isPropertyAccessExpression(map.expression) || map.expression.questionDotToken ||
      map.expression.name.text !== 'map' || map.arguments.length !== 1) return null;
  const callback = map.arguments[0];
  if (!ts.isArrowFunction(callback) || callback.modifiers?.length || callback.parameters.length !== 1 ||
      !ts.isIdentifier(callback.parameters[0].name) || callback.parameters[0].initializer || callback.parameters[0].dotDotDotToken) return null;
  const field = member(callback.body, callback.parameters[0].name.text);
  if (!field) return null;
  return { call: map.expression.expression, field, separator: node.arguments[0].text };
}
