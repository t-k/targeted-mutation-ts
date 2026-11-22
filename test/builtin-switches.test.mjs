import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { renderBuiltinSwitches } from '../src/builtin-switches.mjs';
import { loadTypeScript } from '../src/typescript-compiler.mjs';

const input = readFileSync('fixtures/mutations/runtime.js');
const { output, mutants } = renderBuiltinSwitches(input, 'runtime.js');

function evaluate(source, state = {}) {
  const context = vm.createContext({ __stryker__: state });
  try {
    vm.runInContext(source + '\n;globalThis.__result = run();', context, { timeout: 2_000 });
    return JSON.parse(JSON.stringify(context.__result));
  } catch (error) {
    return `module ${error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : error.constructor.name}`;
  }
}
const rewrite = mutant => Buffer.concat([input.subarray(0, mutant.source.edit[0]), Buffer.from(mutant.source.replacement),
  input.subarray(mutant.source.edit[1])]).toString();
const original = evaluate(input.toString());

test('the fixture exercises every placement and runs to completion', () => {
  assert.equal(original.length, 11);
  assert.ok(original.every(entry => typeof entry === 'string'), JSON.stringify(original));
  assert.ok(mutants.length > 150, `${mutants.length} mutations`);
  for (const marker of ['; if (__tmtOn(', '{ if (__tmtOn(', '\nvoid 0, (__tmtOn(', '(() => { const identity = ', '{ __tmtCover(']) {
    assert.ok(output.includes(marker), marker);
  }
});

test('with every switch off the program behaves exactly as the original', () => {
  const state = {};
  assert.deepEqual(evaluate(output, state), original);
  const covered = Object.keys(state.mutantCoverage.static);
  assert.ok(covered.length > mutants.length / 2, `${covered.length} of ${mutants.length} covered`);
  assert.equal(new Set(mutants.map(mutant => mutant.id)).size, mutants.length);
});

test('each switch behaves exactly like the same mutation applied to the source text', () => {
  let changed = 0;
  for (const mutant of mutants) {
    const switched = evaluate(output, { activeMutant: mutant.id });
    const rewritten = evaluate(rewrite(mutant));
    assert.deepEqual(switched, rewritten, `${mutant.mutatorName} at ${mutant.location.line}:${mutant.location.column} -> ${mutant.replacement}`);
    if (JSON.stringify(switched) !== JSON.stringify(original)) changed++;
  }
  assert.ok(changed > mutants.length / 2, `${changed} of ${mutants.length} mutations change the observed results`);
});

test('switched TypeScript and TSX sources still parse, and so does every plain source edit', () => {
  const ts = loadTypeScript();
  const parses = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false).parseDiagnostics.map(problem =>
    `${ts.flattenDiagnosticMessageText(problem.messageText, ' ')} near ${JSON.stringify(text.slice(Math.max(0, problem.start - 40), problem.start + 40))}`);
  for (const file of ['fixtures/mutations/sample.ts', 'fixtures/mutations/component.tsx', 'fixtures/mutations/runtime.js',
    'src/analysis.mjs', 'src/typescript-grammar.mjs', 'src/builtin-mutations.mjs']) {
    const source = readFileSync(file);
    const rendered = renderBuiltinSwitches(source, file);
    assert.deepEqual(parses(file, rendered.output), [], file);
    for (const mutant of rendered.mutants) {
      const edited = Buffer.concat([source.subarray(0, mutant.source.edit[0]), Buffer.from(mutant.source.replacement),
        source.subarray(mutant.source.edit[1])]).toString();
      assert.deepEqual(parses(file, edited), [], `${file} ${mutant.mutatorName} ${mutant.location.line}:${mutant.location.column}`);
    }
  }
});

