import { loadTypeScript } from './typescript-compiler.mjs';
import { orderRules } from './witness-order.mjs';

const ts = loadTypeScript();

export const parseSource = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

export function bare(node) {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

export function integer(node) {
  node = bare(node);
  if (!node) return undefined;
  const literal = ts.isNumericLiteral(node) ? node
    : ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)
      ? node.operand : null;
  if (!literal) return undefined;
  const value = Number(literal.text) * (literal === node ? 1 : -1);
  return Number.isSafeInteger(value) ? value : undefined;
}

const ordered = new Map([
  [ts.SyntaxKind.LessThanToken, (left, right) => left < right],
  [ts.SyntaxKind.LessThanEqualsToken, (left, right) => left <= right],
  [ts.SyntaxKind.GreaterThanToken, (left, right) => left > right],
  [ts.SyntaxKind.GreaterThanEqualsToken, (left, right) => left >= right],
]);

function parameterShape(type) {
  if (type?.kind === ts.SyntaxKind.StringKeyword) return 'string';
  if (type?.kind === ts.SyntaxKind.NumberKeyword) return 'number';
  if (type && ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) type = type.type;
  if (type && ts.isArrayTypeNode(type) && type.elementType.kind === ts.SyntaxKind.NumberKeyword) return 'array';
  if (type && ts.isArrayTypeNode(type) && ts.isTypeLiteralNode(type.elementType)) {
    const fields = [];
    for (const member of type.elementType.members) {
      if (!ts.isPropertySignature(member) || member.questionToken || !member.name || !ts.isIdentifier(member.name) ||
          member.name.text === '__proto__' || ![ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.StringKeyword].includes(member.type?.kind)) return null;
      fields.push([member.name.text, member.type.kind === ts.SyntaxKind.NumberKeyword ? 'number' : 'string']);
    }
    return fields.length && new Set(fields.map(([name]) => name)).size === fields.length
      ? { items: { record: Object.fromEntries(fields) } } : null;
  }
  if (!type || !ts.isTypeLiteralNode(type)) return null;
  const fields = type.members.filter(member => ts.isPropertySignature(member) && !member.questionToken &&
    member.name && ts.isIdentifier(member.name) && member.type?.kind === ts.SyntaxKind.NumberKeyword)
    .map(member => member.name.text).filter(name => name !== '__proto__');
  return fields.length ? fields : null;
}

export function functionParts(statement) {
  if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return [];
  if (ts.isFunctionDeclaration(statement) && statement.name) return [[statement.name, statement]];
  if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) return [];
  return statement.declarationList.declarations.filter(decl => decl.initializer && ts.isArrowFunction(decl.initializer) &&
    ts.isIdentifier(decl.name)).map(decl => [decl.name, decl.initializer]);
}

function bodyExpression(fn) {
  if (!fn.body || fn.asteriskToken || fn.modifiers?.length && fn.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  if (!ts.isBlock(fn.body)) return bare(fn.body);
  const [statement] = fn.body.statements;
  return fn.body.statements.length === 1 && ts.isReturnStatement(statement) ? bare(statement.expression) : null;
}

function reference(node, parameters) {
  node = bare(node);
  if (ts.isIdentifier(node)) {
    const index = parameters.findIndex(param => param.name === node.text);
    return parameters[index]?.shape === 'number' ? { index, node, text: node.text } : null;
  }
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression)) {
    const index = parameters.findIndex(param => param.name === node.expression.text);
    const field = node.name.text;
    const shape = parameters[index]?.shape;
    return Array.isArray(shape) && shape.includes(field) ? { index, field, node, text: node.getText() } : null;
  }
  const value = integer(node);
  return value === undefined ? null : { value };
}

const read = (args, ref) => ref.index === undefined ? ref.value
  : ref.field === undefined ? args[ref.index] : args[ref.index][ref.field];

