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

function roundingRule(parameters, expression) {
  if (!ts.isCallExpression(expression) || expression.questionDotToken || expression.arguments.length !== 1 ||
      !ts.isPropertyAccessExpression(expression.expression) || expression.expression.questionDotToken ||
      !ts.isIdentifier(expression.expression.expression) || expression.expression.expression.text !== 'Math') return null;
  const method = expression.expression.name.text;
  if (method !== 'floor' && method !== 'trunc') return null;
  const div = bare(expression.arguments[0]);
  if (!div || !ts.isBinaryExpression(div) || div.operatorToken.kind !== ts.SyntaxKind.SlashToken) return null;
  const divisor = integer(div.right);
  if (divisor === undefined || divisor < 2) return null;
  const mul = bare(div.left);
  if (!mul || !ts.isBinaryExpression(mul) || mul.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return null;
  const first = reference(mul.left, parameters);
  const second = reference(mul.right, parameters);
  if (!first?.node || !second?.node || first.field !== undefined || second.field !== undefined || first.index === second.index) return null;
  const roundFn = method === 'floor' ? Math.floor : Math.trunc;
  return {
    rule: 'divide-before-multiply/v1',
    node: expression,
    replacement: `Math.${method}(${first.text} / ${divisor}) * ${second.text}`,
    propose(args) {
      const a0 = read(args, first);
      const b0 = read(args, second);
      if (!Number.isSafeInteger(a0) || !Number.isSafeInteger(b0) || !Number.isSafeInteger(a0 * b0)) return [];
      if (roundFn((a0 * b0) / divisor) !== roundFn(a0 / divisor) * b0) return [];
      const candidates = new Set();
      const limit = Math.min(divisor - 1, 64);
      for (let delta = 1; delta <= limit; delta++) candidates.add(delta);
      if (b0 !== 0) {
        const step = Math.ceil(divisor / Math.abs(b0));
        if (step >= 1 && step < divisor) candidates.add(step);
        if (step + 1 >= 1 && step + 1 < divisor) candidates.add(step + 1);
      }
      for (const delta of [...candidates].sort((x, y) => x - y)) {
        const a1 = a0 + delta;
        if (!Number.isSafeInteger(a1) || !Number.isSafeInteger(a1 * b0)) continue;
        const original = roundFn((a1 * b0) / divisor);
        const mutant = roundFn(a1 / divisor) * b0;
        if (Number.isSafeInteger(original) && Number.isSafeInteger(mutant) && original !== mutant) {
          return [{ path: [first.index], next: a1, original, mutant, append: true }];
        }
      }
      return [];
    },
  };
}

function templateKeyRules(parameters, expression) {
  if (!ts.isTemplateExpression(expression) || expression.templateSpans.length < 2) return [];
  const parts = [];
  for (const span of expression.templateSpans) {
    const expr = bare(span.expression);
    if (!ts.isIdentifier(expr)) return [];
    const index = parameters.findIndex(p => p.name === expr.text && (p.shape === 'string' || p.shape === 'number'));
    if (index < 0) return [];
    parts.push({ index, shape: parameters[index].shape, literalText: span.literal.text });
  }
  const headText = expression.head.text;
  const render = (args, omitPos) => {
    let out = headText;
    for (let i = 0; i < parts.length; i++) {
      if (i !== omitPos) out += String(args[parts[i].index]);
      out += parts[i].literalText;
    }
    return out;
  };
  return parts.map((part, omitPos) => {
    const span = expression.templateSpans[omitPos];
    // Replace `${param}` with empty string inside the template literal by editing the whole template.
    let replacement = '`' + expression.head.rawText;
    for (let i = 0; i < expression.templateSpans.length; i++) {
      const s = expression.templateSpans[i];
      if (i !== omitPos) replacement += '${' + s.expression.getText() + '}';
      replacement += s.literal.rawText;
    }
    replacement += '`';
    return {
      rule: 'composite-key-omit/v1',
      node: expression,
      replacement,
      propose(args) {
        const current = args[part.index];
        const next = part.shape === 'string' ? `${current}_alt` : current + 1;
        if (part.shape === 'number' && !Number.isSafeInteger(next)) return [];
        const mutatedArgs = args.map((v, idx) => (idx === part.index ? next : v));
        const original = render(mutatedArgs, -1);
        const mutant = render(mutatedArgs, omitPos);
        return original === mutant ? [] : [{ path: [part.index], next, original, mutant, append: true }];
      },
    };
  });
}

function joinKeyRules(parameters, expression) {
  if (!methodCall(expression, 'join', 1) || !ts.isStringLiteral(expression.arguments[0])) return [];
  const arrayExpr = bare(expression.expression.expression);
  if (!ts.isArrayLiteralExpression(arrayExpr) || arrayExpr.elements.length < 2) return [];
  const sepText = expression.arguments[0].text;
  const parts = [];
  for (const el of arrayExpr.elements) {
    const inner = bare(el);
    if (!ts.isIdentifier(inner)) return [];
    const index = parameters.findIndex(p => p.name === inner.text && (p.shape === 'string' || p.shape === 'number'));
    if (index < 0) return [];
    parts.push({ index, shape: parameters[index].shape, text: inner.text });
  }
  return parts.map((part, omitPos) => {
    const remaining = parts.filter((_, i) => i !== omitPos).map(p => p.text).join(', ');
    const replacement = `[${remaining}].join(${expression.arguments[0].getText()})`;
    return {
      rule: 'composite-key-omit/v1',
      node: expression,
      replacement,
      propose(args) {
        const current = args[part.index];
        const next = part.shape === 'string' ? `${current}_alt` : current + 1;
        if (part.shape === 'number' && !Number.isSafeInteger(next)) return [];
        const mutatedArgs = args.map((v, idx) => (idx === part.index ? next : v));
        const original = parts.map(p => String(mutatedArgs[p.index])).join(sepText);
        const mutant = parts.filter((_, i) => i !== omitPos).map(p => String(mutatedArgs[p.index])).join(sepText);
        return original === mutant ? [] : [{ path: [part.index], next, original, mutant, append: true }];
      },
    };
  });
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
          roundingRule(parameters, expression), ...joinKeyRules(parameters, expression),
          ...orderRules(parameters, expression, sortConstraints.filter(entry => entry.function === name.text))].filter(Boolean)
          : ts.isTemplateExpression(expression) ? templateKeyRules(parameters, expression)
            : [lengthRule(parameters, expression)].filter(Boolean);
      for (const rule of rules) result.push({ ...rule, name: name.text, parameters });
    }
  }
  return result;
}
