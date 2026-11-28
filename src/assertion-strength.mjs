import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceTrialsAsync } from './analysis.mjs';
import { inParallel } from './in-parallel.mjs';
import { loadTypeScript } from './typescript-compiler.mjs';
import { canonicalPath, inside, withCopy } from './vitest.mjs';

// A test can make the very call that tells an edit from the original and still pass, because its assertion does
// not pin the result down: `expect(bucket(3)).not.toBe('none')`, `expect(total(1, 2)).toBeGreaterThan(0)`, a call
// whose result is not looked at. For a finding that names such tests, the call is run where the test makes it,
// once as it is and once with the edit, and where the two values differ the report gives the value to compare with.
const pinning = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toBeNull', 'toBeUndefined', 'toBeNaN', 'toBeCloseTo',
  'toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchObject']);
const extension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const defaultRun = { sourceTrialsAsync };
const sessionWorker = fileURLToPath(new URL('./assertion-session.mjs', import.meta.url));

function loadTsPaths(root, fromFile, ts, cache) {
  let dir = dirname(resolve(root, fromFile));
  const visited = [];
  while (true) {
    if (cache.tsconfigs.has(dir)) {
      const found = cache.tsconfigs.get(dir);
      for (const seen of visited) cache.tsconfigs.set(seen, found);
      return found;
    }
    visited.push(dir);
    const candidate = resolve(dir, 'tsconfig.json');
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      let info = null;
      try {
        const read = ts.readConfigFile(candidate, file => readFileSync(file, 'utf8'));
        if (!read.error && read.config) {
          const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, candidate);
          const opts = parsed.options ?? {};
          const paths = opts.paths && typeof opts.paths === 'object' ? opts.paths : null;
          const baseDir = opts.baseUrl ? resolve(dir, opts.baseUrl) : (opts.pathsBasePath ?? dir);
          if (paths || opts.baseUrl) info = { paths, baseDir, hasBaseUrl: Boolean(opts.baseUrl) };
        }
      } catch { /* ignore unreadable tsconfig */ }
      for (const seen of visited) cache.tsconfigs.set(seen, info);
      return info;
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith('..')) break;
    dir = parent;
  }
  for (const seen of visited) cache.tsconfigs.set(seen, null);
  return null;
}

function candidatePathsFor(root, fromFile, specifier, ts, cache) {
  const candidates = [];
  if (specifier.startsWith('.')) {
    candidates.push(resolve(dirname(resolve(root, fromFile)), specifier));
    return candidates;
  }
  const tsPaths = loadTsPaths(root, fromFile, ts, cache);
  if (!tsPaths) return candidates;
  if (tsPaths.paths) {
    // Follow TypeScript's `paths` precedence: an exact match wins immediately; otherwise the single wildcard
    // pattern with the longest prefix (breaking ties by declaration order) wins, without falling back to other
    // `paths` patterns if its substitutions are missing.
    let bestExact = null;
    let bestWildcard = null;
    for (const [pattern, targets] of Object.entries(tsPaths.paths)) {
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf('*');
      if (star === -1) {
        if (specifier === pattern && !bestExact) {
          bestExact = targets.map(target => resolve(tsPaths.baseDir, target));
        }
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
          if (!bestWildcard || prefix.length > bestWildcard.prefixLen) {
            const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
            bestWildcard = { prefixLen: prefix.length, paths: targets.map(target => resolve(tsPaths.baseDir, target.replace('*', matched))) };
          }
        }
      }
    }
    if (bestExact) candidates.push(...bestExact);
    else if (bestWildcard) candidates.push(...bestWildcard.paths);
  }
  if (tsPaths.hasBaseUrl) candidates.push(resolve(tsPaths.baseDir, specifier));
  return candidates;
}

function resolveModuleInRoot(root, fromFile, specifier, ts, cache) {
  const cacheKey = `${fromFile}\0${specifier}`;
  if (cache.resolved.has(cacheKey)) return cache.resolved.get(cacheKey);
  let found = null;
  for (const base of candidatePathsFor(root, fromFile, specifier, ts, cache)) {
    const stripped = base.replace(extension, '');
    const tries = [base, ...sourceExtensions.map(ext => stripped + ext), ...sourceExtensions.map(ext => resolve(stripped, 'index' + ext))];
    for (const file of tries) {
      try {
        if (!existsSync(file) || !statSync(file).isFile()) continue;
        const safe = inside(root, file);
        found = relative(root, safe).split(sep).join('/');
        break;
      } catch { /* escapes root or unreadable */ }
    }
    if (found) break;
  }
  cache.resolved.set(cacheKey, found);
  return found;
}

function collectExportedLocalNames(tree, ts) {
  const explicit = new Set();
  const hasExportModifier = node => Boolean(node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  const hasDefaultModifier = node => Boolean(node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword));
  const collectBinding = binding => {
    if (!binding) return;
    if (ts.isIdentifier(binding)) explicit.add(binding.text);
    else if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
      for (const el of binding.elements) if (ts.isBindingElement(el)) collectBinding(el.name);
    }
  };
  for (const stmt of tree.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) if (!el.isTypeOnly) explicit.add(el.name.text);
      } else if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        explicit.add(stmt.exportClause.name.text);
      }
    } else if (hasExportModifier(stmt) && !hasDefaultModifier(stmt)) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) collectBinding(decl.name);
      } else if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name) {
        explicit.add(stmt.name.text);
      }
    }
  }
  return explicit;
}

