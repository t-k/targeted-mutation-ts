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

The full-module parse can also publish erasure ranges for annotations, type parameters and arguments, delimited assertions, optional and non-null markers, type-only declarations, overload signatures, and inline type imports. The emitter retains value imports and explicit module settings. Runtime enum emission visits the committed declaration ranges. JSX uses the same source offsets after masking the type ranges. Lean checks length preservation, bytes outside a mask, and LF and CR preservation. A projection is published when the parse certifies it, as described under Certified emission and native entries. The audit build still passes every projection to V8.

The `pulse+node-strip` route passes the remaining erasable syntax through Node. The `node-strip` route covers validated TypeScript modules and ordinary scripts. The Node 24 compatibility path also lowers constructor parameter properties. ESNext compilation can use the native paths without the full TypeScript compiler or the optional TypeScript syntax projection.

The Pulse span writer proves that a successful replacement changes only the requested bytes and that invalid spans leave the buffer untouched. The extracted parser preserves its input borrow. Syntax-only validation counts comparisons without reserving candidate slots. The NEON and SSE2 builds also skip ordinary 16-byte JSX runs. Lean proves that these skips preserve the scalar cursor state, and the native test checks the matching predicates for every byte in every lane. The extraction check regenerates and compares both variants of the generated C and headers.

Computed enum initializers, object-literal JSX spreads, and forms requiring downlevel lowering can still require the TypeScript emitter. Source maps for ESNext module output, CommonJS output, `jsx: 'preserve'`, legacy decorators, and non-ASCII type erasure come from the native emitter (see "Native source maps" and "CommonJS lexical scanning, source maps, dialects, and lifted parser limits"). Output formatting can differ across the supported backends.

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

Class modifier projection made the published `table.tsx` fixture fully native at `2434866`. In the isolated retest it took 2.11 ms warm and 22.11 ms on the first process. Oxc took 1.36 ms warm, and SWC Next took 8.21 ms on the first process. The full compiler remains behind on this fixture.

The multiline type masker uses NEON or SSE2 on complete 16-byte ASCII blocks, then a scalar loop for the tail. The block preserves LF and CR and rejects bytes with the high bit set. Lean checks the composition of block results. Both native implementations match the scalar contract for every byte value and lane. The paired whole-compiler test retained identical output. Its per-thread CPU medians moved by less than 2% in either direction on the four tested upstream sources.

At the `88f665b` checkpoint, 309 of the 653 core inputs used the full native path. The additional framework probe covered 2,036 TypeScript and JavaScript modules. Of these, 2,011 emitted JavaScript with TypeScript unavailable. It compared 664 newly native outputs with the previous compiler or the TypeScript reference and found no new structural difference.

### Reviewed projection benchmark

At `1d0c208`, all 653 core inputs emitted valid JavaScript in a temporary directory with no TypeScript package installed. The Pulse emitter handled 311 inputs without Node's type eraser. The expanded framework probe emitted 2,138 of 2,165 inputs with TypeScript unavailable. It includes 25 of 26 Solid modules and 102 of 103 TanStack Query modules. The probe reads source blobs from fixed revisions and verifies output without running those modules.

The isolated Linux arm64 run had 17 comparable emission rows. TMT led 8 warm comparisons and 1 first-process comparison. The official transformer `parser.ts` and the Yuku `checker.ts` input had no common eligible emission row.

| Workload | TMT warm (ms) | Fastest reference warm (ms) | TMT first (ms) | Fastest reference first (ms) |
| --- | ---: | ---: | ---: | ---: |
| 256 declarations in one module | 0.014 | 0.058 (Oxc) | 0.900 | 0.452 (SWC Next) |
| tachyon-dom TSX, 32 files | 0.480 | 0.515 (SWC Next) | 1.874 | 0.800 (SWC Next) |
| UserSettings.tsx | 0.051 | 0.069 (Oxc) | 1.081 | 0.469 (SWC Next) |
| table.tsx | 0.375 | 0.292 (Oxc) | 1.819 | 0.981 (SWC Next) |
| App.tsx | 11.958 | 3.343 (Oxc) | 44.251 | 5.908 (SWC Next) |
| renderer.ts | 2.005 | 0.542 (Oxc) | 28.480 | 1.316 (SWC Next) |
| TypeScript JavaScript bundle | 20.020 | 62.753 (Oxc) | 54.479 | 79.350 (Oxc) |

The review regressions exercise runtime behavior for multiline generic arrows in return and yield positions. They also check the exported object from a namespace that contains a standalone empty statement. The latter continues through the runtime lowering route. All 2,960 tests passed on this revision.

### Committed lexical regions and one-pass validation

At `d28736a`, the Pulse emitter handles 438 of the same 653 core inputs without Node's type eraser. All 653 still emit with the TypeScript module blocked. The output audit identifies only the previously reviewed reference normalization differences. The official `App.tsx` and `renderer.ts` fixtures now use the Pulse emitter and match the normalized TypeScript reference. Pulse records inert JSX, template, and regex spans alongside type spans, so validation can inspect embedded expressions without interpreting the surrounding text as TypeScript. The final emitted JavaScript still undergoes V8 syntax validation.

Seven alternating macOS samples measure `App.tsx` at 23.03 → 6.83 ms warm and 86.35 → 16.78 ms on first emission from `1d0c208`. The `renderer.ts` medians are 3.48 → 0.90 ms warm and 46.84 → 4.18 ms on first emission. Isolating the shared guard from the preceding change gives 8.14 → 6.80 ms for `App.tsx` and 1.31 → 1.11 ms for `renderer.ts` warm, with byte-identical output. An additional SIMD experiment inside the guard gave mixed results and was discarded. SIMD still masks erased ASCII type ranges.

The isolated Linux arm64 retest uses in-memory inputs and includes module loading in the first emission measurement. TMT led eight of 17 comparable warm emission workloads and one first emission workload. The following rows show total milliseconds per input or corpus. Yuku contributes timings only where it emits the same kind of JavaScript, which excludes the TSX rows.

| Workload | TMT warm | Fastest reference warm | TMT first | Fastest reference first |
| --- | ---: | ---: | ---: | ---: |
| Vite, 113 common .ts files | 57.51 | 20.96 (Oxc) | 130.92 | 21.95 (SWC Next) |
| mreact, 315 common .ts files | 287.79 | 79.68 (Oxc) | 361.87 | 87.02 (SWC Next) |
| tachyon-dom, 94 common .ts files | 77.59 | 24.00 (Oxc) | 175.67 | 26.91 (SWC Next) |
| mreact TSX, 84 files | 14.13 | 6.85 (Oxc) | 81.24 | 8.44 (SWC Next) |
| tachyon-dom TSX, 32 files | 0.96 | 1.10 (SWC Next) | 4.47 | 1.89 (SWC Next) |
| renderer.ts | 1.51 | 1.32 (Oxc) | 6.02 | 3.22 (SWC Next) |
| table.tsx | 0.75 | 0.72 (Oxc) | 3.88 | 2.25 (SWC Next) |
| App.tsx | 8.07 | 7.25 (Oxc) | 16.47 | 11.71 (SWC Next) |
| TypeScript JavaScript bundle | 43.54 | 143.28 (Oxc) | 130.31 | 152.94 (Oxc) |

The [raw samples, coverage, and framework differential](../evidence/compiler/native-type-projection.json) record all engines and workload hashes. The framework differential against `6f98caa` covered 2,165 source inputs on `99a2a8b`. The 974 newly native outputs retained normalized output and dependency equivalence.

### Re-exports and consecutive assertions

Pulse projects whole type re-exports and the type members of a mixed export list. A runtime re-export remains in the output even when its list becomes empty, preserving the dependency's side effects. Runtime aliases can retain contextual names such as `type`. The guard accepts a chain such as `value as unknown as T` when the next committed assertion starts at the next token on the same line. The final assertion still needs a supported boundary.

These changes increased Pulse-only coverage from 438 to 510 of the 653 core inputs. The compiler emitted all 653 in an isolated directory with no TypeScript package installed. Seven alternating samples measure mreact's 321 TypeScript files at 158.09 → 131.71 ms warm and 293.22 → 267.32 ms on first emission for the consecutive-assertion change. The output audit found no new differences within the core inputs. The isolated competitor retest at `6add454` led nine of 17 comparable warm workloads. SWC Next led all 17 first-emission workloads. For `App.tsx`, the same-run medians were 7.33 ms warm and 13.82 ms first for TMT, 6.80 ms warm for Oxc, and 10.79 ms first for SWC Next.

### Complete native emission on the fixed TSX inputs

The shared Pulse journal reserves slots only for compiler spans during type capture. The mutation extractor keeps its comparison slot behavior. JSX and enum lowering share one writer and one runtime import insertion point. Certified lexical exports can precede erased type declarations, and an assertion can end before a separate identifier-led line. These changes reach all 116 fixed TSX inputs and 417 of 537 TypeScript inputs without Node type erasure on `74093b7`. The core audit reports no new normalized output or dependency differences.

Seven alternating macOS samples against `6add454` measure mreact TSX at 3.66 → 2.25 ms warm and 25.09 → 5.41 ms for first emission. The isolated measurements on `8147cba` led eight of 17 comparable warm workloads and none of the first-emission workloads. The three rows labeled Pulse-only are subsets selected by the backend on that revision and then intersected with the reference engines' accepted inputs.

| Workload | TMT warm (ms) | Fastest reference warm (ms) | TMT first (ms) | Fastest reference first (ms) |
| --- | ---: | ---: | ---: | ---: |
| mreact TSX, 84 files | 7.48 | 5.97 (Oxc) | 12.54 | 7.84 (SWC Next) |
| tachyon-dom TSX, 32 files | 0.94 | 1.09 (SWC Next) | 4.34 | 2.25 (SWC Next) |
| App.tsx | 5.89 | 5.03 (Oxc) | 11.61 | 8.60 (SWC Next) |
| Vite TS Pulse-only, 79 common files | 5.00 | 4.15 (Oxc) | 9.12 | 4.78 (SWC Next) |
| mreact TS Pulse-only, 256 common files | 32.04 | 23.38 (Oxc) | 50.09 | 25.11 (SWC Next) |
| tachyon-dom TS Pulse-only, 69 common files | 7.19 | 5.63 (Oxc) | 12.56 | 6.36 (SWC Next) |
| mreact TS, 315 common files | 236.63 | 100.65 (Oxc) | 422.95 | 107.81 (SWC Next) |

The macOS profile of mreact's Pulse-only inputs attributes about 49% of process CPU time to the Pulse module parse, 19% to the ambiguity guard, and 12% to V8 validation. The length-based guard keyword dispatch experiment produced byte-identical output and changed warm medians by at most 2%, with mixed first-emission results. The implementation retains the original guard dispatch.

The upstream source sample uses a fixed TypeScript revision and reads test blobs as data. It selected 503 single-source candidates and found 126 module inputs with valid reference ESNext emission. With TypeScript loading blocked, TMT emitted 66 of those inputs, including 32 through Pulse alone. This sample reports input and emission coverage. All 3,036 repository tests passed. The [raw profiles and comparison samples](../evidence/compiler/native-type-projection.json) record the measured paths and source hashes.

### JavaScript JSX modules and local type declarations

The JavaScript JSX emitter handles multiple exports and preserves directive placement. It validates the rendered module with V8 before publishing. JSX-extension modules without markup can preserve their original JavaScript bytes after validation. JSX and TSX share the F★ reader for namespace-qualified attribute names such as `prop:id`. The fixed JSX audit compiled 50 valid SolidJS modules and the tachyon-dom Solid benchmark without TypeScript. The 48 newly supported outputs matched the normalized TypeScript reference.

At `c8b62a3`, all 653 fixed inputs emit without loading TypeScript. The Pulse path handles 553, including all 116 TSX files. The upstream sample contains 126 modules with valid TypeScript reference output. Of those, 69 emit without TypeScript, including 40 through Pulse. The other 57 exercise remaining compatibility work.

On macOS, the six highest file medians account for 0.592 ms of the 2.009 ms sum of mreact's 84 TSX file medians. `api-reference-data.tsx` spends about 103 µs in the Pulse parse and 4 µs sorting JSX and lexical spans. In the six-file profile, only the Hacker News `render.tsx` needed a second parse. Extra inline workspace reduced that file from 0.089 to 0.068 ms and changed the full TSX corpus from 2.381 to 2.362 ms. The wider-workspace, sorted-range check, trivia-prefix, and borrowed-tape experiments delivered mixed results across workloads.

The local type declaration change moves mreact's 267,218-byte router `build.ts` to Pulse. Seven alternating samples measured 6.53 → 1.59 ms warm and 29.18 → 4.11 ms on first emission. The 321-file mreact TypeScript corpus fell from 52.41 to 47.43 ms warm. The corpus audit reports the same normalized output and dependencies.

The Linux arm64 comparison at `c8b62a3` led eight of 17 comparable warm workloads and one first-emission workload. The table times complete ESNext JavaScript emission from source prepared in each engine's accepted representation. Each row compares engines within the same run.

| Workload | TMT warm (ms) | Fastest reference warm (ms) | TMT first (ms) | Fastest reference first (ms) |
| --- | ---: | ---: | ---: | ---: |
| mreact TSX, 84 files | 3.00 | 2.46 (Oxc) | 5.52 | 3.07 (SWC Next) |
| tachyon-dom TSX, 32 files | 0.43 | 0.44 (SWC Next) | 1.74 | 0.71 (SWC Next) |
| App.tsx | 3.55 | 3.02 (Oxc) | 7.05 | 5.08 (SWC Next) |
| Vite TS, 113 common files | 22.68 | 8.70 (Oxc) | 50.39 | 9.54 (SWC Next) |
| mreact TS, 315 common files | 61.01 | 31.05 (Oxc) | 104.99 | 33.34 (SWC Next) |
| tachyon-dom TS, 94 common files | 22.22 | 9.26 (Oxc) | 53.76 | 10.33 (SWC Next) |
| TypeScript JavaScript bundle | 19.96 | 54.75 (Oxc) | 50.37 | 63.66 (Oxc) |

All 3,080 repository tests passed. The [raw benchmarks, phase samples, and coverage results](../evidence/compiler/native-type-projection.json) record the current workloads and source hashes.

### Cache-disabled emission and native coverage

The benchmark tracks V8 compilation caching and source preparation as independent settings. Use `node --no-compilation-cache scripts/bench-compiler.mjs` for the cache-disabled condition. The first-emission workers receive the same V8 setting. The default `prepared` input mode supplies each engine its accepted representation. TMT, SWC Next, and unified Yuku receive UTF-8 buffers. Oxc, legacy Yuku, and Node's type stripper receive prepared strings. Set `TMT_BENCH_INPUT=bytes` to include UTF-8 decoding in the timed path for the string-only APIs.

The paired baseline at `c8b62a3` led eight of 17 comparable warm workloads with repeated-source caching and six with the V8 cache disabled. It led one first-emission workload in both modes. The harness also reports a separate TMT/Oxc/SWC Next row when the common cohort across all available engines excludes additional inputs. The official Oxc runtime namespace fixture and the Yuku checker fixture still have no common emitted JavaScript result.

