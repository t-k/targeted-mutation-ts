import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const fixture = (file, value) => ({ file, mode: 'module', source: Buffer.from(value).toString('base64') });
const expressionCases = new Map([
  ['chain', 'const result = 1 as number satisfies number;'],
  ['conditional', 'const result = true ? (1) : (2 as number);'],
  ['template', 'const result = `as < type: ${1 as number}`;'],
  ['regex', 'const result = /satisfies|<T>/.test("as");'],
  ['comparison', 'const result = 0 < 1 && 2 > 1;'],
  ['instantiation', 'const result = (String<number>);'],
  ['unbound-export', 'type Result = number; export { Result }; const result = 42;'],
  ['duplicate', 'const result = 1; const result = 2;'],
  ['newline', 'const result = (value: number): {\\LINE\\value: number\\LINE\\} => ({ value });'],
  ['assertion-then-array', 'const result = [1] as number[]\\LINE\\[0];'],
  ['assertion-then-paren', 'const result = Math.abs as typeof Math.abs\\LINE\\(-42);'],
  ['class-computed', 'const result = class { item: number\\LINE\\["method"]() { return 1; } };'],
  ['enum', 'enum Flag { Ready = 42 }; const result = Flag.Ready;'],
  ['raw-receiver', 'const result = function(this) { return this; };'],
]);
export function generatedCases() {
  const inputs = [];
  for (const dialect of ['ts', 'tsx']) {
    const start = dialect === 'tsx' ? 'export const view = () => <i title="&amp;"/>;\n' : '';
    for (const [shape, code] of expressionCases) {
      for (const [newlineName, newline] of [['lf', '\n'], ['crlf', '\r\n'], ['unicode', '\u2028']]) {
        for (const [style, header] of [['empty', ''], ['directive', '"use strict";' + newline],
          ['comment', '/* prefix with type and < */' + newline]]) {
          const suffix = 'export const output = result;' + newline;
          inputs.push(fixture('generated/' + shape + '/' + newlineName + '/' + style + '.' + dialect,
            header + start + code.replaceAll('\\LINE\\', newline) + newline + suffix));
        }
      }
    }
  }
  return inputs;
}

export function mutateCases(path, corpus) {
  const suffixes = [
    '\nexport const tmtAuditAdded = (): {\n n: number;\n} => ({n: 1});\n',
    '\ntype TmtAuditRemoved = number;\nexport { TmtAuditRemoved };\n',
    '\nexport const tmtAuditMalformed = ready as boolean ? ++count < limit : false;\n',
    '\n// tmt audit EOF comment\n',
  ];
  const selected = corpus.filter(test => test.mode === 'module' &&
    /\.[jt]sx?$/.test(test.file) && !test.file.endsWith('.d.ts'));
  const variants = [];
  for (let index = 0; index < Math.min(selected.length, 137); index += 17) {
    const { file, source } = selected[index];
    const original = Buffer.from(source, 'base64').toString('utf8');
    for (const [mutation, suffix] of suffixes.entries()) {
      variants.push(fixture('mutation/' + basename(path, '.json') + '/' + mutation + '/' + file, original + suffix));
    }
  }
  return variants;
}

const certificationShapes = new Map([
  ['annotation', 'const result: number = 42;'],
  ['arguments', 'const result = new Map<string, number>().size + 42;'],
  ['assertion', 'const result = 42 as number;'],
  ['markers', 'class Box { value?: number; ready!: boolean }\\LINE\\const result = new Box();'],
  ['erased-statement', 'interface Shape { side: number }\\LINE\\const result = 42;'],
  ['overload', 'function pick(value: string): string;\\LINE\\function pick(value: number): number;\\LINE\\' +
    'function pick(value: any) { return value; }\\LINE\\const result = pick(42);'],
  ['modifiers', 'class Box { private readonly value = 42; }\\LINE\\const result = new Box();'],
  ['literal-enum', 'enum Flag { Ready = 42 }\\LINE\\const result = Flag.Ready;'],
  ['computed-enum', 'function next() { return 9; }\\LINE\\enum Flag { On = next() }\\LINE\\const result = Flag.On;'],
  ['string-enum-implicit', 'enum Ready { A = "s", B }\\LINE\\const result = Ready.A;'],
  ['constructor-this', 'class Box { constructor(this: Box) {} }\\LINE\\const result = 42;'],
  ['ambient-class-export', 'declare class Ambient {}\\LINE\\export { Ambient };\\LINE\\const result = 42;'],
  ['ambient-const-export', 'declare const ambient: number;\\LINE\\export { ambient };\\LINE\\const result = 42;'],
  ['parameter-property', 'class Box { constructor(public value: number) {} }\\LINE\\const result = new Box(42);'],
  ['parameter-property-derived', 'class Base {}\\LINE\\class Box extends Base { constructor(private readonly value: number, protected other = 1) { super()\\LINE\\} }\\LINE\\const result = new Box(42);'],
  ['parameter-property-constructor', 'class Box { constructor(public constructor: number) {} }\\LINE\\const result = 42;'],
  ['ambient-enum-export', 'declare enum Ambient { A }\\LINE\\export { Ambient };\\LINE\\const result = 42;'],
  ['ambient-var-export-as', 'declare var ambient: number;\\LINE\\export { ambient as renamed };\\LINE\\const result = 42;'],
  ['ambient-class-export-before', 'export { Ambient };\\LINE\\declare abstract class Ambient {}\\LINE\\const result = 42;'],
  ['ambient-function-export', 'declare function ambient(): void;\\LINE\\export { ambient };\\LINE\\const result = 42;'],
  ['ambient-const-reference', 'declare const ambient: number;\\LINE\\const result = typeof ambient;'],
  ['ambient-class-default', 'declare class Ambient {}\\LINE\\export default Ambient;\\LINE\\const result = 42;'],
  ['ambient-const-duplicate', 'declare const ambient: number;\\LINE\\const ambient = 1;\\LINE\\const result = ambient;'],
  ['ambient-enum-duplicate', 'declare enum Ambient { A }\\LINE\\class Ambient {}\\LINE\\const result = 42;'],
]);

// Shapes that the emitter certifies, and shapes that only V8 or a compatibility route can decide.
export function certificationCases() {
  const inputs = [];
  for (const dialect of ['ts', 'tsx']) {
    const view = dialect === 'tsx' ? 'export const view = () => <i title="&amp;"/>;\\LINE\\' : '';
    for (const [shape, code] of certificationShapes) {
      for (const [newlineName, newline] of [['lf', '\n'], ['crlf', '\r\n']]) {
        for (const [position, lead] of [['first', ''], ['after-import', 'import { lead } from "./lead.js";\\LINE\\'],
          ['after-erased', 'type Lead = string;\\LINE\\']]) {
          const text = lead + view + code + '\\LINE\\export const output = result;\\LINE\\';
          inputs.push(fixture('certification/' + shape + '/' + newlineName + '/' + position + '.' + dialect,
            text.replaceAll('\\LINE\\', newline)));
        }
      }
    }
  }
  return inputs;
}

if (import.meta.main) {
  const inputs = generatedCases().concat(certificationCases());
  for (const path of process.argv.slice(2)) {
    const raw = JSON.parse(readFileSync(path));
    inputs.push(...mutateCases(path, raw.rows ?? raw));
  }
  console.log(JSON.stringify(inputs));
}