function exportsFromSubject(root, filePosix, subjectPosix, ts, cache, depth = 0, visiting = new Set()) {
  if (filePosix === subjectPosix) {
    return { all: true, excluded: new Set(), names: new Set(), defaultExport: true, namespaces: new Map() };
  }
  if (depth >= 4 || visiting.has(filePosix)) {
    return { all: false, excluded: new Set(), names: new Set(), defaultExport: false, namespaces: new Map() };
  }
  const key = `${filePosix}\0${subjectPosix}`;
  if (depth === 0 && cache.exports.has(key)) return cache.exports.get(key);
  let tree = cache.asts.get(filePosix);
  if (!tree) {
    try {
      const abs = inside(root, filePosix);
      tree = ts.createSourceFile(filePosix, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
      cache.asts.set(filePosix, tree);
    } catch {
      return { all: false, excluded: new Set(), names: new Set(), defaultExport: false, namespaces: new Map() };
    }
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(filePosix);
  // Explicit exports in this barrel override `export *` re-exports of the same name.
  const explicitInBarrel = collectExportedLocalNames(tree, ts);
  const info = { all: false, excluded: new Set(), names: new Set(), defaultExport: false, namespaces: new Map() };
  const starChildren = [];
  for (const statement of tree.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveModuleInRoot(root, filePosix, statement.moduleSpecifier.text, ts, cache);
    if (!target) continue;
    const child = exportsFromSubject(root, target, subjectPosix, ts, cache, depth + 1, nextVisiting);
    if (!child.all && !child.defaultExport && !child.names.size && !child.namespaces.size) continue;
    const clause = statement.exportClause;
    if (!clause) {
      starChildren.push(child);
    } else if (ts.isNamespaceExport(clause)) {
      if (child.all) info.namespaces.set(clause.name.text, child.excluded.size ? { all: true, excluded: new Set(child.excluded) } : null);
      else if (child.names.size) info.namespaces.set(clause.name.text, new Set(child.names));
    } else if (ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        const orig = (element.propertyName ?? element.name).text;
        const exported = element.name.text;
        const childHas = orig === 'default'
          ? child.defaultExport
          : (child.names.has(orig) || (child.all && !child.excluded.has(orig)));
        if (orig !== 'default' && child.namespaces.has(orig)) {
          info.namespaces.set(exported, child.namespaces.get(orig));
        } else if (childHas) {
          if (exported === 'default') info.defaultExport = true;
          else info.names.add(exported);
        }
      }
    }
  }
  // Apply `export *` only for names not explicitly overridden by another export in this barrel.
  for (const child of starChildren) {
    if (child.all) {
      if (!info.all) {
        info.all = true;
        for (const name of child.excluded) info.excluded.add(name);
      } else {
        for (const name of [...info.excluded]) if (!child.excluded.has(name)) info.excluded.delete(name);
      }
    } else {
      for (const name of child.names) if (!explicitInBarrel.has(name)) info.names.add(name);
      for (const [ns, members] of child.namespaces) if (!explicitInBarrel.has(ns)) info.namespaces.set(ns, members);
    }
  }
  if (info.all) {
    for (const name of explicitInBarrel) {
      if (!info.names.has(name) && !info.namespaces.has(name)) info.excluded.add(name);
    }
  }
  if (depth === 0) cache.exports.set(key, info);
  return info;
}

// The calls of the subject's exported functions (named, default, or namespace-imported, directly or via
// tsconfig path aliases and barrel re-exports, optionally awaited) with written arguments that a test of the
// given names makes directly in its body without pinning the result down.
export function weakCalls(text, testFile, subjectFile, testNames, ts = loadTypeScript(), context = {}) {
  const tree = ts.createSourceFile(testFile, text, ts.ScriptTarget.Latest, true);
  const K = ts.SyntaxKind;
  const testPosix = testFile.split(sep).join('/');
  const subjectPosix = subjectFile.split(sep).join('/');
  const subjectStem = subjectPosix.replace(extension, '');
  const root = context.root ? canonicalPath(context.root) : null;
  const cache = context.cache ?? { tsconfigs: new Map(), resolved: new Map(), asts: new Map(), exports: new Map() };
  const imported = new Set();
  // Map of namespace identifier -> null (any member) or Set of member names originating from subjectFile.
  const namespaces = new Map();
  const addNamespace = (name, members) => {
    if (!namespaces.has(name) || members === null) { namespaces.set(name, members); return; }
    const existing = namespaces.get(name);
    if (existing === null) return;
    if (existing instanceof Set && members instanceof Set) {
      for (const member of members) existing.add(member);
    } else {
      namespaces.set(name, members);
    }
  };
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    let info = null;
    if (root) {
      const resolved = resolveModuleInRoot(root, testPosix, specifier, ts, cache);
      if (resolved) info = exportsFromSubject(root, resolved, subjectPosix, ts, cache);
    }
    if (!info && specifier.startsWith('.')) {
      const target = posix.join(posix.dirname(testPosix), specifier).replace(extension, '');
      if (target === subjectStem || target + '/index' === subjectStem) {
        info = { all: true, excluded: new Set(), names: new Set(), defaultExport: true, namespaces: new Map() };
      }
    }
    if (!info) continue;
    if (statement.importClause?.name && info.defaultExport) imported.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const orig = (element.propertyName ?? element.name).text;
        const local = element.name.text;
        if (info.namespaces.has(orig)) addNamespace(local, info.namespaces.get(orig));
        else if (orig === 'default' ? info.defaultExport : (info.names.has(orig) || (info.all && !info.excluded.has(orig)))) imported.add(local);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      if (info.all) addNamespace(bindings.name.text, info.excluded.size ? { all: true, excluded: new Set(info.excluded) } : null);
      else if (info.names.size) addNamespace(bindings.name.text, new Set(info.names));
    }
  }
  if (!imported.size && !namespaces.size) return [];
  const strip = node => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  const up = node => {
    let child = node;
    while (ts.isParenthesizedExpression(child.parent)) child = child.parent;
    return [child.parent, child];
  };
  function written(node) {
    const inner = strip(node);
    if (ts.isNumericLiteral(inner) || ts.isBigIntLiteral(inner) || ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ||
        [K.TrueKeyword, K.FalseKeyword, K.NullKeyword].includes(inner.kind) || (ts.isIdentifier(inner) && inner.text === 'undefined')) return true;
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === K.MinusToken) return ts.isNumericLiteral(inner.operand) || ts.isBigIntLiteral(inner.operand);
    if (ts.isArrayLiteralExpression(inner)) return inner.elements.every(written);
    if (ts.isObjectLiteralExpression(inner)) {
      return inner.properties.every(property => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && written(property.initializer));
    }
    return false;
  }
  function collectBindingNames(binding, out) {
    if (!binding) return;
    if (ts.isIdentifier(binding)) out.add(binding.text);
    else if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
      for (const element of binding.elements) {
        if (ts.isBindingElement(element)) collectBindingNames(element.name, out);
      }
    }
  }
  function collectHoistedVars(node, out) {
    if (!node) return;
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const decl of node.declarations) collectBindingNames(decl.name, out);
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node)) return;
    ts.forEachChild(node, child => collectHoistedVars(child, out));
  }
  function localBindingsIn(container) {
    const names = new Set();
    const record = statement => {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) collectBindingNames(decl.name, names);
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        names.add(statement.name.text);
      }
    };
    if (ts.isSourceFile(container)) {
      for (const statement of container.statements) collectHoistedVars(statement, names);
    } else if (ts.isBlock(container) || ts.isModuleBlock(container)) {
      for (const statement of container.statements) record(statement);
    } else if (ts.isCaseClause(container) || ts.isDefaultClause(container)) {
      for (const statement of container.statements) record(statement);
    } else if (ts.isFunctionLike(container)) {
      if (container.name && ts.isIdentifier(container.name)) names.add(container.name.text);
      for (const param of container.parameters) collectBindingNames(param.name, names);
      if (container.body) collectHoistedVars(container.body, names);
    } else if (ts.isCatchClause(container) && container.variableDeclaration) {
      collectBindingNames(container.variableDeclaration.name, names);
    } else if ((ts.isForStatement(container) || ts.isForInStatement(container) || ts.isForOfStatement(container)) &&
        container.initializer && ts.isVariableDeclarationList(container.initializer)) {
      for (const decl of container.initializer.declarations) collectBindingNames(decl.name, names);
    }
    return names;
  }
  function isSubjectCall(node, shadowed) {
    if (!ts.isCallExpression(node) || node.questionDotToken) return false;
    if (ts.isIdentifier(node.expression)) return imported.has(node.expression.text) && !shadowed.has(node.expression.text);
    if (ts.isPropertyAccessExpression(node.expression) && !node.expression.questionDotToken &&
        ts.isIdentifier(node.expression.expression) && ts.isIdentifier(node.expression.name)) {
      const ns = node.expression.expression.text;
      if (!namespaces.has(ns) || shadowed.has(ns)) return false;
      const allowed = namespaces.get(ns);
      const member = node.expression.name.text;
      if (allowed === null) return true;
      if (allowed instanceof Set) return allowed.has(member);
      return allowed.all && !allowed.excluded.has(member);
    }
    return false;
  }
  // The matcher an `expect(call)` is checked with, or nothing when the chain is not a plain matcher call.
  function weakExpectation(expectCall) {
    const names = [];
    let [parent, child] = up(expectCall);
    while (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
      names.push(parent.name.text);
      [parent, child] = up(parent);
    }
    if (!names.length || !ts.isCallExpression(parent) || parent.expression !== child || names.includes('resolves') || names.includes('rejects')) return false;
    if (!ts.isExpressionStatement(up(parent)[0])) return false;
    return names.includes('not') || !pinning.has(names.at(-1));
  }
  // The titles of the suites around a test, outermost first, or nothing where one of them is not written out.
  function suitesOf(call) {
    const titles = [];
    for (let node = call.parent; node; node = node.parent) {
      // The callback is the last argument: options may stand before it.
      if (!ts.isCallExpression(node) || !node.arguments.some(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) continue;
      // `describe.skip(...)`, and `describe.each(rows)(...)`, whose title is a pattern filled in per row.
      let callee = node.expression;
      let each = false;
      while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
        each ||= ts.isCallExpression(callee);
        callee = callee.expression;
      }
      if (!ts.isIdentifier(callee) || !['describe', 'suite'].includes(callee.text)) continue;
      if (each || !node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) return undefined;
      titles.unshift(node.arguments[0].text);
    }
    return titles;
  }

  // The title of the test whose body holds the statement directly, with the suites around it.
  function testOf(statement) {
    const body = statement.parent;
    const callback = ts.isBlock(body) ? body.parent : null;
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isCallExpression(callback.parent)) return undefined;
    const call = callback.parent;
    const title = call.arguments[0];
    // Options may stand before the callback and a timeout after it.
    if (!ts.isIdentifier(call.expression) || !['it', 'test'].includes(call.expression.text) || call.arguments.indexOf(callback) < 1 ||
        !title || !ts.isStringLiteralLike(title)) return undefined;
    return { title: title.text, suites: suitesOf(call) };
  }
  const found = [];
  // Every test of the file whose name is written out in full, with or without a call to take.
  const spelled = new Set();
  (function visit(node, shadowed) {
    const locals = localBindingsIn(node);
    const scope = locals.size ? new Set([...shadowed, ...locals]) : shadowed;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['it', 'test'].includes(node.expression.text) && node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])) {
      const suites = suitesOf(node);
      if (suites) spelled.add([...suites, node.arguments[0].text].join(' > '));
    }
    if (isSubjectCall(node, scope) && (node.arguments.every(written) || context.allowBoundNonLiteral)) {
      let target = node;
      let awaited = false;
      let [parent, child] = up(node);
      if (ts.isAwaitExpression(parent) && parent.expression === child) {
        target = parent;
        awaited = true;
        [parent, child] = up(target);
      }
      let statement;
      let bound;
      if (ts.isExpressionStatement(parent)) statement = parent;
      else if (ts.isVariableDeclaration(parent) && parent.initializer === child && ts.isVariableStatement(parent.parent.parent)) {
        statement = parent.parent.parent;
        if (ts.isIdentifier(parent.name)) bound = parent.name.text;
      } else if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'expect' &&
          parent.arguments.length === 1 && weakExpectation(parent)) {
        let outer = parent;
        while (!ts.isExpressionStatement(outer)) outer = outer.parent;
        statement = outer;
      }
      if (!node.arguments.every(written) && !bound) {
        ts.forEachChild(node, childNode => visit(childNode, scope));
        return;
      }
      const { title, suites } = (statement && testOf(statement)) ?? {};
      const start = target.getStart(tree);
      const call = text.slice(start, target.end);
      if (title !== undefined && !/[\n\r]/.test(call)) {
        const { line, character } = tree.getLineAndCharacterOfPosition(start);
        found.push({ start, end: target.end, text: call, test: title, full: suites && [...suites, title].join(' > '), line: line + 1, column: character + 1,
          ...(bound ? { bound } : {}), ...(awaited ? { awaited: true } : {}) });
      }
    }
    ts.forEachChild(node, childNode => visit(childNode, scope));
  })(tree, new Set());
  // A test is named with its suites. Where a suite's title is not written out, the test's own title has to do,
  // for the names that no fully written test of the file has.
  return found.filter(call => (call.full !== undefined ? testNames.includes(call.full)
    : testNames.some(name => !spelled.has(name) && (name === call.test || name.endsWith(' > ' + call.test)))))
    .map(({ full: _full, ...call }) => call);
}