The audit build preserves V8's decision and correlates each validation with its input and emission phase. Use `npm run build:compiler -- --audit-v8`, then pass JSON corpora to `scripts/audit-compiler-v8.mjs`. The audit independently checks that the ordinary and instrumented binaries return the same output hash, backend and diagnostics. `scripts/generate-compiler-validation-cases.mjs` produces the bounded generated and corpus-mutated input used for the validation audit.

The native emitter now handles typed and bare receiver parameters, multiline arrow return types, standalone instantiation expressions, and matching overload groups. Unicode masking inside erased declarations preserves UTF-8 and UTF-16 offsets and line terminators. The emitter preserves implicit class field boundaries even when erasure exposes a contextual keyword such as `static`. This distinction matters independently of syntax validity. V8 accepts `static next = 42` as a static field when the original typed source declares two instance fields. The class field event retains the separator in the removed type span. Vue's constant enum shifts use unsigned C operations with signed shift and value reconstruction checked in Lean.

An experimental build omitted only V8 module parsing. On the macOS inputs with identical emitted bytes, App.tsx moved from 4.34 ms to 2.48 ms warm and the 84-file mreact TSX cohort moved from 3.20 ms to 1.82 ms. The shipped emitter retains V8 validation. The packed-state experiment improved several macOS medians and regressed all seven Linux arm64 medians in an alternating run. The wide-keyword load and guard whitespace experiments delivered mixed results. These experiments are excluded from the normal build.

The following Linux arm64 run at `f6c1831` used Node 24.14.0, seven rotating samples, the cache disabled, and byte-input timing. Each row compares engines measured in the same run. On this revision, TMT led six of 20 timed warm rows and one first-emission row. Three native-only subsets extend the original 17-row comparison. The two official fixtures without a common emitted result are excluded from the rank count.

| Workload | TMT warm (ms) | Fastest reference warm (ms) | TMT first (ms) | Fastest reference first (ms) |
| --- | ---: | ---: | ---: | ---: |
| Vite TS, 113 common files | 18.33 | 8.73 (Yuku 0.28) | 48.03 | 9.45 (SWC Next) |
| Vite TS, 122 TMT/Oxc/SWC Next files | 27.65 | 10.51 (Oxc) | 70.52 | 11.52 (SWC Next) |
| mreact TS, 315 common files | 69.48 | 31.55 (Oxc) | 100.77 | 33.64 (SWC Next) |
| tachyon-dom TS, 94 files | 18.99 | 9.19 (Oxc) | 20.24 | 10.39 (SWC Next) |
| mreact TSX, 84 files | 4.18 | 2.61 (Oxc) | 5.31 | 3.14 (SWC Next) |
| App.tsx | 5.56 | 3.25 (Oxc) | 7.07 | 5.11 (SWC Next) |
| table.tsx | 0.53 | 0.28 (Oxc) | 1.55 | 0.89 (SWC Next) |
| TypeScript JavaScript bundle | 46.58 | 54.05 (Oxc) | 49.76 | 63.24 (Oxc) |

The same container measured a one-input startup floor using eleven alternating fresh processes. An empty N-API addon took 0.20 ms. The direct Pulse addon emitted the small typed input in 0.20 ms, the public TMT facade in 0.69 ms, and the SWC Next adapter in 0.33 ms. The corresponding values after the small ASCII export path were 0.18, 0.18, 0.64, and 0.29 ms. These experiments isolate initialization from the larger first-emission workloads.

The instrumented Pulse parser counted 1.72–2.44 in-bounds logical `peek` reads per input byte across the selected real workloads. The count covers successful whole parses and omits class scan block reads and subsequent JS validation. App.tsx used 1.76 reads per byte. The [raw timing, audit, and coverage evidence](../evidence/compiler/cache-disabled-emission.json) preserves input hashes, individual measurements, and the explicitly labeled architecture experiments.


At this checkpoint, all 653 fixed project inputs emit valid JavaScript with TypeScript loading blocked. Pulse emits 628 directly, including all 94 TypeScript and 32 TSX files from tachyon-dom and all 84 mreact TSX files. The core comparison retains five previously reviewed normalized output differences. Across the broader 2,818-file framework comparison, 358 files moved to Pulse with matching normalized output or dependencies. The additional sources include Astro, Hono, React Router, Solid, Svelte, TanStack Query, Vitest, and Vue.

The original 3,321-input audit recorded 77 V8 rejections. At the current revision, the same corpus and 408 generated or mutated inputs produce 2,487 successful V8 validations and zero rejections. An expanded set of 1,709 raw TypeScript compiler and conformance inputs produces 361 successful validations and zero rejections. Its previous 16 rejections were CommonJS export assignments sent to the ESM path. The current parser also checks whether a local export has a runtime binding before emission.

All 3,248 repository tests pass. F★/Pulse checked both generated snapshots, Lean built the compiler arithmetic proofs, and TLC explored all 270 reachable publication model states.

A final paired Linux experiment isolated V8 module parsing on outputs that were byte-identical with validation enabled and disabled. App.tsx moved from 5.35 to 3.40 ms warm and from 7.04 to 4.77 ms on first emission. The mreact TSX cohort moved from 3.85 to 2.31 ms warm. The 260-file native mreact TypeScript cohort still took 28.72 ms warm in the ablation. The performance comparison above uses the release path with validation enabled.

A per-source trivia memo preserved all output hashes and regressed the warm and first-emission medians on all seven tested macOS workloads. The release parser keeps the existing trivia reader.

### Native coverage and projection scanning

At `82ab0c5`, Pulse emits all 653 fixed Vite, mreact, and tachyon-dom inputs without either compatibility emitter. The normalized TypeScript audit retains one previously reviewed output difference with identical static dependencies. Committed ranges now cover parameter properties, abstract and declared members, optional method signatures, contextual references, and delimited type annotations. Markerless TypeScript scripts use the same projection with V8 script validation. ESNext .mjs validates once and preserves the input text. The fallback emitter loads on demand.

The Arm64 projection scan checks sixteen possible token starts at once. It advances to the first lexical sentinel or contextual-keyword prefix, then applies the ordinary check. Lean verifies the lookup predicates for all byte values. The C checks exercise every byte pair in every lane. A separate scalar-to-NEON comparison matched code, backend, and diagnostics for 2,501 inputs. Native emission continues to call V8 validation.

The following Linux arm64 comparison used Node 24.14.0, disabled V8 compilation caching, and supplied UTF-8 bytes. Each row uses seven interleaved samples. The complete common suite still leads in six of 20 warm rows and one first-emission row. The two official fixtures without a common emitted result are excluded. The full Vite and mreact rows compare the three engines that emitted all files. TanStack Query has one more file outside the shared cohort.

| Workload | TMT warm before → current (ms) | Fastest reference warm (ms) | TMT first before → current (ms) | Fastest reference first (ms) |
| --- | ---: | ---: | ---: | ---: |
| Vite TS, 122 files | 28.32 → 18.91 | 10.97 (Oxc) | 73.98 → 20.50 | 11.83 (SWC Next) |
| mreact TS, 321 files | 73.69 → 61.44 | 32.12 (Oxc) | 120.50 → 64.25 | 34.84 (SWC Next) |
| tachyon-dom TS, 94 files | 19.29 → 18.63 | 9.35 (Oxc) | 20.53 → 19.62 | 10.54 (SWC Next) |
| mreact TSX, 84 files | 4.43 → 4.25 | 2.85 (Oxc) | 5.37 → 5.00 | 3.16 (SWC Next) |
| TanStack Query TS, 96 files | 12.32 → 8.43 | 4.71 (SWC Next) | 54.58 → 9.67 | 4.39 (SWC Next) |
| SWC Next App.tsx | 5.84 → 5.39 | 3.38 (Oxc) | 7.27 → 6.75 | 5.26 (SWC Next) |
| Local .mjs scripts, 10 files | 3.18 → 1.22 | 1.07 (Yuku 0.28) | 33.37 → 1.92 | 1.38 (SWC Next) |

The direct Pulse addon emitted one representative small input in 0.21 ms. The public facade took 0.58 ms and the SWC Next adapter took 0.32 ms. The direct addon and the public facade have different option and compatibility responsibilities.

A separate validation ablation with the starting implementation reduced warm tachyon-dom from 18.28 to 8.54 ms and App.tsx from 5.53 to 2.50 ms. The 260-file native mreact TS cohort reached 23.22 ms against Oxc's 23.36 ms. These experiments quantify the cost of output validation. The measured release path retains both the ambiguity check and V8 parsing. The [timings and conformance evidence](../evidence/compiler/all-pulse-neon.json) includes each final sample, input hashes, and the separate experiments.

### ECMAScript module strings

At `63d064a`, an ESNext `.mjs` transform without a source map passes the decoded JavaScript string directly to V8. The small validator addon avoids loading the full compiler and encoding the string as UTF-8 again. A missing or incompatible validator addon uses the previous module route. Directive handling, invalid encoding and V8's module syntax decision retain their existing behavior.

The paired Linux arm64 run used Node 24.14.0 with UTF-8 byte inputs, seven interleaved samples, and V8 compilation caching disabled. On ten local `.mjs` scripts the change moved the warm median from 1.605 to 1.336 ms and the first-process median from 2.936 to 2.441 ms. SWC Next measured 1.340 and 1.888 ms respectively. The warm medians are within 0.004 ms of each other. A separate prototype run measured 1.20 to 1.10 ms warm and 2.05 to 1.95 ms first. The common suite led seven of 21 warm rows and one of 21 first-process rows. The four supplemental cohorts shared by TMT, Oxc and SWC Next remain behind.

| Workload | TMT warm (ms) | Fastest reference warm (ms) | TMT first (ms) | Fastest reference first (ms) |
| --- | ---: | ---: | ---: | ---: |
| Vite TS, 122 files | 23.84 | 13.15 (Oxc) | 25.68 | 14.71 (SWC Next) |
| mreact TS, 321 files | 70.21 | 39.50 (Oxc) | 74.36 | 40.54 (SWC Next) |
| tachyon-dom TS, 94 files | 23.43 | 11.03 (Oxc) | 24.66 | 12.51 (SWC Next) |
| mreact TSX, 84 files | 4.88 | 3.33 (Oxc) | 5.99 | 3.76 (SWC Next) |
| SWC Next App.tsx | 5.90 | 3.64 (Oxc) | 7.27 | 5.78 (SWC Next) |

The additional NEON byte-class loop, exact binding byte comparison, and binding-presence filter did not consistently improve the Linux warm and first medians. A packed byte-class index and a prototype that delegates lexically simple function bodies to the final V8 parse gave no repeatable gain on macOS. GCC profile-guided optimization trained on the 642 TypeScript inputs in the pinned Astro corpus. It shortened some TypeScript medians by 1–4.5% and increased the mreact TSX warm median by 6.5%. These experiments remain outside the release build.

The text validation audit compared ordinary and instrumented results for 671 inputs. The case matrix covers BOM preservation, invalid Unicode, invalid module syntax, unbound exports, and unavailable addons. TLC explored 489 distinct states of the publication model. The [comparison and verification data](../evidence/compiler/mjs-text-validation.json) include sample timings and corpus hashes.

### JavaScript project emission and x86 projection scanning

At `4da4552`, JavaScript modules with static import or export declarations can pass their original text directly to V8. Modules beginning with a static declaration use the small validator addon. For later declarations, the Pulse marker reader identifies the module without running Node type erasure. Plain scripts retain their previous strictness handling. Directive diagnostics and Unicode identifier boundaries are part of the module-routing tests.

The pinned Svelte workload is 376 JavaScript files. All complete results matched the preceding compiler. The isolated Linux arm64 JavaScript routing experiment moved Svelte from 64.21 to 14.15 ms warm and from 108.71 to 16.51 ms first. SWC Next measured 17.13 and 17.91 ms in that run. Astro's 642-file TypeScript workload increased from 639 to 641 direct Pulse outputs. All 641 matched the normalized TypeScript AST and static dependencies. The remaining file contains a leading triple-slash reference directive and still uses the compatibility emitter.

The projection guard retains each SIMD block's candidate mask as it makes scalar syntax decisions. On x86-64 it selects AVX2 when available, SSSE3 otherwise, and scalar on CPUs without either extension. ARM64 uses NEON. Lean proves the packed mask suffix law and the x86 lookup groups. C tests check all 65,536 byte pairs in every SIMD lane, including the byte following the final lane. Both x86 widths also ran on a Ryzen 9 9950X. The 64-lane AVX-512 experiment increased the warm mreact TSX median from 4.01 to 4.21 ms and is excluded from release builds. A narrower Pulse probe handles bare arrow parameters and keeps the existing parser for comment trivia and complex heads.

On the Ryzen 9 9950X, the Node 24.22.3 comparison used seven interleaved samples, pinned one CPU, and disabled the V8 cache. The input and full emitted results matched between TMT variants. The table uses the AVX2 build and lists the fastest reference engine for each measurement.

| Workload | TMT warm before → current (ms) | Fastest reference warm (ms) | TMT first before → current (ms) | Fastest reference first (ms) |
| --- | ---: | ---: | ---: | ---: |
| Vite TS, 122 files | 26.73 → 23.41 | 13.38 (SWC Next) | 28.33 → 25.11 | 13.09 (SWC Next) |
| mreact TS, 321 files | 76.98 → 64.45 | 39.33 (Oxc) | 83.73 → 71.73 | 38.13 (SWC Next) |
| tachyon-dom TS, 94 files | 22.68 → 19.42 | 11.29 (Oxc) | 24.60 → 21.35 | 11.43 (SWC Next) |
| mreact TSX, 84 files | 5.35 → 4.55 | 3.16 (Oxc) | 7.12 → 6.32 | 3.79 (SWC Next) |
| SWC Next App.tsx | 6.83 → 5.73 | 3.61 (Oxc) | 9.00 → 7.96 | 5.85 (SWC Next) |
| Svelte JS, 376 files | 15.20 → 16.17 | 18.79 (Yuku 0.28) | 20.27 → 20.23 | 19.25 (SWC Next) |

The final arm64 suite led seven of 23 common warm workloads and two first-process workloads. The Ryzen suite led three of 13 common warm workloads and one first-process workload. These totals exclude supplemental cohorts and the two official fixtures without a common supported emission. Runtime namespace and const-enum differences keep Oxc's `parser.ts` outside the dependency-free comparison. Preserving implicit type imports creates a duplicate runtime binding in Yuku's `checker.ts`, so it needs shared import-elision semantics for a valid comparison.

A separate prototype mapped function braces through the JSX writer and removed selected bodies only in the validation input. On App.tsx, broad removal of 185 bodies reduced validation input construction plus V8 parsing from 3.87 to 0.83 ms. The small ordinary-function subset gave no gain. The broad measurement leaves the certification of parameter-scope interactions, directives and context-sensitive syntax open. Production still validates the full emitted text. The [comparison and verification evidence](../evidence/compiler/projection-simd-and-ecosystem.json) records each sample, the exact input hashes, and the separate body experiment.

