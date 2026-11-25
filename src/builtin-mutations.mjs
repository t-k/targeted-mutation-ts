import { mutatePattern } from './regex-mutations.mjs';
import { tmtIgnoreLines } from './baseline.mjs';
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

// Stands for the call that reads the active shift. The renderer puts the helper's name in its place.
export const shiftPlaceholder = '\u0000shift\u0000';

// The targeted rules: edits whose behaviour on the values a test passes can be told from the operands alone, so a
// recording run knows in which tests an edit would have gone another way. `ignored-operand` drops what one side
// of a logical operator decides and still evaluates it.
export const targetedRules = {
  constant: 'equality-constant/v1', nullish: 'nullish-equality/v1', ignored: 'ignored-operand/v1', fallback: 'nullish-fallback/v1',
  arithmetic: 'arithmetic-swap/v1', extreme: 'extreme-swap/v1', rounding: 'rounding-swap/v1', ends: 'sequence-end/v1',
  order: 'sort-order/v1', awaited: 'await-dropped/v1', copy: 'copy-dropped/v1',
  spreadDrop: 'spread-property-drop/v1', prefixSubstring: 'prefix-to-substring/v1', replaceMultiplicity: 'replace-multiplicity/v1',
  clampBound: 'clamp-bound/v1', literalSetPrune: 'literal-set-prune/v1', mergePrecedence: 'merge-precedence/v1',
  quantifierSwap: 'quantifier-swap/v1', regexAnchor: 'regex-anchor-slack/v1', cleanupDropped: 'cleanup-dropped/v1',
};
// Two other operators for each arithmetic one: its inverse, and the one the same operands most often agree on.
// (Maps: a method may be named like a property every object has.)
const arithmeticSwaps = new Map([['+', ['-', '*']], ['-', ['+', '/']], ['*', ['/', '+']], ['/', ['*', '%']], ['%', ['/', '+']]]);
const roundingSwaps = new Map([['floor', ['ceil', 'round', 'trunc']], ['ceil', ['floor', 'round']], ['round', ['floor', 'ceil']], ['trunc', ['floor', 'round']]]);
const endSwaps = new Map([['find', 'findLast'], ['findLast', 'find'], ['findIndex', 'findLastIndex'], ['findLastIndex', 'findIndex'],
  ['indexOf', 'lastIndexOf'], ['lastIndexOf', 'indexOf']]);
const ignoredValue = { '&&': 'true', '||': 'false', '??': 'undefined' };