const nonValueMatchers = new Set([
  'toThrow', 'toThrowError', 'toHaveBeenCalled', 'toHaveBeenCalledTimes', 'toHaveBeenCalledWith',
  'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith', 'toHaveReturned', 'toHaveReturnedTimes',
  'toHaveReturnedWith', 'toHaveLastReturnedWith', 'toHaveNthReturnedWith',
]);

function suitesOfNode(call, ts) {
  const titles = [];
  for (let node = call.parent; node; node = node.parent) {
    if (!ts.isCallExpression(node) || !node.arguments.some(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) continue;
    let callee = node.expression;
    let each = false;
    while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
      each ||= ts.isCallExpression(callee);
      callee = callee.expression;
    }
    if (!ts.isIdentifier(callee) || !['describe', 'suite'].includes(callee.text)) continue;
    if (each || !node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) return undefined;
    titles.unshift(node.arguments[0].text);
  }
  return titles;
}

function collectTestBlocks(tree, testNames, ts) {
  const found = [];
  const spelled = new Set();
  (function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['it', 'test'].includes(node.expression.text) &&
        node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const suites = suitesOfNode(node, ts);
      const title = node.arguments[0].text;
      if (suites) spelled.add([...suites, title].join(' > '));
      const callback = node.arguments.slice(1).find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if (callback && ts.isBlock(callback.body)) {
        found.push({ title, suites, full: suites && [...suites, title].join(' > '), body: callback.body, callNode: node });
      }
    }
    ts.forEachChild(node, visit);
  })(tree);
  return found.filter(entry => (entry.full !== undefined ? testNames.includes(entry.full)
    : testNames.some(name => !spelled.has(name) && (name === entry.title || name.endsWith(' > ' + entry.title)))));
}

// Only side-effect-free read expressions (identifiers, property/element accesses, and literal indices) are
// eligible for weak `expect(<expr>)` wrapping, avoiding comma expressions, operator-precedence traps, and
// stateful calls such as `iterator.next().value`.
function isSafeReadExpr(node, ts) {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (ts.isIdentifier(inner)) return true;
  if (ts.isPropertyAccessExpression(inner)) return isSafeReadExpr(inner.expression, ts);
  if (ts.isElementAccessExpression(inner) && inner.argumentExpression) {
    let idx = inner.argumentExpression;
    while (ts.isParenthesizedExpression(idx)) idx = idx.expression;
    const safeIdx = ts.isNumericLiteral(idx) || ts.isStringLiteral(idx) || ts.isNoSubstitutionTemplateLiteral(idx) ||
      isSafeReadExpr(idx, ts);
    return safeIdx && isSafeReadExpr(inner.expression, ts);
  }
  return false;
}

// Weak `expect(<expr>).<matcher>(...)` expressions directly inside named tests, regardless of whether `<expr>` is
// a direct subject call (covers Proxy properties, DOM queries, and non-literal bound variables).
export function weakExpectations(text, testFile, testNames, ts = loadTypeScript()) {
  const tree = ts.createSourceFile(testFile, text, ts.ScriptTarget.Latest, true);
  const blocks = collectTestBlocks(tree, testNames, ts);
  const found = [];
  for (const { title, body } of blocks) {
    for (const statement of body.statements) {
      if (!ts.isExpressionStatement(statement)) continue;
      let expr = statement.expression;
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (!ts.isCallExpression(expr)) continue;
      const names = [];
      let cursor = expr.expression;
      while (ts.isParenthesizedExpression(cursor)) cursor = cursor.expression;
      while (ts.isPropertyAccessExpression(cursor)) {
        names.unshift(cursor.name.text);
        cursor = cursor.expression;
        while (ts.isParenthesizedExpression(cursor)) cursor = cursor.expression;
      }
      if (!names.length || !ts.isCallExpression(cursor) || !ts.isIdentifier(cursor.expression) ||
          cursor.expression.text !== 'expect' || cursor.arguments.length !== 1) continue;
      if (names.includes('resolves') || names.includes('rejects')) continue;
      const matcher = names.at(-1);
      if (nonValueMatchers.has(matcher)) continue;
      const isWeak = names.includes('not') || !pinning.has(matcher);
      if (!isWeak) continue;
      const rawArg = cursor.arguments[0];
      if (!isSafeReadExpr(rawArg, ts)) continue;
      const start = rawArg.getStart(tree);
      const exprText = text.slice(start, rawArg.end);
      if (!exprText || /[\n\r]/.test(exprText)) continue;
      const { line, character } = tree.getLineAndCharacterOfPosition(start);
      found.push({
        start, end: rawArg.end, text: exprText, test: title, line: line + 1, column: character + 1,
      });
    }
  }
  return found;
}