The fixed TypeScript upstream sample had 126 inputs with valid reference ESNext module emission. The current compiler emitted 72 through Pulse and one through Pulse plus Node's eraser with TypeScript loading blocked. The emitted AST shapes and dependency lists matched the reference for all 73. The other 53 still require TypeScript, including cases with import-equals declarations.

Two extra V8 validation experiments remained outside the release build. The public Node-API string bridge retained the validated string but gave mixed timings across the main TypeScript cohorts. Replacing static intrinsic JSX calls in the validation input increased validation and construction time on all four measured workloads. On the Ryzen 9 9950X, the packed keyword load with type capture shortened tachyon-dom TS from 19.32 to 18.61 ms warm. It also increased mreact TSX first-process time from 6.13 to 6.34 ms. Lean proved the word-fold identity for all eight supported arities. The compiler retains its scalar keyword fold.

### Certified emission and native entries

At `1f1bcb7`, a TypeScript or TSX module projection is published without a second parse. The Pulse parse records kind 29 wherever it accepts TypeScript-only syntax that the projection would keep, and the emitter declines those files to the compatibility routes. An enum that the emitter cannot lower is declined the same way. The V8 reparse and the textual projection guard are compiled only into the audit build (`npm run build:compiler -- --audit-v8`). That build validates every projection, reports the certification decision and the guard's verdict, and `scripts/audit-compiler-v8.mjs` fails on a certified projection that V8 rejects or on a guard objection whose output differs from TypeScript's emit.

The audit covered 198,020 inputs: the fixed project corpora, 12,357 TypeScript compiler and conformance cases, test262 as TypeScript and JavaScript modules, 4,769 generated ambiguity shapes and 100,000 mutations. V8 accepted all 61,301 certified projections. The guard objected to 601 published projections, and all 601 have the syntax TypeScript emits. `scripts/fuzz-compiler-certification.mjs` compared the audit and ordinary builds on 3.3 million mutated sources without a certified rejection or a difference.

A differential against TypeScript's own emit found results that V8 and the guard both accepted. The JSX writer emitted `return_tmtJsx0(...)` for `return<div/>`. A line break after `declare` was read as an ambient module, and `global` before a name was read as an expression where TypeScript reads a declaration. These are fixed, and `test/compiler-typescript-reference.test.mjs` holds the regressions. The remaining differences on 900,000 mutated sources are TypeScript emit details: the `default_1` name for an anonymous default class, a setter return type that TypeScript keeps, and the `export {}` marker under preserved modules.

`src/compiler.cjs` is now a small entry. Default-option `.ts`, `.mts` and `.tsx` sources go to `emitTypeScript`, and `.js` and `.mjs` sources to `emitJavaScriptModule` and then `emitJavaScript`. Each native call repeats the steps of the router in `src/compiler-routes.cjs` and returns `undefined` for every input the router must decide. A JavaScript module whose certified parse commits no edit is published as its own bytes, and every other JavaScript source is validated by V8. Scripts are validated inside the addon, because Node 24 aborts the process while decorating some syntax errors from `vm.Script`, for example `await using x = null, [] = null`.

Three changes account for most of the time. Skipping the V8 reparse removed about 45% of a warm pass on the TypeScript corpora. The block comment scanner now skips to a star followed by a slash, which cut TanStack Query from 3.53 to 2.61 ms on macOS. Raising the inlining limits for the extracted parser cut a warm mreact pass from 28.0 to 20.0 ms on Linux arm64 and from 29.9 to 24.2 ms on the Ryzen host. `-O2` and `-Os` were 25 to 150% slower than `-O3`. A second, compact addon for cold small inputs was slower on mid-sized cold workloads and is not part of the build.

All fixed inputs of Vite, mreact, tachyon-dom, Solid and TanStack Query emit through Pulse, and 641 of 642 Astro files. The normalized TypeScript audit reports 1,417 of 1,418 as equivalent and one reviewed difference. The Oxc `parser.ts` and Yuku `checker.ts` fixtures still have no common emitted result: they need runtime namespace lowering, non-literal const enums and, for `checker.ts`, inputs above the 1 MiB parser limit.

The comparison uses Node 24.14.0 on Linux arm64 and Node 24.22.3 on the Ryzen 9 9950X, UTF-8 byte input, the V8 compilation cache disabled, and three suite runs of seven interleaved samples pooled per engine. The first-process child no longer installs the resolve hook that blocks TypeScript and no longer inherits `--experimental-vm-modules`. Both slowed module loading inside the timed region for engines with a JavaScript entry. The child asserts after the timed region that no TypeScript module was loaded. Medians are in milliseconds.

| Linux arm64 workload | Files | TMT warm | Fastest reference warm | TMT first | Fastest reference first |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vite TS | 113 | 5.86 | 9.61 (Oxc) | 7.21 | 10.30 (SWC Next) |
| mreact TS | 315 | 21.13 | 37.14 (Yuku 0.28) | 21.94 | 36.79 (SWC Next) |
| tachyon-dom TS | 94 | 6.17 | 10.35 (Oxc) | 6.71 | 11.13 (SWC Next) |
| mreact TSX | 84 | 1.80 | 2.86 (Oxc) | 2.03 | 3.32 (SWC Next) |
| TanStack Query TS | 93 | 2.96 | 4.36 (SWC Next) | 3.49 | 4.32 (SWC Next) |
| Astro TS | 641 | 11.75 | 21.59 (SWC Next) | 13.08 | 21.36 (SWC Next) |
| Svelte JS | 376 | 13.44 | 18.09 (Oxc) | 13.56 | 18.66 (SWC Next) |
| Local .mjs modules | 10 | 0.65 | 1.16 (Oxc) | 1.06 | 1.54 (SWC Next) |
| SWC Next App.tsx | 1 | 1.84 | 3.59 (Oxc) | 2.73 | 5.48 (SWC Next) |
| renderer.ts | 1 | 0.33 | 0.50 (Oxc) | 0.93 | 1.33 (SWC Next) |
| UserSettings.tsx | 1 | 0.03 | 0.07 (SWC Next) | 0.52 | 0.48 (SWC Next) |
| TypeScript JavaScript bundle | 1 | 51.18 | 59.34 (Oxc) | 53.03 | 70.02 (Oxc) |

| Ryzen 9 9950X workload | Files | TMT warm | Fastest reference warm | TMT first | Fastest reference first |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vite TS | 113 | 6.78 | 10.13 (SWC Next) | 8.66 | 10.64 (SWC Next) |
| mreact TS | 315 | 24.48 | 36.36 (SWC Next) | 26.30 | 36.48 (SWC Next) |
| tachyon-dom TS | 94 | 7.29 | 11.16 (SWC Next) | 7.91 | 11.35 (SWC Next) |
| mreact TSX | 84 | 1.91 | 3.09 (Oxc) | 2.58 | 3.88 (SWC Next) |
| TanStack Query TS | 93 | 2.92 | 3.94 (SWC Next) | 3.75 | 4.63 (SWC Next) |
| Astro TS | 641 | 12.79 | 22.30 (SWC Next) | 14.59 | 22.25 (SWC Next) |
| Svelte JS | 376 | 12.30 | 18.32 (SWC Next) | 15.80 | 19.37 (SWC Next) |
| Local .mjs modules | 10 | 0.73 | 1.21 (Yuku 0.28) | 1.86 | 1.82 (SWC Next) |
| SWC Next App.tsx | 1 | 2.21 | 3.70 (Oxc) | 3.37 | 5.88 (SWC Next) |
| renderer.ts | 1 | 0.41 | 0.67 (Oxc) | 1.22 | 1.66 (SWC Next) |
| UserSettings.tsx | 1 | 0.04 | 0.08 (SWC Next) | 0.74 | 0.80 (SWC Next) |
| TypeScript JavaScript bundle | 1 | 54.58 | 88.64 (Oxc) | 56.10 | 92.73 (Oxc) |

TMT leads all 23 common warm rows on Linux arm64 and all 20 on the Ryzen host. It leads 22 of 23 and 19 of 20 first-process rows. The two exceptions are `UserSettings.tsx` on arm64 (0.52 against 0.48 ms) and the ten local modules on the Ryzen host (1.86 against 1.82 ms). Single runs disagree on both, and a direct 41-sample repetition of the Ryzen first-process sample measured 2.04 ms for TMT against 2.38 ms for SWC Next. The [pooled samples, audit totals and experiments](../evidence/compiler/certified-native-emission.json) record every row.

### Record mutation check and sanitizer fuzzing

`scripts/mutate-compiler-records.mjs` changes one record call of the generated parser at a time. It drops the record, moves one end of its span by a byte, or keeps the records that a count rewind was meant to replace. Over 59 record calls this gives 305 mutants, run against 18,777 cases. No mutant changed the syntax of a published output without the audit build or the TypeScript comparison noticing. 152 were detected, 105 only moved files to a compatibility route, and 48 had no visible effect. Of those 48, 27 sit on records whose span the ordinary build does not read, 10 change spacing of a whole erased statement, 4 leave an empty statement, and 7 are unexplained.

`scripts/fuzz-compiler-native.mjs` builds `native/compiler/fuzz.c` with libFuzzer, AddressSanitizer and UndefinedBehaviorSanitizer and runs every emitter entry on exactly sized inputs. It needs a clang that ships libFuzzer (`TMT_FUZZ_CLANG`). Ten minutes on four workers found no defect.

The entry also accepts options spelled out with their default values, so `tmt-compile file.ts` and callers that pass `target: 'esnext'` or `sourceMap: false` take the native call.

### Native source maps

With `sourceMap: true` the ESNext module routes for `.ts`, `.mts` and `.tsx` publish the same code as without it, plus a map written by the native emitter. The TypeScript emitter is used only where it already produced the code (scripts, CommonJS, downlevel targets, `jsx: 'preserve'`, a byte order mark, names with unusual extensions).

The writer logs every copy of source bytes into the output as a run of output offset, source offset and length. Type erasure is one run that covers the whole file. Parameter properties, enums and JSX produce several runs with generated text between them, and the inserted JSX helper import moves the runs after it. `native/compiler/source-map.h` walks the runs once. Inside a run it checks that the output is a projection of the source (equal bytes, a space, `;`, `(` or `)` written over erased syntax, the eraser's equal-width blanks over erased non-ASCII text, every line terminator kept) and writes a segment where a run of word or punctuation characters starts. Generated text has no segment. Columns are UTF-16 code units and lines end at LF, CRLF, CR, U+2028 and U+2029. If a run fails the check, no native map is published and the TypeScript route produces code and map.

`version`, `file`, `sourceRoot`, `sources`, `names` and `sourcesContent` equal what TypeScript writes. `mappings` is finer for copied text and absent for generated text. A module of types alone has empty mappings.

Checks: 36 pairwise rows over line endings, non-ASCII placement, edit kind, input form and name; every output token (TypeScript scanner) maps to the same token in the source for position-preserving output, and every segment maps to the same text for lowered output, over the fixtures and 2,400 files of the fixed projects; direct tests of the scan with hand-made runs; 26 mutants of the scan, of which 24 fail the tests, one does not build and one guards a position that cannot occur.

On an Apple M-series host under load, the fixed projects with maps take 1.6 to 2.2 times the time without maps and about one twentieth to one thirtieth of the TypeScript emitter's time (Vite 26 ms against 545 ms, mreact 66 ms against 2,370 ms, mreact TSX 3.4 ms against 105 ms). Competitors were not measured with maps.

### Wider corpora, declaration merging and two emission defects

Eleven tagged open-source projects (zod, hono, rxjs, trpc, excalidraw, drizzle, vue, typescript-eslint, playwright, effect, prisma; 8,973 `.ts` and `.tsx` files, read as data) were added to the scratch corpora to see where the native routes stop and whether their output is right. Declined files fell from 984 to 640 after the changes below. The remaining causes are listed at the end.

Comparing every native output with TypeScript's emit found two defects that were older than this work:

- A class member that starts with `[`, `*`, `in` or `instanceof` joined the field initializer on the line before it once an erased modifier or an erased member no longer stood between them (`a = f` / `readonly [k] = 2` became `a = f[k] = 2`). The eraser now writes `;` at the start of an erased leading modifier or an erased signature when the next member starts that way. 57 corpus files change.
- The two JSX helper imports were printed in the opposite order to TypeScript's when a file used both the runtime and `createElement`. The writer now settles which module was requested first by TypeScript's visiting order (children, attributes, key, then the helper for a runtime call; attributes, the helper, then children for `createElement`).

New native coverage:

- `yield` as an expression, `return` with a comma expression, `debugger`.
- Enum initializers fold like TypeScript's constant evaluation (hex, octal and binary literals, parentheses, unary and binary arithmetic and bitwise operators, earlier members). A fraction, a negative zero, a value beyond 2^53 - 1, a member named like a literal and an update operator leave the native route. `test/compiler-enum-constants.test.mjs` generates 6,000 declarations and compares the enum objects that the native output and TypeScript's output build.
- An interface merges with a class of its name. A namespace of types merges with a type alias, an interface, a value, a function or a class of its name.
- Parameter properties take `override`, need neither a type nor an initializer, and lower in the same pass as enums.

After these changes 14,531 of 14,535 native outputs over all corpora have TypeScript's syntax. The four differences are a kept parenthesis around a callee and two TypeScript quirks (`default_1`, a setter's return annotation). Warm timings of the fixed projects are unchanged within noise.

A second round reduced declined files to their cause by deleting statements while the file stayed declined, and added: a heritage clause that is any left-hand-side expression with optional type arguments (`extends S.Class<A>("A")({})`), type arguments before a tagged template and after the result of a call, `x!++`, variance annotations on class and type alias parameters, a local type that shares its name with a value, an exported namespace of types beside an exported value of its name, and quoted enum member names.

| Project | Files | Declined before | Declined now |
| --- | ---: | ---: | ---: |
| zod | 164 | 42 | 18 |
| hono | 346 | 37 | 37 |
| rxjs | 757 | 116 | 115 |
| trpc | 596 | 43 | 40 |
| excalidraw | 348 | 5 | 4 |
| drizzle | 574 | 79 | 22 |
| vue | 472 | 19 | 12 |
| typescript-eslint | 1,173 | 35 | 28 |
| playwright | 1,045 | 58 | 56 |
| effect | 1,579 | 525 | 31 |
| prisma | 1,919 | 26 | 23 |
| Total | 8,973 | 985 | 386 |

Over all corpora 14,824 of 14,828 native outputs have TypeScript's syntax. No output that was native before these parser changes differs after them, apart from the two defects above.

Still declined, by what the reductions show: decorators (most of rxjs, whose documentation app is Angular), a JSX import-source pragma and a leading triple-slash directive (most of hono), JSX spread of an object literal, a comparison followed by a comma and a literal in an argument list (`skip(v < 104, 'reason')`, which the parser cannot yet tell from type arguments), enums and type declarations in blocks outside a function, runtime namespaces, `export =` and `import =`, ambient classes and modules, angle-bracket assertions, and non-ASCII identifiers.

