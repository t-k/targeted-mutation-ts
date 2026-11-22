import { byteOffsets, sourceDialect } from './source-text.mjs';
import { createTypeScriptBindings } from './typescript-bindings.mjs';
import { withTypeScriptSyntax } from './typescript-compiler.mjs';
import { createTypeScriptGrammar } from './typescript-grammar.mjs';

const extractors = new WeakMap();

export function createTypeScriptExtractor(ts) {
  const {
    LanguageVariant, ScriptKind, ScriptTarget, SyntaxKind, createScanner, createSourceFile,
    flattenDiagnosticMessageText, forEachChild, isArrowFunction, isAsExpression, isBinaryExpression, isIdentifier,
    isImportTypeNode, isJsxAttribute, isJsxClosingElement, isJsxElement, isJsxOpeningElement,
    isJsxSelfClosingElement, isParenthesizedExpression, isSatisfiesExpression, isTypeAssertionExpression,
  } = ts;
  const checkGrammar = createTypeScriptGrammar(ts, createTypeScriptBindings(ts));

  const kind = SyntaxKind;
  const comparison = new Map([
    [kind.LessThanToken, ['<', '<=']],
    [kind.LessThanEqualsToken, ['<=', '<']],
    [kind.GreaterThanToken, ['>', '>=']],
    [kind.GreaterThanEqualsToken, ['>=', '>']],
  ]);
  const isName = token => token === kind.Identifier || token >= kind.FirstKeyword && token <= kind.LastKeyword;
  const scannerFor = source => createScanner(ScriptTarget.Latest, true, LanguageVariant.Standard, source);

  function jsxTagMarkers(source, diagnostics) {
    const errors = new Set(diagnostics.filter(diagnostic => diagnostic.code === 1003).map(diagnostic => diagnostic.start));
    if (!errors.size) return [];
    const scanner = scannerFor(source);
    const markers = [];
    for (let start = source.indexOf('<'); start >= 0; start = source.indexOf('<', start + 1)) {
      scanner.setTextPos(start);
      if (scanner.scan() !== kind.LessThanToken) continue;
      let token = scanner.scan();
      const closing = token === kind.SlashToken;
      if (closing) token = scanner.scan();
      if (!isName(token)) continue;
      let member = false;
      let affected = false;
      const edits = [];
      while (isName(token) || member && token === kind.PrivateIdentifier) {
        if (token === kind.PrivateIdentifier) edits.push(scanner.getTokenStart());
        affected ||= errors.has(scanner.getTextPos());
        let end = scanner.getTextPos();
        token = scanner.scan();
        while ((token === kind.MinusToken || token === kind.MinusMinusToken) && scanner.getTokenStart() === end) {
          affected ||= errors.has(end);
          for (; end < scanner.getTextPos(); end++) edits.push(end);
          token = scanner.scan();
          if ((isName(token) || token === kind.NumericLiteral) && scanner.getTokenStart() === end) {
            end = scanner.getTextPos();
            token = scanner.scan();
          }
        }
        if (token !== kind.DotToken) break;
        member = true;
        token = scanner.scan();
      }
      if (member && (affected || closing) && edits.length && (isName(token) || token === kind.SlashToken ||
          token === kind.GreaterThanToken || token === kind.OpenBraceToken || token === kind.LessThanToken)) {
        for (const edit of edits) markers.push(edit);
      }
    }
    return markers;
  }

  function repairJsxTags(source, tree, read) {
    const markers = jsxTagMarkers(source, tree.parseDiagnostics);
    if (!markers.length) return tree;
    const available = [];
    for (let code = 0x416; code <= 0x42f && available.length < 2; code++) {
      const char = String.fromCharCode(code);
      if (!source.includes(char)) available.push(char);
    }
    if (available.length < 2) return tree;
    const text = source.split('');
    for (const position of markers) text[position] = source[position] === '#' ? available[0] : available[1];
    let repaired = read(text.join(''));
    const confirmed = new Set();
    const pending = [repaired];
    while (pending.length) {
      const node = pending.pop();
      if (isJsxOpeningElement(node) || isJsxClosingElement(node) || isJsxSelfClosingElement(node)) {
        const start = node.tagName.getStart(repaired);
        for (let index = start; index < node.tagName.end; index++) {
          if (text[index] !== source[index]) confirmed.add(index);
        }
      }
      forEachChild(node, child => { pending.push(child); });
    }
    if (!confirmed.size) return tree;
    if (markers.some(position => !confirmed.has(position))) {
      for (const position of markers) {
        if (!confirmed.has(position)) text[position] = source[position];
      }
      repaired = read(text.join(''));
    }
    return repaired;
  }

  function insertSyntax(source, edits) {
    const pieces = [];
    const inserted = [];
    let previous = 0;
    for (const [index, [offset, char]] of edits.entries()) {
      pieces.push(source.slice(previous, offset), char);
      inserted.push(offset + index);
      previous = offset;
    }
    pieces.push(source.slice(previous));
    const originalOffset = offset => {
      let low = 0;
      let high = inserted.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (inserted[mid] < offset) low = mid + 1;
        else high = mid;
      }
      return offset - low;
    };
    return { text: pieces.join(''), inserted, originalOffset };
  }

  function locateArrowRepairs(tree, source) {
    // A comma may disambiguate a single bare type parameter in TSX. The reparsed
    // AST must consume each inserted comma in an actual arrow type-parameter list.
    const matchedTags = new Set();
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (isJsxElement(node) && node.openingElement.tagName.getText(tree) === node.closingElement.tagName.getText(tree)) {
        matchedTags.add(node.openingElement.getStart(tree));
      }
      forEachChild(node, child => { pending.push(child); });
    }
    const scanner = scannerFor(source);
    const offsets = [];
    for (let start = source.indexOf('<'); start >= 0; start = source.indexOf('<', start + 1)) {
      if (matchedTags.has(start)) continue;
      scanner.setTextPos(start);
      if (scanner.scan() !== kind.LessThanToken) continue;
      let token = scanner.scan();
      if (token === kind.ConstKeyword) token = scanner.scan();
      if (!isName(token) || scanner.scan() !== kind.GreaterThanToken) continue;
      const close = scanner.getTokenStart();
      if (scanner.scan() === kind.OpenParenToken) offsets.push(close);
    }
    return offsets;
  }

  function arrowCommas(tree) {
    const confirmed = new Set();
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (isArrowFunction(node) && node.typeParameters?.length === 1 && node.typeParameters.hasTrailingComma &&
          node.equalsGreaterThanToken.getWidth(tree) > 0) {
        confirmed.add(node.typeParameters.end - 1);
      }
      forEachChild(node, child => { pending.push(child); });
    }
    return confirmed;
  }

  function repairTsx(source, tree, read) {
    const identity = offset => offset;
    tree = repairJsxTags(source, tree, read);
    if (!tree.parseDiagnostics.length) return { tree, originalOffset: identity };
    const patched = tree.text;
    const offsets = locateArrowRepairs(tree, patched);
    if (!offsets.length) return { tree, originalOffset: identity };

    const withCommas = positions => insertSyntax(patched, positions.map(position => [position, ',']));
    const trial = withCommas(offsets);
    const alternative = read(trial.text);
    const confirmed = arrowCommas(alternative);
    const selected = offsets.filter((offset, index) => confirmed.has(trial.inserted[index]));
    if (!selected.length) return { tree, originalOffset: identity };
    const repaired = selected.length === offsets.length ? trial : withCommas(selected);
    const repairedTree = repaired === trial ? alternative : read(repaired.text);
    const repairedCommas = repaired === trial ? confirmed : arrowCommas(repairedTree);
    if (repaired.inserted.some(position => !repairedCommas.has(position))) {
      return { tree, originalOffset: identity };
    }
    return { tree: repairedTree, originalOffset: repaired.originalOffset };
  }

  function repairAssertedAssignments(result, read) {
    const { tree, originalOffset } = result;
    const expected = new Set(tree.parseDiagnostics.filter(diagnostic => diagnostic.code === 1005).map(diagnostic => diagnostic.start));
    if (!expected.size) return result;
    const scanner = scannerFor(tree.text);
    const isAssignment = token => token >= kind.FirstAssignment && token <= kind.LastAssignment;
    const isAssertion = node => isAsExpression(node) || isSatisfiesExpression(node) || isTypeAssertionExpression(node);
    const edits = [];
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (isAssertion(node)) {
        scanner.setTextPos(node.end);
        if (isAssignment(scanner.scan()) && expected.has(scanner.getTokenStart())) {
          edits.push([node.getStart(tree), '('], [node.end, ')']);
        }
      }
      forEachChild(node, child => { pending.push(child); });
    }
    if (!edits.length) return result;
    edits.sort((a, b) => a[0] - b[0]);
    const repair = insertSyntax(tree.text, edits);
    const repaired = read(repair.text);
    const confirmed = new Set();
    pending.push(repaired);
    while (pending.length) {
      const node = pending.pop();
      if (isBinaryExpression(node) && isAssignment(node.operatorToken.kind) &&
          isParenthesizedExpression(node.left) && isAssertion(node.left.expression)) {
        confirmed.add(node.left.getStart(repaired));
        confirmed.add(node.left.end - 1);
      }
      forEachChild(node, child => { pending.push(child); });
    }
    if (repair.inserted.some(position => !confirmed.has(position))) return result;
    return { tree: repaired, originalOffset: offset => originalOffset(repair.originalOffset(offset)) };
  }

  function repairImportTypeArguments(tree, read) {
    const source = tree.text;
    if (!/\bimport\b(?=\s*[(/])/.test(source)) return tree;
    const scanner = scannerFor(source);
    const pending = [tree];
    const gaps = [];
    while (pending.length) {
      const node = pending.pop();
      if (isImportTypeNode(node) && !node.typeArguments) {
        scanner.setTextPos(node.end);
        if (scanner.scan() === kind.LessThanToken && scanner.hasPrecedingLineBreak()) {
          gaps.push([node.end, scanner.getTokenStart()]);
        }
      }
      forEachChild(node, child => { pending.push(child); });
    }
    if (!gaps.length) return tree;
    const parts = [];
    let previous = 0;
    for (const [start, end] of gaps.sort((a, b) => a[0] - b[0])) {
      parts.push(source.slice(previous, start), ' '.repeat(end - start));
      previous = end;
    }
    parts.push(source.slice(previous));
    return read(parts.join(''));
  }

  function parse(source, file, dialect) {
    const scriptKind = dialect === 'tsx' ? ScriptKind.TSX : ScriptKind.TS;
    const read = text => createSourceFile(file, text, ScriptTarget.Latest, false, scriptKind);
    const tree = repairImportTypeArguments(read(source), read);
    let result = { tree, originalOffset: offset => offset };
    if (!tree.parseDiagnostics.length) return result;
    if (scriptKind === ScriptKind.TSX) result = repairTsx(tree.text, tree, read);
    return repairAssertedAssignments(result, read);
  }

  function materializeCandidates(sites, tree, source, span, originalOffset) {
    const candidates = sites.map(node => {
      const boundary = comparison.get(node.operatorToken.kind);
      if (boundary) {
        const [operator, replacement] = boundary;
        return {
          rule: 'comparison-boundary/v1', operator, replacement,
          edit: span(node.operatorToken), left: span(node.left), right: span(node.right),
        };
      }
      return {
        rule: 'jsx-disabled-drop-left/v1', operator: '||', operatorEdit: span(node.operatorToken),
        replacement: '(' + source.slice(originalOffset(node.right.getStart(tree)), originalOffset(node.right.end)) + ')',
        edit: span(node), left: span(node.left), right: span(node.right),
      };
    });
    candidates.sort((a, b) => (a.operatorEdit ?? a.edit)[0] - (b.operatorEdit ?? b.edit)[0]);
    return candidates;
  }

  return function extract(source, options) {
    const path = options.file ?? null;
    const { tree, originalOffset } = parse(source, path ?? 'input.ts', options.dialect ?? sourceDialect(path));
    let offsets;
    const bytes = unit => {
      if (offsets === undefined) offsets = Buffer.byteLength(source) === source.length ? null : byteOffsets(source);
      return offsets === null ? unit : offsets[unit];
    };
    const insideCodePoint = unit => {
      const code = source.charCodeAt(unit);
      return code >= 0xdc00 && code <= 0xdfff;
    };
    const span = node => [bytes(originalOffset(node.getStart(tree))), bytes(originalOffset(node.end))];
    const diagnostics = new Map();
    const syntaxErrors = [];
    function record(start, end, message, labels = []) {
      const diagnostic = { severity: 'error', message, path, start, end, labels, help: null };
      diagnostics.set(JSON.stringify([start, end, message]), diagnostic);
    }
    for (const diagnostic of tree.parseDiagnostics) {
      const at = diagnostic.start ?? 0;
      const start = originalOffset(at);
      const end = originalOffset(at + (diagnostic.length ?? 0));
      // Triple-slash build directives do not change the syntax of the program.
      const directive = diagnostic.code === 2458 || diagnostic.code === 1084;
      if (directive && source.slice(start, end).trimStart().startsWith('///')) continue;
      if (options.mode === 'script' && [1121, 1487, 1488, 1489].includes(diagnostic.code)) continue;
      const first = insideCodePoint(start) ? start - 1 : start;
      const last = insideCodePoint(end) ? end + 1 : end;
      syntaxErrors.push({ start: at, end: at + (diagnostic.length ?? 0) });
      record(bytes(first), bytes(last), flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    }
    function overlapsSyntaxError(node) {
      if (!syntaxErrors.length) return false;
      const start = node.getStart(tree);
      return start >= node.end || syntaxErrors.some(error => start <= error.end && error.start < node.end);
    }
    const sites = [];
    function visitBinary(node, attribute) {
      const token = node.operatorToken.kind;
      if (comparison.has(token) || (options.logical && token === kind.BarBarToken && attribute && isJsxAttribute(attribute) &&
          isIdentifier(attribute.name) && attribute.name.text === 'disabled')) sites.push(node);
    }
    const scanCandidates = source.includes('<') || source.includes('>') || (options.logical && source.includes('||'));
    checkGrammar(tree, options.mode, (node, message, previous) => {
      if (overlapsSyntaxError(node)) return;
      const [start, end] = span(node);
      const labels = [];
      if (previous && !overlapsSyntaxError(previous)) {
        const [priorStart, priorEnd] = span(previous);
        labels.push({ start: priorStart, end: priorEnd, message: 'Previously declared here' });
      }
      record(start, end, message, labels);
    }, scanCandidates ? visitBinary : undefined);
    if (diagnostics.size) {
      return { path: 'diagnostic', candidates: [], diagnostics: [...diagnostics.values()].sort((a, b) => a.start - b.start) };
    }
    return { path: 'fallback', fallback: 'typescript', candidates: materializeCandidates(sites, tree, source, span, originalOffset) };
  };
}

export function extractTypeScript(source, options = {}) {
  return withTypeScriptSyntax(ts => {
    let extract = extractors.get(ts);
    if (!extract) {
      extract = createTypeScriptExtractor(ts);
      extractors.set(ts, extract);
    }
    return extract(source, options);
  });
}
