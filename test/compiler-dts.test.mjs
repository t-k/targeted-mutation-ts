import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { emitDeclaration } from '../src/compiler.mjs';

function astShape(code) {
  const sf = ts.createSourceFile('out.d.ts', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  assert.equal(sf.parseDiagnostics?.length ?? 0, 0, code);
  const walk = node => {
    const out = [ts.SyntaxKind[node.kind]];
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) out.push(node.text);
    node.forEachChild(child => out.push(walk(child)));
    return out;
  };
  return walk(sf);
}

test('emitDeclaration produces isolatedDeclarations .d.ts natively matching ts.transpileDeclaration', () => {
  const cases = [
    `import type { Foo, Unused } from "./foo";
import { Bar } from "./bar";
const helper = 123;
function internal() { return helper; }
export const x: number = 1;
export let y: string = "hi";
export function add<T>(a: T, b: number = 0, ...rest: Foo[]): Promise<T> { return Promise.resolve(a); }
export interface Box<T> { value: T; }
export type Maybe<T> = T | null;
export enum Kind { A = 1, B = "b" }
export const enum Flags { None = 0, Read = 1 }
export { Bar };
export * from "./re";
`,
    `export async function fetchItem(id: string, retries: number = 3): Promise<string> { return id; }\n`,
    `export type Pair = [number, string];\nexport const origin: Pair = [0, ""];\n`,
  ];

  for (const source of cases) {
    const r = emitDeclaration(source, { file: 'mod.ts' });
    assert.equal(r.backend, 'native', source);
    assert.equal(r.diagnostics.length, 0, source);
    const expected = ts.transpileDeclaration(source, {
      fileName: 'mod.ts',
      reportDiagnostics: true,
      compilerOptions: { isolatedDeclarations: true, declaration: true },
    });
    assert.equal(expected.diagnostics.length, 0);
    assert.deepEqual(astShape(r.code), astShape(expected.outputText), `OURS:\n${r.code}\nTS:\n${expected.outputText}`);
  }
});

test('emitDeclaration falls back to TypeScript when inference, classes, or unsupported forms appear', () => {
  // Missing return type -> TypeScript reports isolatedDeclarations diagnostic.
  const missingRet = emitDeclaration('export function f(x: number) { return x + 1; }\n', { file: 'a.ts' });
  assert.equal(missingRet.backend, 'typescript');
  assert.ok(missingRet.diagnostics.length > 0);

  // Class declaration -> TypeScript emits declaration cleanly.
  const cls = emitDeclaration('export class Counter { count: number = 0; inc(): void { this.count++; } }\n', { file: 'a.ts' });
  assert.equal(cls.backend, 'typescript');
  assert.equal(cls.diagnostics.length, 0);
  assert.match(cls.code, /export declare class Counter/);

  // Local type referenced in export -> falls back cleanly.
  const localRef = emitDeclaration('type Local = number;\nexport const x: Local = 1;\n', { file: 'a.ts' });
  assert.equal(localRef.backend, 'typescript');
  assert.equal(localRef.diagnostics.length, 0);
});
