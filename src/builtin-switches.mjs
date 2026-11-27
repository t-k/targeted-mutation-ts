import { createHash } from 'node:crypto';
import { collectMutations, shiftPlaceholder } from './builtin-mutations.mjs';
import { byteOffsets } from './source-text.mjs';

// Runtime switches for the built-in mutation set. Expressions become `on(id) ? mutated : (cover(id), original)`;
// blocks, case clauses and removable statements become `if (on(id)) mutated else { cover(id); original }`.
// The helpers speak the test session's protocol: one active mutation and per-test hit counts.
const helpers = (on, cover, shift, scope) => `
function ${shift}() {
  var scope = ${scope};
  return (scope.__stryker__ && scope.__stryker__.shift) || 0;
}
function ${on}(id) {
  var scope = ${scope}, ns = scope.__stryker__ || (scope.__stryker__ = {});
  if (ns.activeMutant !== id) return false;
  if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) throw new Error('Mutation hit limit reached (' + ns.hitCount + ')');
  return true;
}
function ${cover}() {
  var scope = ${scope}, ns = scope.__stryker__ || (scope.__stryker__ = {});
  var coverage = ns.mutantCoverage || (ns.mutantCoverage = { static: {}, perTest: {} });
  var counts = ns.currentTestId ? (coverage.perTest[ns.currentTestId] || (coverage.perTest[ns.currentTestId] = {})) : coverage.static;
  for (var i = 0; i < arguments.length; i++) counts[arguments[i]] = (counts[arguments[i]] || 0) + 1;
}
`;
// The probe of the targeted rules. It takes the operands of one expression, the right one of a logical operator as a
// function, and returns what the expression gives: with the active edit when one of the site's edits is on. While
// the baseline is recorded it also notes, for every edit of the site and per test, whether the edit would have
// given the same value after evaluating the same operands.
const probe = (see, table, cover, scope, rows) => `
function ${table}(i) {
  return (${table}.rows || (${table}.rows = ${JSON.stringify(rows)}))[i];
}
function ${see}(i, l, r, r2, g) {
  var site = ${table}(i), op = site[0], edits = site[2], kind = site[6], scope = ${scope}, ns = scope.__stryker__ || (scope.__stryker__ = {});
  var utilTypes = ${table}.u !== void 0 ? ${table}.u : (${table}.u = typeof scope.process === 'object' && scope.process && typeof scope.process.getBuiltinModule === 'function' ? scope.process.getBuiltinModule('node:util').types : null);
  var isProxy = utilTypes ? utilTypes.isProxy : null;
  var isTypedArray = utilTypes ? utilTypes.isTypedArray : null;
  function safeProtoMethod(proto, name) {
    var d = scope.Object.getOwnPropertyDescriptor(proto, name);
    return d && 'value' in d && typeof d.value === 'function' ? d.value : null;
  }
  var strMethods = ${table}.s || (${table}.s = { indexOf: safeProtoMethod(scope.String.prototype, 'indexOf'), lastIndexOf: safeProtoMethod(scope.String.prototype, 'lastIndexOf'), includes: safeProtoMethod(scope.String.prototype, 'includes'), replace: safeProtoMethod(scope.String.prototype, 'replace'), replaceAll: safeProtoMethod(scope.String.prototype, 'replaceAll') });
  var arrMethods = ${table}.a || (${table}.a = { includes: safeProtoMethod(scope.Array.prototype, 'includes'), every: safeProtoMethod(scope.Array.prototype, 'every'), some: safeProtoMethod(scope.Array.prototype, 'some') });
  function isNativeFn(fn) {
    try { return typeof fn === 'function' && scope.Function.prototype.toString.call(fn).indexOf('[native code]') >= 0; } catch (e) { return false; }
  }
  function numMin(a, b) { return a !== a || b !== b ? NaN : (a === 0 && b === 0 ? (1 / a < 0 || 1 / b < 0 ? -0 : 0) : a < b ? a : b); }
  function numMax(a, b) { return a !== a || b !== b ? NaN : (a === 0 && b === 0 ? (1 / a > 0 || 1 / b > 0 ? 0 : -0) : a > b ? a : b); }
  function isPlainDataObj(v) {
    if (v === null || v === void 0) return true;
    if (typeof v !== 'object' || (isProxy && isProxy(v))) return false;
    try {
      var ks = scope.Reflect.ownKeys(v), ki;
      for (ki = 0; ki < ks.length; ki++) {
        var desc = scope.Object.getOwnPropertyDescriptor(v, ks[ki]);
        if (desc && desc.enumerable && !('value' in desc)) return false;
      }
      return true;
    } catch (e) { return false; }
  }
  function isolatedRegexTest(pat, flags, text) {
    if (${table}.v === void 0) {
      try {
        var vmMod = typeof scope.process === 'object' && scope.process && typeof scope.process.getBuiltinModule === 'function' ? scope.process.getBuiltinModule('node:vm') : null;
        ${table}.v = vmMod ? vmMod.runInNewContext('(function(p,f,s){return new RegExp(p,f).test(s);})') : null;
      } catch (e) { ${table}.v = null; }
    }
    return ${table}.v ? ${table}.v(pat, flags, text) : null;
  }
  var logical = kind === 'l', missing = l === null || l === void 0, k, form;
  var taken = op === '&&' ? !!l : op === '||' ? !l : missing;
  var constant = op === '&&' ? true : op === '||' ? false : void 0;
  function equal(operator, a, b) { return operator === '===' ? a === b : operator === '!==' ? a !== b : operator === '==' ? a == b : a != b; }
  // An operation on values: arithmetic, the functions of Math, and the ends of a sequence.
  function apply(o, a, b, c) {
    switch (o) {
      case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
      case 'max': return Math.max(a, b); case 'min': return Math.min(a, b);
      case 'floor': return Math.floor(a); case 'ceil': return Math.ceil(a); case 'round': return Math.round(a); case 'trunc': return Math.trunc(a);
      case 'idx0': return a[0]; case 'idxLast': return a[a.length - 1]; case 'at0': return a.at(0); case 'at-1': return a.at(-1);
      case 'find': return a.find(b); case 'findLast': return a.findLast(b); case 'findIndex': return a.findIndex(b);
      case 'findLastIndex': return a.findLastIndex(b); case 'indexOf': return a.indexOf(b); case 'lastIndexOf': return a.lastIndexOf(b);
      case 'startsWith': return a.startsWith(b); case 'endsWith': return a.endsWith(b); case 'includes': return a.includes(b);
      case 'replace': return a.replace(b, c); case 'replaceAll': return a.replaceAll(b, c);
      case 'copyArray': return [...a]; case 'copyObject': return { ...a };
      case 'sort': return a.sort(b); case 'toSorted': return a.toSorted(b); default: return op === 'sort' ? a.sort() : a.toSorted();
    }
  }
  function callMethod(methodName) {
    var fn = l[methodName];
    var a1 = r();
    if (site[7] === 3) {
      var a2 = r2();
      return scope.Reflect.apply(fn, l, [a1, a2]);
    }
    return scope.Reflect.apply(fn, l, [a1]);
  }
  function callClamp(mode) {
    var cm = site[8], oMath, oFn, iMath, iFn, v0, v1, v2, iv;
    if (mode === 'orig') {
      oMath = scope.Math;
      oFn = oMath[cm.outer];
      if (cm.innerPos === 0) {
        iMath = scope.Math;
        iFn = iMath[cm.inner];
        v0 = l[0](); v1 = l[1]();
        iv = scope.Reflect.apply(iFn, iMath, [v0, v1]);
        v2 = l[2]();
        return scope.Reflect.apply(oFn, oMath, [iv, v2]);
      }
      v0 = l[0]();
      iMath = scope.Math;
      iFn = iMath[cm.inner];
      v1 = l[1](); v2 = l[2]();
      iv = scope.Reflect.apply(iFn, iMath, [v1, v2]);
      return scope.Reflect.apply(oFn, oMath, [v0, iv]);
    }
    if (mode === 'dropOuter') {
      iMath = scope.Math;
      iFn = iMath[cm.inner];
      return cm.innerPos === 0
        ? scope.Reflect.apply(iFn, iMath, [l[0](), l[1]()])
        : scope.Reflect.apply(iFn, iMath, [l[1](), l[2]()]);
    }
    oMath = scope.Math;
    oFn = oMath[cm.outer];
    var keepA = mode === 'dropInnerB';
    return cm.innerPos === 0
      ? scope.Reflect.apply(oFn, oMath, [keepA ? l[0]() : l[1](), l[2]()])
      : scope.Reflect.apply(oFn, oMath, [l[0](), keepA ? l[1]() : l[2]()]);
  }
  function makeArrayWithout(src, skipIdx) {
    if (skipIdx < 0) return src;
    var out = [], idx;
    for (idx = 0; idx < src.length; idx++) {
      if (idx !== skipIdx) scope.Object.defineProperty(out, out.length, { value: src[idx], enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  function callLiteralIncludes(skipIdx) {
    var arr = makeArrayWithout(l, skipIdx);
    var fn = arr.includes;
    var arg = r();
    return scope.Reflect.apply(fn, arr, [arg]);
  }
  function callRegexTest(reFactory) {
    var re = reFactory();
    var fn = re.test;
    var arg = r();
    return scope.Reflect.apply(fn, re, [arg]);
  }
  function buildSpread(skipIndex) {
    var keys = site[8], out = { ...l }, m;
    for (m = 0; m < keys.length; m++) {
      if (m === skipIndex) continue;
      scope.Object.defineProperty(out, keys[m], { value: r[m](), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  function edited(f) {
    if (kind === 'c') return l;
    if (kind === 'p') return buildSpread(Number(f.slice(5)));
    if (kind === 'r') return callMethod(f);
    if (kind === 'k') return callClamp(f);
    if (kind === 'u') return callLiteralIncludes(Number(f.slice(6)));
    if (kind === 'g') { var cb = { ...r() }; return { ...cb, ...l() }; }
    if (kind === 'x') return callRegexTest(l[f]);
    if (kind !== 'e') return apply(f, l, r, r2);
    if (f === 'true') return true;
    if (f === 'false') return false;
    if (f === 'loose') return equal(op.slice(0, 2), l, r);
    if (f === 'strict') return equal(op + '=', l, r);
    var subject = site[3] ? l : r, other = (site[3] ? r : l) === null ? void 0 : null;
    return (subject === other) === (op === '==');
  }
  function original() {
    if (logical) return taken ? r() : l;
    if (kind === 'e') return equal(op, l, r);
    if (kind === 'p') return buildSpread(-1);
    if (kind === 'r') return callMethod(op);
    if (kind === 'k') return callClamp('orig');
    if (kind === 'u') return callLiteralIncludes(-1);
    if (kind === 'g') { var ca = { ...l() }; return { ...ca, ...r() }; }
    if (kind === 'x') return callRegexTest(l.orig);
    return apply(op, l, r, r2);
  }
  function plain(v) { return v === null || (typeof v !== 'object' && typeof v !== 'function'); }
  // An array of the built-in kind with the same elements: slice would call the constructor of a subclass.
  function copy(a) {
    var plainArray = [], n;
    plainArray.length = a.length;
    for (n = 0; n < a.length; n++) if (n in a) plainArray[n] = a[n];
    return plainArray;
  }
  function is(a, b) { return a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b; }
  // Whether the edit gives the same, where the operation can be worked out again without an effect: on plain
  // values and numbers, and on arrays and text for their ends. Otherwise it is not known (null).
  function alike(f, value) {
    var sequence = scope.Array.isArray(l);
    if (op === 'sort' || op === 'toSorted') {
      // The order without the comparison is the order of the elements as text. For numbers and text that can be
      // worked out on a copy; anything else would be converted by its own code.
      var from = op === 'sort' ? unsorted : l, n;
      // Only the sort of the built-in arrays is known: a subclass may have one of its own.
      if (!scope.Array.isArray(from) || !scope.Array.isArray(value) || from.length !== value.length || l[op] !== scope.Array.prototype[op]) return null;
      for (n = 0; n < from.length; n++) if (!(n in from) || (typeof from[n] !== 'number' && typeof from[n] !== 'string')) return null;
      var other = copy(from).sort();
      for (n = 0; n < other.length; n++) if (!is(other[n], value[n])) return false;
      return true;
    }
    if (op === 'startsWith' || op === 'endsWith') {
      var incFn = safeProtoMethod(scope.String.prototype, f);
      if (typeof l !== 'string' || !plain(arg1) || !incFn || incFn !== strMethods[f]) return null;
      try { return is(value, scope.Reflect.apply(incFn, l, [arg1])); } catch (error) { return false; }
    }
    if (op === 'replace' || op === 'replaceAll') {
      var repFn = safeProtoMethod(scope.String.prototype, f);
      if (typeof l !== 'string' || !plain(arg1) || !plain(arg2) || !repFn || repFn !== strMethods[f]) return null;
      try { return is(value, scope.Reflect.apply(repFn, l, [arg1, arg2])); } catch (error) { return false; }
    }
    if (op === 'every' || op === 'some') {
      if (!qPreOk) return null;
      if (qPreLen === 0) return false;
      if (qPreLen === 1 && qPreDense0) return true;
      return null;
    }
    if (kind === 'a' ? !plain(l) || !plain(r) : kind === 'm' ? typeof l !== 'number' || (site[7] === 2 && typeof r !== 'number')
      : (!sequence && typeof l !== 'string') || ((op === 'indexOf' || op === 'lastIndexOf') && typeof l === 'string' && (!plain(r) || l[f] !== strMethods[f]))) return null;
    // The callback of a search would run again: with at most one element both ends are the same search.
    if (op.slice(0, 4) === 'find') return sequence && l.length <= 1 ? true : null;
    try {
      return is(value, apply(f, l, r, r2));
    } catch (error) {
      return false;
    }
  }
  function show(v) {
    var t = typeof v;
    return v === null ? 'null' : t === 'string' ? '"' + (v.length > 40 ? v.slice(0, 40) + '...' : v) + '"'
      : t === 'number' ? (v === 0 && 1 / v < 0 ? '-0' : '' + v) : t === 'boolean' || t === 'undefined' ? '' + v : t === 'bigint' ? v + 'n'
        : scope.Array.isArray(v) ? 'array of ' + v.length : t;
  }
  if (ns.activeMutant !== void 0) for (k = 0; k < edits.length; k++) if (edits[k][0] === ns.activeMutant) form = edits[k][1];
  if (form !== void 0) {
    if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) throw new Error('Mutation hit limit reached (' + ns.hitCount + ')');
    if (!logical) return edited(form);
    if (form === 'left') return r();
    if (form === 'right') return taken ? (r(), constant) : l;
    return (form === 'or' ? !l : missing) ? r() : l;
  }
  ${cover}.apply(null, site[4]);
  var state = scope[scope.Symbol.for('targeted-mutation-ts/session')];
  if (!state || state.phase !== 'baseline') return original();
  // An operation that throws is observed too: an edit that evaluates the same right side throws as well, and any other differs.
  // A sort in place loses the order it started from.
  var value, threw = true, unsorted = op === 'sort' && scope.Array.isArray(l) ? copy(l) : void 0, spreadBase, spreadVals, arg1, arg2, clampVals, clampBuiltins, mergeA, mergeB, mergePure = false, litFn, regexFn, regexProto, qPreOk = false, qPreLen = -1, qPreDense0 = false;
  try {
    if (kind === 'p') {
      spreadBase = { ...l };
      spreadVals = [];
      value = { ...spreadBase };
      var spreadKeys = site[8], sm;
      for (sm = 0; sm < spreadKeys.length; sm++) {
        var sv = r[sm]();
        spreadVals[sm] = sv;
        scope.Object.defineProperty(value, spreadKeys[sm], { value: sv, enumerable: true, writable: true, configurable: true });
      }
    } else if (kind === 'r') {
      var origFn = l[op];
      arg1 = r();
      if ((op === 'every' || op === 'some') && l != null && (!isProxy || !isProxy(l)) && scope.Array.isArray(l)) {
        try {
          var qAlt = op === 'every' ? 'some' : 'every';
          var qProto = scope.Object.getPrototypeOf(l);
          var qOrigCur = safeProtoMethod(scope.Array.prototype, op);
          var qAltCur = safeProtoMethod(scope.Array.prototype, qAlt);
          if (qProto === scope.Array.prototype && qOrigCur && qAltCur && origFn === qOrigCur && qOrigCur === arrMethods[op] && qAltCur === arrMethods[qAlt] &&
              !scope.Object.getOwnPropertyDescriptor(l, op) && !scope.Object.getOwnPropertyDescriptor(l, qAlt)) {
            qPreOk = true;
            qPreLen = l.length;
            qPreDense0 = qPreLen === 1 && scope.Object.prototype.hasOwnProperty.call(l, 0);
          }
        } catch (error) { qPreOk = false; }
      }
      if (site[7] === 3) {
        arg2 = r2();
        value = scope.Reflect.apply(origFn, l, [arg1, arg2]);
      } else {
        value = scope.Reflect.apply(origFn, l, [arg1]);
      }
    } else if (kind === 'k') {
      var cm = site[8], oMath = scope.Math, oFn = oMath[cm.outer], iMath, iFn;
      if (cm.innerPos === 0) {
        iMath = scope.Math;
        iFn = iMath[cm.inner];
        var cv0 = l[0](), cv1 = l[1](), civ = scope.Reflect.apply(iFn, iMath, [cv0, cv1]), cv2 = l[2]();
        clampVals = [cv0, cv1, cv2];
        value = scope.Reflect.apply(oFn, oMath, [civ, cv2]);
      } else {
        var cu0 = l[0]();
        iMath = scope.Math;
        iFn = iMath[cm.inner];
        var cu1 = l[1](), cu2 = l[2](), ciu = scope.Reflect.apply(iFn, iMath, [cu1, cu2]);
        clampVals = [cu0, cu1, cu2];
        value = scope.Reflect.apply(oFn, oMath, [cu0, ciu]);
      }
      clampBuiltins = isNativeFn(oFn) && isNativeFn(iFn);
    } else if (kind === 'u') {
      var litArr = makeArrayWithout(l, -1);
      litFn = litArr.includes;
      arg1 = r();
      value = scope.Reflect.apply(litFn, litArr, [arg1]);
    } else if (kind === 'g') {
      var rawA = l();
      var pureA = isPlainDataObj(rawA);
      mergeA = { ...rawA };
      var rawB = r();
      var pureB = isPlainDataObj(rawB);
      mergeB = { ...rawB };
      mergePure = Boolean(site[8]) && pureA && pureB;
      value = { ...mergeA, ...mergeB };
    } else if (kind === 'x') {
      var origRe = l.orig();
      regexProto = scope.Object.getPrototypeOf(origRe);
      regexFn = origRe.test;
      arg1 = r();
      value = scope.Reflect.apply(regexFn, origRe, [arg1]);
    } else {
      value = original();
    }
    threw = false;
  } finally {
    if (threw) note();
  }
  note();
  return value;
  function note() {
    var seen = ns.observed || (ns.observed = {}), test = ns.currentTestId || '', gFn = g && (typeof g === 'function' ? g : g.g), rawR = g && g.r;
    function sameInGuard(origLeaf, altLeaf) {
      try {
        var go = gFn(origLeaf), ga = gFn(altLeaf);
        return site[8] ? (!go === !ga) : is(go, ga);
      } catch (e) {
        return false;
      }
    }
    for (k = 0; k < edits.length; k++) {
      var f = edits[k][1], same, other, altVal, absorbed = false, spreadIdx, spreadKey, spreadHad;
      if (threw) same = logical ? (f !== 'nullish' || missing) : null;
      else if (kind === 'c') same = null;
      else if (kind === 'p') {
        spreadIdx = Number(f.slice(5));
        spreadKey = site[8][spreadIdx];
        spreadHad = scope.Object.prototype.hasOwnProperty.call(spreadBase, spreadKey);
        same = spreadHad && is(spreadBase[spreadKey], spreadVals[spreadIdx])
          ? (site[9][spreadIdx] ? true : null)
          : false;
      } else if (kind === 'k') {
        var cmeta = site[8];
        if (!clampBuiltins || typeof clampVals[0] !== 'number' || typeof clampVals[1] !== 'number' || typeof clampVals[2] !== 'number') same = null;
        else {
          var oF = cmeta.outer === 'min' ? numMin : numMax, iF = cmeta.inner === 'min' ? numMin : numMax, altV, droppedIdx;
          if (f === 'dropOuter') {
            altV = cmeta.innerPos === 0 ? iF(clampVals[0], clampVals[1]) : iF(clampVals[1], clampVals[2]);
            droppedIdx = cmeta.innerPos === 0 ? 2 : 0;
          } else {
            var keepA = f === 'dropInnerB';
            altV = cmeta.innerPos === 0 ? oF(keepA ? clampVals[0] : clampVals[1], clampVals[2]) : oF(clampVals[0], keepA ? clampVals[1] : clampVals[2]);
            droppedIdx = cmeta.innerPos === 0 ? (keepA ? 1 : 0) : (keepA ? 2 : 1);
          }
          same = is(value, altV) ? (cmeta.pures[droppedIdx] ? true : null) : false;
        }
      } else if (kind === 'u') {
        var curInc = safeProtoMethod(scope.Array.prototype, 'includes');
        if (!curInc || litFn !== curInc || curInc !== arrMethods.includes) same = null;
        else {
          var skipU = Number(f.slice(6));
          var prunedArr = makeArrayWithout(l, skipU);
          same = is(value, scope.Reflect.apply(curInc, prunedArr, [arg1]));
        }
      } else if (kind === 'g') {
        var swappedObj = { ...mergeB, ...mergeA };
        var origKeys = scope.Reflect.ownKeys(value), swapKeys = scope.Reflect.ownKeys(swappedObj);
        var ki, valDiff = false, orderDiff = origKeys.length !== swapKeys.length;
        for (ki = 0; ki < origKeys.length; ki++) {
          var keyName = origKeys[ki];
          if (!is(value[keyName], swappedObj[keyName])) { valDiff = true; break; }
          if (!orderDiff && swapKeys[ki] !== keyName) orderDiff = true;
        }
        same = valDiff ? false : (orderDiff || !mergePure) ? null : true;
      } else if (kind === 'x') {
        var curTest = regexProto ? safeProtoMethod(regexProto, 'test') : null;
        var curExec = regexProto ? safeProtoMethod(regexProto, 'exec') : null;
        if (typeof arg1 !== 'string' || !curTest || regexFn !== curTest || !isNativeFn(curTest) || !isNativeFn(curExec)) same = null;
        else if (value === true && site[8].pattern.indexOf('|') >= 0) same = null;
        else {
          var iso = isolatedRegexTest(site[8].alts[f], site[8].flags, arg1);
          same = iso === null ? null : is(value, iso);
        }
      } else if (kind === 'e') {
        altVal = edited(f);
        same = value === altVal;
        if (same === false && gFn && (op === '===' || op === '!==' || site[9] || (plain(l) && plain(r)))) {
          if (sameInGuard(value, altVal)) { same = true; absorbed = true; }
        }
      } else if (!logical) {
        same = alike(f, value);
        if (same === false && gFn && (kind === 'a' || kind === 'm')) {
          try { if (sameInGuard(value, apply(f, l, r, r2))) { same = true; absorbed = true; } } catch (e) { /* keep false */ }
        }
      } else if (site[5] || f === 'right' || rawR) {
        // A written right side (or switch-free pure guard right side) can be evaluated without touching nested switches.
        if (f === 'right' && !taken) same = true;
        else {
          var evalR = taken || site[5] ? r : rawR;
          other = f === 'right' ? constant : f === 'left' ? evalR() : (f === 'or' ? !l : missing) ? evalR() : l;
          same = site[1] ? !value === !other : is(value, other);
          if (same === false && gFn) {
            if (sameInGuard(value, other)) { same = true; absorbed = true; }
          }
        }
      } else same = f === 'left' ? taken : missing || !!l;
      var entry = seen[edits[k][0]] || (seen[edits[k][0]] = { tests: {} }), counts = entry.tests[test] || (entry.tests[test] = [0, 0, 0]);
      if (absorbed) entry.absorbed = true;
      if (kind === 'c' && !threw) {
        if (op === 'copyArray') {
          try { if (scope.Array.isArray(l)) entry.realCopy = true; else entry.nonArray = true; } catch (error) { /* leave unclassified */ }
        } else if (l === null || (typeof l !== 'object' && typeof l !== 'function')) {
          entry.nonPlain = true;
        } else if (!isProxy || !isProxy(l)) {
          try {
            var proto = scope.Object.getPrototypeOf(l);
            if (proto === scope.Object.prototype) entry.realCopy = true; else entry.nonPlain = true;
          } catch (error) { /* leave unclassified */ }
        }
      }
      if (kind === 's' && op === 'idx0') {
        if (threw) entry.threw = true;
        else if (scope.Array.isArray(l) || typeof l === 'string' || (isTypedArray && isTypedArray(l))) entry.sequence = true;
        else if (l != null) {
          var isSeq = false;
          try {
            if (!isProxy || !isTypedArray || isProxy(l)) isSeq = true;
            else {
              for (var cur = l, depth = 0; cur; depth++) {
                if (depth >= 16 || isProxy(cur)) { isSeq = true; break; }
                var atDesc = scope.Object.getOwnPropertyDescriptor(cur, 'at');
                if (atDesc) { isSeq = 'value' in atDesc ? typeof atDesc.value === 'function' : true; break; }
                cur = scope.Object.getPrototypeOf(cur);
              }
            }
          } catch (error) { isSeq = true; }
          if (isSeq) entry.sequence = true; else entry.nonSequence = true;
        }
      }
      var slot = same === null ? 'unsure' : same ? 'agree' : 'differ';
      counts[same === null ? 2 : same ? 0 : 1]++;
      if (kind === 'p' && !threw && !entry[slot]) {
        entry[slot] = [spreadHad ? show(spreadBase[spreadKey]) : '(missing)', show(spreadVals[spreadIdx])];
      } else if (kind === 'k' && !threw && !entry[slot]) {
        entry[slot] = clampVals.map(show);
      } else if ((kind === 'u' || kind === 'x') && !threw && !entry[slot]) {
        entry[slot] = [show(arg1)];
      } else if (kind === 'g' && !threw && !entry[slot]) {
        entry[slot] = [show(mergeA), show(mergeB)];
      } else if (kind === 'r' && !entry[slot]) {
        entry[slot] = threw ? [show(l)] : [show(l), show(arg1)];
      } else if (kind !== 'c' && kind !== 'p' && kind !== 'r' && kind !== 'k' && kind !== 'u' && kind !== 'g' && kind !== 'x' && !entry[slot]) entry[slot] = (logical ? !taken || threw : site[7] === 1) ? [show(l)] : [show(l), show(logical ? value : r)];
      var type = typeof l;
      if (type === 'number' || type === 'string' || type === 'bigint' || type === 'boolean') entry.typed = true;
    }
  }
}
`;
const outerFirst = { statement: 0, block: 0, case: 0, expression: 1, observed: 2 };