function comparisonRules(parameters, expression) {
  const evaluate = ordered.get(expression.operatorToken.kind);
  if (!evaluate) return [];
  const refs = [reference(expression.left, parameters), reference(expression.right, parameters)];
  if (refs.includes(null)) return [];
  return refs.flatMap((ref, side) => {
    if (!ref.node) return [];
    const other = refs[1 - side];
    const alternatives = ref.field === undefined
      ? parameters.flatMap((parameter, index) => index !== ref.index && parameter.shape === 'number'
        ? [{ index, text: parameter.name }] : [])
      : parameters[ref.index].shape.filter(field => field !== ref.field)
        .map(field => ({ index: ref.index, field, text: parameters[ref.index].name + '.' + field }));
    return alternatives.filter(alternate => alternate.index !== other.index || alternate.field !== other.field).map(alternate => ({
      rule: 'substitute-number/v1', node: ref.node, replacement: alternate.text,
      propose(args) {
        const value = read(args, other);
        const original = evaluate(...refs.map(operand => read(args, operand)));
        return [value - 1, value, value + 1].filter(Number.isSafeInteger).flatMap(next => {
          const mutated = refs.map((operand, index) => index === side ? next : read(args, operand));
          const mutant = evaluate(...mutated);
          return original === mutant || next === read(args, alternate) ? [] : [{
            path: alternate.field === undefined ? [alternate.index] : [alternate.index, alternate.field],
            next, original, mutant,
          }];
        });
      },
    }));
  });
}

function indexRule(parameters, call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || call.questionDotToken ||
      callee.name.text !== 'indexOf' || !ts.isIdentifier(callee.expression) || call.arguments.length !== 1 ||
      !ts.isIdentifier(call.arguments[0])) return null;
  const list = parameters.findIndex(parameter => parameter.name === callee.expression.text && parameter.shape === 'array');
  const target = parameters.findIndex(parameter => parameter.name === call.arguments[0].text && parameter.shape === 'number');
  if (list < 0 || target < 0) return null;
  return {
    rule: 'first-to-last-index/v1', node: callee.name, replacement: 'lastIndexOf',
    outcome(args, expected) {
      const index = args[list].indexOf(args[target]);
      if (index !== expected) return null;
      return index < 0 ? 'missing' : 'found';
    },
    propose(args) {
      const items = args[list], key = args[target];
      const original = items.indexOf(key);
      if (original < 0 || items.lastIndexOf(key) !== original) return [];
      const index = original + 1;
      return [{ path: [list, index], next: key, original, mutant: index, insert: index === items.length }];
    },
  };
}

function maskRule(parameters, expression) {
  const masked = bare(expression.left);
  if (expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken || integer(expression.right) !== 0 ||
      !ts.isBinaryExpression(masked) || masked.operatorToken.kind !== ts.SyntaxKind.AmpersandToken) return null;
  const flags = reference(masked.left, parameters), mask = reference(masked.right, parameters);
  if (!flags?.node || !mask?.node || flags.field !== undefined || mask.field !== undefined || flags.index === mask.index) return null;
  return {
    rule: 'any-to-all-flags/v1', node: expression, replacement: `(${masked.getText()}) === ${mask.text}`,
    propose(args) {
      const f = read(args, flags), m = read(args, mask);
      if (f < 0 || f > 0x7fffffff || m <= 0 || m > 0x7fffffff || (f & m) !== m) return [];
      const bit = m & -m;
      if (bit !== m) return [{ path: [flags.index], next: f ^ bit, original: true, mutant: false }];
      for (let spare = 1; spare <= 0x40000000; spare *= 2) {
        if ((spare & f) === 0) return [{ path: [mask.index], next: m | spare, original: true, mutant: false }];
      }
      return [];
    },
  };
}

function methodCall(node, method, count) {
  return ts.isCallExpression(node) && !node.questionDotToken && node.arguments.length === count &&
    ts.isPropertyAccessExpression(node.expression) && !node.expression.questionDotToken && node.expression.name.text === method;
}

