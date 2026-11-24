import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const require = createRequire(import.meta.url);
const nodeModule = require('node:module');
const { emitAnnotatedModule } = require('../build/compiler-module.node');
const rows = readFileSync(new URL('../verification/pict/compiler-parameter-property-route.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const parameters = {
  Required: 'private readonly value: number',
  Optional: 'public value?: number',
  Default: 'protected value: number = 42',
};
const extra = { Plain: '', Namespace: '\nexport namespace Extra { export const item = 42; }',
  Enum: '\nexport enum Extra { Item = 42 }' };

for (const row of rows) {
  test('parameter property route ' + row.replaceAll('\t', ' '), () => {
    const [kind, parameter, other] = row.split('\t');
    const base = kind === 'Derived' ? 'class Base {}\n' : '';
    const extendsBase = kind === 'Derived' ? ' extends Base' : '';
    // A super call inside a block is not a statement of the constructor body, so the native emitter has no
    // place for the assignment and the reference compiler takes the file.
    const body = kind === 'Derived' ? '{ super(); }' : '"custom";';
    const source = base + 'export class Entry' + extendsBase + ' {\n  constructor(' + parameters[parameter] + ') { ' +
      body + ' }\n  read() { return this.value; }\n}' + extra[other];
    const hint = emitAnnotatedModule(Buffer.from(source), other === 'Enum', false);
    if (other === 'Plain') assert.deepEqual(hint, kind === 'Derived' ? { reference: true } : { parameterProperty: true });
    const calls = [];
    const original = nodeModule.stripTypeScriptTypes;
    nodeModule.stripTypeScriptTypes = (text, options) => {
      calls.push(options?.mode ?? 'strip');
      return original(text, options);
    };
    try {
      const output = compile(source, { file: 'class.ts' });
      assert.ok(output.code, source);
      if (other === 'Plain' && kind === 'Base') {
        assert.deepEqual(calls, ['transform']);
        if (output.backend === 'node-transform') {
          assert.equal(output.code, stripTypeScriptTypes(source, { mode: 'transform' }));
        }
      } else if (other === 'Plain') {
        assert.equal(output.backend, 'typescript');
        assert.deepEqual(calls, []);
      } else {
        assert.ok(!calls.includes('transform'), source);
      }
    } finally {
      nodeModule.stripTypeScriptTypes = original;
    }
  });
}
