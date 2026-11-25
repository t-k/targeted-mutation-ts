import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadTypeScript } from './typescript-compiler.mjs';

const PRIMITIVE_PROTOTYPE_KEYS = new Set([
  '__proto__',
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(String.prototype),
  ...Object.getOwnPropertyNames(Number.prototype),
  ...Object.getOwnPropertyNames(Boolean.prototype),
  ...Object.getOwnPropertyNames(BigInt.prototype),
  ...Object.getOwnPropertyNames(Symbol.prototype),
]);

function isGuaranteedNonPrimitiveObject(ts, checker, type) {
  if (checker.isArrayType(type) || checker.isTupleType(type)) return true;
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return true;
  // Require at least one non-optional property that does not exist on built-in primitive prototypes;
  // `{}` and `{ toString(): string }` accept primitives like `0`, `""`, and `false` in TypeScript.
  for (const prop of type.getProperties()) {
    if (prop.flags & ts.SymbolFlags.Optional) continue;
    if (!PRIMITIVE_PROTOTYPE_KEYS.has(prop.name)) return true;
  }
  return false;
}

function canContainNullish(ts, checker, type, kind, seen = new Set()) {
  if (!type || seen.has(type)) return true;
  seen.add(type);
  const flags = type.flags;
  // `void` can hold arbitrary return values at runtime (e.g. `const f: () => void = () => false`).
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void)) return true;
  if (flags & ts.TypeFlags.Never) return false;
  if (kind === 'null' && (flags & ts.TypeFlags.Null)) return true;
  if (kind === 'undefined' && (flags & ts.TypeFlags.Undefined)) return true;
  if (type.isUnion()) return type.types.some(member => canContainNullish(ts, checker, member, kind, new Set(seen)));
  if (type.isIntersection()) return type.types.every(member => canContainNullish(ts, checker, member, kind, new Set(seen)));
  if (flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution | ts.TypeFlags.TemplateLiteral)) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint ? canContainNullish(ts, checker, constraint, kind, seen) : true;
  }
  return false;
}

function collectNonNullishFalsy(ts, checker, type, out = new Set(), seen = new Set()) {
  if (!type || seen.has(type)) return 'any';
  seen.add(type);
  const flags = type.flags;
  // `void` can hold arbitrary return values at runtime (e.g. `() => void` returning `false` or `0`).
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void)) return 'any';
  if (flags & (ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return out;
  if (type.isUnion()) {
    for (const member of type.types) {
      if (collectNonNullishFalsy(ts, checker, member, out, new Set(seen)) === 'any') return 'any';
    }
    return out;
  }
  if (type.isIntersection()) {
    if (type.types.some(member => member.flags & ts.TypeFlags.Never)) return out;
    // Branded primitives (e.g. `string & { __brand: 'id' }`) still carry the primitive's runtime values,
    // so over-approximating by collecting from all constituents is sound.
    for (const member of type.types) {
      if (collectNonNullishFalsy(ts, checker, member, out, new Set(seen)) === 'any') return 'any';
    }
    return out;
  }
  if (flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution)) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint ? collectNonNullishFalsy(ts, checker, constraint, out, seen) : 'any';
  }
  if (flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
    out.add('string');
    return out;
  }
  if (flags & ts.TypeFlags.StringLiteral) {
    if (type.value === '') out.add('string');
    return out;
  }
  if (flags & ts.TypeFlags.Boolean) {
    out.add('boolean');
    return out;
  }
  if (flags & ts.TypeFlags.BooleanLiteral) {
    if (checker.typeToString(type) === 'false') out.add('boolean');
    return out;
  }
  if (flags & ts.TypeFlags.BigInt) {
    out.add('bigint');
    return out;
  }
  if (flags & ts.TypeFlags.BigIntLiteral) {
    if (type.value?.base10Value === '0') out.add('bigint');
    return out;
  }
  if (flags & ts.TypeFlags.Number) {
    out.add('number_zero');
    out.add('number_nan');
    return out;
  }
  if (flags & ts.TypeFlags.NumberLiteral) {
    // Numeric enum types accept arbitrary numbers (including 0 and NaN) without a TypeScript error.
    if (flags & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral)) {
      out.add('number_zero');
      out.add('number_nan');
    } else if (type.value === 0 || Object.is(type.value, -0)) {
      out.add('number_zero');
    } else if (Number.isNaN(type.value)) {
      out.add('number_nan');
    }
    return out;
  }
  if (flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.NonPrimitive)) {
    return out;
  }
  if (flags & ts.TypeFlags.Object) {
    return isGuaranteedNonPrimitiveObject(ts, checker, type) ? out : 'any';
  }
  return 'any';
}