// Local variables declared at top-level of each named test body, for end-of-test side-effect state comparison
// (Proxy stores, DOM elements, callback counters, event arrays) when direct call/expect wrapping finds nothing.
export function testEndTargets(text, testFile, testNames, ts = loadTypeScript()) {
  const tree = ts.createSourceFile(testFile, text, ts.ScriptTarget.Latest, true);
  const blocks = collectTestBlocks(tree, testNames, ts);
  const collectNames = (binding, out) => {
    if (!binding) return;
    if (ts.isIdentifier(binding)) {
      if (!binding.text.startsWith('_')) out.push(binding.text);
    } else if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
      for (const el of binding.elements) if (ts.isBindingElement(el)) collectNames(el.name, out);
    }
  };
  const targets = [];
  for (const { title, body } of blocks) {
    if (!body.statements.length) continue;
    if (body.statements.some(stmt => ts.isReturnStatement(stmt))) continue;
    const vars = [];
    for (const stmt of body.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) collectNames(decl.name, vars);
      }
    }
    const uniqueVars = [...new Set(vars)].slice(0, 12);
    if (!uniqueVars.length) continue;
    const insertAt = body.end - 1;
    const lastStmt = body.statements.at(-1);
    const { line, character } = tree.getLineAndCharacterOfPosition(lastStmt.getStart(tree));
    targets.push({ insertAt, vars: uniqueVars, test: title, line: line + 1, column: character + 1 });
  }
  return targets;
}

// Wraps the end of one test body to snapshot observable local variables (primitives, arrays, plain/Proxy objects,
// and DOM elements) after all test actions and existing assertions complete normally.
export function recordingTestEndState(text, target, key) {
  const fnName = `__tmtEndState_${key}`;
  const captures = target.vars.map(name => `try { __s[${JSON.stringify(name)}] = ${name}; } catch (e) {}`).join(' ');
  const hook = `\n;(() => { var __s = Object.create(null); ${captures} ${fnName}(__s); })();\n`;
  const helper = `
var __tmtEndFiles_${key};
var __tmtEndUtil_${key};
try { __tmtEndFiles_${key} = globalThis.process.getBuiltinModule('node:fs'); } catch (error) { /* taken at first call */ }
try { __tmtEndUtil_${key} = globalThis.process.getBuiltinModule('node:util'); } catch (error) { /* taken at first call */ }
function ${fnName}(locals) {
  if (!__tmtEndUtil_${key}) {
    try { __tmtEndUtil_${key} = globalThis.process.getBuiltinModule('node:util'); } catch (error) { /* unavailable */ }
  }
  var isProxy = __tmtEndUtil_${key} && __tmtEndUtil_${key}.types && typeof __tmtEndUtil_${key}.types.isProxy === 'function' ? __tmtEndUtil_${key}.types.isProxy : null;
  function fmtPrim(v) {
    var t = typeof v;
    if (v === null || t === 'boolean' || t === 'undefined') return String(v);
    if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (t === 'string') return v.length <= 200 ? JSON.stringify(v) : null;
    if (t === 'bigint') return v + 'n';
    return null;
  }
  function isDomElement(v) {
    try { return Boolean(v && typeof v === 'object' && v.nodeType === 1 && typeof v.tagName === 'string'); } catch (e) { return false; }
  }
  function snapDom(el, depth) {
    var props = Object.create(null);
    var numProps = ['childElementCount', 'scrollTop', 'scrollLeft'];
    for (var i = 0; i < numProps.length; i++) {
      try {
        var nv = el[numProps[i]];
        if (typeof nv === 'number' && !Number.isNaN(nv)) props[numProps[i]] = Object.is(nv, -0) ? '-0' : String(nv);
      } catch (e) {}
    }
    var boolProps = ['hidden', 'disabled', 'checked'];
    for (var b = 0; b < boolProps.length; b++) {
      try {
        if (boolProps[b] in el && typeof el[boolProps[b]] === 'boolean') props[boolProps[b]] = String(el[boolProps[b]]);
      } catch (e) {}
    }
    var strProps = ['value', 'className', 'textContent'];
    for (var s = 0; s < strProps.length; s++) {
      try {
        if (strProps[s] in el && typeof el[strProps[s]] === 'string' && el[strProps[s]].length <= 200) {
          props[strProps[s]] = JSON.stringify(el[strProps[s]]);
        }
      } catch (e) {}
    }
    var attrs = Object.create(null);
    var attrsTruncated = false;
    var skippedAttrs = [];
    try {
      var list = el.attributes;
      if (list && typeof list.length === 'number') {
        if (list.length > 20) attrsTruncated = true;
        var attrCount = Math.min(list.length, 20);
        for (var a = 0; a < attrCount; a++) {
          var item = list[a];
          if (!item || typeof item.name !== 'string' || item.name === 'style') continue;
          if (typeof item.value === 'string' && item.value.length <= 200) attrs[item.name] = JSON.stringify(item.value);
          else skippedAttrs.push(item.name);
        }
      }
    } catch (e) { attrsTruncated = true; }
    var style = Object.create(null);
    var styleTruncated = false;
    var skippedStyles = [];
    try {
      var st = el.style;
      if (st && typeof st === 'object') {
        var styleKeys = [];
        if (typeof st.length === 'number') {
          if (st.length > 20) styleTruncated = true;
          var stLen = Math.min(st.length, 20);
          for (var si = 0; si < stLen; si++) {
            var sp = st[si];
            if (typeof sp === 'string' && sp) styleKeys.push(sp);
          }
        }
        var common = ['display', 'visibility', 'opacity', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'minHeight', 'maxHeight', 'transform', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'overflow', 'zIndex'];
        for (var ci = 0; ci < common.length; ci++) styleKeys.push(common[ci]);
        var seenStyle = Object.create(null);
        for (var sk = 0; sk < styleKeys.length; sk++) {
          var propName = styleKeys[sk];
          if (seenStyle[propName]) continue;
          seenStyle[propName] = true;
          var sv = propName.indexOf('--') === 0 && typeof st.getPropertyValue === 'function' ? st.getPropertyValue(propName) : (typeof st[propName] === 'string' ? st[propName] : (typeof st.getPropertyValue === 'function' ? st.getPropertyValue(propName) : ''));
          if (typeof sv === 'string' && sv.length > 0) {
            if (sv.length <= 200) style[propName] = JSON.stringify(sv);
            else skippedStyles.push(propName);
          }
        }
      }
    } catch (e) { styleTruncated = true; }
    var children = [];
    if (depth === 0) {
      try {
        var ch = el.children;
        if (ch && typeof ch.length === 'number') {
          var cLen = Math.min(ch.length, 8);
          for (var c = 0; c < cLen; c++) {
            if (isDomElement(ch[c])) children.push(snapDom(ch[c], 1));
          }
        }
      } catch (e) {}
    }
    var tag = '';
    try { tag = String(el.tagName); } catch (e) {}
    return { k: 'dom', tag: tag, props: props, attrs: attrs, attrsTruncated: attrsTruncated, skippedAttrs: skippedAttrs, style: style, styleTruncated: styleTruncated, skippedStyles: skippedStyles, children: children };
  }
  function fmtExact(v, depth, seen) {
    var prim = fmtPrim(v);
    if (prim !== null) return prim;
    if (typeof v !== 'object' || v === null || depth >= 3 || isDomElement(v)) return null;
    if (isProxy && isProxy(v)) return null;
    if (seen.indexOf(v) >= 0) return null;
    var nextSeen = seen.concat([v]);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 20 || Object.getOwnPropertySymbols(v).length > 0 || Object.getOwnPropertyNames(v).length !== v.length + 1) return null;
      var items = [];
      for (var i = 0; i < v.length; i++) {
        var d = Object.getOwnPropertyDescriptor(v, i);
        if (!d || !('value' in d) || !d.enumerable) return null;
        var fItem = fmtExact(d.value, depth + 1, nextSeen);
        if (fItem === null) return null;
        items.push(fItem);
      }
      return '[' + items.join(', ') + ']';
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Object.getOwnPropertySymbols(v).length > 0) return null;
    var keys = Object.keys(v);
    if (keys.length > 20 || Object.getOwnPropertyNames(v).length !== keys.length) return null;
    keys.sort();
    var pairs = [];
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j], desc = Object.getOwnPropertyDescriptor(v, k);
      if (k === '__proto__' || !desc || !('value' in desc)) return null;
      var fVal = fmtExact(desc.value, depth + 1, nextSeen);
      if (fVal === null) return null;
      var label = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      pairs.push(label + ': ' + fVal);
    }
    return pairs.length ? '{ ' + pairs.join(', ') + ' }' : '{}';
  }
  function snapValue(v, depth, seen) {
    if (isDomElement(v)) return snapDom(v, 0);
    try {
      var exact = fmtExact(v, depth, seen);
      if (exact !== null) return { k: 'val', v: exact };
    } catch (e) {}
    if (typeof v !== 'object' || v === null || depth >= 3) return null;
    if (v instanceof Date || v instanceof RegExp || v instanceof Error || v instanceof Map || v instanceof Set || v instanceof Promise) return null;
    if (seen.indexOf(v) >= 0) return null;
    var nextSeen = seen.concat([v]);
    var isArr = false;
    try { isArr = Array.isArray(v); } catch (e) { return null; }
    if (isArr) {
      // Only fall back for Proxy-wrapped dense arrays without extra own properties; never reconstruct sparse or
      // augmented arrays as plain array literals for toStrictEqual.
      if (!isProxy || !isProxy(v)) return null;
      var len = 0;
      try {
        len = v.length;
        if (len > 20 || Object.getOwnPropertySymbols(v).length > 0 || Object.getOwnPropertyNames(v).length !== len + 1) return null;
      } catch (e) { return null; }
      var items = [];
      for (var i = 0; i < len; i++) {
        var elVal;
        try {
          if (!(i in v)) return null;
          elVal = v[i];
        } catch (e) { return null; }
        var fEl = fmtExact(elVal, depth + 1, nextSeen);
        if (fEl === null) return null;
        items.push(fEl);
      }
      return { k: 'val', v: '[' + items.join(', ') + ']' };
    }
    var keys;
    try { keys = Object.keys(v); } catch (e) { return null; }
    if (keys.length === 0 || keys.length > 20) return null;
    keys.sort();
    var objIsProxy = Boolean(isProxy && isProxy(v));
    var fields = Object.create(null);
    var fieldCount = 0;
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if (k === '__proto__') continue;
      if (!objIsProxy) {
        var ownDesc;
        try { ownDesc = Object.getOwnPropertyDescriptor(v, k); } catch (e) { continue; }
        // Skip accessor getters on non-Proxy objects so snapshot reads cannot trigger stateful side effects.
        if (!ownDesc || !('value' in ownDesc)) continue;
      }
      var propVal;
      try { propVal = v[k]; } catch (e) { continue; }
      if (typeof propVal === 'function' || typeof propVal === 'symbol') continue;
      var childSnap = snapValue(propVal, depth + 1, nextSeen);
      if (childSnap && (childSnap.k === 'val' || childSnap.k === 'partialObj')) {
        fields[k] = childSnap;
        fieldCount++;
      }
    }
    return fieldCount > 0 ? { k: 'partialObj', fields: fields } : null;
  }
  var out = Object.create(null);
  var varNames = Object.keys(locals);
  for (var idx = 0; idx < varNames.length; idx++) {
    var name = varNames[idx];
    try {
      var entry = snapValue(locals[name], 0, []);
      if (entry) out[name] = entry;
    } catch (e) {}
  }
  (__tmtEndFiles_${key} || (__tmtEndFiles_${key} = globalThis.process.getBuiltinModule('node:fs'))).appendFileSync(new URL('./.tmt-values-${key}.jsonl', import.meta.url), JSON.stringify(out) + '\\n');
}
`;
  return text.slice(0, target.insertAt) + hook + text.slice(target.insertAt) + helper;
}