export function collectMutations(text, file, { dialect, selected = () => true, shifts = false, targeted = false, excludeRules = [], typeEquivalence = null, ts = loadTypeScript() } = {}) {
  const excludedRuleSet = new Set((excludeRules ?? []).map(r => String(r).trim()).filter(Boolean));
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
  const tmtIgnored = tmtIgnoreLines(text, ts);
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
    if (tmtIgnored.has(line)) return tmtIgnored.get(line);
    for (let current = from; current; current = current.previous) {
      if ((current.line === undefined || current.line === line) && (current.names.includes(name.toLowerCase()) || current.names.includes('all'))) {
        return current.reason;
      }
    }
    return undefined;
  }

  const mutations = [];
  let live = 0;
  // Code that a probe does not evaluate again (the index in `list[list.length - 1]`) holds no edit of its own.
  const unprobed = [];
  function add(name, node, replacement, placement, extra, from) {
    if (excludedRuleSet.has(name)) return;
    const start = begin(node);
    if (extra?.targeted && unprobed.some(([from, to]) => from <= start && node.end <= to)) return;
    for (let line = lineOf(start); line <= lineOf(node.end); line++) if (!selected(line + 1)) return;
    const ignored = ignoreReason(name, lineOf(start), from);
    // A shift switch is not a mutation of the set, so it does not count for the rules about statement removals.
    if (ignored === undefined && extra?.shift === undefined && extra?.targeted === undefined) live++;
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
      // The focused analysis moves a comparison's right side by an integer it only knows after a recorded run:
      // another threshold, or one step tighter. One switch per comparison takes that amount at run time.
      if (shifts && ['<', '<=', '>', '>='].includes(operator)) {
        add('ComparisonShift', node, `${text.slice(begin(node), token.end)} ((${source(node.right)}) + ${shiftPlaceholder})`, undefined, { shift: begin(token) });
      }
    } else if (isLogical(node)) {
      // A different precedence would regroup an unparenthesized operand, so operands keep their own group.
      const operand = side => ts.isBinaryExpression(side) ? `(${source(side)})` : source(side);
      add('LogicalOperator', node, `${operand(node.left)} ${logical.get(operator)} ${operand(node.right)}`);
    } else if (assignment.has(operator) && !(isString(strip(node.right)) && !['&&=', '||=', '??='].includes(operator))) {
      add('AssignmentOperator', node, swapToken(node, token, assignment.get(operator)));
    }
  }

  // Whether only the truth of the expression's value is used: as a condition, under `!`, inside a
  // single-argument global `Boolean(...)` call, or as an operand of a logical operator used that way.
  function onlyTruthUsed(node) {
    for (let [parent, child] = up(node); ; [parent, child] = up(parent)) {
      if (ts.isPrefixUnaryExpression(parent) && parent.operator === K.ExclamationToken) return true;
      if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === child) return true;
      if ((ts.isForStatement(parent) || ts.isConditionalExpression(parent)) && parent.condition === child) return true;
      if (ts.isCallExpression(parent) && !ts.isOptionalChain(parent) &&
          parent.arguments.length === 1 && parent.arguments[0] === child) {
        const callee = strip(parent.expression);
        if (ts.isIdentifier(callee) && callee.text === 'Boolean' && !ownBoolean()) return true;
      }
      if (!isLogical(parent) || operatorOf(parent) === '??') return false;
    }
  }

  // A right operand that awaits or yields cannot be evaluated inside the function a probe wraps it in, and a
  // direct eval there would declare its variables in that function.
  function staysInPlace(node) {
    let found = false;
    (function look(inner) {
      if (found) return;
      if (ts.isAwaitExpression(inner) || ts.isYieldExpression(inner) ||
          (ts.isCallExpression(inner) && ts.isIdentifier(strip(inner.expression)) && strip(inner.expression).text === 'eval')) found = true;
      else if (!ts.isFunctionLike(inner)) ts.forEachChild(inner, look);
      // A computed name belongs to the code around its method.
      else if (inner.name && ts.isComputedPropertyName(inner.name)) look(inner.name);
    })(node);
    return found;
  }

  // A written value: evaluating it has no effect and always gives the same.
  function written(node) {
    const inner = strip(node);
    return ts.isNumericLiteral(inner) || ts.isBigIntLiteral(inner) || ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ||
      [K.TrueKeyword, K.FalseKeyword, K.NullKeyword].includes(inner.kind) || (ts.isIdentifier(inner) && inner.text === 'undefined') ||
      (ts.isPrefixUnaryExpression(inner) && inner.operator === K.MinusToken && (ts.isNumericLiteral(inner.operand) || ts.isBigIntLiteral(inner.operand)));
  }
  const writtenFalsy = node => {
    const inner = strip(node);
    const number = ts.isPrefixUnaryExpression(inner) ? inner.operand : inner;
    return written(node) && (['false', 'null', 'undefined'].includes(source(inner)) ||
      (ts.isNumericLiteral(number) && Number(number.text) === 0) || (ts.isBigIntLiteral(number) && /^0[box]?0*n$/i.test(number.text)) ||
      ((ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) && inner.text === ''));
  };

  const falsyLiteralLabel = node => {
    const inner = strip(node);
    const number = ts.isPrefixUnaryExpression(inner) && inner.operator === K.MinusToken ? inner.operand : inner;
    if (inner.kind === K.FalseKeyword) return 'false';
    if (ts.isIdentifier(inner) && inner.text === 'NaN') return 'NaN';
    if (ts.isNumericLiteral(number) && Number(number.text) === 0) return '0';
    if (ts.isBigIntLiteral(number) && /^0[box]?0*n$/i.test(number.text)) return '0n';
    if ((ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) && inner.text === '') return "''";
    return undefined;
  };

  const nullishLiteral = node => {
    const inner = strip(node);
    return inner.kind === K.NullKeyword ? 'null' : ts.isIdentifier(inner) && inner.text === 'undefined' ? 'undefined' : undefined;
  };

  function isSimplePath(node) {
    node = strip(node);
    // Restrict to bare identifiers so property getters that may return different values on
    // re-evaluation (e.g. `typeof o.value === "object" && o.value !== null`) are never skipped.
    return Boolean(node && ts.isIdentifier(node));
  }

  function isTypeofObjectCheck(term, targetText) {
    term = strip(term);
    if (!ts.isBinaryExpression(term)) return false;
    const op = operatorOf(term);
    if (op !== '===' && op !== '==') return false;
    const check = (typeNode, strNode) => {
      typeNode = strip(typeNode);
      strNode = strip(strNode);
      return ts.isTypeOfExpression(typeNode) &&
        ts.isStringLiteralLike(strNode) && strNode.text === 'object' &&
        source(strip(typeNode.expression)) === targetText;
    };
    return check(term.left, term.right) || check(term.right, term.left);
  }

  function isGuardedTypeofObject(node, subjectNode) {
    if (!isSimplePath(subjectNode)) return false;
    const targetText = source(subjectNode);
    let current = node;
    let [parent] = up(current);
    while (parent && isLogical(parent) && operatorOf(parent) === '&&') {
      current = parent;
      [parent] = up(current);
    }
    if (current === node) return false;
    let guarded = false;
    (function scanAnd(expr) {
      if (guarded) return;
      expr = strip(expr);
      if (isLogical(expr) && operatorOf(expr) === '&&') {
        scanAnd(expr.left);
        scanAnd(expr.right);
      } else if (expr !== node && isTypeofObjectCheck(expr, targetText)) {
        guarded = true;
      }
    })(current);
    return guarded;
  }

  // An edit of one expression that a probe can stand for. `operands` are the parts the probe evaluates, in order.
  function probed(node, operator, operands, shared = {}) {
    // The probe stands where the expression stands, inside its own parentheses: what encloses them (a template
    // tag, `delete`) still applies to what the probe gives.
    const statement = ts.isExpressionStatement(node.parent);
    const boolean = onlyTruthUsed(node);
    const spans = operands.map(operand => [begin(operand), operand.end]);
    return (rule, form, replacement, more) => add(rule, node, replacement, { kind: 'observed', placement: [begin(node), node.end], statement,
      leading: !statement && begin(node) === statementStart, mutated: ` ${replacement} ` },
    { targeted: { operator, form, boolean, left: source(operands[0]), ...shared, ...more }, operands: spans });
  }

  // A different precedence would regroup an unparenthesized operand, so operands keep their own group.
  const grouped = side => ts.isBinaryExpression(side) ? `(${source(side)})` : source(side);

  function targetedEdits(node) {
    const operator = operatorOf(node);
    const token = node.operatorToken;
    const left = source(node.left);
    const right = source(node.right);
    const boolean = onlyTruthUsed(node);
    const edit = probed(node, operator, [node.left, node.right]);
    if (isBinary(node) && arithmeticSwaps.has(operator)) {
      const leftKind = isBinary(strip(node.left)) ? strip(strip(node.left).right) : strip(node.left);
      // Text is joined with `+`; another operator there is a type error and not a wrong program.
      if (isString(strip(node.right)) || isString(leftKind)) return;
      for (const swap of arithmeticSwaps.get(operator)) edit(targetedRules.arithmetic, swap, `(${grouped(node.left)} ${swap} ${grouped(node.right)})`);
      return;
    }
    if (isBinary(node) && ['===', '!==', '==', '!='].includes(operator)) {
      edit(targetedRules.constant, 'true', `(${left}, ${right}, true)`);
      edit(targetedRules.constant, 'false', `(${left}, ${right}, false)`);
      const written = [nullishLiteral(node.left), nullishLiteral(node.right)];
      // Beside a written null or undefined, the strict and the loose comparison differ for the other of the two.
      if ((written[0] === undefined) === (written[1] === undefined)) return;
      const literalSide = written[0] === undefined ? 1 : 0;
      const other = written[literalSide] === 'null' ? 'undefined' : 'null';
      const subjectNode = strip(literalSide ? node.left : node.right);
      const subject = literalSide ? left : right;
      // In `typeof x === "object" && x !== null` (or reversed), `x` cannot be `undefined`, so
      // relaxing `!== null` / `=== null` to loose equality is an unreachable equivalent mutant.
      if (written[literalSide] === 'null' && isGuardedTypeofObject(node, subjectNode)) return;
      const isNullishEqv = target => Boolean(typeEquivalence?.isNullishEqualityEquivalent(begin(subjectNode), subjectNode.end, target));
      if (operator.length === 3) {
        if (!isNullishEqv(other)) {
          edit(targetedRules.nullish, 'loose', swapToken(node, token, operator.slice(0, 2)), { literalSide, differsFor: other, subject });
        }
      } else {
        const strict = operator + '=';
        if (!isNullishEqv(other)) {
          edit(targetedRules.nullish, 'strict', swapToken(node, token, strict), { literalSide, differsFor: other, subject });
        }
        if (!isNullishEqv(written[literalSide])) {
          edit(targetedRules.nullish, 'other', literalSide ? `${left} ${strict} ${other}` : `${other} ${strict} ${right}`,
            { literalSide, differsFor: written[literalSide], subject });
        }
      }
    } else if (isLogical(node) && !staysInPlace(node.right)) {
      const operand = grouped;
      const rightNode = strip(node.right);
      const rawRightFalsy = falsyLiteralLabel(node.right);
      const rightFalsy = rawRightFalsy === 'NaN' && typeEquivalence?.hasLocalNaNBinding?.(begin(rightNode), rightNode.end)
        ? undefined
        : rawRightFalsy;
      const more = { thunk: true, ...(written(node.right) ? { pureRight: true } : {}) };
      edit(targetedRules.ignored, 'left', `(${left}, ${right})`, more);
      edit(targetedRules.ignored, 'right', `(${left} ${operator} (${right}, ${ignoredValue[operator]}))`, more);
      // Where only the truth is used, a written falsy fallback makes `??` and `||` the same for every value.
      if (boolean && writtenFalsy(node.right)) return;
      const leftNode = strip(node.left);
      if (typeEquivalence?.isNullishFallbackEquivalent(begin(leftNode), leftNode.end, rightFalsy)) return;
      const possibleFalsy = typeEquivalence?.possibleNullishFallbackFalsy?.(begin(leftNode), leftNode.end) ?? null;
      const fallbackMore = { ...more, ...(rightFalsy ? { rightFalsy } : {}), ...(possibleFalsy?.length ? { possibleFalsy } : {}), evidence: true };
      if (operator === '??') edit(targetedRules.fallback, 'or', `(${operand(node.left)} || ${operand(node.right)})`, fallbackMore);
      // Where only the truth of the value is used, nobody writes `??` for `||`.
      else if (operator === '||' && !boolean) edit(targetedRules.fallback, 'nullish', `(${operand(node.left)} ?? ${operand(node.right)})`, fallbackMore);
    }
  }

  const rename = (node, name, to) => text.slice(begin(node), begin(name)) + to + text.slice(name.end, node.end);

  // A file that binds or reassigns a global name itself (a parameter, a variable, a function, an import,
  // or a bare assignment) is not guaranteed to be calling the built-in one.
  function bindsIdentifier(targetName, pattern) {
    if (!pattern.test(text) && !text.includes('\\u')) return false;
    let found = false;
    (function look(inner) {
      if (found) return;
      if (ts.isIdentifier(inner) && inner.text === targetName &&
          !(ts.isPropertyAssignment(inner.parent) && inner.parent.name === inner) &&
          isAssignmentTarget(inner)) {
        found = true;
        return;
      }
      const name = inner.name;
      if (name !== undefined && ts.isIdentifier(name) && name.text === targetName) {
        if (ts.isImportSpecifier(inner)) {
          const clause = inner.parent?.parent;
          found = !inner.isTypeOnly && !clause?.isTypeOnly;
        } else if (ts.isImportClause(inner)) {
          found = !inner.isTypeOnly;
        } else if (ts.isNamespaceImport(inner)) {
          found = !inner.parent?.isTypeOnly;
        } else if (ts.isImportEqualsDeclaration(inner)) {
          found = !inner.isTypeOnly;
        } else {
          found = ts.isParameter(inner) || ts.isVariableDeclaration(inner) ||
            ts.isBindingElement(inner) || ts.isFunctionDeclaration(inner) || ts.isClassDeclaration(inner) ||
            ts.isFunctionExpression(inner) || ts.isClassExpression(inner);
        }
      }
      if (!found) ts.forEachChild(inner, look);
    })(tree);
    return found;
  }
  let bindsMath;
  function ownMath() {
    if (bindsMath === undefined) bindsMath = bindsIdentifier('Math', /\bMath\b(?!\s*(?:\.|\?\.|\[))/);
    return bindsMath;
  }
  let bindsBoolean;
  function ownBoolean() {
    if (bindsBoolean === undefined) bindsBoolean = bindsIdentifier('Boolean', /\bBoolean\b/);
    return bindsBoolean;
  }

  function isMathCall(node, expectedName) {
    if (!ts.isCallExpression(node) || ts.isOptionalChain(node) || node.arguments.length !== 2 || node.arguments.some(ts.isSpreadElement)) return false;
    const c = node.expression;
    return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'Math' &&
      ts.isIdentifier(c.name) && c.name.text === expectedName;
  }

  function hasUnescapedTrailingDollar(pattern) {
    if (!pattern.endsWith('$')) return false;
    let slashes = 0;
    for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i--) slashes++;
    return slashes % 2 === 0;
  }

  function compilesRegex(pattern, flags) {
    try { new RegExp(pattern, flags); return true; } catch { return false; }
  }

  function literalPrimitiveValue(node) {
    const inner = strip(node);
    if (ts.isNumericLiteral(inner)) return { ok: true, value: Number(inner.text) };
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === K.MinusToken && ts.isNumericLiteral(inner.operand)) {
      return { ok: true, value: -Number(inner.operand.text) };
    }
    if (ts.isBigIntLiteral(inner)) return { ok: true, value: BigInt(inner.text.slice(0, -1)) };
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === K.MinusToken && ts.isBigIntLiteral(inner.operand)) {
      return { ok: true, value: -BigInt(inner.operand.text.slice(0, -1)) };
    }
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return { ok: true, value: inner.text };
    if (inner.kind === K.TrueKeyword) return { ok: true, value: true };
    if (inner.kind === K.FalseKeyword) return { ok: true, value: false };
    if (inner.kind === K.NullKeyword) return { ok: true, value: null };
    return { ok: false };
  }

  const skippedMathCalls = new Set();

  function targetedCall(node) {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name) || ts.isOptionalChain(node) ||
        callee.expression.kind === K.SuperKeyword || node.arguments.some(ts.isSpreadElement)) return;
    const name = callee.name.text;
    const args = node.arguments;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Math') {
      if (ownMath() || skippedMathCalls.has(node)) return;
      if ((name === 'max' || name === 'min') && args.length === 2) {
        const innerName = name === 'max' ? 'min' : 'max';
        const innerPos = isMathCall(strip(args[0]), innerName) ? 0 : isMathCall(strip(args[1]), innerName) ? 1 : -1;
        if (innerPos !== -1 && !staysInPlace(args[0]) && !staysInPlace(args[1])) {
          const inner = strip(args[innerPos]);
          const outerOther = args[1 - innerPos];
          const [ia, ib] = inner.arguments;
          const ordered = innerPos === 0 ? [ia, ib, outerOther] : [outerOther, ia, ib];
          const pures = ordered.map(arg => written(arg) ? 1 : 0);
          const beforeClamp = mutations.length;
          const edit = probed(node, 'clamp', ordered, { clampMeta: { outer: name, inner: innerName, innerPos, pures } });
          edit(targetedRules.clampBound, 'dropOuter', source(inner), { boundKind: name === 'min' ? 'upper' : 'lower' });
          const aLit = written(ia);
          const bLit = written(ib);
          if (aLit !== bLit) {
            const keepIdx = aLit ? 1 : 0;
            const keptNode = inner.arguments[keepIdx];
            const innerReplacement = innerPos === 0 ? `Math.${name}(${source(keptNode)}, ${source(outerOther)})`
              : `Math.${name}(${source(outerOther)}, ${source(keptNode)})`;
            edit(targetedRules.clampBound, keepIdx === 0 ? 'dropInnerB' : 'dropInnerA', innerReplacement,
              { boundKind: innerName === 'min' ? 'upper' : 'lower' });
          }
          if (mutations.length > beforeClamp) skippedMathCalls.add(inner);
          return;
        }
        probed(node, name, [args[0], args[1]])(targetedRules.extreme, name === 'max' ? 'min' : 'max', rename(node, callee.name, name === 'max' ? 'min' : 'max'));
      } else if (roundingSwaps.has(name) && args.length === 1) {
        const edit = probed(node, name, [args[0]]);
        for (const swap of roundingSwaps.get(name)) edit(targetedRules.rounding, swap, rename(node, callee.name, swap));
      }
    } else if ((name === 'sort' || name === 'toSorted') && args.length === 1 && ascending(args[0])) {
      // Without its comparison a sort orders numbers as text: 10 before 9.
      probed(node, name, [callee.expression, args[0]])(targetedRules.order, 'default', text.slice(begin(node), args.pos) + ')');
    } else if (endSwaps.has(name) && args.length === 1) {
      probed(node, name, [callee.expression, args[0]])(targetedRules.ends, endSwaps.get(name), rename(node, callee.name, endSwaps.get(name)));
    } else if (name === 'at' && args.length === 1 && ['0', '-1'].includes(source(args[0]).replace(/\s/g, ''))) {
      const first = source(args[0]) === '0';
      probed(node, first ? 'at0' : 'at-1', [callee.expression])(targetedRules.ends, first ? 'at-1' : 'at0',
        text.slice(begin(node), begin(args[0])) + (first ? '-1' : '0') + text.slice(args[0].end, node.end));
    } else if ((name === 'startsWith' || name === 'endsWith') && args.length === 1 && !staysInPlace(args[0])) {
      probed(node, name, [callee.expression, args[0]])(targetedRules.prefixSubstring, 'includes', rename(node, callee.name, 'includes'));
    } else if ((name === 'replace' || name === 'replaceAll') && args.length === 2 && !ts.isRegularExpressionLiteral(strip(args[0])) &&
        !staysInPlace(args[0]) && !staysInPlace(args[1])) {
      const swapped = name === 'replace' ? 'replaceAll' : 'replace';
      probed(node, name, [callee.expression, args[0], args[1]])(targetedRules.replaceMultiplicity, swapped, rename(node, callee.name, swapped));
    } else if ((name === 'every' || name === 'some') && args.length === 1 && !staysInPlace(args[0])) {
      const swapped = name === 'every' ? 'some' : 'every';
      probed(node, name, [callee.expression, args[0]])(targetedRules.quantifierSwap, swapped, rename(node, callee.name, swapped));
    } else if (name === 'includes' && args.length === 1 && !staysInPlace(args[0])) {
      const recv = strip(callee.expression);
      if (ts.isArrayLiteralExpression(recv) && recv.elements.length >= 2 && recv.elements.length <= 16) {
        const parsed = recv.elements.map(el => ts.isSpreadElement(el) ? { ok: false } : literalPrimitiveValue(el));
        if (parsed.every(entry => entry.ok)) {
          const elems = recv.elements.map(el => source(el));
          // SameValueZero duplicate values cannot change `includes` when only one copy is pruned.
          const sameValueZero = (a, b) => a === b || (a !== a && b !== b);
          const counts = parsed.map(a => parsed.filter(b => sameValueZero(a.value, b.value)).length);
          const prunable = counts.map((count, idx) => count === 1 ? idx : -1).filter(idx => idx >= 0);
          if (prunable.length) {
            const edit = probed(node, 'literalIncludes', [args[0]], { setElems: elems, argName: source(args[0]) });
            for (const j of prunable) {
              const kept = elems.filter((_, idx) => idx !== j);
              edit(targetedRules.literalSetPrune, `prune:${j}`, `[${kept.join(', ')}].includes(${source(args[0])})`, { pruned: elems[j] });
            }
          }
        }
      }
    } else if (name === 'test' && args.length === 1 && !staysInPlace(args[0])) {
      const recv = strip(callee.expression);
      if (recv.kind === K.RegularExpressionLiteral) {
        const raw = source(recv);
        const close = raw.lastIndexOf('/');
        const pattern = raw.slice(1, close);
        const flags = raw.slice(close + 1);
        const alts = [];
        if (pattern.startsWith('^') && compilesRegex(pattern.slice(1), flags)) {
          alts.push(['dropStart', pattern.slice(1)]);
        }
        if (hasUnescapedTrailingDollar(pattern) && compilesRegex(pattern.slice(0, -1), flags)) {
          alts.push(['dropEnd', pattern.slice(0, -1)]);
        }
        if (alts.length) {
          const altMap = Object.fromEntries(alts);
          const edit = probed(node, 'regexTest', [args[0]], { regexMeta: { pattern, flags, alts: altMap }, argName: source(args[0]) });
          for (const [form, altPattern] of alts) {
            edit(targetedRules.regexAnchor, form, `/${altPattern || '(?:)'}/${flags}.test(${source(args[0])})`);
          }
        }
      }
    }
  }

  // `(a, b) => a - b`: the comparison that puts numbers in ascending order.
  function ascending(node) {
    if (!ts.isArrowFunction(node) || node.parameters.length !== 2 || !node.parameters.every(parameter => ts.isIdentifier(parameter.name) && !parameter.initializer)) return false;
    const body = ts.isBlock(node.body) ? undefined : strip(node.body);
    return body !== undefined && ts.isBinaryExpression(body) && operatorOf(body) === '-' && ts.isIdentifier(strip(body.left)) && ts.isIdentifier(strip(body.right)) &&
      strip(body.left).text === node.parameters[0].name.text && strip(body.right).text === node.parameters[1].name.text;
  }

  function insideFinallyBlock(node) {
    let cur = node.parent;
    let prev = node;
    while (cur) {
      if (ts.isFunctionLike(cur) || ts.isClassLike(cur)) return false;
      if (ts.isTryStatement(cur) && cur.finallyBlock === prev) return true;
      prev = cur;
      cur = cur.parent;
    }
    return false;
  }

  // Edits that no recording can judge: they change when something happens or which object is which, not a value.
  function unobservedEdits(node) {
    if (ts.isExpressionStatement(node)) {
      const expr = strip(node.expression);
      const isAwaited = ts.isAwaitExpression(expr);
      const call = isAwaited ? strip(expr.expression) : expr;
      if (ts.isCallExpression(call) && call.expression.kind !== K.SuperKeyword && insideFinallyBlock(node)) {
        add(targetedRules.cleanupDropped, node, ';', { kind: 'statement', placement: [begin(node), node.end], mutated: ' ;' },
          { targeted: { operator: 'cleanup', form: 'dropped', left: source(call) } });
        return;
      }
      // The call goes on alone: what follows no longer waits for it. `void` keeps it an expression whatever it
      // begins with (a parenthesis, a function that is called at once), and the space keeps it off an `else`.
      if (isAwaited && ts.isCallExpression(call)) {
        add(targetedRules.awaited, node, `void ${source(call)};`, { kind: 'statement', placement: [begin(node), node.end], mutated: ` void ${source(call)};` },
          { targeted: { operator: 'await', form: 'dropped', left: source(call) } });
      }
      return;
    }
    // `[...list]` and `{ ...record }` as the whole literal are copies (or iterable/spread conversions):
    // probing records whether the operand is actually an array or a plain object.
    const isArray = ts.isArrayLiteralExpression(node);
    const only = isArray ? node.elements : ts.isObjectLiteralExpression(node) ? node.properties : undefined;
    if (!only || isAssignmentTarget(node)) return;
    if (only.length === 1 && (ts.isSpreadElement(only[0]) || ts.isSpreadAssignment(only[0]))) {
      const original = source(only[0].expression);
      probed(node, isArray ? 'copyArray' : 'copyObject', [only[0].expression])(targetedRules.copy, 'dropped', `(${original})`);
      return;
    }
    // `{ ...a, ...b }`: swap merge precedence to `{ ...b, ...a }`.
    if (!isArray && only.length === 2 && ts.isSpreadAssignment(only[0]) && ts.isSpreadAssignment(only[1]) &&
        !staysInPlace(only[0].expression) && !staysInPlace(only[1].expression)) {
      const a = source(only[0].expression);
      const b = source(only[1].expression);
      const pureMerge = ts.isIdentifier(strip(only[0].expression)) && ts.isIdentifier(strip(only[1].expression)) ? 1 : 0;
      probed(node, 'mergeSpread', [only[0].expression, only[1].expression], { right: b, pureMerge })(
        targetedRules.mergePrecedence, 'swap', `{ ...${b}, ...${a} }`,
      );
      return;
    }
    // `{ ...base, k1: v1, k2: v2 }`: drop one explicit static property at a time.
    if (!isArray && only.length >= 2 && ts.isSpreadAssignment(only[0])) {
      const rest = only.slice(1);
      const keys = [];
      const values = [];
      const pureProps = [];
      const seenKeys = new Set();
      for (const prop of rest) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return;
        const name = prop.name;
        let key;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) key = name.text;
        else return;
        if (key === '__proto__' || seenKeys.has(key)) return;
        const valueNode = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
        if (staysInPlace(valueNode)) return;
        // Anonymous functions and classes receive inferred `.name` from their property key in an object literal,
        // including through erased TypeScript wrappers (`as`, `satisfies`, `<T>x`, `!`).
        let innerVal = valueNode;
        while (innerVal && (ts.isParenthesizedExpression(innerVal) || ts.isAsExpression(innerVal) ||
            ts.isSatisfiesExpression(innerVal) || ts.isTypeAssertionExpression(innerVal) || ts.isNonNullExpression(innerVal))) {
          innerVal = innerVal.expression;
        }
        if (ts.isArrowFunction(innerVal) || (ts.isFunctionExpression(innerVal) && !innerVal.name) ||
            (ts.isClassExpression(innerVal) && !innerVal.name)) return;
        seenKeys.add(key);
        keys.push(key);
        values.push(valueNode);
        pureProps.push(written(valueNode) ? 1 : 0);
      }
      const edit = probed(node, 'spreadUpdate', [only[0].expression, ...values], { spreadKeys: keys, pureProps });
      for (let j = 0; j < rest.length; j++) {
        const kept = [only[0], ...rest.filter((_, idx) => idx !== j)];
        edit(targetedRules.spreadDrop, `drop:${j}`, `{ ${kept.map(prop => source(prop)).join(', ')} }`, { key: keys[j] });
      }
    }
  }

  // A name or a chain of property names: reading it twice gives the same and does nothing else.
  const plainReference = node => ts.isIdentifier(node) || node.kind === K.ThisKeyword ||
    (ts.isPropertyAccessExpression(node) && !node.questionDotToken && ts.isIdentifier(node.name) && plainReference(node.expression));

  function targetedElement(node) {
    // What the element is used for shows above its parentheses and erased TypeScript wrappers.
    let [parent, child] = up(node);
    while (ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent) || ts.isAsExpression(parent)) {
      [parent, child] = up(parent);
    }
    if (ts.isNewExpression(parent) && parent.expression === child) return;
    const written = isAssignmentTarget(child) || ts.isDeleteExpression(parent) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && [K.PlusPlusToken, K.MinusMinusToken].includes(parent.operator)) ||
      (isAssignment(parent) && parent.left === child);
    // As a callee the element is called with its sequence as `this`.
    const called = (ts.isCallExpression(parent) && parent.expression === child) || (ts.isTaggedTemplateExpression(parent) && parent.tag === child);
    if (written || called || ts.isOptionalChain(node) || node.expression.kind === K.SuperKeyword) return;
    const index = strip(node.argumentExpression);
    const receiver = source(node.expression);
    if (ts.isNumericLiteral(index) && index.text === '0') {
      probed(node, 'idx0', [node.expression])(targetedRules.ends, 'at-1', `${receiver}.at(-1)`);
    } else if (ts.isBinaryExpression(index) && operatorOf(index) === '-' && ts.isNumericLiteral(strip(index.right)) && strip(index.right).text === '1' &&
        ts.isPropertyAccessExpression(strip(index.left)) && strip(index.left).name.text === 'length' && plainReference(node.expression) &&
        source(strip(index.left).expression) === receiver) {
      probed(node, 'idxLast', [node.expression])(targetedRules.ends, 'idx0', `${receiver}[0]`);
      unprobed.push([begin(node.argumentExpression), node.argumentExpression.end]);
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
    if (targeted && ts.isBinaryExpression(node)) targetedEdits(node);
    else if (targeted && ts.isCallExpression(node)) targetedCall(node);
    else if (targeted && ts.isElementAccessExpression(node)) targetedElement(node);
    else if (targeted) unobservedEdits(node);
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