function falsyLabelsFromSet(falsy) {
  if (falsy === 'any') return null;
  const labels = [];
  if (falsy.has('number_zero')) labels.push('0');
  if (falsy.has('bigint')) labels.push('0n');
  if (falsy.has('string')) labels.push("''");
  if (falsy.has('boolean')) labels.push('false');
  if (falsy.has('number_nan')) labels.push('NaN');
  return labels;
}

function hasLocalValueBinding(ts, checker, node, name) {
  if (typeof checker.resolveName === 'function') {
    const sym = checker.resolveName(name, node, ts.SymbolFlags.Value, false);
    if (sym?.declarations?.some(decl => !decl.getSourceFile().isDeclarationFile)) return true;
  }
  if (typeof checker.getSymbolsInScope === 'function') {
    const inScope = checker.getSymbolsInScope(node, ts.SymbolFlags.Value);
    for (const sym of inScope) {
      if (sym.name === name && sym.declarations?.some(decl => !decl.getSourceFile().isDeclarationFile)) {
        return true;
      }
    }
  }
  return false;
}

function hasLocalUndefinedBinding(ts, checker, node) {
  return hasLocalValueBinding(ts, checker, node, 'undefined');
}

function isUncheckedIndexedRead(ts, checker, node) {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  if (!node) return false;
  if (ts.isElementAccessExpression(node)) return true;
  if (ts.isPropertyAccessExpression(node)) {
    const recvType = checker.getTypeAtLocation(node.expression);
    if (recvType && checker.getIndexTypeOfType(recvType, ts.IndexKind.String) && !recvType.getProperty(node.name.text)) {
      return true;
    }
  }
  if (ts.isIdentifier(node)) {
    const sym = checker.getSymbolAtLocation(node);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isUncheckedIndexedRead(ts, checker, decl.initializer)) {
      return true;
    }
  }
  return false;
}

function indexExpressions(ts, sourceFile) {
  const nodes = new Map();
  (function walk(node) {
    if (!ts.isParenthesizedExpression(node)) {
      const start = node.getStart(sourceFile);
      const key = `${start}:${node.end}`;
      if (!nodes.has(key)) nodes.set(key, node);
    }
    ts.forEachChild(node, walk);
  })(sourceFile);
  return nodes;
}