function formatStyleAccess(baseExpr, propName) {
  if (propName.startsWith('--')) return `${baseExpr}.style.getPropertyValue(${JSON.stringify(propName)})`;
  const camel = propName.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(camel)
    ? `${baseExpr}.style.${camel}`
    : `${baseExpr}.style.getPropertyValue(${JSON.stringify(propName)})`;
}

function diffDomSnapshots(baseExpr, orig, edit) {
  const propOrder = ['childElementCount', 'scrollTop', 'scrollLeft', 'hidden', 'disabled', 'checked', 'value', 'className'];
  for (const prop of propOrder) {
    if (orig.props?.[prop] !== undefined && edit.props?.[prop] !== undefined && orig.props[prop] !== edit.props[prop]) {
      return { expression: `${baseExpr}.${prop}`, original: orig.props[prop], edited: edit.props[prop] };
    }
  }
  const origSkippedStyles = new Set(orig.skippedStyles ?? []);
  const editSkippedStyles = new Set(edit.skippedStyles ?? []);
  const styleKeys = [...new Set([...Object.keys(orig.style ?? {}), ...Object.keys(edit.style ?? {})])].sort();
  for (const prop of styleKeys) {
    const inOrig = Object.hasOwn(orig.style ?? {}, prop);
    const inEdit = Object.hasOwn(edit.style ?? {}, prop);
    if (!inOrig && (orig.styleTruncated || origSkippedStyles.has(prop))) continue;
    if (!inEdit && (edit.styleTruncated || editSkippedStyles.has(prop))) continue;
    const o = inOrig ? orig.style[prop] : '""';
    const e = inEdit ? edit.style[prop] : '""';
    if (o !== e) {
      return { expression: formatStyleAccess(baseExpr, prop), original: o, edited: e };
    }
  }
  const origSkippedAttrs = new Set(orig.skippedAttrs ?? []);
  const editSkippedAttrs = new Set(edit.skippedAttrs ?? []);
  const attrKeys = [...new Set([...Object.keys(orig.attrs ?? {}), ...Object.keys(edit.attrs ?? {})])].sort();
  for (const attr of attrKeys) {
    const inOrig = Object.hasOwn(orig.attrs ?? {}, attr);
    const inEdit = Object.hasOwn(edit.attrs ?? {}, attr);
    if (!inOrig && (orig.attrsTruncated || origSkippedAttrs.has(attr))) continue;
    if (!inEdit && (edit.attrsTruncated || editSkippedAttrs.has(attr))) continue;
    const o = inOrig ? orig.attrs[attr] : 'null';
    const e = inEdit ? edit.attrs[attr] : 'null';
    if (o !== e) {
      return { expression: `${baseExpr}.getAttribute(${JSON.stringify(attr)})`, original: o, edited: e };
    }
  }
  if (orig.props?.textContent !== undefined && edit.props?.textContent !== undefined && orig.props.textContent !== edit.props.textContent) {
    return { expression: `${baseExpr}.textContent`, original: orig.props.textContent, edited: edit.props.textContent };
  }
  const origChildren = orig.children ?? [];
  const editChildren = edit.children ?? [];
  const shared = Math.min(origChildren.length, editChildren.length);
  for (let i = 0; i < shared; i++) {
    const childDiff = diffDomSnapshots(`${baseExpr}.children[${i}]`, origChildren[i], editChildren[i]);
    if (childDiff) return childDiff;
  }
  return null;
}

