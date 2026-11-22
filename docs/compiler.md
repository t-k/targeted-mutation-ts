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

The direct Node addon includes only the necessary Pulse entry points and the runtime emitter. It loads the full-module addon when a direct form declines. For supported mixed TSX or TypeScript modules, the full parser validates the input and recovers its top-level item boundaries. The native emitter lowers complete runtime declarations, and Node erases any remaining TypeScript annotations on the `pulse+node-strip` route. The `node-strip` route supports Pulse-validated ESNext modules whose JavaScript retains a static import or export, or contains only comments and whitespace. Node can also lower supported parameter properties on runtimes that provide the transform option.

The Pulse span writer proves that a successful replacement changes only the requested bytes and that invalid spans leave the buffer untouched. The extracted parser preserves its input borrow. The runtime C emitter is checked by executable differential tests. The NEON and SSE2 builds accelerate comment and string scanning when the generated scalar functions match the checked versions. The extraction check regenerates and compares both variants of the generated C and headers.

Computed enum initializers, JSX outside the supported shapes, CommonJS, downlevel targets, and source maps can still require the TypeScript emitter. Output formatting can differ across the supported backends.

```sh
FSTAR_EXE=/path/to/fstar.exe KARAMEL_EXE=/path/to/krml npm run verify:compiler
node --test test/compiler*.test.mjs
```

## Performance comparison

The workloads measure complete JavaScript emission over in-memory inputs. First-process samples include backend loading. Node startup and corpus reading are outside the timed region. The default comparison uses Oxc 0.159.0, the Yuku 0.19.0 parser and code generator, and SWC Next 0.7.0 through its native transform adapter. Yuku takes part in workloads compatible with its strip and print API.

The synthetic workload checks 256 exported threshold functions. The JSX and enum workloads each execute 256 controlled modules and check the results. The JSX fixtures exercise both the direct and grouped function forms. The real workloads time files whose output parsed as JavaScript for every measured engine. They read pinned source blobs without executing project code or loading the projects' tooling.

Medians are milliseconds from five rotating rounds on an Apple M5 Max in a rootless, offline Linux arm64 Podman container with Node 24.14.0. Host load varied between benchmark runs.

| Workload | Common files | TMT warm | Fastest reference warm | TMT first | Fastest reference first |
| --- | ---: | ---: | ---: | ---: | ---: |
| synthetic | 256 | 0.64 | 1.76 (swc-next) | 6.82 | 4.34 (swc-next) |
| jsx | 256 | 1.28 | 5.11 (swc-next) | 8.15 | 7.43 (swc-next) |
| enum | 256 | 0.93 | 3.42 (swc-next) | 6.54 | 6.48 (swc-next) |
| vite | 113 | 227.52 | 48.52 (oxc) | 893.54 | 57.94 (swc-next) |
| mreact | 315 | 598.73 | 121.78 (oxc) | 1098.95 | 133.00 (swc-next) |
| tachyon-dom | 94 | 189.35 | 39.48 (oxc) | 323.08 | 41.36 (swc-next) |
| mreact.tsx | 84 | 452.54 | 10.25 (oxc) | 972.06 | 12.69 (swc-next) |
| tachyon-dom.tsx | 32 | 193.34 | 1.93 (oxc) | 841.36 | 3.58 (swc-next) |

All generated JSX and enum fixtures used the direct Pulse route. It was 4.0× faster for JSX and 3.7× faster for enums than the fastest warm reference. SWC Next had the lowest first-process times. On the three real TypeScript workloads, 532 of 537 files avoided loading the TypeScript compiler, including Vite's two runtime `const enum` files. The native and Node erasure routes produced JavaScript in 39 of 116 tracked real TSX files, up from 27 before mixed expression support. The 5 TypeScript and 77 TSX fallbacks continue to use the TypeScript emitter.

The structural audit compared files that avoided TypeScript against the corresponding TypeScript output. It found four differences in constructor emission and two in optional-chain parentheses. All 39 real TSX outputs that avoided TypeScript had the same static dependency order and normalized JavaScript syntax tree as the TypeScript emitter. The isolated runtime tests check constructor initialization order and execute the bounded JSX and enum forms. The real-file speed suite verifies syntax and route coverage.

The small direct addon is 83 KiB on the host, down from the previous monolithic 332 KiB. In a paired arm64 check, the shared NEON scanner reduced 256 long comment and string lowering fixtures from 3.33 ms to 1.99 ms, with identical output. On 537 inputs, the native module-validation stage changed from 132.58 ms to 131.75 ms. Separate stage timings show that Node erasure took about five times as long as Pulse validation on the three bridge workloads. The remaining work for general throughput is to emit the type edits during the Pulse parse and expand the TSX emitter to more expression and component forms.

The [runtime-lowering samples and route counts](../evidence/compiler/runtime-lowering.json) include the input hashes and TSX snapshot revisions. The [earlier compiler measurements](../evidence/compiler/experiment.json) and [native SWC Next benchmark adapter](../verification/compiler-comparison/README.md) are also available.