### Speed after the wider grammar and native maps

On the Ryzen 9950X host the build before this work (`de3adb4`) and the current build were measured in alternating runs, three each, 21 samples pooled per row, with the usual isolation (rootless Podman, no network, CPU 13, 9 GiB scope). Warm time is unchanged and the compiler is ahead of every peer on 20 of 20 common rows. First-process time is ahead on 19 of 20, as before. The exception is still the ten local `.mjs` scripts (1.863 against 1.747 ms).

The first measurement showed a first-process regression of 0.03 to 0.1 ms on small inputs. The entry's compile function and file had grown with explicit options and maps, and V8 compiles that function on the first call. The default call has its earlier shape again, and `src/compiler-maps.cjs` holds the handling of spelled-out options and maps and loads only when one is given. After that every row is within about one percent of the earlier build. A single first call remains 0.004 to 0.007 ms slower, which matches an addon that is about three percent larger.

Peers were not measured with source maps.

### Decorators, JSX import source, triple-slash comments and identity escapes

A third round added four things that kept whole files on the TypeScript emitter.

- Decorators. TypeScript keeps standard decorators as written at the ESNext target, so the native route only has to parse them: a name, a member chain, or either with arguments, before a class declaration (also behind `export`, `export default` and `abstract`) and before a method, field or accessor. An erased modifier behind a decorator is blanked without a separator. Parameter decorators, a decorator on a constructor or an erased signature, `@(expr)`, type arguments in a decorator, `export @dec class`, class expressions, local classes and `accessor` fields stay with TypeScript. V8 does not parse decorators, so the router's module route asks the certified parse when V8 refuses an `.mjs` source, as the entry does.
- `@jsxImportSource`. One pragma in a block comment before the first token, with a plain package name, selects that package for the helper imports under the automatic runtime. The reader follows TypeScript's tag matching, in which a tag takes the white space after it and the rest of the following line, so an earlier tag can hide the pragma. Every other `@jsx` text stays with TypeScript.
- Leading triple-slash comments. Notes without markup and references with `types`, `path` or `lib` and a quoted value are taken by the module emitters, which keep them as comments. A malformed reference keeps TypeScript's diagnostic 1084.
- Identity escapes. An ordinary string or template takes a backslash before any printable ASCII character other than `x`, `u` and a digit. A regular expression without the `u` flag takes an identity escape of punctuation. Property keys, module specifiers and directives are compared as written and keep the short list. `test/compiler-literal-escapes.test.mjs` generates 11,000 literals and checks that whatever the native lexer accepts, V8 accepts in strict code.

| Project | Files | Declined at the start | Declined now |
| --- | ---: | ---: | ---: |
| zod | 164 | 42 | 16 |
| hono | 346 | 37 | 6 |
| rxjs | 757 | 116 | 47 |
| trpc | 596 | 43 | 34 |
| excalidraw | 348 | 5 | 4 |
| drizzle | 574 | 79 | 17 |
| vue | 472 | 19 | 11 |
| typescript-eslint | 1,173 | 35 | 28 |
| playwright | 1,045 | 58 | 41 |
| effect | 1,579 | 525 | 29 |
| prisma | 1,919 | 26 | 19 |
| Total | 8,973 | 985 | 252 |

Over all corpora 15,006 of 15,010 native outputs have TypeScript's syntax, with the same four benign differences. The entry and the router return the same result for 65,756 compile calls. On the Ryzen host the build with decorators and the pragma, measured against the build before them in alternating runs, is unchanged on the project rows and still ahead of every peer on 20 of 20 warm rows and 19 of 20 first-process rows. The triple-slash change was made after that measurement.

Still declined: enums and type declarations inside blocks, JSX spread of an object literal, a comparison followed by a comma and a literal in an argument list, angle-bracket assertions, parameter decorators, runtime namespaces, `export =` and `import =`, ambient classes and modules, and non-ASCII identifiers.

### Angle-bracket assertions and enums inside blocks

In a `.ts` file `<T>x` is erased to `x`. The assertion and the start of its operand lie on one line, since the erased text must not put a line break after `return`. An operand that starts with a brace, `function`, `class` or `async` is taken only behind a token that can only be followed by an expression. Erased at the start of a statement or of an arrow body it would open a block or a declaration: `a => <any>{}` would lose its object. Two opening angles in a row are a shift operator to TypeScript's scanner and stay an error. The extractor's parse is unchanged.

An enum inside a function or a block is lowered where it stands and declared with `let`, as TypeScript declares it. The emitter evaluates the body with the same constant folding as at module level. Beside lowered parameter properties TypeScript declares a block enum with `var`, so that pair is declined. A bare reserved word in an enum initializer is declined, because it is a syntax error even when a member has that name. A reference directive may have spaces around its equals sign.

Two differences from TypeScript are left as they are. `-<number>-value` keeps the space between the signs and negates twice, where TypeScript 6.0.3 prints `--value`, a decrement. `(<string>"use client");` keeps its parentheses and is an expression statement, where TypeScript prints a directive.

| Project | Files | Declined before | Declined now |
| --- | ---: | ---: | ---: |
| zod | 164 | 16 | 6 |
| hono | 346 | 6 | 5 |
| rxjs | 757 | 47 | 20 |
| trpc | 596 | 34 | 34 |
| excalidraw | 348 | 4 | 3 |
| drizzle | 574 | 17 | 17 |
| vue | 472 | 11 | 9 |
| typescript-eslint | 1,173 | 28 | 28 |
| playwright | 1,045 | 41 | 41 |
| effect | 1,579 | 29 | 19 |
| prisma | 1,919 | 19 | 18 |
| Total | 8,973 | 252 | 200 |

Over all corpora 158 more files compile natively, no output that was native changes, and 15,135 of 15,139 native outputs have TypeScript's syntax, with the same four benign differences.

The first build with the two forms was 2 to 4 percent slower on the project rows of the Ryzen host. Swapping the parser and the emitter one at a time showed the parser alone caused it, although neither form occurs in those rows. The build inlines aggressively, so the new bodies were copied into the expression and statement parsers, and a second recursive call in the expression parser made the build copy that function once more. The two forms are now functions of their own that the build marks `noinline` and `cold` in a scratch copy of the generated source (`coldSource` in `scripts/native-simd-source.mjs`), and the assertion continues through the recursive call that prefix operators already use. Warm times on five project rows are then within 1 percent of the build before the two forms. In the pooled comparison before the last of these changes the build was ahead of every peer on 20 of 20 warm rows and 20 of 20 first-process rows.

### Declined files by cause, and the forms taken from that list

Every declined file of the eleven projects was reduced to the construct that declines it, and the causes were counted. The largest were taken first.

| Form | Rule |
| --- | --- |
| `f(a.b && c < 3, 'text')` | TypeScript tries a type argument list at the less-than sign. The argument is taken when its only `<` byte compares with a name or a number that ends the argument, and the following arguments read as types up to the closing parenthesis, where the attempt fails. |
| `<g {...{ a: 1 }} b />` | The members of the literal are written among the other properties, as TypeScript writes them: a getter stays a getter and a later key attribute keeps the runtime call. The verified parser bounds the literal (`jsx_operand_end`). Declined: `__proto__`, a comment, a spread member before a later key, an empty literal for the classic factory, a trailing comma behind a line separator outside ASCII. |
| interfaces of one name | They merge whatever they extend and whether or not they are exported. |
| `[{ a: 1 }?]`, `[(A \| B)?]` | Optional tuple elements with a composite operand. |
| overloads followed by `async` | An async method implements signatures that are not async. |
| `abstract class` inside a function | The modifier and the abstract members are erased as at module level. |
| `type` and `interface` in a block at module level | Erased as inside a function. |
| `declare function`, `declare const a: T, b` | Erased. The first was not read as a declaration at all before. |
| members of a `declare class` | May be static, readonly or override. |

A statement that ends by a line break now ends at its last token, not where the next token starts. An erased declaration used to take the comment on the following line with it, which lost a `/*#__PURE__*/` annotation. The helper import written at a module marker adds a semicolon when the text before it does not end a statement, and a directive prologue without semicolons still precedes the import in a script.

TypeScript ends an expression at a JSX element. A parenthesis, bracket, template or member access behind one, even on the next line, was read as a call or an access and, once lowered, applied to the element. Such sources are declined.

| Project | Files | Declined before | Declined now |
| --- | ---: | ---: | ---: |
| zod | 164 | 6 | 4 |
| hono | 346 | 5 | 3 |
| rxjs | 757 | 20 | 18 |
| trpc | 596 | 34 | 7 |
| excalidraw | 348 | 3 | 3 |
| drizzle | 574 | 17 | 12 |
| vue | 472 | 9 | 2 |
| typescript-eslint | 1,173 | 28 | 23 |
| playwright | 1,045 | 41 | 11 |
| effect | 1,579 | 19 | 8 |
| prisma | 1,919 | 18 | 15 |
| Total | 8,973 | 200 | 106 |

On TypeScript's own test cases the native route takes 3,033 of 6,479 files under `tests/cases/compiler` and 2,104 of 5,877 under `tests/cases/conformance`; the rest take the TypeScript route, 1,007 of them with TypeScript's diagnostics. Those suites exercise namespaces, `import =`, legacy scripts, decorators and deliberate errors far more than projects do. Over all corpora 15,667 of 15,675 native outputs have TypeScript's syntax. The eight differences are benign: the `default_1` name TypeScript gives an anonymous default class (five), a pair of parentheses (two) and a setter's return annotation (one). No native output is invalid and no input that TypeScript rejects is published. The entry and the router agree on 181,776 compile calls.

On the Ryzen host the build is ahead of every peer on 20 of 20 warm rows and 19 of 20 first-process rows, the exception being `tmt-scripts.js` on the first call as before. Against the build before this section's forms the project rows are within about 1 percent, which is the spread between repeated runs of one build.

Still declined: `export =` and `import =`, parameter decorators and decorators on classes inside functions, runtime namespaces, `declare module` with a string name, non-ASCII identifiers, and single forms such as `new X!()`, an assignment pattern with defaults, an unnamed parameter in a function type, accessors in interfaces, import attributes and computed keys in a binding pattern.

### Running Test262 through the compiler

Every test under `test/language` of Test262 was compiled twice, as JavaScript (`.js`, `.mjs`) and as TypeScript (`.ts`, `.mts`), and the original and the compiled text were both executed with the upstream harness, in strict and sloppy mode as the metadata asks. Compilation ran on the development machine; execution ran in a container without network. A test counts as identical when both sides pass, or fail in the same phase with the same error constructor.

| | JavaScript | TypeScript |
| --- | ---: | ---: |
| Compared (file and mode) | 43,993 | 43,993 |
| Native route | 35,173 | 12,534 |
| TypeScript route | 6,450 | 28,980 |
| Rejected, as the test expects | 2,363 | 2,363 |
| Rejected although valid | 7 | 116 |
| Identical behaviour | 40,662 | 40,552 |
| Different on the native route | 335 | 236 |
| Different on the TypeScript route | 626 | 726 |

All differences on the native route have one cause, and it is TypeScript's own behaviour that the compiler follows: a script without imports or exports receives `"use strict";`, so a sloppy-mode test such as `undeclared = 1;` throws afterwards. Each of them reproduces with the directive added to the original by hand. With strict or module input the native route changed the behaviour of no test.

The differences on the TypeScript route are TypeScript's: the same directive (`with ({}) {}` becomes a syntax error), JavaScript syntax errors that its printer repairs (`function f(...a,) {}`, a line break before `=>`, `({async async})`), and one module where `await /x.y/g` is printed as a division. Valid inputs that TypeScript rejects as TypeScript are counted apart: legacy octal and escaped `let` in sloppy scripts, identifiers of recent Unicode versions, and a private name behind an optional chain, which TypeScript does not allow.

The run used the build of commit 8e9ce0a. It found two defects outside the native route, both fixed afterwards: an `.mts` file without imports or exports was handed to TypeScript as a script, and an internal failure of TypeScript's printer on `return o?.c.#f` escaped as an exception instead of a diagnostic. `test/built-ins` was not run, since the compiler does not change built-ins.

### Export assignments, namespaces, and what the reviews of that round found

`export = value;` as the last statement of a file without other exports is written as `module.exports = value;` where the output may be CommonJS; for an ECMAScript output the incompatibility is still reported.

A namespace that exists at run time is written as TypeScript writes it: `var N;(function (N) { ... })(N||(N={}));`. An exported variable becomes a property of `N`, an exported function or class is followed by `N.f = f`, and an exported enum is stored with `(E=N.E||(N.E={}))`. TypeScript also rewrites a reference to an exported variable inside the body to `N.a`. The emitter does not: it declines when the variable's name stands anywhere else in the body as a whole word, a name behind a single dot aside, and when the body holds a character outside ASCII. Also declined: several declarators, a variable without a value, binding patterns, nested and dotted namespaces, merging with another value of the name, overloads, and a namespace beside parameter properties or JSX.

Further forms: setters in object types, index signatures as class members, statements before the super call of a constructor with parameter properties, JSX files with unicode escapes in strings (only an escape that could spell a letter of the helper prefix keeps the file off the route), and `disabled={a || b}`.

Three review findings of this round had one cause: the emitter called the parser for a boundary while it was still reading the records of the first parse, and the second parse wrote into them. A file with an enum and a constructor with statements before `super`, or with a decorator holding a template literal in front of a namespace, lost a lowering. The tape now stops recording as soon as the first parse returns. Since no corpus held such a combination, a further check was added: fixed constructs with unique names (an enum with a namespace, a constructor with parameter properties behind a statement, a decorated class with a template literal, an abstract class with overloads) are put in front of and behind 1,488 real files, in eight variants, and every native output is compared with TypeScript's. Of 11,904 files 9,164 compile natively and all of them match.

68 of the 8,973 project files still take the TypeScript route. Over all corpora 15,806 of 15,814 native outputs have TypeScript's syntax, with the eight benign differences named above. On the Ryzen host the build is ahead of every peer on 20 of 20 warm rows and 19 of 20 first-process rows.

### The remaining declined files, cause by cause

Each of the 57 project files that still took the TypeScript route was reduced to its cause and checked the other way round: with only that construct replaced, the original file compiles natively. There were 35 causes, most of them in one to three files. The following were taken.