function diffPartialObject(baseExpr, origFields, editFields, ts, prefixPath = []) {
  const keys = Object.keys(origFields ?? {}).sort();
  for (const key of keys) {
    if (!Object.hasOwn(editFields ?? {}, key)) continue;
    const o = origFields[key];
    const e = editFields[key];
    if (!o || !e || o.k !== e.k) continue;
    const nextPath = [...prefixPath, key];
    if (o.k === 'partialObj') {
      const deeper = diffPartialObject(baseExpr, o.fields, e.fields, ts, nextPath);
      if (deeper) return deeper;
    } else if (o.k === 'val' && o.v !== e.v) {
      const narrowed = narrowSiblingPath(o.v, e.v, ts);
      const path = narrowed ? [...nextPath, ...narrowed.path] : nextPath;
      const expression = formatTargetPath(baseExpr, path);
      const original = narrowed ? narrowed.original : o.v;
      const edited = narrowed ? narrowed.edited : e.v;
      return {
        expression,
        original,
        edited,
        path,
        suggestedTest: `expect(${expression}).${matcherFor(original)}(${original})`,
      };
    }
  }
  return null;
}

export function diffEndSnapshots(origSnap, editSnap, ts = loadTypeScript()) {
  if (!origSnap || !editSnap || typeof origSnap !== 'object' || typeof editSnap !== 'object') return null;
  for (const name of Object.keys(origSnap)) {
    const origEntry = origSnap[name];
    const editEntry = editSnap[name];
    if (!origEntry || !editEntry || origEntry.k !== editEntry.k) continue;
    if (origEntry.k === 'dom') {
      const domDiff = diffDomSnapshots(name, origEntry, editEntry);
      if (domDiff) {
        return {
          ...domDiff,
          suggestedTest: `expect(${domDiff.expression}).${matcherFor(domDiff.original)}(${domDiff.original})`,
        };
      }
    } else if (origEntry.k === 'partialObj') {
      // Never emit whole-object `toStrictEqual` on partially observed objects (e.g. Proxies or objects with methods).
      const partialDiff = diffPartialObject(name, origEntry.fields, editEntry.fields, ts);
      if (partialDiff) return partialDiff;
    } else if (origEntry.k === 'val' && origEntry.v !== editEntry.v) {
      const narrowed = narrowSiblingPath(origEntry.v, editEntry.v, ts);
      const expression = narrowed ? formatTargetPath(name, narrowed.path) : name;
      const original = narrowed ? narrowed.original : origEntry.v;
      const edited = narrowed ? narrowed.edited : editEntry.v;
      return {
        expression,
        original,
        edited,
        ...(narrowed ? { path: narrowed.path } : {}),
        suggestedTest: `expect(${expression}).${matcherFor(original)}(${original})`,
      };
    }
  }
  return null;
}

// The test file with one call wrapped so that every value it gives is written beside the file.
// Supports primitives (`toBe`) and plain, acyclic, bounded arrays and objects (`toStrictEqual`) without invoking getters or Proxy traps.
export function recordingCall(text, call, key) {
  const name = `__tmtValue_${key}`;
  // The file system and `node:util` are taken from Node itself, when the file has loaded or else at the first call: a test may
  // replace the module with a mock, or `process` with something else for a while.
  const helper = `
var __tmtFiles_${key};
var __tmtUtil_${key};
try { __tmtFiles_${key} = globalThis.process.getBuiltinModule('node:fs'); } catch (error) { /* taken at the first call */ }
try { __tmtUtil_${key} = globalThis.process.getBuiltinModule('node:util'); } catch (error) { /* taken at the first call */ }
function ${name}(value) {
  if (!__tmtUtil_${key}) {
    try { __tmtUtil_${key} = globalThis.process.getBuiltinModule('node:util'); } catch (error) { /* unavailable */ }
  }
  var isProxy = __tmtUtil_${key} && __tmtUtil_${key}.types && typeof __tmtUtil_${key}.types.isProxy === 'function' ? __tmtUtil_${key}.types.isProxy : null;
  function fmt(v, depth, seen) {
    var type = typeof v;
    if (v === null || type === 'boolean' || type === 'undefined') return String(v);
    if (type === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (type === 'string') return JSON.stringify(v);
    if (type === 'bigint') return v + 'n';
    if (type !== 'object' || depth >= 4 || !isProxy || isProxy(v)) return null;
    if (seen.indexOf(v) >= 0) return null;
    var nextSeen = seen.concat([v]);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) return null;
      if (v.length > 20 || Object.getOwnPropertySymbols(v).length > 0 || Object.getOwnPropertyNames(v).length !== v.length + 1) return null;
      var items = [];
      for (var i = 0; i < v.length; i++) {
        var d = Object.getOwnPropertyDescriptor(v, i);
        if (!d || !('value' in d) || !d.enumerable) return null;
        var item = fmt(d.value, depth + 1, nextSeen);
        if (item === null) return null;
        items.push(item);
      }
      return '[' + items.join(', ') + ']';
    }
    if (Object.getOwnPropertySymbols(v).length > 0) return null;
    if (Object.getPrototypeOf(v) !== Object.prototype) return null;
    var keys = Object.keys(v);
    if (keys.length > 20 || Object.getOwnPropertyNames(v).length !== keys.length) return null;
    keys.sort();
    var pairs = [];
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j], desc = Object.getOwnPropertyDescriptor(v, k);
      if (k === '__proto__' || !desc || !('value' in desc)) return null;
      var val = fmt(desc.value, depth + 1, nextSeen);
      if (val === null) return null;
      var label = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      pairs.push(label + ': ' + val);
    }
    return pairs.length ? '{ ' + pairs.join(', ') + ' }' : '{}';
  }
  var shown = null;
  try { shown = fmt(value, 0, []); } catch (error) { shown = null; }
  (__tmtFiles_${key} || (__tmtFiles_${key} = globalThis.process.getBuiltinModule('node:fs'))).appendFileSync(new URL('./.tmt-values-${key}.jsonl', import.meta.url), JSON.stringify(shown) + '\\n');
  return value;
}
`;
  return text.slice(0, call.start) + `${name}(${call.text})` + text.slice(call.end) + helper;
}

const valuesOf = run => (run.collected ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));
const matcherFor = formatted => (formatted.startsWith('[') || formatted.startsWith('{')) ? 'toStrictEqual' : 'toBe';

