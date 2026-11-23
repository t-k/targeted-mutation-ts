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

if (import.meta.main) {
  const inputs = generatedCases();
  for (const path of process.argv.slice(2)) {
    const raw = JSON.parse(readFileSync(path));
    inputs.push(...mutateCases(path, raw.rows ?? raw));
  }
  console.log(JSON.stringify(inputs));
}