test('a file without mutations is returned unchanged and line selection limits the switches', () => {
  assert.deepEqual(renderBuiltinSwitches(Buffer.from('import x from "y";\nexport type T = { a: 1 };\n'), 'a.ts'),
    { output: 'import x from "y";\nexport type T = { a: 1 };\n', mutants: [] });
  const selected = renderBuiltinSwitches(Buffer.from('const a = 1 + 2;\nconst b = 3 * 4;\n'), 'a.js', line => line === 2);
  assert.deepEqual(selected.mutants.map(mutant => [mutant.mutatorName, mutant.location.line, mutant.location.column, mutant.original, mutant.replacement]),
    [['ArithmeticOperator', 2, 11, '3 * 4', '3 / 4']]);
  assert.ok(selected.output.startsWith('const a = 1 + 2;\nconst b = (__tmtOn('));
  const multibyte = renderBuiltinSwitches(Buffer.from('const s = "é😀"; const n = 1 + 2;'), 'a.js');
  const sum = multibyte.mutants.find(mutant => mutant.mutatorName === 'ArithmeticOperator');
  assert.equal(Buffer.from('const s = "é😀"; const n = 1 + 2;').subarray(...sum.edit).toString(), '1 + 2');
});

const placements = readFileSync(new URL('../verification/pict/builtin-switches.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const statementForms = {
  Expression: 'a + b > 1 ? note(1) : note(2)',
  Chain: 'list.filter(Boolean).length > 1 ? note(1) : note(2)',
  Block: '{ count++ }',
  Case: 'switch (b) { case 1: count++; break; default: count--; }',
  Statement: 'note(a)',
};
const nestedForms = {
  Expression: 'count += Number(a + b > 1)',
  Chain: 'count += list.filter(Boolean).length',
  Block: 'if (a) { count++ } else note(0)',
  Case: 'if (a) switch (b) { case 1: count++; break; default: count--; } else note(0)',
  // Without care, an if statement placed here would capture the following else.
  Statement: 'if (a) note(a); else note(0)',
};

for (const [placement, position, dialect] of placements) {
  test(`switch placement: ${placement} ${position} ${dialect}`, () => {
    const typed = dialect === 'Js' ? ['a, b, list', ''] : ['a: number, b: number, list: unknown[]', ': number[]'];
    const body = position === 'Nested' ? `count = 1;\n  ${nestedForms[placement]}`
      : position === 'StatementStart' ? `count = 1;\n  ${statementForms[placement]}`
        // The previous line ends without a semicolon, so the next statement must not start with `(` or `[`.
        : `const t = a\n  ${statementForms[placement]}`;
    const source = `var notes = []\nfunction note(x) { notes.push(x) }\n` +
      (dialect === 'Tsx' ? 'const view = (a: number) => <b title="t">{a}</b>;\n' : '') +
      `function f(${typed[0]})${typed[1]} {\n  let count = 0\n  ${body}\n  return [count, notes.length]\n}\n`;
    const file = { Js: 'p.js', Ts: 'p.ts', Tsx: 'p.tsx' }[dialect];
    const rendered = renderBuiltinSwitches(Buffer.from(source), file);
    const ts = loadTypeScript();
    const problems = text => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false).parseDiagnostics.length;
    assert.equal(problems(rendered.output), 0, rendered.output);
    assert.ok(rendered.mutants.length > 0);
    const edited = mutant => source.slice(0, mutant.source.edit[0]) + mutant.source.replacement + source.slice(mutant.source.edit[1]);
    for (const mutant of rendered.mutants) assert.equal(problems(edited(mutant)), 0, edited(mutant));
    if (dialect !== 'Js') return;
    const calls = text => {
      const context = vm.createContext({ __stryker__: text.state ?? {} });
      try {
        vm.runInContext(text.code, context, { timeout: 1_000 });
        return JSON.stringify([[0, 0, []], [1, 1, [1, 0, 2]], [2, 5, [1, 2]]].map(args => {
          context.args = args;
          try {
            return vm.runInContext('notes.length = 0, f(...args)', context, { timeout: 1_000 });
          } catch (error) {
            return error.constructor.name;
          }
        }));
      } catch (error) {
        return error.constructor.name;
      }
    };
    const expected = calls({ code: source });
    assert.equal(calls({ code: rendered.output }), expected);
    for (const mutant of rendered.mutants) {
      assert.equal(calls({ code: rendered.output, state: { activeMutant: mutant.id } }), calls({ code: edited(mutant) }),
        `${mutant.mutatorName} ${mutant.original} -> ${mutant.replacement}`);
    }
  });
}