function parseFormattedObject(formatted, ts) {
  if (typeof formatted !== 'string' || !formatted.startsWith('{') || !formatted.endsWith('}')) return null;
  const wrapped = `(${formatted})`;
  const tree = ts.createSourceFile('value.js', wrapped, ts.ScriptTarget.Latest, false);
  if (tree.parseDiagnostics.length || tree.statements.length !== 1 || !ts.isExpressionStatement(tree.statements[0])) return null;
  let expr = tree.statements[0].expression;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isObjectLiteralExpression(expr)) return null;
  const entries = new Map();
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop)) return null;
    const name = prop.name;
    let key;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) key = name.text;
    else return null;
    if (key === '__proto__' || entries.has(key)) return null;
    entries.set(key, wrapped.slice(prop.initializer.getStart(tree), prop.initializer.end));
  }
  return entries;
}

export function narrowSiblingPath(originalText, editedText, ts = loadTypeScript()) {
  const origMap = parseFormattedObject(originalText, ts);
  const editMap = parseFormattedObject(editedText, ts);
  if (!origMap || !editMap || origMap.size < 2) return null;
  const keys = new Set([...origMap.keys(), ...editMap.keys()]);
  const diffKeys = [];
  for (const key of keys) {
    if (!origMap.has(key) || !editMap.has(key) || origMap.get(key) !== editMap.get(key)) diffKeys.push(key);
  }
  if (diffKeys.length !== 1) return null;
  const [key] = diffKeys;
  if (!origMap.has(key) || !editMap.has(key)) return null;
  const origChild = origMap.get(key);
  const editChild = editMap.get(key);
  if (origChild.startsWith('{') && editChild.startsWith('{')) {
    const deeper = narrowSiblingPath(origChild, editChild, ts);
    if (deeper) return { path: [key, ...deeper.path], original: deeper.original, edited: deeper.edited };
  }
  return { path: [key], original: origChild, edited: editChild };
}

