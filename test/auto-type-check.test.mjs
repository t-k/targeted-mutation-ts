import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { mergeProjectConfig } from '../src/project-config.mjs';
import { createTypeContext } from '../src/type-equivalence.mjs';
import { loadTypeScript } from '../src/typescript-compiler.mjs';

const cli = resolve('bin/tmt.mjs');
const pictRows = readFileSync(new URL('../verification/pict/type-check-default.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(line => line.split('\t'));

function withTempProject(files, action) {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-auto-tc-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const nullishSource = `export function pick(x: string | null) {
  return x === null ? 'empty' : x;
}
`;
const plainSource = `export function add(a: number, b: number) {
  return a + b;
}
`;

test('PICT type-check-default matrix: CLI flags, config, tsconfig state, and nullish sites', () => {
  for (const [cliFlag, configTypeCheck, tsconfigState, nullishSite] of pictRows) {
    const files = {
      'src/target.ts': nullishSite === 'Present' ? nullishSource : plainSource,
    };
    if (tsconfigState === 'Strict') {
      files['tsconfig.json'] = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' } });
    } else if (tsconfigState === 'NonStrict') {
      files['tsconfig.json'] = JSON.stringify({ compilerOptions: { strict: false, strictNullChecks: false, target: 'ES2022' } });
    }
    if (configTypeCheck !== 'Unset') {
      files['targeted-mutation.config.json'] = JSON.stringify({ typeCheck: configTypeCheck === 'True' });
    }

    withTempProject(files, dir => {
      const args = [cli, 'analyze', dir, 'src/target.ts', '--list', '--format', 'json'];
      if (cliFlag === 'TypeCheck') args.push('--type-check');
      else if (cliFlag === 'NoTypeCheck') args.push('--no-type-check');
      else if (cliFlag === 'Tsconfig') args.push('--tsconfig', 'tsconfig.json');

      const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(res.status, 0, `row=${cliFlag}/${configTypeCheck}/${tsconfigState}/${nullishSite} stderr=${res.stderr}`);
      const report = JSON.parse(res.stdout);
      const nullishEq = report.mutants.filter(m => m.rule === 'nullish-equality/v1');

      let mode;
      if (cliFlag === 'NoTypeCheck') mode = 'off';
      else if (cliFlag === 'TypeCheck' || cliFlag === 'Tsconfig') mode = 'explicit';
      else if (configTypeCheck === 'False') mode = 'off';
      else if (configTypeCheck === 'True') mode = 'explicit';
      else mode = 'auto';

      const shouldSuppress = mode !== 'off' && tsconfigState === 'Strict';
      const shouldWarn = mode === 'explicit' && tsconfigState !== 'Strict';

      if (nullishSite === 'Absent') {
        assert.equal(nullishEq.length, 0);
      } else if (shouldSuppress) {
        assert.equal(nullishEq.length, 0, `Expected suppression for ${cliFlag}/${configTypeCheck}/${tsconfigState}`);
      } else {
        assert.equal(nullishEq.length, 1, `Expected nullish-equality/v1 kept for ${cliFlag}/${configTypeCheck}/${tsconfigState}`);
      }

      if (shouldWarn) {
        assert.match(res.stderr, /Warning: --type-check:/, `Expected warning for ${cliFlag}/${configTypeCheck}/${tsconfigState}`);
      } else {
        assert.doesNotMatch(res.stderr, /Warning: --type-check:/, `Unexpected warning for ${cliFlag}/${configTypeCheck}/${tsconfigState}: ${res.stderr}`);
      }
    });
  }
});

test('createTypeContext lazily builds ts.createProgram only when a nullish query is invoked', () => {
  withTempProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
    'src/plain.ts': plainSource,
    'src/nullish.ts': nullishSource,
  }, dir => {
    const realTs = loadTypeScript();
    let createProgramCalls = 0;
    const proxyTs = new Proxy(realTs, {
      get(target, prop, receiver) {
        if (prop === 'createProgram') {
          return (...args) => {
            createProgramCalls++;
            return target.createProgram(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const ctx = createTypeContext(dir, ['src/plain.ts', 'src/nullish.ts'], { silent: true, ts: proxyTs });
    assert.equal(ctx.strictNullChecks, true);
    assert.equal(createProgramCalls, 0, 'createProgram must not run before a nullish site queries the helper');
    const helper = ctx.forFile('src/plain.ts');
    assert.ok(helper);
    assert.equal(createProgramCalls, 0, 'forFile alone must not trigger createProgram');
    const nullishHelper = ctx.forFile('src/nullish.ts');
    const xIdx = nullishSource.indexOf('x === null');
    assert.equal(nullishHelper.isNullishEqualityEquivalent(xIdx, xIdx + 1, 'undefined'), true);
    assert.equal(createProgramCalls, 1, 'createProgram runs once when first nullish check executes');
  });
});

test('CLI rejects mutually exclusive --type-check/--no-type-check and --copy-exclude-gitignore/--no-copy-exclude-gitignore', () => {
  withTempProject({ 'src/a.ts': plainSource }, dir => {
    const tc = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/a.ts', '--list', '--type-check', '--no-type-check'], { encoding: 'utf8' });
    assert.equal(tc.status, 1);
    assert.match(tc.stderr, /--type-check cannot be combined with --no-type-check/);

    const gi = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/a.ts', '--list', '--copy-exclude-gitignore', '--no-copy-exclude-gitignore'], { encoding: 'utf8' });
    assert.equal(gi.status, 1);
    assert.match(gi.stderr, /--copy-exclude-gitignore cannot be combined with --no-copy-exclude-gitignore/);
  });
});

test('mergeProjectConfig honors boolean false for typeCheck and copyExcludeGitignore and CLI --no-* overrides', () => {
  const fromFalse = mergeProjectConfig({ typeCheck: false, copyExcludeGitignore: false }, {}, []);
  assert.equal(fromFalse.values['type-check'], false);
  assert.equal(fromFalse.values['copy-exclude-gitignore'], false);

  const cliOverride = mergeProjectConfig({ typeCheck: true, copyExcludeGitignore: true }, { 'no-type-check': true, 'no-copy-exclude-gitignore': true }, []);
  assert.equal(cliOverride.values['type-check'], undefined);
  assert.equal(cliOverride.values['copy-exclude-gitignore'], undefined);
});

test('Review fix: auto type-check preserves mutable closure-mutated nullish-equality and skips createProgram on &&-only files', async () => {
  const { collectMutations } = await import('../src/builtin-mutations.mjs');
  withTempProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true } }),
    'src/closure.ts': `export function check() {
  let value: string | undefined = 'x';
  const reset = () => { value = undefined; };
  reset();
  return value === null;
}
export function destructured() {
  let { value }: { value: string | undefined } = { value: 'x' };
  const reset = () => { value = undefined; };
  reset();
  return value === null;
}
export function guardedProp(state: { value: string | undefined }) {
  const reset = () => { state.value = undefined; };
  if (state.value !== undefined) {
    reset();
    return state.value === null;
  }
  return false;
}
`,
    'src/and-only.ts': `export function both(a: boolean, b: boolean) {
  return a && b;
}
`,
  }, dir => {
    // 1. Closure mutation breaks TS control-flow narrowing; declared type `string | undefined` must preserve `=== null -> == null`.
    const res = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/closure.ts', '--list', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const mutants = JSON.parse(res.stdout).mutants;
    assert.equal(mutants.filter(m => m.rule === 'nullish-equality/v1').length, 3, 'mutable let, destructured let, and guarded property must keep nullish-equality/v1');

    // 2. Logical `&&`-only file must never trigger ts.createProgram.
    const realTs = loadTypeScript();
    let createProgramCalls = 0;
    const proxyTs = new Proxy(realTs, {
      get(target, prop, receiver) {
        if (prop === 'createProgram') {
          return (...args) => { createProgramCalls++; return target.createProgram(...args); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const ctx = createTypeContext(dir, ['src/and-only.ts'], { silent: true, ts: proxyTs });
    const src = readFileSync(join(dir, 'src/and-only.ts'), 'utf8');
    collectMutations(src, 'src/and-only.ts', { targeted: true, typeEquivalence: ctx.forFile('src/and-only.ts') });
    assert.equal(createProgramCalls, 0, '&&-only file must not invoke ts.createProgram');
  });
});
