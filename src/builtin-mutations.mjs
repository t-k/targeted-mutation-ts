import { mutatePattern } from './regex-mutations.mjs';
import { loadTypeScript } from './typescript-compiler.mjs';

// The built-in mutation set follows the StrykerJS mutators, found here in the TypeScript syntax tree.
// Each mutation names the node it replaces and the enclosing node where a runtime switch can be placed.
const arithmetic = new Map([['+', '-'], ['-', '+'], ['*', '/'], ['/', '*'], ['%', '*']]);
const assignment = new Map([['+=', '-='], ['-=', '+='], ['*=', '/='], ['/=', '*='], ['%=', '*='], ['<<=', '>>='], ['>>=', '<<='],
  ['&=', '|='], ['|=', '&='], ['&&=', '||='], ['||=', '&&='], ['??=', '&&=']]);
const equality = new Map([['<', ['<=', '>=']], ['<=', ['<', '>']], ['>', ['>=', '<=']], ['>=', ['>', '<']],
  ['==', ['!=']], ['!=', ['==']], ['===', ['!==']], ['!==', ['===']]]);
const logical = new Map([['&&', '||'], ['||', '&&'], ['??', '&&']]);
const booleanOperators = new Set(['!=', '!==', '&&', '<', '<=', '==', '===', '>', '>=', '||']);
const methods = new Map([['charAt', null], ['endsWith', 'startsWith'], ['every', 'some'], ['filter', null], ['reverse', null],
  ['slice', null], ['sort', null], ['substr', null], ['substring', null], ['toLocaleLowerCase', 'toLocaleUpperCase'],
  ['toLowerCase', 'toUpperCase'], ['trim', null], ['trimEnd', 'trimStart'], ['min', 'max'], ['setDate', 'setTime'],
  ['setFullYear', 'setMonth'], ['setHours', 'setMinutes'], ['setSeconds', 'setMilliseconds'], ['setUTCDate', 'setTime'],
  ['setUTCFullYear', 'setUTCMonth'], ['setUTCHours', 'setUTCMinutes'], ['setUTCSeconds', 'setUTCMilliseconds']]);
for (const [name, other] of [...methods]) if (other && name !== 'setUTCDate') methods.set(other, name);