function isWithinRoot(realRoot, candidate) {
  const rel = relative(realRoot, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

function normalizePath(filePath) {
  return existsSync(filePath) ? realpathSync(filePath) : resolve(filePath);
}

function readParsedConfig(ts, configPath, cache) {
  const key = normalizePath(configPath);
  if (cache.has(key)) return cache.get(key);
  if (!existsSync(key)) {
    const missing = { configPath: key, missing: true, strictNullChecks: false };
    cache.set(key, missing);
    return missing;
  }
  const read = ts.readConfigFile(key, ts.sys.readFile);
  if (read.error || !read.config) {
    const failed = { configPath: key, error: true, strictNullChecks: false };
    cache.set(key, failed);
    return failed;
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(key));
  const compilerOptions = parsed.options ?? {};
  const strictNullChecks = compilerOptions.strictNullChecks === true ||
    (compilerOptions.strict === true && compilerOptions.strictNullChecks !== false);
  const fileNames = new Set((parsed.fileNames ?? []).map(normalizePath));
  const info = {
    configPath: key,
    parsed,
    compilerOptions,
    strictNullChecks,
    noUncheckedIndexedAccess: compilerOptions.noUncheckedIndexedAccess === true,
    projectReferences: parsed.projectReferences ?? [],
    fileNames,
  };
  cache.set(key, info);
  return info;
}

function resolveReferenceConfigPath(refPath) {
  const resolved = resolve(refPath);
  const st = statSync(resolved, { throwIfNoEntry: false });
  if (st?.isDirectory()) return resolve(resolved, 'tsconfig.json');
  return resolved;
}

function findConfigViaReferences(ts, configPath, absFile, cache, visited = new Set()) {
  const key = normalizePath(configPath);
  if (visited.has(key)) return null;
  visited.add(key);
  const info = readParsedConfig(ts, key, cache);
  if (info.missing || info.error) return null;
  for (const ref of info.projectReferences) {
    const refConfigPath = resolveReferenceConfigPath(ref.path);
    if (!existsSync(refConfigPath)) continue;
    const refInfo = readParsedConfig(ts, refConfigPath, cache);
    if (refInfo.missing || refInfo.error) continue;
    if (refInfo.fileNames.has(absFile)) return refInfo.configPath;
    if (refInfo.projectReferences.length) {
      const nested = findConfigViaReferences(ts, refInfo.configPath, absFile, cache, visited);
      if (nested) return nested;
    }
  }
  return null;
}

function collectAncestorConfigsInRoot(ts, realRoot, startDir) {
  const configs = [];
  let dir = startDir;
  while (isWithinRoot(realRoot, dir)) {
    const candidate = resolve(dir, 'tsconfig.json');
    if (ts.sys.fileExists(candidate)) configs.push(normalizePath(candidate));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return configs;
}

function resolveConfigForFile(ts, realRoot, absFile, explicitConfigPath, cache) {
  if (explicitConfigPath) return explicitConfigPath;
  const ancestors = collectAncestorConfigsInRoot(ts, realRoot, dirname(absFile));
  if (!ancestors.length) {
    const fallback = ts.findConfigFile(realRoot, ts.sys.fileExists, 'tsconfig.json');
    if (fallback) ancestors.push(normalizePath(fallback));
  }
  if (!ancestors.length) return null;

  // Walk from nearest ancestor upward: if a config has projectReferences, prefer an owning
  // referenced config before falling back to an ancestor config that merely includes absFile.
  for (const configPath of ancestors) {
    const info = readParsedConfig(ts, configPath, cache);
    if (info.missing || info.error) continue;
    if (info.projectReferences.length) {
      const fromRef = findConfigViaReferences(ts, configPath, absFile, cache);
      if (fromRef) return fromRef;
    }
    if (info.fileNames.has(absFile)) {
      return configPath;
    }
  }

  // Fallback to the nearest ancestor tsconfig so warnings report the actual config checked.
  return ancestors[0];
}

function buildGroupContext(ts, info, absTargets) {
  const { compilerOptions, noUncheckedIndexedAccess, parsed } = info;
  const ambientDts = (parsed.fileNames ?? []).filter(file => file.endsWith('.d.ts'));
  const rootNames = [...new Set([...absTargets, ...ambientDts])];
  if (!rootNames.length) return () => null;
  const program = ts.createProgram(rootNames, { ...compilerOptions, noEmit: true });
  const checker = program.getTypeChecker();
  const fileCache = new Map();

  return (absFile, resolved) => {
    if (fileCache.has(absFile)) return fileCache.get(absFile);
    const sourceFile = program.getSourceFile(absFile) ?? program.getSourceFile(resolved);
    if (!sourceFile) {
      fileCache.set(absFile, null);
      return null;
    }
    const nodes = indexExpressions(ts, sourceFile);
    const helper = {
      isNullishEqualityEquivalent(subjectStart, subjectEnd, differsFor) {
        if (differsFor !== 'null' && differsFor !== 'undefined') return false;
        const node = nodes.get(`${subjectStart}:${subjectEnd}`);
        if (!node) return false;
        // Without `noUncheckedIndexedAccess`, indexed reads (`xs[i]`, `rec.missing`, or variables initialized from them) can evaluate to `undefined` at runtime.
        if (!noUncheckedIndexedAccess && differsFor === 'undefined' && isUncheckedIndexedRead(ts, checker, node)) return false;
        // If `undefined` is locally shadowed in scope, `x === undefined` / `=== undefined` does not compare against the built-in value.
        if (hasLocalUndefinedBinding(ts, checker, node)) return false;
        const type = checker.getTypeAtLocation(node);
        if (!type) return false;
        return !canContainNullish(ts, checker, type, differsFor);
      },
      isNullishFallbackEquivalent(leftStart, leftEnd, rightFalsy) {
        const node = nodes.get(`${leftStart}:${leftEnd}`);
        if (!node) return false;
        const type = checker.getTypeAtLocation(node);
        if (!type) return false;
        const falsy = collectNonNullishFalsy(ts, checker, type);
        if (falsy === 'any') return false;
        if (falsy.size === 0) return true;
        if (falsy.size === 1) {
          if (falsy.has('string') && rightFalsy === "''") return true;
          if (falsy.has('boolean') && rightFalsy === 'false') return true;
          if (falsy.has('bigint') && rightFalsy === '0n') return true;
        }
        return false;
      },
      possibleNullishFallbackFalsy(leftStart, leftEnd) {
        const node = nodes.get(`${leftStart}:${leftEnd}`);
        if (!node) return null;
        const type = checker.getTypeAtLocation(node);
        if (!type) return null;
        return falsyLabelsFromSet(collectNonNullishFalsy(ts, checker, type));
      },
      hasLocalNaNBinding(nodeStart, nodeEnd) {
        const node = nodes.get(`${nodeStart}:${nodeEnd}`);
        return node ? hasLocalValueBinding(ts, checker, node, 'NaN') : false;
      },
    };
    fileCache.set(absFile, helper);
    return helper;
  };
}

export function createTypeContext(root, targetFiles = [], { tsconfig, onWarning, ts = loadTypeScript() } = {}) {
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  const configCache = new Map();
  const warnings = [];
  const seenWarnings = new Set();
  const warn = message => {
    if (seenWarnings.has(message)) return;
    seenWarnings.add(message);
    warnings.push(message);
    onWarning?.(message);
  };
  const labelConfig = configPath => {
    const rel = relative(realRoot, configPath);
    return rel && !isAbsolute(rel) && !rel.startsWith('..' + sep) ? rel : configPath;
  };
  const explicitConfigPath = tsconfig ? resolve(realRoot, tsconfig) : null;

  if (!targetFiles.length) {
    const configPath = explicitConfigPath ?? ts.findConfigFile(realRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath || !existsSync(configPath)) {
      warn(explicitConfigPath
        ? `--type-check: tsconfig file not found (${tsconfig}); skipping type-based suppression.`
        : '--type-check: no tsconfig.json found; skipping type-based suppression.');
      return { strictNullChecks: false, warnings, forFile: () => null };
    }
    const info = readParsedConfig(ts, configPath, configCache);
    if (info.error) {
      warn(`--type-check: failed to read ${labelConfig(configPath)}; skipping type-based suppression.`);
      return { strictNullChecks: false, warnings, forFile: () => null };
    }
    if (!info.strictNullChecks) {
      warn(`--type-check: strictNullChecks is not enabled in ${labelConfig(configPath)}; skipping type-based suppression.`);
    }
    return { strictNullChecks: info.strictNullChecks, warnings, forFile: () => null };
  }

  const grouped = new Map();
  const fileToConfig = new Map();
  for (const file of targetFiles) {
    const resolved = resolve(realRoot, file);
    const absFile = normalizePath(resolved);
    const configPath = resolveConfigForFile(ts, realRoot, absFile, explicitConfigPath, configCache);
    if (!configPath) {
      warn(`--type-check: no tsconfig.json found for ${file}; skipping type-based suppression.`);
      fileToConfig.set(absFile, null);
      continue;
    }
    const key = normalizePath(configPath);
    fileToConfig.set(absFile, key);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(absFile);
  }

  const groupLookups = new Map();
  let anyStrictNullChecks = false;
  for (const [configPath, absTargets] of grouped) {
    const info = readParsedConfig(ts, configPath, configCache);
    if (info.missing) {
      warn(`--type-check: tsconfig file not found (${tsconfig ?? labelConfig(configPath)}); skipping type-based suppression.`);
      groupLookups.set(configPath, () => null);
      continue;
    }
    if (info.error) {
      warn(`--type-check: failed to read ${labelConfig(configPath)}; skipping type-based suppression.`);
      groupLookups.set(configPath, () => null);
      continue;
    }
    if (!info.strictNullChecks) {
      warn(`--type-check: strictNullChecks is not enabled in ${labelConfig(configPath)}; skipping type-based suppression.`);
      groupLookups.set(configPath, () => null);
      continue;
    }
    anyStrictNullChecks = true;
    groupLookups.set(configPath, buildGroupContext(ts, info, absTargets));
  }

  function forFile(file) {
    const resolved = resolve(realRoot, file);
    const absFile = normalizePath(resolved);
    const configKey = fileToConfig.get(absFile);
    if (!configKey) return null;
    const lookup = groupLookups.get(configKey);
    return lookup ? lookup(absFile, resolved) : null;
  }

  return { strictNullChecks: anyStrictNullChecks, warnings, forFile };
}
