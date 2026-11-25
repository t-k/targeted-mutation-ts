import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
    if ((flags & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral)) || type.value === 0 || Object.is(type.value, -0) || Number.isNaN(type.value)) {
      out.add('number_zero');
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

function hasLocalUndefinedBinding(ts, checker, node) {
  if (typeof checker.resolveName === 'function') {
    const sym = checker.resolveName('undefined', node, ts.SymbolFlags.Value, false);
    if (sym?.declarations?.some(decl => !decl.getSourceFile().isDeclarationFile)) return true;
  }
  if (typeof checker.getSymbolsInScope === 'function') {
    const inScope = checker.getSymbolsInScope(node, ts.SymbolFlags.Value);
    for (const sym of inScope) {
      if (sym.name === 'undefined' && sym.declarations?.some(decl => !decl.getSourceFile().isDeclarationFile)) {
        return true;
      }
    }
  }
  return false;
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

export function createTypeContext(root, targetFiles = [], { tsconfig, ts = loadTypeScript() } = {}) {
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  const configPath = tsconfig
    ? resolve(realRoot, tsconfig)
    : ts.findConfigFile(realRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath || !existsSync(configPath)) {
    return { strictNullChecks: false, forFile: () => null };
  }
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) {
    return { strictNullChecks: false, forFile: () => null };
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  const compilerOptions = parsed.options ?? {};
  const strictNullChecks = compilerOptions.strictNullChecks === true ||
    (compilerOptions.strict === true && compilerOptions.strictNullChecks !== false);
  if (!strictNullChecks) {
    return { strictNullChecks: false, forFile: () => null };
  }
  const noUncheckedIndexedAccess = compilerOptions.noUncheckedIndexedAccess === true;

  const absTargets = targetFiles.map(file => {
    const resolved = resolve(realRoot, file);
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  });
  const ambientDts = (parsed.fileNames ?? []).filter(file => file.endsWith('.d.ts'));
  const rootNames = [...new Set([...absTargets, ...ambientDts])];
  if (!rootNames.length) {
    return { strictNullChecks: true, forFile: () => null };
  }

  const program = ts.createProgram(rootNames, { ...compilerOptions, noEmit: true });
  const checker = program.getTypeChecker();
  const fileCache = new Map();

  function forFile(file) {
    const resolved = resolve(realRoot, file);
    const absFile = existsSync(resolved) ? realpathSync(resolved) : resolved;
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
    };
    fileCache.set(absFile, helper);
    return helper;
  }

  return { strictNullChecks: true, forFile };
}
