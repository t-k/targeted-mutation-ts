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

The `pulse` backend handles bounded exported constants, simple typed arrows, complete type-only modules, and runtime JSX and enum forms. Explicitly separated sequences of eligible constants share the direct path. The emitter checks duplicate bindings before publishing JavaScript. Type-only modules with comments or a hashbang use Pulse's initialized statement ranges to preserve the surrounding source. The native JSX emitter handles automatic and classic runtimes, elements and fragments, nested children, multiline text, typical attributes and object spreads. Its entry points include direct and parenthesized initializers, arrow expressions, and simple exported function components. The enum emitter handles numeric and string literal members, signed values, implicit numbering, reverse maps, and literal `const enum` declarations under isolated emission semantics.

The direct Node addon includes only the necessary Pulse entry points and the runtime emitter. The full-module addon records JSX element and expression spans during the validated Pulse parse. It publishes initialized records only after reaching EOF. The emitter visits the captured spans, reuses expression boundaries, and copies the surrounding source. This supports JSX in function bodies, nested callback expressions, attributes, conditionals, and scripts. ESNext JavaScript scripts use V8 syntax validation and preserve the original source and strictness whenever possible.

The full-module parse can also publish erasure ranges for annotations, type parameters and arguments, delimited assertions, optional and non-null markers, type-only declarations, overload signatures, and inline type imports. The emitter retains value imports and explicit module settings. Runtime enum emission visits the committed declaration ranges. JSX uses the same source offsets after masking the type ranges. Lean checks length preservation, bytes outside a mask, and LF and CR preservation. The completed native output is checked by V8 before the compiler returns it.

The `pulse+node-strip` route passes the remaining erasable syntax through Node. The `node-strip` route covers validated TypeScript modules and ordinary scripts. The Node 24 compatibility path also lowers constructor parameter properties. ESNext compilation can use the native paths without the full TypeScript compiler or the optional TypeScript syntax projection.

The Pulse span writer proves that a successful replacement changes only the requested bytes and that invalid spans leave the buffer untouched. The extracted parser preserves its input borrow. Syntax-only validation counts comparisons without reserving candidate slots. The NEON and SSE2 builds also skip ordinary 16-byte JSX runs. Lean proves that these skips preserve the scalar cursor state, and the native test checks the matching predicates for every byte in every lane. The extraction check regenerates and compares both variants of the generated C and headers.

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

The four supported official TypeScript and TSX transform inputs also matched the normalized TypeScript reference. The Oxc transformer `parser.ts` fixture contains a runtime namespace outside the native grammar. The Yuku `checker.ts` parser fixture did not have a common valid JavaScript emission in the measured engines. These two cases have no TMT timing. The reference engines retain a lead on real TypeScript and TSX emission. A retest on `830b5de` measured the 8.2 MB JavaScript bundle at 96.92 ms warm, compared with Oxc at 262.80 ms, SWC Next at 381.17 ms and unified Yuku at 428.02 ms. The same retest measured App.tsx at 57.76 ms warm, compared with Oxc at 14.15 ms and SWC Next at 19.77 ms. The bottleneck remains the type-erasure pass and initialization for inputs that cannot be emitted by the direct Pulse route. A separate macOS profile of App.tsx measured 9.12 ms for Pulse parsing and JSX rewriting, followed by 39.84 ms for Node type erasure.

The [raw timing and coverage evidence](../evidence/compiler/complete-corpus.json) includes engine declines, input hashes, and separate first-process samples. The [earlier runtime-lowering benchmark](../evidence/compiler/runtime-lowering.json) records the previous 532/537 TypeScript and 39/116 TSX coverage.

### Retest with direct declaration sequences

The [optimization retest](../evidence/compiler/optimized-compiler.json) includes the same pinned inputs and a 256-declaration module. The new direct path leads that module's warm comparison. SWC Next still leads its first-process comparison. Both retests put the large JavaScript bundle ahead of the three engines in warm complete emission, and its first-process ranking reversed between runs. Host load varies between container runs. Each row compares engines measured in the same run.

| Workload | TMT warm (ms) | Fastest reference warm (ms) | TMT first (ms) | Fastest reference first (ms) |
| --- | ---: | ---: | ---: | ---: |
| 256 declarations in one module | 0.06 | 0.23 (Oxc) | 4.24 | 1.85 (SWC Next) |
| TypeScript JavaScript bundle | 96.06 | 219.68 (SWC Next) | 299.67 | 220.06 (SWC Next) |
| React JavaScript bundle | 0.086 | 2.05 (Yuku) | 7.23 | 4.64 (SWC Next) |
| App.tsx | 50.85 | 14.51 (Oxc) | 216.04 | 24.09 (SWC Next) |
| renderer.ts | 9.40 | 2.25 (Oxc) | 99.84 | 4.87 (SWC Next) |

The paired macOS run reduced warm emission of a 64 KiB JSX text fixture from 0.97 ms to 0.42 ms with identical output. The first-process result moved from 7.89 ms to 8.70 ms. Whole-corpus mreact comparisons changed direction between runs, and the retest establishes no reproducible throughput gain for it.

An AST-guided measurement erased 342 ordinary annotations before passing App.tsx to Node. Node's warm erasure time moved from 29.97 ms to 28.03 ms and produced identical bytes. This measurement excludes the cost of finding and erasing the ranges. The production compiler keeps one Node erasure pass for that file. The remaining cost is the complete second parse across the emitted module.

### Native type-range projection

In an alternating macOS arm64 comparison with seven samples per revision, all three rows retained byte-identical output between `6f98caa` and `0d5b16f`. These medians compare two TMT revisions in the same run.

| Workload | Previous warm (ms) | Projected warm (ms) | Previous first (ms) | Projected first (ms) |
| --- | ---: | ---: | ---: | ---: |
| renderer.ts | 19.29 | 10.86 | 265.12 | 238.94 |
| UserSettings.tsx | 0.61 | 0.14 | 230.21 | 7.17 |
| tachyon-dom TSX, 32 files | 8.41 | 1.24 | 202.74 | 30.56 |

The same source set contains 293 fully projected outputs at this checkpoint, compared with 20 before the type-range changes. All 653 inputs still emit valid JavaScript with the TypeScript package unavailable. The real-project probe also compares newly native outputs on Astro, Hono, React Router, Vitest, and Vue. Svelte's 376 JavaScript modules pass the JavaScript emission path.

The [type projection evidence](../evidence/compiler/native-type-projection.json) includes the isolated compiler comparisons and the paired measurements. Warm runs showed a lead for the small declarations workload. The real-project and first-process rankings did not converge across runs. SWC Next retained the first-process lead for the official TS and TSX transform inputs that the compared compilers emitted. A combined native addon and a Clang profile-guided build showed no consistent gain in the paired experiments and were excluded from the release build.