| Form | Rule |
| --- | --- |
| `g(1, () => x < 3, () => x + 1)`, `const ok = s < 300, other = 1` | TypeScript tries a type argument list at a less-than sign and takes it only if the list ends in a greater-than sign before the closing bracket, or before the end of the statement for declarators. With no such sign behind the first less-than sign, an arrow head aside, the item is a comparison. |
| `({ a = 1, b: c = 2, ...rest } = value)` | An assignment pattern with defaults, with targets that strict code may assign. |
| `(string) => string[]`, `(a, b) => void` | Parameters of signatures without a type. |
| `(...[head, ...tail]: Params) => head` | A binding pattern as the rest parameter of an arrow function. |
| `/** @jsx h */`, `@jsxFrag` | Ignored under the automatic runtime, as TypeScript ignores them; declined under the classic factory. |
| `abstract override m(): void;` | An abstract member is erased whole. |
| a type declaration behind a lowered namespace or enum | Erased. |
| `import type { A } from 'a' with { 'resolution-mode': 'import' }` | One import attribute with a name or string key and a string value. |
| `new W!(u)` | The mark is erased. |
| `declare module 'name' { }` before the first import, `declare global { let x: T }` | Erased. |

Parameter decorators need `experimentalDecorators`; see "Legacy decorators" below. Still declined: a reference to an exported namespace variable inside the namespace, nested and merged namespaces, labelled statements other than loops, regular expressions and identifiers with characters outside the Basic Multilingual Plane, more than 512 declarations in one scope, conditional types nested deeper than 16, JSX type arguments, JSX spread children, and a few single forms.

The list parser has to stay a loop. The first version of the rule for comparison items called the list parser from a position that was not its tail, the extraction no longer produced a loop, and an array literal of 30,000 items overflowed the C stack. The parser now carries the offset of the first such item through its iterations and searches once when it reaches the bracket. Lists of 40,000 items are tested, and `build/fable/self-calls.py` compares the generated C with an earlier commit for functions that became self-recursive.

Review findings of this round, all fixed: a non-null mark behind a JSX element was erased although TypeScript rejects it; a declaration erased in front of a string statement let the string become a directive, where TypeScript writes the helper import of a JSX file in front of it; `with` on the line after a re-export was read as attributes; and a target of an assignment pattern has to be assignable in strict code, which an existing test of the extractor caught.

Test262 was run again on this build, with `test/built-ins/RegExp` added: no test that behaved identically before behaves differently now, and the only differences on the native route remain scripts that receive `"use strict"`. After a file of comments alone, characters outside the Basic Multilingual Plane as pattern characters of a regular expression, and the review fixes on directives in JSX files, 36 of the 8,973 project files take the TypeScript route, nine of them for parameter decorators; 15,910 of 15,918 native outputs over all corpora have TypeScript's syntax. On the Ryzen host the build is ahead of every peer on 20 of 20 warm rows and 19 of 20 first-process rows; against the build before these forms the project rows are 0.6 to 2.2 percent slower.

### TypeScript's own test cases: scripts, the module keyword and the byte order mark

On `tests/cases/compiler` and `tests/cases/conformance` the native route answered for fewer than half of the files. A sample of 400 declined files was reduced to causes, each confirmed by a counter-test on the original. The largest causes were restrictions of routes, not missing syntax, and three of them accounted for about 1,700 files.

| Cause | Change |
| --- | --- |
| A script, a file without imports or exports, was read in its own mode, where even `function f() { var a = 1; }` was declined. | The compiler publishes a TypeScript script with the strict directive in front, as TypeScript does, and now reads it as strict code. The extractor keeps the script's mode. The published script is still checked by V8. |
| `module M { }`, the older spelling of a namespace. | Read as a namespace. `declare module 'name'`, `module.exports` and `module` before a line break keep their meaning. |
| A byte order mark. | Dropped, as TypeScript drops it. A result with diagnostics is produced from the unchanged input, so positions hold, and a mark in front of a hashbang is left to TypeScript, which reports the hashbang. |
| Enums, namespaces and parameter properties in scripts. | Lowered as in a module. |
| `function f();`, `m();` in a class, `interface I { x; y? }`. | Signatures without a result type and properties without a type are erased. |

| Suite | Files | Native before | Native now |
| --- | ---: | ---: | ---: |
| `tests/cases/compiler` | 6,479 | 3,166 | 3,930 |
| `tests/cases/conformance` | 5,877 | 2,206 | 3,070 |

Of the files that remain on the TypeScript route in these suites, about 1,000 carry TypeScript's diagnostics, and a tenth of the rest are sources with syntax errors that TypeScript's recovery tolerates; the native route does not take those by design. Over all corpora 17,601 of 17,609 native outputs have TypeScript's syntax, with the eight benign differences.

The comparison with TypeScript's output used to cover the certified route only. It now also covers the routes that erase through Node, and a review found a real defect there: `a + b as T * c` is `((a + b) as T) * c`, and Node's type stripping blanks the assertion and leaves `a + b * c`. The native route declined such a source and the node-strip route then published Node's result. A source with an assertion followed on its line by an arithmetic or shift operator is now handed to TypeScript, and strip mode reports `AMBIGUOUS_TYPE_ERASURE` for it. Other findings of that review: a hashbang line ending in CRLF kept the carriage return in front of the inserted directive, and `get value: number` in a declared class was erased although it is an error.

The oracle on the snapshot also caught a defect before it was pushed: a namespace that holds only interfaces was written as an empty function when its type-only reading failed on repeated interface names. The runtime reading now needs a member that is not a type declaration.

### Import-equals, var below the top level, and a slowdown found on the benchmark host

`import x = require("m")` is written as `const x = require("m")` where the output may be CommonJS, and stays a diagnostic for an ECMAScript output. `import A = B.C` is written as `var A = B.C` and, as in TypeScript, does not make the file a module by itself. A const or var declaration continues into a next line that begins with a parenthesis or a slash, and an import declaration does not, so the native route takes the declaration only before a semicolon, the end of the file, or a next line that begins with a word.

A `var` inside a block, a loop, a loop head or a conditional at the top level belongs to the file. The parser reads most files without a log of local names and reads a file again with one only when a function mixes `var` with `let`. That second reading kept no log at the top level, so such a var could neither be checked against the module's own names nor be found by an export list. A module's second reading now keeps the log at the top level; at the end each var found there is entered among the module's names. A name that the module declares itself (`let`, `const`, `class`, `function`, `import`, `enum`, `namespace`) refuses the file, because V8 reports the redeclaration. In a script the compiler publishes, V8 checks the output, so the var is simply taken.

A module-level `var` with a plain name may be declared again by another `var`. Entries made by such a var carry a mark among the module's names; every other declaration of the name is still a conflict.

The comparison of Node's type stripping with TypeScript, added in the previous round, led to a guard that now reads the erased text: Node blanks a type in place, so what stands behind each blanked assertion decides whether the grouping changed. `a + b as T * c`, the same with the operator on the next line or behind a comment, and `a << b as T + c` are handed to TypeScript; `x as T - y` and an assertion in front of a comment are erased. A non-null mark in front of a template is refused only where an optional chain would become the tag.

#### Speed

Three alternating runs per tree on the Ryzen host compared this state with the last measured one. The first comparison showed a slowdown of 2 to 4 percent on project rows and 8 percent on TSX files. Comparing nine commits side by side located two causes:

| Cause | Cost | Change |
| --- | --- | --- |
| The scan that asks whether erasure changes which strings are directives parsed every leading import and export again. | 8 percent on TSX files | The scan ends at an import or export that stays, and looks at the first item before it searches the file for strings. |
| `expression_end` and `declarators_end` were built out of line and cold with the rare-syntax functions, although every list and every declaration ends in them. | about 2 percent on JavaScript | Both are inline again; only the search they start is cold. |

After the changes the project rows are within one percent of the earlier state (vite -0.4, mreact -0.4, tachyon-dom +0.6, mreact.tsx +0.3, astro +0.1, svelte.js +1.7 percent warm), and the comparison with the other compilers is unchanged: 20 of 20 rows warm, 19 of 20 first-process, the exception being `tmt-scripts.js` first at 1.07 times. Two synthetic rows of very small inputs read slower in this comparison (`synthetic` +8.1 percent, `enum` +6.4 percent), but they are within the spread of these rows: in the comparison made two hours earlier the unchanged old tree itself measured 0.057 ms on `synthetic` against 0.062 ms here, and the newer tree was the faster one (0.052 ms). A row of 256 one-line files takes about 0.25 microseconds per file, and interleaved timing of five builds on the development machine shows no ordering among them either.

#### Test262

`test/language` and `test/built-ins/RegExp`, 47,743 compared units of file and mode, executed in a container without network: 44,407 units behave as the original when compiled as JavaScript and 44,333 when compiled as TypeScript. The 962 that differ are the ones that differed before, non-strict scripts that TypeScript also publishes with the strict directive. The native route now answers for 14,216 of the units compiled as TypeScript, up from 12,534.

#### Why the remaining files of TypeScript's suites leave the native route

A sample of 400 of the 4,269 files that still take the TypeScript route without diagnostics, reduced and classified (counts extrapolated from the sample):

| Cause | Estimated files | |
| --- | ---: | --- |
| Programs TypeScript parses that are not valid JavaScript (`break` outside a loop, strict-mode violations) | 961 | stay declined |
| A name declared twice (import and declaration, two constants) | 458 | stay declined |
| Ambient modules and namespaces with value members | 288 | open |
| `var` declared again at the top level | 245 | done |
| `var` directly inside a namespace | 192 | open |
| A class inside a namespace of a script | 181 | open |
| `var` below the top level | 149 | done |
| `export =` beyond the simple form | 149 | open |
| `// @jsx` directives, triple-slash directives, decorators in scripts | about 110 each | open |

### Names outside ASCII, labels, static blocks, declared values

The certified parser reads ASCII names only. A module with other names, `ɵ`-prefixed imports in Angular or names in Japanese, is read through a copy in which every word that holds bytes outside ASCII is spelled in capital letters of the same length. The spelling has to rename injectively and must not meet a word of the source, so the copy has the syntax and the bindings of the source. When the parser only erases from the copy and each renamed word is a well-formed identifier, the names are put back and the result is native. Otherwise Node erases the source itself and its parser checks the names. An escape that could spell a name a second way and a space outside ASCII keep TypeScript's route. A first attempt handed every module that begins with `import` or `export` to Node's erasure; the snapshot check refuted it, because Node accepts sources that TypeScript reports, an empty `implements` clause for one.

Identifier characters follow the engine. TypeScript's own tables are older, so it reports three of Test262's identifier tests for Unicode 16 and 17 that the engine and this compiler accept.

Comparing Node's erasure with TypeScript on Angular found a defect of the former: behind a decorator it blanks the `export` of `export abstract class` and keeps `abstract`. Such a source is handed to TypeScript.

Also taken now: a label in front of a block, an `if`, a `try` or a `switch` (`break` may name it, `continue` may not, no further label inside); class static blocks, read like the initializer of a static field; declared namespaces and modules that hold variables, function signatures, classes and enums; an exported namespace variable without a value, which TypeScript writes nothing for; decorated classes inside functions and blocks; scripts that begin with the strict directive or with well-formed triple-slash comments.

### Legacy decorators

`experimentalDecorators` and `emitDecoratorMetadata` are options of `compile` and of the CLI (`--experimental-decorators`, `--emit-decorator-metadata`). vscode, Angular and Nest are written for this design: 1,412, 1,886 and 611 of their files hold decorators, and vscode injects its services through decorators on constructor parameters, which the standard design does not have.

The lowering rewrites the source. The parser reads the module in a mode that takes decorators on the parameters of class members and records where decorators, classes, members and parameters stand (record kinds 50 to 56 and 60). From those records the decorators are cut out and the calls TypeScript writes follow each class:

```ts
@D class A { @E m(@F a) {} }
```

```js
let A = class A { m(a) {} };
__decorate([E, __param(0, F)], A.prototype, "m", null);
A = __decorate([D], A);
```

The rewritten text is TypeScript without decorators, and the ordinary routes compile it, so type erasure and parameter properties need nothing new. A source whose at signs stand only in comments and strings compiles as without the option.

A class that names itself in its body is the one place where the text differs from TypeScript's. Inside a named class expression the name means the undecorated class, and nothing can assign to it. TypeScript declares a second variable for the decorated class, `A_1`, and writes that name for every reference in the body, which takes scope analysis. Here the class expression loses its name and stands in a scope of its own that declares the name again:

```js
let [A, A_1] = (() => { let A; A = class { static { A = this; } static make() { return new A(); } }; return [A, value => A = value]; })();
A = A_1(__decorate([D], A));
```

The body sees the inner variable, which plays the part of TypeScript's `A_1`: it holds the class while the static members run and the decorated class afterwards, and a later assignment to the outer variable does not reach it. The outer variable is not initialized before the class is, so a function outside the class that reads it during static initialization fails as it does in TypeScript's text. An arrow function keeps `this`, `arguments` and `super`; it does not keep `await` and `yield`, so a class that holds either word is left to TypeScript. Tests run both lowerings and compare what they return: with a decorator that replaces the class, with an assignment to the class's variable, with a read during static initialization, and with a spread of the class.

Inside a function TypeScript's `A_1` is a `var` of that function, so every round of a loop shares it and the body of an earlier class sees a later one. That is not imitated: a self-naming decorated class inside a function is left to TypeScript.

A class declaration is lowered wherever it stands: at module level, inside a function, a block or a method of another class, and as the default export. An anonymous default class gets the name TypeScript gives it, `default_1`. The lowering keeps a stack of the classes that are open, each with the number of class bodies around its head, so the members of a class expression inside a lowered class are not taken for its own. A PICT table of 38 placements (place, class decorator, member, parameter, self-naming, abstract) is built into sources, and each is compared with TypeScript's lowering by syntax and by running both.

#### Metadata

With `emitDecoratorMetadata`, TypeScript adds `__metadata` calls that name the types of a decorated member: `design:type`, `design:paramtypes` and `design:returntype`. Nest and TypeORM read them at run time. The values come from the annotations, by rules that are TypeScript's own for a file compiled alone, without knowledge of other files:

| Annotation | Value |
| --- | --- |
| `string`, a string literal, a template without holes | `String` |
| `number`, `boolean`, `bigint`, `symbol` and their literals | `Number`, `Boolean`, `BigInt`, `Symbol` |
| `void`, `undefined`, `null`, `never` | `void 0` |
| an array, a tuple | `Array` |
| a function or constructor type | `Function` |
| an object type, `any`, `unknown`, `this`, `keyof`, `typeof`, an indexed access, no annotation | `Object` |
| a union or intersection | the common value of its members, else `Object` |
| a class of the module | the class |
| an interface of the module, a type-only import | `Object` |
| any name the file does not declare | `typeof (_a = typeof Name !== "undefined" && Name) === "function" ? _a : Object` |

The last row is the common one: an imported name may be a class or a type, and one file cannot tell. TypeScript numbers the temporaries in the order it creates them, so the lowering creates them in the same order: the constructor's parameters first, then the members in source order, and a reference only when it is written. `S[]` creates none, and in `string | number | S` the union is `Object` before `S` is reached. A setter's parameter is serialized twice, once as the type of the member and once in the parameter list.

