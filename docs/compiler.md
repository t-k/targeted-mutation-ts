# Standalone JavaScript and TypeScript compiler experiment

The compiler emits one JavaScript file at a time. The API accepts JavaScript, TypeScript, JSX, and TSX, selects an ECMAScript target and a module format, and can emit a source map. It can lower runtime TypeScript forms such as enums, transform JSX, and preserve JSX when requested. Type checking, declaration generation, module resolution, and bundling are outside the isolated-file API.

```sh
npm ci --ignore-scripts
npm run build:compiler
node bin/tmt-compile.mjs --target es2018 --module cjs --source-map input.tsx > output.cjs
node bin/tmt-compile.mjs --strip input.ts > output.js
```

The CLI writes an inline map when requested. The library returns `{ backend, code, sourceMap, diagnostics }`. It reports diagnostic ranges in UTF-16 code units. An error sets both output fields to `null`. The default target is `esnext` and the default module mode is `preserve`. The `.mts` and `.mjs` extensions imply ESM, and the `.cts` and `.cjs` extensions imply CommonJS. Explicit `esm` and `cjs` settings override that default. CommonJS validation checks the generated JavaScript as a Node module wrapper. `--jsx preserve` returns JSX syntax for a later stage.

```js
import { compile } from './src/compiler.mjs';

const result = compile('export const eligible = (age: number) => age >= 18;', {
  file: 'eligibility.ts',
});
```

CommonJS callers can load the same implementation from `src/compiler.cjs`. Strip mode implements the position-preserving contract for TypeScript files without JSX. It rejects syntax that needs runtime lowering and the compiler reports a diagnostic. Transform mode selects the native emitter, Node type erasure, or the isolated TypeScript emitter according to the input and output options.

## Native path and proof

The `pulse` backend handles bounded exported constants, simple typed arrows, complete type-only modules, and runtime JSX and enum forms. The native JSX emitter handles automatic and classic runtimes, elements and fragments, nested children, multiline text, typical attributes and object spreads. Its entry points include direct and parenthesized initializers, arrow expressions, and simple exported function components. The enum emitter handles numeric and string literal members, signed values, implicit numbering, reverse maps, and literal `const enum` declarations under isolated emission semantics.

The direct Node addon includes only the necessary Pulse entry points and the runtime emitter. The full-module addon records JSX element and expression spans during the validated Pulse parse. It publishes initialized records only after reaching EOF. The emitter visits the captured spans, reuses expression boundaries, and copies the surrounding source. This supports JSX in function bodies, nested callback expressions, attributes, conditionals, and scripts. ESNext JavaScript scripts use V8 syntax validation and preserve the original source and strictness whenever possible.

The `pulse+node-strip` route passes the remaining erasable syntax through Node. The `node-strip` route covers validated TypeScript modules and ordinary scripts. The Node 24 compatibility path also lowers constructor parameter properties. ESNext compilation can use the native paths without the full TypeScript compiler or the optional TypeScript syntax projection.

The Pulse span writer proves that a successful replacement changes only the requested bytes and that invalid spans leave the buffer untouched. The extracted parser preserves its input borrow. The runtime C emitter is checked by executable differential tests. The NEON and SSE2 builds accelerate comment and string scanning when the generated scalar functions match the checked versions. The extraction check regenerates and compares both variants of the generated C and headers.

Computed enum initializers, runtime namespaces, object-literal JSX spreads, CommonJS, downlevel targets, and source maps can still require the TypeScript emitter. Output formatting can differ across the supported backends.

```sh
FSTAR_EXE=/path/to/fstar.exe KARAMEL_EXE=/path/to/krml npm run verify:compiler
node --test test/compiler*.test.mjs
```

## Fixed-corpus coverage

All 537 TypeScript and 116 TSX files in the pinned Vite, mreact and tachyon-dom cohorts emitted valid JavaScript in Node 24.14.0. The audit blocked resolution of both the TypeScript package and its syntax projection in the compilation subprocess. A separate copy containing the compiler's JavaScript entrypoints and native binaries also passed all 653 files with no installed dependencies. All 116 TSX outputs matched the reference's normalized JavaScript syntax and static dependency order. Five of the 537 TypeScript outputs differed in constructor statement grouping or optional-chain parentheses. The gate accepts only the reviewed AST pairs tied to those exact source bytes.

An additional four-project probe produced valid JavaScript for 1,406 of 1,426 TypeScript and TSX inputs without TypeScript. Seventeen inputs still required the compatibility emitter, and three Hono inputs received an unbound runtime export diagnostic. Those files referenced type-only names in ordinary local export lists.

TypeScript is the external conformance source. The audit reads Git blobs from the pinned TypeScript revision and extracts single-file JavaScript baselines and the corresponding source, with harness directives treated as compile options. Two of the eight sampled fixtures match without TypeScript. The six other cases include CommonJS, global enums, and JSX syntax outside the supported profile.