function sumRule(parameters, expression) {
  if (!methodCall(expression, 'reduce', 2) || integer(expression.arguments[1]) !== 0) return null;
  const reduce = expression.arguments[0], slice = expression.expression.expression;
  if (!methodCall(slice, 'slice', 2) || integer(slice.arguments[0]) !== 0 ||
      !ts.isIdentifier(slice.expression.expression) || !ts.isArrowFunction(reduce) || reduce.modifiers?.length ||
      reduce.parameters.length !== 2 || reduce.parameters.some(param => !ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken)) return null;
  const add = bodyExpression(reduce);
  if (!add || !ts.isBinaryExpression(add) || add.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
      !ts.isIdentifier(add.left) || !ts.isIdentifier(add.right) ||
      add.left.text !== reduce.parameters[0].name.text || add.right.text !== reduce.parameters[1].name.text) return null;
  const list = parameters.findIndex(param => param.shape === 'array' && param.name === slice.expression.expression.text);
  const count = reference(slice.arguments[1], parameters);
  if (list < 0 || !count?.node || count.field !== undefined) return null;
  return {
    rule: 'include-next-element/v1', node: count.node, replacement: `${count.text} + 1`,
    propose(args) {
      const n = read(args, count), items = args[list];
      if (n < 0 || n >= items.length || items[n] !== 0) return [];
      const original = items.slice(0, n).reduce((sum, value) => sum + value, 0);
      return Number.isSafeInteger(original) && Number.isSafeInteger(original + 1)
        ? [{ path: [list, n], next: 1, original, mutant: original + 1 }] : [];
    },
  };
}

function lengthRule(parameters, expression) {
  if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken || expression.name.text !== 'length') return null;
  const receiver = expression.expression;
  let points = false;
  let parameter = receiver;
  if (ts.isCallExpression(receiver) && !receiver.questionDotToken && receiver.arguments.length === 1 &&
      ts.isPropertyAccessExpression(receiver.expression) && !receiver.expression.questionDotToken &&
      ts.isIdentifier(receiver.expression.expression) && receiver.expression.expression.text === 'Array' &&
      receiver.expression.name.text === 'from') {
    points = true;
    parameter = receiver.arguments[0];
  }
  if (!ts.isIdentifier(parameter)) return null;
  const index = parameters.findIndex(param => param.name === parameter.text && param.shape === 'string');
  if (index < 0) return null;
  const { text } = parameter;
  return {
    rule: points ? 'code-point-to-utf8-length/v1' : 'code-unit-to-code-point-length/v1',
    node: expression,
    replacement: points ? `Buffer.byteLength(${text}, 'utf8')` : `Array.from(${text}).length`,
    propose(args, fixture) {
      const value = args[index];
      if (!/^[\x00-\x7f]*$/.test(value) || fixture.expected !== value.length) return [];
      const next = (points ? 'é' : '😀') + value.slice(1);
      const codePoints = [...next].length;
      const original = points ? codePoints : next.length;
      return [{ path: [index], next, original, mutant: points ? Buffer.byteLength(next) : codePoints,
        append: original !== fixture.expected }];
    },
  };
}

export function discoverWitnessRules(tree, sortConstraints = []) {
  if (tree.parseDiagnostics.length) return [];
  const javascript = tree.scriptKind === ts.ScriptKind.JS || tree.scriptKind === ts.ScriptKind.JSX;
  const result = [];
  for (const statement of tree.statements) {
    for (const [name, fn] of functionParts(statement)) {
      if (fn.parameters.some(param => !ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken || param.questionToken)) continue;
      const expression = bodyExpression(fn);
      if (!expression) continue;
      const index = javascript && methodCall(expression, 'indexOf', 1) &&
        ts.isIdentifier(expression.expression.expression) && ts.isIdentifier(expression.arguments[0])
        ? new Map([[expression.expression.expression.text, 'array'], [expression.arguments[0].text, 'number']])
        : null;
      const parameters = fn.parameters.map(param => {
        const name = param.name.text;
        const type = param.type ?? (javascript ? ts.getJSDocType(param) : undefined);
        return { name, shape: type ? parameterShape(type) : index?.get(name) };
      });
      if (parameters.some(param => !param.shape)) continue;
      const rules = ts.isBinaryExpression(expression) ? [...comparisonRules(parameters, expression), maskRule(parameters, expression)].filter(Boolean)
        : ts.isCallExpression(expression) ? [indexRule(parameters, expression), sumRule(parameters, expression),
          ...orderRules(parameters, expression, sortConstraints.filter(entry => entry.function === name.text))].filter(Boolean)
          : [lengthRule(parameters, expression)].filter(Boolean);
      for (const rule of rules) result.push({ ...rule, name: name.text, parameters });
    }
  }
  return result;
}