The parser supplies what the text alone does not show. In the legacy reading it records the start of every parameter of a class member (kind 57), the end of each parameter list (kind 58) and every list that declares type parameters (kind 59), and it marks a class below module level (kind 60). The annotation records of type erasure give the extent of each type. What a name stands for comes from the parser's table of module bindings, which the addon returns as records of kind 61: a class, an interface, a type-only import, an import, a value. A name is taken for what the table says only when the text agrees: the words that could declare it anywhere in the file are counted, and a count the table does not explain leaves the name uncertain. An interface that shares its name with a constant is `Object` when the constant is the result of a call to an imported function, as in `export const IFoo = createDecorator<IFoo>('foo')`; with any other value TypeScript may know the constant as a constructor.

Whatever is not certain is left to TypeScript: a name the file declares as a type alias, an enum, a namespace, a function, or more than once; a type parameter; an interface that can be called or that extends another; conditional, `infer`, `import()` and predicate types; `never` and `unknown` together with a union; a destructured or `this` parameter; a rest parameter that is not written as `T[]`; an accessor with both declarations; a comment where an annotation may begin; a source that spells a name like `_a`; and any reference to a name from a class inside a function, where a parameter or a variable may hide the name. A PICT table of 108 rows (position, type form, kind of name, static, class decorator) is compared with TypeScript by syntax.

#### Coverage

Of the files that hold decorators, the rewriting succeeds for 1,338 of vscode's 1,412, 1,754 of Angular's 1,886, 605 of Nest's 611 and all of typeorm's 1,594. With metadata the counts are 1,294, 1,683, 582 and 1,561. Most of the rest are files the parser does not read in any mode, and self-naming classes inside functions.

On the files of these four projects that hold an at sign, 9,254 of 9,256 native outputs have the syntax of TypeScript's lowering once both forms of the self-naming class are folded into one, and 9,072 of 9,074 with metadata; the two others are of the known parenthesis kind in both runs.

Left to TypeScript for now: a decorator between `export default` and `class`, class expressions with decorated members, classes in namespaces, computed and private keys, decorators on both accessors of one name, a leading directive or interpreter line, and source maps.

### Namespaces inside namespaces, and functions that mix var with lexical names

A namespace inside a namespace that exists at run time is lowered as TypeScript lowers it. The parser reads the inner body as a function body of its own and binds the inner name as a variable of the body around it; the emitter keeps the namespaces that are open and writes

```js
var N;(function (N) { let M;(function (M) { M.v = 1; })(M=N.M||(N.M={})); })(N||(N={}));
```

for an exported inner namespace, and `(M||(M={}))` for one that is not exported. A dotted name, `namespace A.B.C { }`, is the same thing written shorter: the parser reads the further names and binds the first, and the emitter opens one namespace per name, each exported from the one before, and closes them all at the one closing brace. TypeScript declares the further names with the keyword of the first, `var` at module level and `let` inside a namespace, and so does the emitter. A dotted namespace that holds types alone is erased like any other. The rule for exported variables holds per namespace over its whole body, the namespaces inside included: a second occurrence of the name would be a reference that needs the namespace in front of it. A namespace's own name may now stand in its body in front of a dot, as in `new N.C()`, which reads a property through the parameter; any other use may be a declaration, for which TypeScript renames the parameter, and is left to TypeScript. The word `namespace` in front of a line break stays the identifier it is. A PICT table of 18 rows (outer export, inner export, member kind, depth, own-name use, sibling) is compared with TypeScript by syntax and by running both outputs.

A reference to a variable that a namespace exports is written as a property of the namespace, as TypeScript writes it:

```ts
namespace N { export var a = 1; function f() { return a; } }
```

```js
var N;(function (N) { N.a = 1; function f() { return N.a; } })(N||(N={}));
```

Which occurrences of `a` are references takes the parser to say: a parameter, a local variable, a key, a label or a member of the same name is none. The tape has a flag for it, in the bytes its layout leaves unused, and with the flag the parser records every name it reads as an expression. The ordinary reading does not set it. When the name of an exported variable occurs a second time in the body, the emitter reads the source once more with the flag, in a workspace of its own, and counts: the namespace is written natively only if every other occurrence of the name is a recorded reference. Then no occurrence is a declaration that hides the variable, and each reference gets the namespace in front of it; in a namespace inside another, the owner is the innermost namespace that exports the name itself. Any other occurrence, a shorthand property `{ a }` among them, leaves the namespace to TypeScript as before. A PICT table of 50 rows (variable kind, site, form of the occurrence, outer export) is compared with TypeScript by syntax and by running both outputs, and 54 forms that hide or use the name are compared by syntax with either kind of variable.

A namespace may follow a namespace, a class or a function of its name. TypeScript then writes its function without a declaration of the name, whatever the second head says about `export`: whether the name is exported is the first declaration's matter.

```ts
class C {}
namespace C { export const x = 1; }
```

```js
class C {}
;(function (C) { C.x = 1; })(C||(C={}));
```

The binding table has a kind of its own for a run-time namespace, which does not conflict with such an earlier declaration, and the parser marks the head of the merging namespace (kind 44). The emitter writes a semicolon in front of the function, so that it is never read as the arguments of the statement before it. Two declarations of one namespace share their exported members, and TypeScript writes a reference from one body to a member of the other as a property; that is not done here, so a body that names a member exported by another declaration of the namespace is left to TypeScript. A PICT table of 14 rows (first declaration, export, member kind, what stands between, a third declaration) is compared with TypeScript by syntax and by running both.

An import alias in a namespace body, `import B = A.x;`, is a variable of the body: the emitter writes `var` for the keyword. An exported one, `export import B = A.x;`, is a member, written `M.B = A.x;`, and references to it get the namespace like those to any exported variable. An alias alone does not make the namespace exist: a namespace that holds only aliases, types and namespaces of that kind is erased, as TypeScript writes nothing for it.

A namespace and parameter properties used to exclude each other: each lowering had a pass of its own. The pass that inserts the property statements now writes the namespace records between its insertions as well, so a class with parameter properties may stand in a namespace or beside one.

Looking at namespace bodies showed a wider gap. The emitter finds the end of each module item by reading the item again. That reading used the mode in which a function that declares both a `var` and a `let`, `const` or `class` stops the parser, so that the whole parse can run its second pass and compare the declarations. The emitter took the stop for the end of what it can write. A module that held such a function was therefore left to TypeScript whenever something in it was written item by item: an enum, a namespace, a type annotation, JSX.

```ts
function f() { var b = 1; const c = 2; return b + c; }
export const x: number = f();
```

The readings that only find boundaries now keep the log of local names inactive. The comparison of declarations stays with the whole parse, which has accepted the source before the emitter runs, so `var b; let b;` in one function is still reported through TypeScript.

Together these changes move 574 files of the wide corpora, TypeScript's own suites and Test262 to the native routes, with no difference to TypeScript's output among them: 34,705 native outputs compared, 34,693 equal, the other twelve of the known kinds. Of TypeScript's own cases that are no declaration files, 4,448 of the 6,479 compiler cases and 3,513 of the 5,877 conformance cases now take a native route; 992 of the rest are cases that TypeScript itself reports. The Test262 pass, compiled here and run in the sandbox without a network, gives the same 962 differing units as before, all of the strict-directive kind, while the units compiled natively from `.ts` rose from 14,216 to 29,769 of 47,743.

### What a flag on the tape costs

The reading for legacy decorators first added a flag at the end of the tape, the record that every parser function receives by value, and one to the parser state. On the benchmark host the project rows became 1.5 to 3.5 percent slower, although no file of those rows sets the flag. Replacing every test of the flag by `false` in the generated C did not bring the time back, so the branches were not the cost. A copy of the commit before the change with nothing but one more `bool` at the end of the tape was 1.2 percent slower: the tape had grown from 48 to 56 bytes.

The flags now stand behind the capacity, where the C layout leaves four bytes unused, and what the state carried is an argument of the one function that needs it. With the later flag for references in the same bytes, alternating runs of the commit before the legacy reading and of the current one give, on the five project corpora of the quick measurement, differences from one percent faster to 1.2 percent slower. The full table of twenty rows, three alternating runs pooled, has the same wins as before, twenty warm and nineteen first; the warm medians of the project rows lie between 3.3 percent faster and 2.8 percent slower than the earlier commit, which is the spread of that measurement on a host that does other work.

### Class keys, accessor fields, decorators in scripts and line-comment pragmas

A sample of TypeScript's own cases that still took TypeScript's emitter, shrunk statement by statement to what keeps them there, showed that most of the rest test programs that are wrong in ways a single-file transform does not report: duplicate declarations, modifiers where none may stand. The forms below were the ones that ordinary code uses.

A computed class key may be any assignment expression: `[0 + 1]() {}`, `[f()] = 1`. The lexical reader of class keys takes a name or a string in brackets; where it does not accept the key, the member reader reads an expression there, in the state of the class body, since the key is evaluated where the class stands.

`accessor` in front of a key on its line declares a field with a getter and a setter. The word belongs to the head of the member and stays in the output; the member behind it is read as the field it is, and a parenthesis behind its key fails the member. An optional method with a body, `foo?() {}`, keeps the body and loses the question mark and its modifiers. The comparison with TypeScript found the first cut of this wrong: it erased the question mark and left `public` in front of the method, in two files of Nest.

V8 parses neither decorators nor accessor fields, so the check of a published script refused every script that holds one. Such a script is given to the certified parse of modules with an empty export behind it: a strict script is a module without the syntax that only a module has, so what that parse accepts, and what holds neither `import` nor `export`, is a script. A decorated class may stand at the top of a script as it does in a module. The V8 audit, which runs the engine on every certified output to check the parser's claim, leaves out sources with accessor fields, as it cannot judge them.

Two declarations of one namespace share the members they export, and TypeScript writes a reference from one body to a member of the other as a property of the namespace. That is done for a member another declaration at the top of the file exports, when every occurrence of its name in the body is a recorded reference:

```ts
namespace N { export function f() { return 1; } }
namespace N { export const g = f(); }
```

```js
var N;(function (N) { function f() { return 1; }N.f=f; })(N||(N={}));
;(function (N) { N.g = N.f(); })(N||(N={}));
```

A name that only the namespaces inside two declarations share still leaves the body to TypeScript.

TypeScript reads the JSX pragmas from block comments only. `// @jsxImportSource preact` in a line comment is no pragma, and neither is the directive `// @jsx: preserve` that many of TypeScript's own cases begin with; the pragma reader reported both as unsupported, which kept every such file with TypeScript's emitter.

### Declared modules, JSX type arguments, and two reviews of the namespace work

`declare module "name" { ... }` holds the text of a module, so it may hold imports of every form, `export = name;`, `export default` in front of a function, a class, an interface or a name, and `export * from "m";`. Style sheet typings, typings of CommonJS packages and augmentations that import a type are written this way. The whole declaration is erased as before; the names its imports bind are entered behind the names of the file while it is read and forgotten after it. `declare global` and a declared namespace do not take these forms.

Type arguments behind a JSX tag name, `<Select<string[]> value={v}>`, are read as types and erased. The JSX emitter reads each element from the source again and passes over the arguments by their brackets, in a TypeScript file only. A nameless class may begin with its implements clause, `class implements I { }`.

The namespace and class member work went through two reviews. The first found five defects and the second five more; all are corrected, and tests hold a case for each:

- A namespace named like a namespace open around it, as in `namespace Button.Button`, would declare a variable that meets a parameter of that name, or let a reference reach the wrong parameter. TypeScript renames a parameter there; such a namespace is left to it.
- A declared namespace of the same name is erased, and its members, which are properties of the namespace, are not known to the emitter. A run-time namespace beside one is left to TypeScript.
- Declarations of a namespace share their members only when both are exported or both are not.
- The name of an open namespace is its parameter. A reference to it gets no property in front, also when the dotted head of another declaration bears the name.
- An exported variable without a value is erased, and a semicolon stands where it stood: the statement before it may end by a line break alone, and the next line would otherwise continue it.
- `get` or `set` in front of a private name begins an accessor on whatever line the name stands. The parser took `get` on a line of its own for a field and the private name for another, which is no JavaScript; a decorated script has no second check by V8, so the mistake was published.
- Behind `export default` in a declared module stands no variable and no type alias.
- A source with a line separator and a JSX pragma is left to TypeScript's emitter.

Of TypeScript's own cases that are no declaration files, the count that takes TypeScript's emitter went from 2,198 to 1,929 of the 6,479 compiler cases and from 2,436 to 2,202 of the 5,877 conformance cases over this work. 992 of those are cases that TypeScript itself reports.

### Forms taken from a large editor code base: construction, enum values, shifts, modifier orders

A sample of the files of a large editor code base that still took TypeScript's emitter was shrunk file by file to the statement that caused it. The forms below came from that list.

- **Legacy decorators in a file with names outside ASCII.** The lowering reads the source with the parser, which reads ASCII names. For other names the decorators are lowered on the copy spelled in ASCII, the copy is compiled, and the names are put back in the result, the second name of a self-naming class included. A copy without a decorator compiles as the source does without the option.
- **`new class { ... }`.** The class expression is what is constructed, with or without a name, a heritage and arguments. The operand of `new` without an argument list may also stand in parentheses (`new (mock<T>())`) or be followed by `as`.
- **`new Name<T>` without an argument list.** The type arguments are erased. The expression has to end behind them, at a semicolon, a comma or a closing bracket.
- **Abstract accessors** (`abstract get count(): number;`) are erased like abstract methods. `readonly abstract name: T;` is read as `abstract readonly` is, and `declare` may stand behind other modifiers (`protected declare model: T;`): the member is erased whole in any order.
- **A string that spells the name of an exported namespace variable.** The emitter counts the occurrences of such a name in the body and compares them with the references the parser recorded. A word with the same quotation mark directly on both sides is no name and is not counted, so `export const mode = 'mode'` no longer leaves the namespace to TypeScript.
- **Enum values.** A member may take its value from a member of something the file does not declare (`A = Phase.Starting`): TypeScript, compiling one file, writes the expression with the reverse mapping of a number, and so does the emitter, when the root of the dotted name is declared in the file neither as an enum, a namespace nor an import alias, is neither the enum's own name nor the name of one of its members, the enum is declared once, and the enum does not stand in a namespace (where the root may be a member of the namespace). The declarations are looked for in the source as written, declared ones and those behind the enum included. A fraction is taken when its text is what JavaScript prints for it (TypeScript prints the value): an optional minus, no needless zero, at most six digits behind the point and fifteen in all. Behind either kind the next member needs a value of its own, and no member computes with it. A template without a hole is written between double quotation marks when its text needs no escape there.
- **`a << b | c >> d`.** TypeScript rescans `<<` as `<` when it tries to read type arguments, so the parser refused a left shift whose right side, read as a type, was followed by `>`. Behind operands that are only names, numbers, dots, `|` and `&` on one line, a following `>>` or `>>>` never closes type arguments: TypeScript's parser was run on 400,000 generated expressions of that shape, with keywords among the names and every kind of token behind the shift, and read none as type arguments. A single `>` and other operands stay refused. This form had sent JavaScript files to TypeScript's emitter as well.