function unusedName(text, base) {
  let name = base;
  while (text.includes(name)) name += '_';
  return name;
}

// A plain edit at the start of a statement must not begin with a token that continues the previous line.
function asStatementStart(mutant, text) {
  const edited = mutant.mutated.trimStart();
  const risky = (mutant.statement || mutant.leading) && '([`+-/'.includes(edited[0]) && edited[0] !== text[mutant.placement[0]];
  return risky ? ' void 0, ' + edited : mutant.mutated;
}

export function renderBuiltinSwitches(input, file, selected = () => true, options = {}) {
  const text = input.toString();
  const all = collectMutations(text, file, { ...options, selected });
  const found = options.keep ? all.filter(mutation => options.keep(mutation, text)) : all;
  if (!found.length) return { output: text, mutants: [] };
  const live = found.filter(mutation => mutation.ignored === undefined);
  const bytes = byteOffsets(text);
  const lineStarts = [0];
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) lineStarts.push(match.index + match[0].length);
  const lineOf = offset => {
    let line = lineStarts.length - 1;
    while (lineStarts[line] > offset) line--;
    return line;
  };
  const on = unusedName(text, '__tmtOn');
  const cover = unusedName(text, '__tmtCover');
  const shift = unusedName(text, '__tmtShift');
  const see = unusedName(text, '__tmtSee');
  const table = unusedName(text, '__tmtSite');
  const valParam = unusedName(text, '__tmtVal');
  const probed = [];
  const identified = mutation => ({ ...mutation,
    id: createHash('sha256').update(JSON.stringify([file, mutation.name, mutation.start, mutation.end, mutation.replacement])).digest('hex').slice(0, 16) });
  const rawMutants = live.map(identified).map(mutant => mutant.shift === undefined ? mutant
    : { ...mutant, mutated: mutant.mutated.replace(shiftPlaceholder, `${shift}()`) });
  // When built-in expression mutations sit inside an observed probe's syntax but outside its rendered
  // operands (e.g. `arr.length - 1` inside `arr[arr.length - 1]`, `-1` inside `arr.at(-1)`, literals in
  // `['a', 'b'].includes(x)`), lift their switch placement to the enclosing observed expression so no
  // live mutant is dropped when the probe renders only its operands.
  const observedHosts = rawMutants
    .filter(mutant => mutant.kind === 'observed')
    .sort((a, b) => (b.placement[1] - b.placement[0]) - (a.placement[1] - a.placement[0]));
  const mutants = observedHosts.length
    ? rawMutants.map(mutant => {
      if (mutant.kind !== 'expression') return mutant;
      const [p0, p1] = mutant.placement;
      const host = observedHosts.find(obs =>
        obs.placement[0] <= p0 && p1 <= obs.placement[1] &&
        (obs.placement[0] !== p0 || obs.placement[1] !== p1) &&
        !obs.operands.some(([o0, o1]) => o0 <= p0 && p1 <= o1));
      if (!host) return mutant;
      return {
        ...mutant,
        placement: host.placement,
        statement: host.statement,
        leading: host.leading,
        named: undefined,
        mutated: text.slice(host.placement[0], p0) + mutant.mutated + text.slice(p1, host.placement[1]),
      };
    })
    : rawMutants;

  const groups = new Map();
  for (const mutant of mutants) {
    const key = `${mutant.placement[0]}:${mutant.placement[1]}:${mutant.kind}`;
    if (!groups.has(key)) groups.set(key, { ...mutant, mutants: [] });
    groups.get(key).mutants.push(mutant);
  }
  const ordered = [...groups.values()].sort((a, b) => a.placement[0] - b.placement[0] || b.placement[1] - a.placement[1] ||
    outerFirst[a.kind] - outerFirst[b.kind]);
  let index = 0;

  function render(start, end) {
    let out = '';
    let from = start;
    while (index < ordered.length && ordered[index].placement[0] < end) {
      const group = ordered[index++];
      const [first, last] = group.placement;
      out += text.slice(from, first);
      const ids = group.mutants.map(mutant => JSON.stringify(mutant.id));
      if (group.kind === 'expression') {
        const inner = render(first, last);
        // An arrow function bound to a variable keeps the variable's name through an inner binding.
        // A property initializer names the function without adding a binding the function body could see.
        const keepName = body => group.named ? `({ ${group.named}: ${body} }).${group.named}` : body;
        const choice = group.mutants.map(mutant => `${on}(${JSON.stringify(mutant.id)}) ? ${keepName(mutant.mutated)} : `).join('') +
          `(${cover}(${ids.join(', ')}), ${keepName(inner)})`;
        // A statement that starts with `(` could continue the previous line as a call.
        // The leading space separates the switch from a keyword such as `do` or `else`.
        out += group.statement ? ` ${choice}` : group.leading ? ` void 0, (${choice})` : `(${choice})`;
      } else if (group.kind === 'observed') {
        // The operands are rendered in source order; what stands between them is the operation the probe performs.
        // Each in parentheses of its own: a probe inside may begin with `void 0,`, which must stay one argument.
        const operands = group.operands.map(([start, end]) => `(${render(start, end)})`);
        const { operator, boolean, thunk, spreadKeys, pureProps, clampMeta, setElems, regexMeta, pureMerge, guardSpan, guardBoolean, nullishSafeLoose, rawRightSpan } = group.targeted;
        // Only the edits beside a written null or undefined say on which side it stands.
        const literalSide = group.mutants.find(mutant => mutant.targeted.literalSide !== undefined)?.targeted.literalSide ?? 0;
        const kind = thunk ? 'l' : ['===', '!==', '==', '!='].includes(operator) ? 'e' : operator.length === 1 ? 'a'
          : ['max', 'min', 'floor', 'ceil', 'round', 'trunc'].includes(operator) ? 'm'
            : operator === 'copyArray' || operator === 'copyObject' ? 'c'
              : operator === 'spreadUpdate' ? 'p'
                : operator === 'clamp' ? 'k'
                  : operator === 'literalIncludes' ? 'u'
                    : operator === 'mergeSpread' ? 'g'
                      : operator === 'regexTest' ? 'x'
                        : ['startsWith', 'endsWith', 'replace', 'replaceAll', 'every', 'some'].includes(operator) ? 'r' : 's';
        const row = [operator, boolean ? 1 : 0, group.mutants.map(mutant => [mutant.id, mutant.targeted.form]), literalSide,
          group.mutants.map(mutant => mutant.id), group.targeted.pureRight ? 1 : 0, kind, operands.length];
        if (spreadKeys) row.push(spreadKeys, pureProps);
        else if (clampMeta) row.push(clampMeta);
        else if (regexMeta) row.push(regexMeta);
        else if (pureMerge !== undefined) row.push(pureMerge);
        else if (guardSpan) row.push(guardBoolean ? 1 : 0, nullishSafeLoose ? 1 : 0);
        probed.push(row);
        let callArgs;
        let argCount = operands.length;
        if (thunk) {
          operands[1] = `() => ${operands[1]}`;
          callArgs = operands.join(', ');
          argCount = 2;
        } else if (kind === 'p') {
          callArgs = `${operands[0]}, [${operands.slice(1).map(opExpr => `() => ${opExpr}`).join(', ')}]`;
          argCount = 2;
        } else if (kind === 'k') {
          callArgs = `[${operands.map(opExpr => `() => ${opExpr}`).join(', ')}]`;
          argCount = 1;
        } else if (kind === 'u') {
          callArgs = `[${setElems.join(', ')}], () => ${operands[0]}`;
          argCount = 2;
        } else if (kind === 'g') {
          callArgs = `() => ${operands[0]}, () => ${operands[1]}`;
          argCount = 2;
        } else if (kind === 'x') {
          const litEntries = [`orig: () => /${regexMeta.pattern || '(?:)'}/${regexMeta.flags}`];
          for (const [fKey, altPat] of Object.entries(regexMeta.alts)) {
            litEntries.push(`${fKey}: () => /${altPat || '(?:)'}/${regexMeta.flags}`);
          }
          callArgs = `{ ${litEntries.join(', ')} }, () => ${operands[0]}`;
          argCount = 2;
        } else if (kind === 'r') {
          callArgs = `${operands[0]}, ${operands.slice(1).map(opExpr => `() => ${opExpr}`).join(', ')}`;
          argCount = operands.length;
        } else {
          callArgs = operands.join(', ');
        }
        if (guardSpan && argCount <= 3) {
          const pad = ', void 0'.repeat(3 - argCount);
          const guardFn = `${valParam} => (${text.slice(guardSpan[0], first)}(${valParam})${text.slice(last, guardSpan[1])})`;
          const guardArg = thunk && rawRightSpan
            ? `{ g: ${guardFn}, r: () => (${text.slice(rawRightSpan[0], rawRightSpan[1])}) }`
            : guardFn;
          callArgs = `${callArgs}${pad}, ${guardArg}`;
        }
        const call = `${see}(${probed.length - 1}, ${callArgs})`;
        // Nothing inside the expression is left to render: an index the probe works out itself has no switch.
        while (index < ordered.length && ordered[index].placement[0] < last) index++;
        out += group.statement ? ` ${call}` : group.leading ? ` void 0, (${call})` : `(${call})`;
      } else if (group.kind === 'block') {
        // The semicolon ends a directive prologue that relies on a line break.
        // A function body returns early instead of moving into a block, which would change how its declarations are scoped.
        out += group.functionBody
          ? `${text.slice(first, group.bodyStart)}; if (${on}(${ids[0]})) return; ${cover}(${ids[0]});` +
            `${render(group.bodyStart, group.bodyEnd)}${text.slice(group.bodyEnd, last)}`
          : `${text.slice(first, group.bodyStart)}; if (${on}(${ids[0]})) {} else { ${cover}(${ids[0]});` +
            `${render(group.bodyStart, group.bodyEnd)}\n} ${text.slice(group.bodyEnd, last)}`;
      } else if (group.kind === 'case') {
        // The case expression can hold switches of its own, so the head is rendered too.
        out += `${render(first, group.bodyStart)} if (${on}(${ids[0]})) {} else { ${cover}(${ids[0]});${render(group.bodyStart, last)}\n}`;
      } else {
        out += ' { ' + group.mutants.map(mutant => `if (${on}(${JSON.stringify(mutant.id)})) { ${mutant.mutated} } else `).join('') +
          `{ ${cover}(${ids.join(', ')}); ${render(first, last)}\n} }`;
      }
      from = last;
    }
    return out + text.slice(from, end);
  }

  // A module that binds its own `globalThis` reaches the real global object through an indirect eval.
  const scope = /\bglobalThis\b/.test(text) ? "(0, eval)('this')" : 'globalThis';
  // A file whose mutations are all ignored keeps its source.
  const rendered = mutants.length ? render(0, text.length) : text;
  const output = mutants.length ? rendered + helpers(on, cover, shift, scope) + (probed.length ? probe(see, table, cover, scope, probed) : '') : text;
  // Ignored mutations are reported in source order with the others and get no switch.
  const reported = [...mutants, ...found.filter(mutation => mutation.ignored !== undefined).map(identified)]
    .sort((a, b) => a.start - b.start || b.end - a.end);
  return { output, mutants: reported.map(mutant => {
    const line = lineOf(mutant.start);
    const edit = [bytes[mutant.start], bytes[mutant.end]];
    return {
      id: mutant.id, mutatorName: mutant.name,
      location: { file, line: line + 1, column: mutant.start - lineStarts[line] + 1, start: edit[0], end: edit[1] },
      edit, original: text.slice(mutant.start, mutant.end), replacement: mutant.replacement,
      // The same mutation as a plain source edit, for runners that cannot use switches.
      source: { edit: [bytes[mutant.placement[0]], bytes[mutant.placement[1]]], replacement: asStatementStart(mutant, text) },
      ...(mutant.operator ? { operatorSwap: [bytes[mutant.operator[0]], mutant.operator[1]] } : {}),
      ...(mutant.targeted ? { targeted: mutant.targeted } : {}),
      ...(mutant.ignored === undefined ? {} : { status: 'ignored', statusReason: mutant.ignored }),
      // A shift switch is driven by the focused analysis and is not a mutation of its own.
      ...(mutant.shift === undefined ? {} : { parametric: { file, at: bytes[mutant.shift] } }),
    };
  }) };
}