```sh
node --experimental-vm-modules scripts/audit-compiler-coverage.mjs /inputs/vite.json /inputs/mreact.json /inputs/tachyon-dom.json /inputs/mreact.tsx.json /inputs/tachyon-dom.tsx.json --upstream-ts /path/to/TypeScript
```

## Performance comparison

The timed operation emits complete ESNext JavaScript from in-memory source. First-process measurements include backend loading and exclude Node startup and corpus reading. The guarded comparator uses Oxc 0.159.0, SWC Next 0.7.0 through its native transform adapter, and both the split Yuku 0.19.0 and unified Yuku 0.28.1. Yuku participates where its strip and print API emits the required JavaScript.

The performance inputs include Oxc's four published transformer fixtures, SWC Next's App.tsx, and the large JavaScript inputs shared by the public parser benchmarks. These are the pinned source bytes. Timing the JavaScript inputs for emission measures a different operation from their official AST parser timing. Cal.com's repeated default exports and the declaration-library fixture remain parser inputs. The compiler API has no general AST output benchmark.

The benchmark ran with verified input hashes and no network in a memory-bounded, rootless Linux arm64 Podman container. It parses real-project outputs without executing them. The generated JSX and enum fixtures execute against self-contained expected results.

Medians are in milliseconds. The timing snapshot is commit `d434e54`. The subsequent diagnostic and accessor fixes retain the verified project coverage. Warm official samples use five synchronous calls per engine, followed by a fresh-process sample. Large cold startup values depend on backend initialization and host load.

| Workload | Files timed | TMT warm | Fastest reference warm | TMT first | Fastest reference first |
| --- | ---: | ---: | ---: | ---: | ---: |
| synthetic | 256 | 0.16 | 0.64 (swc-next) | 2.16 | 1.26 (swc-next) |
| jsx | 256 | 0.36 | 1.33 (swc-next) | 2.49 | 2.14 (swc-next) |
| enum | 256 | 0.29 | 0.85 (swc-next) | 2.17 | 1.50 (swc-next) |
| vite | 113 | 51.28 | 14.19 (oxc) | 93.98 | 14.85 (swc-next) |
| mreact | 315 | 622.31 | 121.61 (swc-next) | 739.74 | 123.47 (swc-next) |
| tachyon-dom | 94 | 225.34 | 42.74 (yuku-current) | 571.40 | 66.09 (swc-next) |
| mreact.tsx | 84 | 92.40 | 14.88 (oxc) | 308.93 | 26.69 (swc-next) |
| tachyon-dom.tsx | 32 | 5.66 | 1.81 (swc-next) | 173.77 | 3.91 (swc-next) |
| oxc-transform-parser.ts | 0 | — | — | — | — |
| oxc-transform-renderer.ts | 1 | 17.60 | 2.71 (swc-next) | 208.17 | 5.33 (swc-next) |
| oxc-transform-UserSettings.tsx | 1 | 0.70 | 0.24 (swc-next) | 164.46 | 2.42 (swc-next) |
| oxc-transform-table.tsx | 1 | 9.06 | 1.36 (oxc) | 158.60 | 4.61 (swc-next) |
| swc-next-App.tsx | 1 | 44.69 | 12.16 (oxc) | 171.85 | 20.85 (swc-next) |
| yuku-checker.ts | 0 | — | — | — | — |
| oxc-parser-typescript.js | 1 | 67.00 | 331.79 (oxc) | 240.26 | 362.37 (oxc) |
| yuku-react.js | 1 | 0.06 | 0.83 (yuku-current) | 4.38 | 2.19 (swc-next) |

The four supported official TypeScript and TSX transform inputs also matched the normalized TypeScript reference. The Oxc transformer `parser.ts` fixture contains a runtime namespace outside the native grammar. The Yuku `checker.ts` parser fixture did not have a common valid JavaScript emission in the measured engines. These two cases have no TMT timing. The reference engines retain a lead on real TypeScript and TSX emission. A retest on `830b5de` measured the 8.2 MB JavaScript bundle at 96.92 ms warm, compared with Oxc at 262.80 ms, SWC Next at 381.17 ms and unified Yuku at 428.02 ms. The same retest measured App.tsx at 57.76 ms warm, compared with Oxc at 14.15 ms and SWC Next at 19.77 ms. The bottleneck remains the type-erasure pass and initialization for inputs that cannot be emitted by the direct Pulse route.

The [raw timing and coverage evidence](../evidence/compiler/complete-corpus.json) includes engine declines, input hashes, and separate first-process samples. The [earlier runtime-lowering benchmark](../evidence/compiler/runtime-lowering.json) records the previous 532/537 TypeScript and 39/116 TSX coverage.