With the legacy decorator option, the native outputs on the four decorator-heavy code bases rose from 9,290 to 9,941 of 14,707 files (9,937 with TypeScript's syntax; the four differences are parentheses kept around an erased assertion), and with metadata from 9,107 to 9,717.

A review of this round found six defects, all in two of the forms above, and each has a test now:

- The search for a declaration of the root of a foreign enum member read the text after the declared statements were blanked and only up to the end of the enum being written, and it did not pass over a line comment between the keyword and the name. A `declare enum`, an enum further down and `enum // note` on the line above the name were missed, and a constant was written as an expression. The search reads the source as written from start to end.
- A member of the enum itself (`Length = Text.length`) was taken for a foreign name. TypeScript writes it as a property of the enum.
- In the copy spelled in ASCII, letters take the place of bytes outside ASCII, and `"\xA"` in front of such a byte became a well-formed escape. A word behind a backslash, or one that begins with a digit, is no longer spelled: the file is left to TypeScript, which reports it.
- Putting the names back also rewrote a word of the source that was spelled like the second name of a self-naming class (`NN_1` for a class spelled `NN`). The second name is put back only for the decorator lowering, and a source that holds such a word is left to TypeScript.

The second review of the round found four more, also corrected:

- The decorator lowering removed an erased member (a declared field, an abstract member) and left nothing. A field before it that ends by a line break alone then ran into a member that begins with a bracket. A semicolon stands where the member stood, as in the default mode.
- A word with bytes outside ASCII whose spelling equals the derived second name of another (`β_1` beside a class or name spelled like `β`) was rewritten when the names were put back. Such a source is left to TypeScript.
- Through `globalThis` TypeScript reaches the enums of the file; `globalThis`, `window`, `self` and `global` are no foreign roots of an enum value.
- A comment between the brace and a shorthand name hid the shorthand from the check that leaves self-naming classes with a shorthand reference to TypeScript.

### More forms from the same list: namespaces with overloads, shorthands and enums, and assertion targets

- **`export import Name = A.B;`** at the top of a module is written `export var Name = A.B;`, as the alias without `export` is written `var`. An alias of a `require` call is written as a constant and an export list by TypeScript and is left to it.
- **`override` alone** makes a constructor parameter a property, as an access modifier or `readonly` does.
- **Overloads of a function that a namespace exports.** `export function any(): T; export function any(x?) {...}`: each further declaration of the group may stand behind `export` when the first does. The word is recorded and left out, and the implementation at the end carries the assignment to the namespace. A group that mixes exported and local declarations is refused.
- **A shorthand property that names a variable the namespace exports.** `{ scheme }` is written `{ scheme: N.scheme }`. The parser records the shorthand name in the reading that records references, with a kind of its own, and the emitter writes the key in front. A pattern that declares the name (a parameter, a declaration, a catch clause) records nothing; the occurrences then do not add up, and the namespace is left to TypeScript. A destructuring assignment is read by another path and is left to TypeScript as well.
- **A namespace behind an enum of its name.** An enum has a binding kind of its own, which behaves as before except that a run-time namespace may follow it. The namespace is written without a declaration, as behind a class or a function. A namespace of types shares its name with a run-time enum. The other order (the namespace first) would need the enum written without its declaration and stays with TypeScript.
- **`(<T>name) = value`.** An angle-bracket assertion keeps its operand a target once parentheses stand around it, as `(name as T) = value` does. Without parentheses TypeScript reports it, and so does the fallback.

Probing these forms showed a defect of the route that uses Node's own type erasure: `t as any = 1` (and `+=`, `-=`, `^=`, `&&=`, `||=`, `??=`, also with `satisfies`) was answered with the erased text and no diagnostic. TypeScript ends the statement in front of the operator and reports that a semicolon is expected. The route now declines when an erased assertion is followed by an assignment operator, and TypeScript answers.

### Operators behind assertions, words outside ASCII that are no names, and a namespace that reads its own name

- **An operator behind an assertion.** `value as T || fallback`, `a as T === b`, `a as T ? b : c`: the emitter took an assertion only in front of a closing bracket, a comma, a semicolon or another assertion. An operator that binds no tighter than the assertion may follow as well (`||`, `&&`, `??`, the equalities, `^`, the `?` of a conditional): the asserted operand holds only operators that bind tighter, so it groups the same without the assertion. The arithmetic operators and the shifts would take the last operand of the asserted expression (`a + b as T * c`), and `<` and `>` meet the type; these stay with the other routes. An assignment operator is no continuation at all, which TypeScript reports.
- **A word outside ASCII that is no identifier.** The copy spelled in ASCII gave up on a file with a dash, a bullet or a typographic quotation mark anywhere, since a letter in its place could make an error disappear. Such a word is now spelled with the digit 9 in front and letters from G to Z behind it. In a string, a comment or a template that is text like any other; where code stands it is no number and no name, so the copy is refused exactly where the source is. The copy is also tried when the parser read the source but the emitter declined it for such a byte, as it does for a namespace body.
- **A regular expression with structure.** What a class, an escape or a group name means, and whether it is well formed, depends on the characters: `/[я-а]/` is a range out of order, and its copy could be in order. A file with a byte outside ASCII between a slash that can begin a literal and the slash that would end it, with a bracket, a backslash or `<` between them, is not read through the copy. This closes a gap that was there before this round. A pattern of plain characters (`/été+/`) is taken.
- **A namespace that reads its own name.** `value instanceof Style` in `namespace Style`, or `[A, B]` in `namespace A.B`: an occurrence of the name was accepted only in front of a dot, since any other might declare the name (TypeScript then renames the parameter of the namespace's function). An occurrence that the parser recorded as a name read as an expression is no declaration and stays as written. The constructed name of `new K()` is recorded as such a reference too, so `new K()` on a variable or a sibling member that the namespace exports is written `new N.K()`.
- **`import type Name = require("m");`** and `import type Name = A.B;` are erased whole.

- **`x **= y` and `[a, ...rest] = value`.** Two forms of plain JavaScript had left the native route: the exponent assignment, which the reader of assignment operators did not know, and a rest element at the end of an array target. Both are read now, in JavaScript files as well.
- **Abstract optional members** (`abstract name?: T;`, `abstract name?(): T;`) are erased whole, and **an angle-bracket assertion may begin the value of a property** (`{ key: <T>{ ... } }`): the parser records the colon of such a property, so that the emitter can tell it from the colon of a label, where the brace behind the erased assertion would open a block.

A review of this round found four defects, all corrected, each with a test:

- The copy spelled in ASCII writes a digit in place of the first byte of a word that is no identifier. In a file that is only erased, the names are put back by position, and only bytes outside ASCII were put back: `'don’t'` came out as `'9on’t'`. Every byte the copy changed is put back.
- `import type Item = Models.Item;` is an alias of a name inside the file and does not make the file a module. The scan for what makes a file a module looked for the equals sign behind the first name and took `type` for an imported name, so a script lost its strict directive.
- A computed key that names its class (`[register(() => Café)]() {}`) is evaluated where the name means the undecorated class, like the heritage clause. Such a self-naming class is left to TypeScript.
- Behind a const enum TypeScript does not resolve the members that the declarations of a namespace share (`{ label }` stays as written). A namespace is merged natively only behind an enum that is not const.

- **`declare module "name";`** without a body is erased whole, at a semicolon or at the end of the line.
- **A decorated class inside a function may name itself** when no loop of the function stands around it. TypeScript declares the class's second name once in the function, so the runs of a loop share it: there the body of the first class sees the second. Outside a loop the declaration runs at most once in each run of the function, and the lowering used at the top of a module, a binding of its own for each evaluation, behaves the same. The parser records whether a loop stands around a local class (the context of `break` and `continue` already knows it, and starts anew in every function body).

The second review of the round found five more defects, each corrected and tested:

- `export` at the end of a line comment above an overload (`// TODO: export`) was taken for the modifier of the overload, and the implementation lost its assignment to the namespace. The word is looked for on the line of the declaration only.
- A computed key over several lines that names its class was not found by the check that leaves such a self-naming class to TypeScript. The key is now read up to its closing bracket.
- A class that a namespace exports was assigned to the namespace right behind its closing brace, in front of the calls of its decorators, while TypeScript assigns it behind them. A decorator that reads the namespace saw the class too early, and a class decorator that returns another class would have left the first one in the namespace. Such a class is left to TypeScript.
- In a JSX file the emitter writes escapes into the text of an element, and an escape next to a word spelled in ASCII read as one word with it, which was then not put back. The copy is not used for JSX files with the legacy option.
- A function assigned to a name in parentheses gets no name: `(handler as T) = () => {}` leaves `handler.name` empty, while TypeScript writes the assignment without the parentheses and the function is named `handler`. A plain or logical assignment of a function, a class or an arrow to an asserted target in parentheses is left to TypeScript. This had been so for `as` before this round as well.

To catch the like of the first defect of the first review earlier, the corpus checks gained two variants in which every real file gets a name outside ASCII and a string and a comment with dashes and typographic quotation marks, once alone and once beside an enum and a namespace; the build before the correction differs from TypeScript on 1,066 of those 1,488 files, the corrected one on none.

### A source map for files with legacy decorators

With the legacy option and a source map, a file was handed to TypeScript: the decorators are lowered by rewriting the source, and the map of the rewritten text does not lead to the source. It is now led on. The rewriting reports the pieces of its result, each either copied from a place in the source or written by the rewriting; the map of the rewritten text is decoded, every copy it names is cut at the borders of those pieces, a copied piece is given its place in the source, and a written piece is marked as generated text, once behind a copy, as the emitter marks its own. A segment that the cutting adds sits on a token.

The code is the same with and without a map. On the decorated files of four code bases (10,075 files), 9,582 are answered natively with a map, and every one of those maps passes the check that the default mode's maps pass (each segment sits on a token of the output and names the same text in the source; 8.9 million segments). Three properties are tested besides: led on through an unchanged text a map stays as it is, a line written in front moves every place down by one line, and a map that does not fit the text is not led on. Files with names outside ASCII, which go through the copy spelled in ASCII, still take TypeScript's map.

### Array and object targets of an assignment

Destructuring declarations were read in full, but an assignment took only flat targets: names in an array, names and renamed names in an object in parentheses. Nested targets, defaults inside an array, members as elements, computed keys, and such targets in the head of a `for ... of` loop left the native route, in JavaScript files as in TypeScript files. They are read now. An object literal is a target when every member is one (a shorthand name that may be assigned, `key: target`, a rest member at the end), `target = value` is an element with a default, and an array takes both as elements; a member expression is a target as an element, behind `...` and in the head of a loop. Nothing is rewritten: the text is JavaScript as it stands. The table of forms (verification/pict/compiler-assignment-targets.pict, 42 rows over the outer form, the element, an extra and the file kind) is run and compared with TypeScript's output row by row.

A review of the last rounds found two defects, both in checks of the decorator lowering that went by the text of the class, and both are now answered by the parser instead:

- A computed key that names its class was looked for behind a punctuation mark or a modifier, and a key behind a field that ends without a semicolon was missed. The parser records the place of every computed key of a class member (kind 65), and the lowering looks at those places.
- A class that a namespace exports was recognised by the word `export` in front of its head, and a comment between the two hid it. The parser's record of the `export` of a namespace member (kind 36) is passed to the lowering, which compares its end with the start of the class or of its first decorator.

- The second review of that round found a third check of the same kind. The heritage clause of a self-naming class was searched for the class's name after taking out what looked like type arguments, a pair of angle brackets; two comparisons in a callback (`extends pick(() => n < 1 || Job.version > 1)`) look like one, and the name between them was not seen. The parser's records of type arguments, type parameter lists and implements clauses are passed to the lowering, which takes out exactly those.

A corpus variant was added for checks that go by the text: real files with block comments put between tokens at random places (a comment without a line break changes nothing for TypeScript). The native outputs of the 1,241 plain and 1,771 decorated files agree with TypeScript's.

### Large files: the table of names, and three costs that grew with the square of a count

A file with more than 512 top-level names was handed to TypeScript: the parser keeps the names of the module, of the open function and of the exports in regions of a fixed table. On the fourteen code bases that was four files, protocol and schema definitions, but they held 13 percent of the bytes that still took TypeScript's emitter. The regions are now 2,048 names wide. The C code used to clear the whole table for every file. Filled with a fixed pattern instead of zeros, every test passed and 71,090 compiled outputs stayed the same byte for byte: the parser reads only entries below the counts it keeps. The table is no longer cleared, so the larger table costs nothing for a small file; the benchmark rows are one to three percent faster than before. The cap of 512 parameter properties in one file went the same way.

Timing files with many declarations of one kind showed three costs that grew with the square of a count, each from a search that was repeated for every item:

- An enum with values from other names searched the whole source twice for every such member (2,000 members in a 670 KB file: about a second). The result is kept for the last root and for the enum's own name (4.5 ms).
- A namespace read its whole body once for every variable it exports, and its list of members once for every reference (500 exported constants: 17 ms). The body is read once with the variables in a hash table (1.0 ms).
- Leading a source map on decoded the source from its start for every decorator (1,000 decorated members: 53 ms). The places are counted on from the piece before (12 ms).

Two limits inside types went with the table. The type behind the colon of a conditional type was read one level deeper, so a chain of more than sixteen links (`T extends A ? X : T extends B ? Y : ...`, the lookup tables of protocol definitions) was handed to TypeScript; the chain is now read at one depth, link by link, up to 64 links in an annotation and 256 in a type alias. A union or an intersection may have 4,096 members in an annotation and 16,384 in an alias (64 and 256 before). Types that really nest, such as type arguments inside type arguments, keep their limit of sixteen levels.

The reviews of this last round found three more points in the decorator lowering. Removing a recorded type from a heritage clause joined the words on both sides (`<Job<"<">title=...>` read as `Jobtitle`); every removed span now leaves a space. A direct `eval` in the body of a class that names itself reads the name by its spelling: TypeScript's text gives the class's own name, the form used here the variable that holds the decorated class. Such a class is left to TypeScript, also when the call stands behind the dots of a spread.

### Targets from ES2022 on

Most projects state `target: es2022` or a later year, and every such file used to go to the TypeScript emitter. TypeScript's own output was compared between ES2022 and ESNext on 33,572 files (sixteen code bases and its own test cases). The two texts differ in four situations only, and no diagnostic differs:

| Form | What TypeScript does below ESNext |
| --- | --- |
| A decorator | Lowers it to `__esDecorate` and `__runInitializers` calls. |
| `using` and `await using` | Lowers the declaration to `__addDisposableResource` with a `try` statement. |
| An accessor field | Writes a private storage field with a getter and a setter. |
| The name of a class inside one of its non-static private members | Replaces the name by a variable that is set behind the class. |

`compile` therefore handles `es2022`, `es2023`, `es2024` and `es2025` as ESNext when the source holds none of the four, and hands the file to TypeScript otherwise. The test errs toward TypeScript: `using name` and `accessor name` are found by pattern (prose that happens to read that way sends the file to TypeScript too), a private name counts whenever it is not read through a dot, and at signs are settled by the parser, which tells a decorator from a JSDoc tag or a string. Each test takes time in proportion to the source. The patterns know spaces, tabs and the line ends of ASCII; a source with any other white space (a vertical tab, a no-break space, a line separator) goes to TypeScript whenever a pattern has to be consulted.

The same was measured for every target down to ES2015: TypeScript's output for a target differs from its ESNext output only where the source holds a form newer than that target. A file is therefore compiled natively for an older target when none of these stands in it, found by their words and signs wherever they are (a comment or a string that holds one sends the file to TypeScript):

| Target below | Forms that send the file to TypeScript |
| --- | --- |
| ES2022 | a class (fields, private names and static blocks all need one), any private name |
| ES2021 | `\|\|=`, `&&=`, `??=` (numeric separators are lowered natively) |
| ES2020 | `?.`, `??` (`export * as` is handled natively across all targets) |
| ES2019 | multiple or Unicode-escaped optional `catch` bindings (single unambiguous `catch {}` is lowered natively) |
| ES2018 | `...`, `for await`, an async generator, and JSX (its attributes become an object that may spread) |
| ES2017 | `async`, `await` |
| ES2016 | `**` |

Of 33,572 measured files, 22,925 hold no class, and 11,429 hold none of the forms at all.

A failure inside TypeScript itself (a `TypeError` raised from its own code, seen with CommonJS output when a file imports its own name) is answered with the diagnostic `TYPESCRIPT_FAILURE` instead of an exception.

JavaScript that is published as written (`.js` and `.mjs` at the ESNext target) keeps that text with `sourceMap: true` as well, and receives a map in which every run of tokens leads to its own position (the grain of the maps for TypeScript files: white space has no segment, and signs that touch share one); a script's map is moved down by the line of the strict directive. Before, the option sent the file to TypeScript, which prints it again in its own layout. Source bytes may be given as a plain `Uint8Array`: they are read in place and take the same routes as a Buffer.

### JSX that is kept

With `jsx: 'preserve'` a `.tsx` module is compiled natively: the types are erased as in the other modes, and every element is written as it stands in the source, without the type arguments of a tag (`<List<Item> />` becomes `<List />`; the projection that erases the types blanks them). The emitter walks an element with the same code that lowers it, which decides whether the element is accepted and where it ends, and then replaces what the walk wrote by the source text. Text, entities and attribute strings are therefore the source's bytes.

A kept element cannot be confirmed by a JavaScript parse, so the result is published only from a certified projection of a module. When type-only statements were removed, the file must still hold an import or export of its own; this is read from a rendering with factory calls, which adds no import. An element with an empty container (`a{}b`) is left to TypeScript, which drops the container and joins the texts. A script, a `.jsx` file and a request for a source map keep the TypeScript route. On 3,005 `.tsx` files of seven code bases, 2,998 are answered natively in this mode, and each output has the same syntax tree as TypeScript's.

### CommonJS output

With `module: 'cjs'` a module is first compiled as a module, on the routes described above, and its text is then written as CommonJS by `src/compiler-commonjs.cjs`. The certified parser reads the text once more and reports where each statement starts (at the top level and in every list below it), which statements are imports and exports, the names the module declares, every name that is read as an expression, and the targets of assignments. From these the writer produces what TypeScript produces, statement by statement:

| In the module | In the CommonJS text |
| --- | --- |
| `import { a, b as c } from "./m"` | `const m_1 = require("./m");` and every reading of `a` becomes `m_1.a`; a call becomes `(0, m_1.a)()`, a shorthand member `{ a: m_1.a }` |
| `import d from`, `import * as n from`, `import d, { a } from` | the same through `__importDefault` or `__importStar`, with TypeScript's helper texts in its order |
| `export const x = value` | `exports.x = value;`, and readings and writings of `x` go through `exports.x` |
| `export const f = () => …` (an arrow function, a function or a class and nothing more) | the declaration stays and `exports.f = f;` follows it, so that the value takes the name |
| `export function f() {}` | the function stays, and `exports.f = f;` is written at the top |
| `export class C {}`, `export default …`, `export { a, b as c }` | an assignment behind the declaration, or a getter behind the import for an imported name |
| `export * from`, `export * as n from`, `export { a } from` | `__exportStar`, `__importStar` and getters |
| a lowered enum or namespace | `var E; (function (E) { … })(E \|\| (exports.E = E = {}));` |

The line `exports.a = exports.b = void 0;` and the names of the module variables (`foo_bar_1`, `_2d_1`) follow TypeScript's rules. Whether the value of an exported variable is function-like is asked of the parser through small texts built around the value. A rewritten call that starts a statement of a list is written behind a semicolon, since its parenthesis would otherwise continue the statement in front.

Whatever is not certain is left to TypeScript: a word of the source that spells an imported or exported name and is neither a reading, a property behind a dot nor the declaration (a parameter of that name, a key, a comment); an assignment to a function or class that is exported by value; `exports`, a dynamic import or `import.meta`; an optional call of such a name, or the name in front of a non-null mark; a pattern or several declarators in an exported declaration; an exported ambient declaration; `default` inside braces; `export =`; a script; files with a module or CommonJS extension, and a source map. The result is read once more by the parser before it is returned.

Modules with legacy decorators are written the same way. The helpers of the decorator lowering are placed among TypeScript's CommonJS helpers in its order, the class that the lowering declares as `let C = class C {…}` is exported behind its declaration, and the assignment `C = __decorate(…)` writes every export of the name (`exports.B = exports.A = C = …`). On Nest, typeorm, Angular and VS Code 6,326 of 14,707 files with decorators are written natively with `module: 'cjs'` and `experimentalDecorators`. On fourteen code bases 9,090 of 17,306 files are written this way with `module: 'cjs'`, each with the syntax tree of TypeScript's output.

### CommonJS lexical scanning, source maps, dialects, and lifted parser limits

- **CommonJS lexical scanning and default re-exports.** `src/compiler-commonjs.cjs` now scans emitted JavaScript lexically (`scanCodeIdentifiers`) rather than matching raw identifier spellings across the whole text, skipping comments, string literals, template static text, and regular expressions while tracking `prevToken` (with bracket/parenthesis stacks and conservative fallback on ambiguous `/` after `}`, `++`, `--`, or contextual `of`, and on `U+2028`/`U+2029`). Non-reference occurrences of imported or exported names behind `.` (across trivia), before `:` (property keys and labels), on method/accessor definitions (`name(` not preceded by `function`, `function*`, or `@`), on `break`/`continue` labels, and on `static` members no longer decline to TypeScript. `export { default } from`, `export { default as Name } from`, and `export { a as default } from` are emitted natively through `__importDefault` getters. Across the sixteen wide code bases (27,282 files), native `module: 'cjs'` coverage rose from 13,058 (48.0%) to 17,081 (62.6%) with zero CommonJS AST mismatches (2 pre-existing optional-chain parenthesis differences); across the four decorator-heavy code bases (14,707 files), native `experimentalDecorators` + `module: 'cjs'` coverage rose from 6,326 (43.0%) to 8,042 (54.7%) with zero CommonJS mismatches.
- **Native source maps for CommonJS, `jsx: 'preserve'`, and non-ASCII identifiers.** `toCommonJs` records byte spans for copied code, directives (`prologueText`), and module specifiers inside `require(...)`, and `composeCommonJsMappings` (`src/compiler-legacy-maps.cjs`) composes the underlying ESM source map (including legacy-decorator maps) with those spans. `jsx: 'preserve'` emits projection source maps with `.jsx` output filenames for `.tsx` and `.jsx` files. Non-ASCII identifier erasure (`highByteNames`) writes UTF-16-width-preserving blanks (`U+00A0`, `U+2002`, `' '+U+FEFF`) matching `native/compiler/source-map.h` so `projectionMappings` maps non-ASCII files natively. Across four real-project corpora (`zod` CJS, `hono` CJS, `mui` `jsx: 'preserve'`, and `aug-U_plain` non-ASCII), 746,720 source-map segments passed `assertSegmentsFaithful` with zero failures.
- **`.cts`/`.cjs`/`.mts` CommonJS and `.jsx` `jsx: 'preserve'`.** CommonJS routing accepts `.cts`, `.cjs`, and `.mts` modules (aligning `sourceMap.file` extensions `.cjs`/`.mjs`/`.jsx`/`.js` with `compiler-compat.cjs`). `native/compiler/lowering.c` enables `jsx_mode_preserve` for `.jsx` modules by validating the classic-lowered JavaScript through V8 while returning the preserved JSX text verbatim.
- **Lifted Pulse parser limits.** `proof/fstar/TmtPulseParser.fst` (all five F★ modules verified and re-extracted via KaRaMeL) now accepts `for ({ a = 1 } of x)` (and renamed/rest defaults via `cover_assignment_members`), `new a!.b()` and `new W!<T>(u)`, labeled simple statements (`lbl: 1 + 2;`, `lbl: break lbl;`, still rejecting lexical declarations such as `lbl: const x = 1;`), and type nesting up to 32 levels (previously 16).
- **Reviews.** Round 34 (15 CommonJS findings) and round 35 (7 findings across the lexical scanner, CJS directive/specifier source maps, and uppercase `.JSX` map filenames) were all fixed and covered by regression tests.

### Further CommonJS, F★ reference-capture, and older-target extensions

- **Pure-JavaScript `.ts`/`.mts` passthrough and Test262/TS-official native rate.** `validJavaScriptTsModule` (`src/compiler-routes.cjs`) publishes pure-JavaScript `.ts`/`.mts` modules and strict scripts natively via V8 validation (with projection source maps) while declining forms where V8 and TypeScript 6.0.3 diverge (escaped keywords, Unicode 16/17 letters, `new import`, `import.source`/`import.defer`, `?.#`, `for ([x = a in b] of ...)`, and generic-call ambiguities). Valid native coverage rose to 80.4% on `test262-module.ts.json` (19,805 / 24,638), 76.1% on `ts-compiler.json` (4,580 / 6,019), and 72.1% on `ts-conformance.json` (3,834 / 5,315) with zero `jsTsErr`.
- **Expanded CommonJS coverage (`src/compiler-commonjs.cjs`, `src/compiler-routes.cjs`, `proof/fstar/TmtPulseParser.fst`).** Added native support for dynamic `import("./lit")`, `import { default as X }`, CommonJS dialect `export =`, comments and URLs in `valueShape` and import/export statements, >50-export 50-chunk `void 0` splitting, multi-declarator `export const/let/var a = e1, b = e2;`, type-only ES modules (and runtime modules whose only imports/exports were type-only), plain strict scripts, trailing JSDoc/empty semicolons on lowered `export enum`/namespaces, TypeScript-exact `specifierName` for `.`/`..`/trailing-slash/URL-root specifiers, non-ASCII CommonJS via `asciiSpelling`+`restoreNames`, and Node CJS wrapper syntax validation (`new Function`). Extended `TmtPulseParser.fst` (`input.capture_references`, all 5 F★ modules verified and re-extracted via KaRaMeL) to capture `kind = 43` references inside computed class member keys, destructuring computed keys/defaults, and arrow parameter defaults. Across the 16 wide code bases (27,282 files), native `module: 'cjs'` coverage reached **73.22% (19,976 / 27,282)** with `tsError: 0`, `outputInvalid: 0`, and zero new non-`.mts` mismatches (excluding unlowered standard ES-decorator files, >93% native); across Nest, TypeORM, Angular, and VS Code with `experimentalDecorators: true, module: 'cjs'`, native coverage reached **87.1% (8,798 / 10,100)** (`typeorm` 95.5%, `angular` 89.6%, `nest` 88.7%, `vscode` 73.3%).
- **Older-target native lowering (`lowerOlderTarget`, `src/compiler-downlevel.cjs`).** Targets ES2015–ES2020 now natively lower numeric separators (`1_000`, `0xff_ff`, `0b1010_0101`, `1_000.2_5e1_0`, `1_000n` for ES2020+; 126/126 match at ES2020 with 0 mismatches), targets ES2015–ES2018 natively lower single unambiguous optional `catch { ... }` bindings (`27/27` match at ES2018 with 0 mismatches), and `export * as ns from "./m"` compiles natively across ES2015–ES2025 (`41/41` match at ES2019 with 0 mismatches). `src/compiler-downlevel.cjs` additionally lowers plain-identifier logical assignment (`||=`, `&&=`, `??=` below ES2021), nullish coalescing (`id ?? rhs` below ES2020), single-step optional chaining (`id?.prop`, `id?.(args)`, `id?.[idx]` below ES2020), and exponentiation (`a ** b`, `id **= rhs` below ES2016) with comment preservation and conservative fallbacks (`Math` shadowing, `eval?.()`, ASI/parenthesized-call/delete hazards, `\u` escapes, and tagged templates). On a 300-file real-world corpus containing those operators, native lowering matched TypeScript 6.0.3 on 279/279 (`es2020`), 252/252 (`es2019`), and 185/185 (`es2015`) with `mismatch: 0`.
- **CommonJS destructuring exports, dynamic `import(expr)`, and Stage 3 standard ES decorators (`src/compiler-commonjs.cjs`, `src/compiler-stage3-decorators.cjs`).** Added native CommonJS lowering for flat object/array destructuring exports (`export const { a, b: c } = expr;`, `export const [x, , y] = arr;`), expression-argument dynamic `import(expr)`, webpack-commented `import(/* ... */ "./x")`, and Stage 3 standard ES decorators at `ESNext` (`@Dec export class C`, `@Dec export default class C`, `@Dec class C; export { C }`, and top-level class member decorators; **+4,478** real-world files on `cjs-declined-16.json`, `4,478/4,478` match, `mismatch: 0`, `outputInvalid: 0`). Added native source maps for CJS `export =`, type-erased-module runtime CJS, and `lowerOlderTarget` (numeric separators and optional `catch`). Added `src/compiler-stage3-decorators.cjs` for ES2022–ES2023 Stage 3 class decorator `__esDecorate` / `__runInitializers` lowering. Across all 53,276 files in `build/fable/wide/*.json`, native CJS reached **38,170 / 53,276** (`tsError: 0`, `outputInvalid: 0`, zero non-`.mts` mismatches).
- **`isolatedDeclarations` `.d.ts` emission (`emitDeclaration`, `src/compiler-dts.cjs`).** Exported `emitDeclaration(input, options)` from `src/compiler.cjs` and `src/compiler.mjs`, emitting `.d.ts` natively for Pulse-validated explicitly-typed top-level `export interface`, `export type`, `export const/let/var x: T = ...`, `export [async] function f<...>(params): R`, `export [const] enum`, re-exports, and used `import [type]` declarations, with automatic fallback to `ts.transpileDeclaration` for inference, classes, namespaces, reference directives, and diagnostics.
- **Reviews and verification.** Review rounds 36–43 (`gpt-6.2-sol` and `gpt-6.1-terra`) were all verified and closed with regression tests; the full compiler test suite (`node --test test/compiler*.test.mjs`) passes **1,077 / 1,077** tests.