// The swaps the focused analysis makes at a comparison boundary: `>=` with `>` and `<=` with `<`.
export const boundarySwap = (mutation, text) => mutation.shift !== undefined || (mutation.operator !== undefined &&
  ['>', '>=', '<', '<='].includes(mutation.operator[1]) && text[mutation.operator[0]] === mutation.operator[1][0]);

// The boundary swaps that a `// Stryker disable` or `// tmt:ignore` comment covers, as `offset:replacement` keys in UTF-8 bytes.
export function ignoredSwaps(input, file, options = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  if (!text.includes('Stryker ') && !/tmt:ignore/i.test(text)) return new Set();
  return new Set(renderBuiltinSwitches(input, file, () => true, { ...options, keep: boundarySwap }).mutants
    .filter(mutant => mutant.status === 'ignored' && mutant.operatorSwap).map(mutant => mutant.operatorSwap.join(':')));
}

// The targeted profile: its own rules, and the comparison boundaries the focused analysis asks about.
export const targetedOrBoundary = (mutation, text) => mutation.targeted !== undefined || boundarySwap(mutation, text);

export function prepareBuiltinSwitches(subjects, options = {}) {
  const sources = [];
  const mutants = [];
  const { typeContext, ...restOptions } = options;
  for (const { file, input, selected } of subjects) {
    const typeEquivalence = typeContext?.forFile(file) ?? null;
    const rendered = renderBuiltinSwitches(input, file, selected, { ...restOptions, typeEquivalence });
    if (!rendered.mutants.length) continue;
    if (rendered.output !== input.toString()) sources.push({ file, output: rendered.output });
    mutants.push(...rendered.mutants);
  }
  return { sources, mutants };
}