export function collectMutations(text, file, { dialect, selected = () => true, ts = loadTypeScript() } = {}) {
  const kind = dialect === 'tsx' ? ts.ScriptKind.TSX : dialect === 'ts' ? ts.ScriptKind.TS : undefined;
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const K = ts.SyntaxKind;
  const starts = tree.getLineStarts();
  const lineOf = offset => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const begin = node => node.getStart(tree);
  const source = node => text.slice(begin(node), node.end);
  const strip = node => {
    while (node && ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  // The parent as a parser without parenthesis nodes sees it, with the child that parent holds.
  const up = node => {
    let child = node;
    while (ts.isParenthesizedExpression(child.parent)) child = child.parent;
    return [child.parent, child];
  };
  const operatorOf = node => ts.isBinaryExpression(node) ? text.slice(begin(node.operatorToken), node.operatorToken.end) : undefined;
  const isAssignment = node => ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= K.FirstAssignment && node.operatorToken.kind <= K.LastAssignment;
  const isLogical = node => ts.isBinaryExpression(node) && logical.has(operatorOf(node));
  const isBinary = node => ts.isBinaryExpression(node) && !isAssignment(node) && !isLogical(node) &&
    node.operatorToken.kind !== K.CommaToken;
  const isString = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
  const isMember = node => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  const merges = unit => '+-*/=&|?!<>%'.includes(text[unit] ?? ' ');
  const swapToken = (node, token, replacement) => text.slice(begin(node), begin(token)) + (merges(begin(token) - 1) ? ' ' : '') +
    replacement + (merges(token.end) ? ' ' : '') + text.slice(token.end, node.end);

  // Array and object literals on the left of an assignment are patterns, not values.
  function isAssignmentTarget(node) {
    const [parent, child] = up(node);
    if (isAssignment(parent) && parent.left === child) return true;
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child) return true;
    if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) return isAssignmentTarget(parent);
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isSpreadAssignment(parent)) {
      return isAssignmentTarget(parent.parent);
    }
    return false;
  }

  function canHoldSwitch(node) {
    const [parent, child] = up(node);
    const chained = (isMember(node) || ts.isCallExpression(node) || ts.isNonNullExpression(node)) && (
      (isMember(parent) && parent.expression === child) || ts.isNonNullExpression(parent) ||
      (ts.isCallExpression(parent) && parent.expression === child));
    return !chained && !ts.isTaggedTemplateExpression(parent) && !ts.isDeleteExpression(parent) &&
      !(isAssignment(parent) && parent.left === child);
  }

  function containsSuperCall(node) {
    let found = false;
    (function look(inner) {
      if (found) return;
      if (ts.isCallExpression(inner) && inner.expression.kind === K.SuperKeyword) found = true;
      else ts.forEachChild(inner, look);
    })(node);
    return found;
  }

  // `// Stryker disable` and `// Stryker restore` comments, read the way StrykerJS reads them: a comment counts
  // when it leads a node, it takes effect from that node on, and `next-line` limits it to mutations that start on
  // that node's line. The newest matching rule decides.
  const directive = /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/;
  const hasDirectives = text.includes('Stryker ');
  let rule = null;
  let directivesReadTo = 0;
  function readDirectives(node) {
    if (!hasDirectives || node.pos < directivesReadTo) return;
    directivesReadTo = begin(node);
    const comments = [...ts.getTrailingCommentRanges(text, node.pos) ?? [], ...ts.getLeadingCommentRanges(text, node.pos) ?? []];
    for (const comment of comments.sort((a, b) => a.pos - b.pos)) {
      const value = text.slice(comment.pos + 2, comment.kind === K.MultiLineCommentTrivia ? comment.end - 2 : comment.end);
      const match = directive.exec(value);
      if (!match) continue;
      const [, type, scope, names, reason] = match;
      rule = { names: names.split(',').map(name => name.trim().toLowerCase()), line: scope ? lineOf(begin(node)) : undefined,
        reason: type === 'disable' ? (reason ?? 'Ignored using a comment').trim() : undefined, previous: rule };
    }
  }
  function ignoreReason(name, line, from = rule) {
    for (let current = from; current; current = current.previous) {
      if ((current.line === undefined || current.line === line) && (current.names.includes(name.toLowerCase()) || current.names.includes('all'))) {
        return current.reason;
      }
    }
    return undefined;
  }

  const mutations = [];
  let live = 0;
  function add(name, node, replacement, placement, extra, from) {
    const start = begin(node);
    for (let line = lineOf(start); line <= lineOf(node.end); line++) if (!selected(line + 1)) return;
    const ignored = ignoreReason(name, lineOf(start), from);
    if (ignored === undefined) live++;
    mutations.push({ name, start, end: node.end, replacement, ...(placement ?? expressionPlacement(node, replacement)), ...extra,
      ...(ignored === undefined ? {} : { ignored }) });
  }

  let statementStart;
  function expressionPlacement(node, replacement) {
    let holder = node;
    while (!canHoldSwitch(holder)) holder = up(holder)[0];
    const start = begin(holder);
    const [parent, child] = up(holder);
    const statement = ts.isExpressionStatement(holder.parent);
    // An arrow function takes its name from the variable, property or field it initializes.
    const names = ts.isArrowFunction(holder) && parent.initializer === child && parent.name && ts.isIdentifier(parent.name) &&
      (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent));
    const named = names ? parent.name.text : undefined;
    return {
      kind: 'expression', placement: [start, holder.end], statement, leading: !statement && start === statementStart, named,
      // Spaces keep the replacement from merging with a neighbouring token.
      mutated: text.slice(start, begin(node)) + ' ' + replacement + ' ' + text.slice(node.end, holder.end),
    };
  }

  function skipped(node) {
    // StrykerJS leaves `x as T` alone: a switch inside it would change what the assertion is checked against.
    return ts.isTypeNode(node) || ts.isAsExpression(node) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) ||
      ts.isDecorator(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) ||
      ts.isTypeParameterDeclaration(node) || node.modifiers?.some(modifier => modifier.kind === K.DeclareKeyword);
  }

  function binary(node) {
    const operator = operatorOf(node);
    const token = node.operatorToken;
    if (isBinary(node)) {
      const left = strip(node.left);
      const leftKind = isBinary(left) ? strip(left.right) : left;
      if (arithmetic.has(operator) && !isString(strip(node.right)) && !isString(leftKind)) {
        add('ArithmeticOperator', node, swapToken(node, token, arithmetic.get(operator)));
      }
      for (const replacement of equality.get(operator) ?? []) {
        add('EqualityOperator', node, swapToken(node, token, replacement), undefined, { operator: [begin(token), replacement] });
      }
    } else if (isLogical(node)) {
      // A different precedence would regroup an unparenthesized operand, so operands keep their own group.
      const operand = side => ts.isBinaryExpression(side) ? `(${source(side)})` : source(side);
      add('LogicalOperator', node, `${operand(node.left)} ${logical.get(operator)} ${operand(node.right)}`);
    } else if (assignment.has(operator) && !(isString(strip(node.right)) && !['&&=', '||=', '??='].includes(operator))) {
      add('AssignmentOperator', node, swapToken(node, token, assignment.get(operator)));
    }
  }

  function condition(node) {
    const [parent, child] = up(node);
    const loopTest = (ts.isForStatement(parent) && parent.condition === child) ||
      ((ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === child);
    if (loopTest) add('ConditionalExpression', node, 'false');
    else if (ts.isIfStatement(parent) && parent.expression === child) {
      add('ConditionalExpression', node, 'true');
      add('ConditionalExpression', node, 'false');
    } else if ((isBinary(node) || isLogical(node)) && booleanOperators.has(operatorOf(node))) {
      const outer = isLogical(parent) ? operatorOf(parent) : undefined;
      if (outer !== '&&') add('ConditionalExpression', node, 'false');
      if (outer !== '||') add('ConditionalExpression', node, 'true');
    }
  }

  function block(node) {
    if (ts.isClassStaticBlockDeclaration(node.parent)) return;
    let directives = 0;
    if (ts.isFunctionLike(node.parent)) {
      while (directives < node.statements.length && ts.isExpressionStatement(node.statements[directives]) &&
        ts.isStringLiteral(node.statements[directives].expression)) directives++;
    }
    if (node.statements.length === directives) return;
    if (ts.isConstructorDeclaration(node.parent) && containsSuperCall(node)) {
      const parameterProperty = node.parent.parameters.some(parameter => parameter.modifiers?.some(modifier =>
        [K.PublicKeyword, K.PrivateKeyword, K.ProtectedKeyword, K.ReadonlyKeyword, K.OverrideKeyword].includes(modifier.kind)));
      const initialized = node.parent.parent.members.some(member => ts.isPropertyDeclaration(member) && member.initializer &&
        !ts.isPrivateIdentifier(member.name));
      if (parameterProperty || initialized) return;
    }
    const bodyStart = directives ? node.statements[directives - 1].end : begin(node) + 1;
    add('BlockStatement', node, '{}', { kind: 'block', placement: [begin(node), node.end], bodyStart, bodyEnd: node.end - 1, mutated: '{}',
      functionBody: ts.isFunctionLike(node.parent) });
  }

  function literal(node) {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const empty = ts.isNoSubstitutionTemplateLiteral(node) && node.end - begin(node) === 2;
      add('StringLiteral', node, empty ? '`Stryker was here!`' : '``');
      return;
    }
    const [parent] = up(node);
    const called = ts.isCallExpression(parent) && (parent.expression.kind === K.ImportKeyword ||
      (ts.isIdentifier(parent.expression) && ['require', 'Symbol'].includes(parent.expression.text)));
    const named = parent.name === node || parent.propertyName === node || ts.isComputedPropertyName(parent) || ts.isJsxAttribute(parent) || ts.isExpressionStatement(parent) ||
      ts.isExternalModuleReference(parent) || ts.isModuleDeclaration(parent) || ts.isExportAssignment(parent);
    if (!called && !named) add('StringLiteral', node, node.text.length ? '""' : '"Stryker was here!"');
    if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'RegExp' &&
        parent.arguments?.[0] === node) {
      const flags = parent.arguments[1] && ts.isStringLiteral(parent.arguments[1]) ? parent.arguments[1].text : undefined;
      for (const pattern of mutatePattern(node.text, flags)) add('Regex', node, JSON.stringify(pattern));
    }
  }

  function call(node) {
    const callee = strip(node.expression);
    if (ts.isIdentifier(callee) && callee.text === 'Array' && !ts.isOptionalChain(node)) {
      const prefix = ts.isNewExpression(node) ? 'new Array' : 'Array';
      add('ArrayDeclaration', node, node.arguments?.length ? `${prefix}()` : `${prefix}([])`);
    }
    if (ts.isNewExpression(node) || !ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return;
    const renamed = methods.get(callee.name.text);
    if (renamed === null) add('MethodExpression', node, source(callee.expression));
    else if (renamed !== undefined) {
      add('MethodExpression', node, text.slice(begin(node), begin(callee.name)) + renamed + text.slice(callee.name.end, node.end));
    }
  }

  function withoutQuestionDot(node) {
    const token = node.questionDotToken;
    const replacement = ts.isPropertyAccessExpression(node) ? '.' : '';
    add('OptionalChaining', node, text.slice(begin(node), begin(token)) + replacement + text.slice(token.end, node.end));
  }

  // A declaration in a case clause is visible in the clauses after it, so such a clause cannot move into a block.
  const lexical = statement => ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
    (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0);

  function statementMutation(node, replacement, mutated, from) {
    add('CallExpression', node, replacement, { kind: 'statement', placement: [begin(node), node.end], mutated }, undefined, from);
  }

  // StrykerJS keeps a statement removal beside inner mutations whenever the statement contains a node it skips
  // (a type annotation, type arguments, `as`, a decorator). The built-in set reproduces that so it stays a superset.
  let skips = 0;
  (function visit(node) {
    readDirectives(node);
    // StrykerJS decides a statement's removal when it enters the statement, before comments inside it are read.
    const ruleOnEntry = rule;
    if (skipped(node)) {
      const parent = node.parent;
      const direct = ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isHeritageClause(parent);
      // A type written directly after `satisfies` or in `<T>x` is traversed there; only its type arguments are skipped.
      if (!ts.isTypeNode(node) || (direct ? source(node).includes('<') : !ts.isTypeNode(parent))) skips++;
      return;
    }
    const skipsBefore = skips;
    if (ts.isExpressionStatement(node)) statementStart = begin(node.expression);
    const before = mutations.length;
    if (ts.isBinaryExpression(node)) binary(node);
    if (ts.isExpression(node) && !ts.isParenthesizedExpression(node)) condition(node);
    if (ts.isArrayLiteralExpression(node) && !isAssignmentTarget(node)) {
      add('ArrayDeclaration', node, node.elements.length ? '[]' : '["Stryker was here"]');
    } else if (ts.isObjectLiteralExpression(node) && node.properties.length && !isAssignmentTarget(node)) {
      add('ObjectLiteral', node, '{}');
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      const body = strip(node.body);
      if (!(ts.isIdentifier(body) && body.text === 'undefined')) add('ArrowFunction', node, '() => undefined');
    } else if (ts.isBlock(node)) block(node);
    else if (node.kind === K.TrueKeyword || node.kind === K.FalseKeyword) {
      add('BooleanLiteral', node, node.kind === K.TrueKeyword ? 'false' : 'true');
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const operand = source(node.operand);
      const prefix = ts.isPrefixUnaryExpression(node);
      if (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken) {
        const swapped = node.operator === K.PlusPlusToken ? '--' : '++';
        add('UpdateOperator', node, prefix ? swapped + operand : operand + swapped);
      } else if (node.operator === K.ExclamationToken) add('BooleanLiteral', node, operand);
      else if (node.operator === K.PlusToken) add('UnaryOperator', node, '- ' + operand);
      else if (node.operator === K.MinusToken) add('UnaryOperator', node, '+ ' + operand);
      else if (node.operator === K.TildeToken) add('UnaryOperator', node, operand);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) literal(node);
    else if (node.kind === K.RegularExpressionLiteral) {
      const raw = source(node);
      const close = raw.lastIndexOf('/');
      // An empty pattern is written as an empty group: `//` would start a comment.
      for (const pattern of mutatePattern(raw.slice(1, close), raw.slice(close + 1))) add('Regex', node, `/${pattern || '(?:)'}/${raw.slice(close + 1)}`);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) call(node);
    if ((isMember(node) || ts.isCallExpression(node)) && node.questionDotToken) withoutQuestionDot(node);
    if (ts.isForStatement(node) && !node.condition && !ts.isLabeledStatement(node.parent)) {
      const semicolon = node.getChildren(tree).find(child => child.kind === K.SemicolonToken);
      const mutated = text.slice(begin(node), semicolon.end) + ' false' + text.slice(semicolon.end, node.end);
      add('ConditionalExpression', node, mutated, { kind: 'statement', placement: [begin(node), node.end], mutated });
    } else if ((ts.isCaseClause(node) || ts.isDefaultClause(node)) && node.statements.length && !node.statements.some(lexical)) {
      const head = text.slice(begin(node), node.statements.pos);
      add('ConditionalExpression', node, head, { kind: 'case', placement: [begin(node), node.end], bodyStart: node.statements.pos, mutated: head });
    }
    const own = mutations.length;
    const liveBefore = live;
    ts.forEachChild(node, visit);
    // Removing a whole call or throw is kept only when nothing inside the statement is mutated on its own.
    // Mutations that a comment ignores do not count, and a removal that is itself ignored is always listed.
    const removalIgnored = () => ignoreReason('CallExpression', lineOf(begin(node)), ruleOnEntry) !== undefined;
    if (own === before && (live === liveBefore || skips !== skipsBefore || removalIgnored())) {
      if (ts.isExpressionStatement(node)) {
        const expression = strip(node.expression);
        if (ts.isCallExpression(expression) && !ts.isOptionalChain(expression) && expression.expression.kind !== K.SuperKeyword) {
          statementMutation(node, ';', ';', ruleOnEntry);
        }
      } else if (ts.isThrowStatement(node) && ts.isNewExpression(strip(node.expression))) statementMutation(node, ';', ';', ruleOnEntry);
    }
  })(tree);

  return mutations.sort((a, b) => a.start - b.start || b.end - a.end);
}
