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

CommonJS callers can load the same implementation from `src/compiler.cjs`. Strip mode implements the position-preserving contract for TypeScript files without JSX. It rejects syntax that needs runtime lowering and the compiler reports a diagnostic. Transform mode supports those constructs through isolated TypeScript emission.

## Native path and proof

For ESNext TypeScript, Pulse recognizes bounded forms of exported constants, single-parameter arrows with primitive annotations, and complete type-only modules. The arrow and constant path records up to three ranges. The C adapter checks their order and bounds, copies the source once, and invokes the verified span writer. The type-only path reuses the existing Pulse TypeScript declaration and import recognizers, requires a module marker and a complete parse, and emits an empty module. Files with comment markers in this path use the compatibility emitter to retain comments it would otherwise emit.

The Pulse span writer proves that a successful replacement changes only bytes in the requested span to spaces and that invalid spans leave the buffer untouched. The parser functions preserve the input borrow. TypeScript grammar and diagnostic agreement are tested with independent implementations and real sources. The native and compatibility emitters can format valid JavaScript differently. Other requested transformations and syntax outside the native subset select TypeScript lazily.

```sh
FSTAR_EXE=/path/to/fstar.exe KARAMEL_EXE=/path/to/krml npm run verify:compiler
node --test test/compiler.test.mjs test/compiler-native.test.mjs
```

## Performance comparison

The synthetic workload emits 256 modules with a typed arrow and a distinct threshold. Every output must parse as JavaScript and contain the expected exported function. The Pulse output also matches Node's position-preserving output byte for byte. The real workloads select TypeScript module implementation files from pinned Git snapshots. Each engine independently validates its output as JavaScript, then timing uses the common accepted files. The coverage counts include inputs that any engine rejected. External project output is parsed and never evaluated.

The benchmark measures selected in-memory inputs through complete JavaScript output. First-process samples include backend loading and exclude Node startup and corpus reading. The benchmark uses the CommonJS library entry for TMT and a direct Node adapter to SWC Next's native Rust transformer. It measures Oxc's transformer, Yuku's parser and code generator, and Node's position-preserving stripper on the synthetic workload. The source snapshots and third-party packages ran offline in a memory-bounded, rootless Linux arm64 Podman container.

All values are medians in milliseconds from five rotating rounds on an Apple M5 Max using Linux arm64. Host load varied, and the final run overlapped the worktree's Node suite.

| Workload | Common files | TMT warm | Fastest reference warm | TMT first | Fastest reference first |
| --- | ---: | ---: | ---: | ---: | ---: |
| synthetic | 256 | 0.31 | 1.70 (swc-next) | 5.01 | 3.68 (swc-next) |
| vite | 113 | 2,462.17 | 45.34 (oxc) | 4,438.54 | 71.99 (swc-next) |
| mreact | 315 | 7,126.92 | 275.53 (oxc) | 9,713.83 | 431.83 (swc-next) |
| tachyon-dom | 94 | 1,717.71 | 62.18 (oxc) | 3,660.76 | 69.59 (swc-next) |

The native path emitted all 256 synthetic inputs. On the three main real workloads it emitted 1 of 122 Vite files, 3 of 321 mreact files and 0 of 94 tachyon-dom files. The six-project native output audit covered 1,817 TypeScript module files, with all 28 accepted native outputs exactly matching TypeScript's bytes. The [raw samples and coverage](../evidence/compiler/experiment.json) include both compiler iterations and the paired [SWC Next native adapter](../verification/compiler-comparison/README.md).

The existing comparison-candidate extractor remains a separate workload. It emits a small list of edits. The general compiler's performance depends on expanding the native path to type erasure and lowering inside mixed modules, where TypeScript still accounts for most of the measured time.
