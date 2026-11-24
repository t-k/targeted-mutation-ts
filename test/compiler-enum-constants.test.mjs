import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { compile } from '../src/compiler.mjs';

const ts = createRequire(import.meta.url)('typescript');

// A small deterministic generator, so a failure names its seed.
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function literal(next) {
  const value = [0, 1, 2, 3, 7, 8, 15, 16, 31, 32, 255, 256, 1023, 65535, 65536, 2147483647, 2147483648, 4294967295,
    Math.floor(next() * 1000), Math.floor(next() * 2 ** 31)][Math.floor(next() * 20)];
  const form = next();
  return form < 0.55 ? String(value) : form < 0.8 ? '0x' + value.toString(16) : form < 0.9 ? '0o' + value.toString(8) :
    '0b' + value.toString(2);
}

function expression(next, names, depth) {
  const pick = next();
  if (depth === 0 || pick < 0.3) {
    if (names.length && next() < 0.35) {
      const name = names[Math.floor(next() * names.length)];
      return next() < 0.5 ? name : 'E.' + name;
    }
    return literal(next);
  }
  if (pick < 0.42) return ['-', '+', '~'][Math.floor(next() * 3)] + expression(next, names, depth - 1);
  if (pick < 0.52) return '(' + expression(next, names, depth - 1) + ')';
  const operator = ['+', '-', '*', '/', '%', '|', '&', '^', '<<', '>>', '>>>'][Math.floor(next() * 11)];
  const space = next() < 0.5 ? ' ' : '';
  return expression(next, names, depth - 1) + space + operator + space + expression(next, names, depth - 1);
}

function declaration(seed) {
  const next = random(seed);
  const names = [], members = [];
  const count = 1 + Math.floor(next() * 6);
  for (let index = 0; index < count; index++) {
    const name = String.fromCharCode(65 + index) + (next() < 0.2 ? '_' + index : '');
    // An unparenthesized unary operand of a binary minus or plus would read as a decrement or increment.
    const value = next() < 0.25 ? '' : ' = ' + expression(next, names, 1 + Math.floor(next() * 3)).replace(/([-+])\1/g, '$1 $1');
    members.push(name + value);
    names.push(name);
  }
  return `export enum E { ${members.join(', ')} }\n`;
}

// The members of the enum object that a module defines, with negative zero kept apart from zero.
function evaluate(code) {
  const context = vm.createContext({});
  vm.runInContext(code.replace(/^export /gm, ''), context);
  const value = vm.runInContext('E', context);
  return Object.entries(value).map(([key, member]) => [key, Object.is(member, -0) ? '-0' : member]);
}

function reference(source) {
  const result = ts.transpileModule(source, { fileName: 'e.ts', reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true } });
  return result.diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ? null : result.outputText;
}

test('constant enum initializers evaluate as TypeScript evaluates them', () => {
  let native = 0, total = 0;
  for (let seed = 1; seed <= 6000; seed++) {
    const source = declaration(seed);
    const expected = reference(source);
    if (expected === null) continue;
    total++;
    const result = compile(Buffer.from(source), { file: 'e.ts' });
    assert.equal(typeof result.code, 'string', `seed ${seed}: ${source}`);
    if (result.backend !== 'pulse') continue;
    native++;
    assert.deepEqual(evaluate(result.code), evaluate(expected), `seed ${seed}: ${source}${result.code}`);
  }
  // Most generated declarations are within the native evaluator. The rest leave the route for a non-integer result.
  assert.ok(native > total * 0.5, `${native} of ${total}`);
});

test('constant enum initializers evaluate the same inside a function', () => {
  let native = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const source = 'export function make() {\n' + declaration(seed).replace('export enum', 'enum') + 'return E;\n}\n';
    const expected = reference(source);
    if (expected === null) continue;
    const result = compile(Buffer.from(source), { file: 'e.ts' });
    if (result.backend !== 'pulse') continue;
    native++;
    const members = code => {
      const context = vm.createContext({});
      vm.runInContext(code.replace(/^export /gm, ''), context);
      return Object.entries(vm.runInContext('make()', context)).map(([key, member]) => [key, Object.is(member, -0) ? '-0' : member]);
    };
    assert.deepEqual(members(result.code), members(expected), `seed ${seed}: ${source}${result.code}`);
  }
  assert.ok(native > 700, String(native));
});

test('enum initializers outside the constant evaluator match TypeScript or leave the native route', () => {
  for (const [source, native] of [
    ['export enum E { A = 0x10, B = 0b101, C = 0o17, D }', true],
    ['export enum E { A = 1 << 0, B = 1 << 1, C = A | B, D = E.A | E.C, F = ~D & 0xff }', true],
    ['export enum E { A = -1, B, C = (A + 3) * 2, D = C % 4, F = C / 2 }', true],
    ['export enum E { A = 1 << 31, B = 1 << 32, C = -1 >>> 0, D = -1 >>> 28, F = 2147483648 | 0 }', true],
    ['export enum E { A = "a", B = "b" }', true],
    ['export enum E { A = 1, B = "b", C = 2, D }', true],
    ['export enum E { A = 9007199254740991, B = A - 1 }', true],
    ['export enum E { A = 1 / 2 }', false],
    ['export enum E { A = 0 * -1 }', false],
    ['export enum E { A = -0 }', false],
    ['export enum E { A = 5 % 0, B = 1 / 0 }', false],
    ['export enum E { A = 9007199254740991, B = A + 2 }', false],
    ['export enum E { A = "a".length }', false],
    ['export enum E { A = 1, B = A.toString().length }', false],
    ['const k = 2;\nexport enum E { A = k }', false],
    ['export enum E { A = 1_000 }', false],
    ['export enum E { A = 1.5, B = 1e3 }', false],
    ['export enum E { A = 010 }', false],
    ['export enum E { A = 2 ** 3 }', false],
    ['export enum E { A = `a` }', false],
    ['export enum E { A = "a" + "b" }', false],
    ['export enum E { A = "x", B = A }', false],
    ['export enum E { A = B, B = 1 }', false],
    ['export enum E { A = 1, B = F.A }', false],
    // A member named like a literal is not what the bare word means, and an update is not constant.
    ['export enum E { false = 7, Default = +false }', false],
    ['export enum E { true = 2, null = 3, A = true | null }', false],
    ['export enum E { false = 7, Default = E.false + 1 }', true],
    ['export enum E { A = 1, B = A++ + 2 }', false],
    // A reserved word is a syntax error as a bare reference, even when a member has that name.
    ['export enum E { default = 0, initial = default }', false],
    ['export enum E { return = 1, x = return + 1 }', false],
    ['export enum E { default = 0, initial = E.default + 2 }', true],
    // Two members of one name, quoted or not, are left to TypeScript, which resolves a reference to the first.
    ['export enum E { "Ready" = 1, Ready = 2, Default = Ready }', false],
    ['export enum E { A = 1, A = 2 }', false],
    ['export enum E { A = 5, B = A-- - 2 }', false],
    ['export enum E { A = 1, B = A + +2, C = A - -2, D = A + -B }', true],
  ]) {
    const result = compile(Buffer.from(source), { file: 'e.ts' });
    const expected = reference(source);
    if (native) assert.equal(result.backend, 'pulse', source);
    else assert.notEqual(result.backend, 'pulse', source);
    if (result.backend === 'pulse') {
      assert.deepEqual(evaluate(result.code.replace(/^const k = 2;\n/, '')), evaluate(expected), source + '\n' + result.code);
    }
  }
});