function formatTargetPath(base, path, awaited = false) {
  const needsParens = path.length > 0 && (awaited || /^\s*await\b/.test(base) || !/^[A-Za-z_$][\w$.[\]()]*$/.test(base.trim()));
  let expr = needsParens ? `(${base})` : base;
  for (const key of path) {
    expr += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  return expr;
}

// Reuses one temporary project copy and one warm Vitest 4/5 child process (`cwd: workspace`, dedicated IPC channel,
// `isolate: true` per run) across all assertion-strength value recordings, terminating the child process group
// cleanly on timeout or exit.
async function withWarmAssertionSession(root, subjectsByFile, options, action) {
  return withCopy(root, async (workspace, temp) => {
    const configArg = options.config ?? '';
    const child = spawn(process.execPath, [sessionWorker, workspace, configArg], {
      cwd: workspace,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        VITE_CACHE_DIR: resolve(temp, 'vite-cache'),
        VITEST_FS_MODULE_CACHE: 'false',
        VITEST_FS_MODULE_CACHE_PATH: resolve(temp, 'vitest-fs-cache'),
      },
    });
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    const killGroup = () => {
      if (!child.pid) return;
      try {
        // On POSIX always signal the process group even if the group leader already exited, so surviving
        // worker descendants are terminated before `withCopy` deletes `workspace`.
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch { /* group already gone */ }
    };
    const pending = new Map();
    let readyResolve;
    const readyPromise = new Promise(resolveReady => { readyResolve = resolveReady; });
    let broken = false;
    child.on('message', msg => {
      if (!msg || typeof msg !== 'object') return;
      if ('ready' in msg && readyResolve) {
        const done = readyResolve;
        readyResolve = null;
        done(msg.ready === true);
        return;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    });
    const failPending = () => {
      broken = true;
      if (readyResolve) { const done = readyResolve; readyResolve = null; done(false); }
      for (const waiter of pending.values()) waiter({ closed: true });
      pending.clear();
    };
    child.once('exit', failPending);
    child.once('disconnect', failPending);
    const timeoutMs = (options.timeout ?? 60) * 1000;
    try {
      let bootTimer;
      const ready = await Promise.race([
        readyPromise,
        new Promise(resolveTimeout => { bootTimer = setTimeout(() => resolveTimeout(false), Math.min(timeoutMs, 30_000)); }),
      ]);
      clearTimeout(bootTimer);
      if (!ready) return null;
      let nextId = 1;
      const runInSession = async ({ testFile, rewriteContent, collect, trial }) => {
        if (broken || !child.connected) return null;
        const id = nextId++;
        const subject = trial ? subjectsByFile.get(trial.site.location.file) : null;
        let timer;
        const response = await new Promise(resolveWait => {
          pending.set(id, resolveWait);
          timer = setTimeout(() => {
            pending.delete(id);
            resolveWait({ timedOut: true });
          }, timeoutMs);
          try {
            child.send({
              id, testFile, rewriteContent, collect,
              ...(trial ? { trial: { edit: trial.edit, replacement: trial.replacement }, subjectFile: subject.file, subjectDigest: subject.digest } : {}),
            });
          } catch {
            pending.delete(id);
            resolveWait({ closed: true });
          }
        });
        clearTimeout(timer);
        if (response.timedOut) {
          broken = true;
          killGroup();
          await exited;
          return { collected: '' };
        }
        if (response.closed || response.unsupported || response.error) {
          return null;
        }
        return { collected: response.collected ?? '' };
      };
      return await action(runInSession);
    } finally {
      if (child.connected) {
        try { child.send({ close: true }); } catch { /* ignore */ }
      }
      let closeTimer;
      await Promise.race([
        exited,
        new Promise(resolveWait => { closeTimer = setTimeout(() => { killGroup(); resolveWait(); }, 5_000); }),
      ]);
      clearTimeout(closeTimer);
      killGroup();
      await exited;
    }
  }, { exclude: options['copy-exclude'], include: options['copy-include'] });
}

export async function strengthenAssertions(root, report, options, run = defaultRun) {
  const runnerFactory = run.sourceTrialsAsync ?? run.sourceTrials;
  const concurrency = options.concurrency ?? Math.max(1, Math.min(8, availableParallelism() - 1));
  const ts = loadTypeScript();
  const resolveContext = { root, allowBoundNonLiteral: true, cache: { tsconfigs: new Map(), resolved: new Map(), asts: new Map(), exports: new Map() } };
  const subjectsByFile = new Map();
  const candidates = [];
  for (const gap of report.diagnostics ?? []) {
    const mutation = gap.mutations?.[0];
    if (!gap.tests?.length || !mutation || gap.suggestedTest || !gap.location?.file) continue;
    let subject = subjectsByFile.get(gap.location.file);
    if (!subject) {
      const input = readFileSync(inside(root, gap.location.file));
      subject = { file: gap.location.file, input, digest: createHash('sha256').update(input).digest('hex'), sites: [] };
      subjectsByFile.set(gap.location.file, subject);
    }
    const trial = { site: { location: gap.location }, edit: mutation.source?.edit ?? mutation.edit, replacement: mutation.source?.replacement ?? mutation.replacement };
    const calls = [];
    const endTargets = [];
    const seenCallIds = new Set();
    for (const testFile of [...new Set(gap.tests.map(test => test.file))].slice(0, 2)) {
      const text = readFileSync(inside(root, testFile), 'utf8');
      const names = gap.tests.filter(test => test.file === testFile).map(test => test.name);
      const attempt = runnerFactory(root, [subject], { ...options, test: [testFile] });
      for (const call of weakCalls(text, testFile, gap.location.file, names, ts, resolveContext)) {
        if (calls.length >= 4) break;
        const id = `${testFile}:${call.start}`;
        if (seenCallIds.has(id)) continue;
        seenCallIds.add(id);
        calls.push({ id, testFile, text, call, attempt });
      }
      if (calls.length < 4) {
        for (const call of weakExpectations(text, testFile, names, ts)) {
          if (calls.length >= 4) break;
          const id = `${testFile}:${call.start}`;
          if (seenCallIds.has(id)) continue;
          seenCallIds.add(id);
          calls.push({ id, testFile, text, call, attempt });
        }
      }
      if (endTargets.length < 2) {
        for (const target of testEndTargets(text, testFile, names, ts)) {
          if (endTargets.length >= 2) break;
          const id = `end:${testFile}:${target.insertAt}`;
          endTargets.push({ id, testFile, text, target, attempt });
        }
      }
    }
    if (calls.length || endTargets.length) candidates.push({ gap, trial, calls, endTargets });
  }
  if (!candidates.length) return report;

  const originalPromises = new Map();
  let tried = 0;
  const evaluateCandidate = async ({ gap, trial, calls, endTargets }, sessionRun) => {
    let perGapTried = 0;
    // Reserve at least one trial slot for Pass 2 end-of-test state inspection when Pass 2 targets exist.
    const pass1Limit = endTargets.length ? 3 : 4;
    for (const { id, testFile, text, call, attempt } of calls) {
      if (tried >= 24 || perGapTried >= pass1Limit) break;
      let originalPromise = originalPromises.get(id);
      if (!originalPromise) {
        originalPromise = (async () => {
          const key = randomUUID().replaceAll('-', '');
          const collect = posix.join(posix.dirname(testFile.split(sep).join('/')), `.tmt-values-${key}.jsonl`);
          const rewriteContent = recordingCall(text, call, key);
          const sessionOutcome = sessionRun ? await sessionRun({ testFile, rewriteContent, collect }) : null;
          const outcome = sessionOutcome ?? await attempt({ witness: { rewrite: { file: testFile, content: rewriteContent } }, collect });
          return valuesOf(outcome);
        })();
        originalPromises.set(id, originalPromise);
        originalPromise.catch(() => { if (originalPromises.get(id) === originalPromise) originalPromises.delete(id); });
      }
      const original = await originalPromise;
      if (!original?.length || original.includes(null)) continue;
      if (tried >= 24 || perGapTried >= 4) break;
      tried++;
      perGapTried++;
      const key = randomUUID().replaceAll('-', '');
      const collect = posix.join(posix.dirname(testFile.split(sep).join('/')), `.tmt-values-${key}.jsonl`);
      const rewriteContent = recordingCall(text, call, key);
      const sessionOutcome = sessionRun ? await sessionRun({ testFile, rewriteContent, collect, trial }) : null;
      const outcome = sessionOutcome ?? await attempt({ witness: { rewrite: { file: testFile, content: rewriteContent } }, collect, trial });
      const edited = valuesOf(outcome);
      // The first time the call gives another comparable value with the edit. Where the edit keeps a test from making
      // the call, or returns an unformattable value, nothing is suggested.
      // The values are matched by their order, so the call has to be made as often with the edit as without.
      const at = edited.length === original.length
        ? original.findIndex((value, index) => edited[index] !== null && edited[index] !== value)
        : -1;
      if (at === -1) continue;
      // A result the test keeps is compared where it is kept: calling again may give another value.
      // When a multi-key plain object differs along a single sibling field path, narrow the suggestion to that path.
      const narrowed = narrowSiblingPath(original[at], edited[at], ts);
      const baseExpr = call.bound ?? call.text;
      const targetExpr = narrowed ? formatTargetPath(baseExpr, narrowed.path, !call.bound && call.awaited) : baseExpr;
      const expectedText = narrowed ? narrowed.original : original[at];
      const editedText = narrowed ? narrowed.edited : edited[at];
      gap.suggestedTest = `expect(${targetExpr}).${matcherFor(expectedText)}(${expectedText})`;
      gap.strengthens = {
        file: testFile, test: call.test, line: call.line, column: call.column, call: call.text,
        original: expectedText, edited: editedText, ...(narrowed ? { path: narrowed.path } : {}),
      };
      return;
    }
    // Pass 2: if no direct call or weak expectation produced a suggestion, compare observable end-of-test local
    // state (Proxy stores, DOM elements, callback variables, event arrays).
    for (const { id, testFile, text, target, attempt } of endTargets) {
      if (tried >= 24 || perGapTried >= 4) break;
      let originalPromise = originalPromises.get(id);
      if (!originalPromise) {
        originalPromise = (async () => {
          const key = randomUUID().replaceAll('-', '');
          const collect = posix.join(posix.dirname(testFile.split(sep).join('/')), `.tmt-values-${key}.jsonl`);
          const rewriteContent = recordingTestEndState(text, target, key);
          const sessionOutcome = sessionRun ? await sessionRun({ testFile, rewriteContent, collect }) : null;
          const outcome = sessionOutcome ?? await attempt({ witness: { rewrite: { file: testFile, content: rewriteContent } }, collect });
          return valuesOf(outcome);
        })();
        originalPromises.set(id, originalPromise);
        originalPromise.catch(() => { if (originalPromises.get(id) === originalPromise) originalPromises.delete(id); });
      }
      const original = await originalPromise;
      if (!original?.length) continue;
      if (tried >= 24 || perGapTried >= 4) break;
      tried++;
      perGapTried++;
      const key = randomUUID().replaceAll('-', '');
      const collect = posix.join(posix.dirname(testFile.split(sep).join('/')), `.tmt-values-${key}.jsonl`);
      const rewriteContent = recordingTestEndState(text, target, key);
      const sessionOutcome = sessionRun ? await sessionRun({ testFile, rewriteContent, collect, trial }) : null;
      const outcome = sessionOutcome ?? await attempt({ witness: { rewrite: { file: testFile, content: rewriteContent } }, collect, trial });
      const edited = valuesOf(outcome);
      if (edited.length !== original.length) continue;
      let diff = null;
      for (let i = 0; i < original.length; i++) {
        diff = diffEndSnapshots(original[i], edited[i], ts);
        if (diff) break;
      }
      if (!diff) continue;
      gap.suggestedTest = diff.suggestedTest;
      gap.strengthens = {
        kind: 'state', file: testFile, test: target.test, line: target.line, column: target.column,
        expression: diff.expression, original: diff.original, edited: diff.edited,
        ...(diff.path ? { path: diff.path } : {}),
      };
      return;
    }
  };

  const useWarmSession = run === defaultRun && options.runner !== 'playwright' && !options['isolated-trials'];
  if (useWarmSession) {
    const completed = await withWarmAssertionSession(root, subjectsByFile, options, async sessionRun => {
      for (const candidate of candidates) {
        if (tried >= 24) break;
        await evaluateCandidate(candidate, sessionRun);
      }
      return true;
    });
    if (completed) return report;
  }

  // Fallback path (custom runner, --isolated-trials, non-Vitest-4, or unit tests): run candidates in deterministic
  // order while parallelizing safe batches whose worst-case cost fits the remaining budget.
  let cursor = 0;
  while (cursor < candidates.length && tried < 24) {
    const remaining = 24 - tried;
    const batch = [];
    let reserved = 0;
    while (cursor < candidates.length && batch.length < concurrency) {
      const worstCase = Math.min(4, candidates[cursor].calls.length + candidates[cursor].endTargets.length);
      if (batch.length > 0 && reserved + worstCase > remaining) break;
      batch.push(candidates[cursor++]);
      reserved += worstCase;
      if (reserved >= remaining) break;
    }
    await inParallel(batch, batch.length, candidate => evaluateCandidate(candidate, null));
  }
  return report;
}

// The plain source edits are for the runs above and are not part of the report.
export function withoutSourceEdits(report) {
  for (const gap of report.diagnostics ?? []) for (const mutation of gap.mutations ?? []) delete mutation.source;
  return report;
}
