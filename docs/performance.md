# Performance measurements

## First extraction and focused analysis planning

The CLI loads only the selected command, and native-only extraction leaves the TypeScript compatibility parser and grammar unloaded. Low★ handles right-associative exponentiation, common static import attributes and more regular expressions with named captures. Across the five pinned TS/TSX corpora, Low★ covered 2,490 of 2,968 candidates, up from 2,424. Both logical-rule settings matched the Yuku reference on source acceptance and every ordered candidate field. A further 3,303 captured inputs passed the same checks.

| Workload | Previous Low★ candidates | Current Low★ candidates | Low★ files |
| --- | ---: | ---: | ---: |
| Vite | 194 / 201 | 196 / 201 | 470 / 482 |
| mreact | 1,452 / 1,550 | 1,510 / 1,550 | 1,166 / 1,193 |
| tachyon-dom | 604 / 654 | 610 / 654 | 364 / 373 |

First extraction measures the initial module load and parsing in a fresh process for every sample. Source buffers are already in memory. Nine samples alternate baseline and current versions per checkout on an Apple M5 Max with Node 24.14.0. Each experiment has its own paired baseline. The host was running other workloads, and absolute times vary between experiments.

| Workload | First extraction, previous → current | First extraction with local cache, previous → current | Warm extraction, previous → current |
| --- | ---: | ---: | ---: |
| Vite | 210.45 → 204.39 ms | 203.25 → 116.40 ms | 30.50 → 28.44 ms |
| mreact | 438.00 → 358.89 ms | 503.36 → 277.47 ms | 189.02 → 144.06 ms |
| tachyon-dom | 251.71 → 240.03 ms | 504.41 → 274.52 ms | 61.07 → 54.99 ms |

| Workload | Former Yuku → current, first extraction | Former Yuku → current, first extraction with local cache |
| --- | ---: | ---: |
| Vite | 133.99 → 228.14 ms | 113.34 → 143.03 ms |
| mreact | 357.20 → 520.27 ms | 292.37 → 290.45 ms |
| tachyon-dom | 117.92 → 197.98 ms | 217.71 → 260.07 ms |

The local checkout can opt into the Node module compile cache with `npm run build:typescript-cache` on Node 24.12 or later. It still reads and parses the supplied sources on every extraction. The runtime archive uses the normal Node compiler load. Node 26.12 selects different cache directories for portable and portable read-only activation. See the [Node implementation](https://github.com/nodejs/node/blob/v26.12.0/src/compile_cache.cc#L43-L59).

Focused analysis now indexes trace observations by site and reuses observed test identities and threshold metadata. With 200 comparison sites and 2,000 observations, generating the complete trial plan dropped from 357.70 to 40.64 ms over nine alternating samples. The full trial records matched. This measurement excludes running the tests.

The [recorded samples and corpus details](../evidence/m1/cold-start.json) use `4fb291a` and the former Yuku runtime `8592705` as baselines. Reproduce first-process measurements with `node scripts/bench-first-extraction.mjs BASELINE/src/extract.mjs GIT_CHECKOUT...`. Set `NODE_DISABLE_COMPILE_CACHE=1` for the unprepared experiment. Warm measurements use `--expose-gc scripts/bench-extraction.mjs` with both native addons built using `--pgo`.

## Extraction compared with the former Yuku runtime

At `69a4a22`, repeated extraction on an Apple M5 Max with Node 24.14.0 is faster than the former Yuku runtime `8592705` on all three measured projects. Each of the nine alternating samples parses every file anew from an in-memory buffer. Source results are never cached. The current binary uses Clang LTO and profile data trained on 19 repository fixtures. The measured corpora are outside that training set.

| Workload | Former Yuku | Current | Reduction |
| --- | ---: | ---: | ---: |
| Vite | 23.81 ms | 16.43 ms | 31.0% |
| mreact | 85.37 ms | 79.80 ms | 6.5% |
| tachyon-dom | 40.10 ms | 26.56 ms | 33.8% |

The first extraction in a fresh Node process includes importing the extractor and loading the compatibility parser when a file requires it. The corresponding Yuku and current medians are 47.19 and 106.25 ms for Vite, 133.10 and 203.92 ms for mreact, and 70.03 and 123.70 ms for tachyon-dom. These timings begin with source buffers in memory and exclude test execution.

Low★ accepted 4,117 of the 8,549 files from the five pinned checkouts and extracted 2,424 of 2,968 comparison candidates. Both logical-rule settings agreed with Yuku on source acceptance, candidate order and every candidate field. An additional 3,303 captured inputs passed the same comparison. The compatibility parser produces its own diagnostic text and recovery. Type, expression and candidate checks share an AST traversal in the compatibility path.

| Workload | Low★ candidates | Total candidates | Low★ files |
| --- | ---: | ---: | ---: |
| Vite | 194 | 201 | 468 / 482 |
| mreact | 1,452 | 1,550 | 1,159 / 1,193 |
| tachyon-dom | 604 | 654 | 363 / 373 |

The compiled Lean checker also evaluates boundary-flip replay summaries through `maySkipBoundary`. Lean proves that the summary gives the same decision as evaluating all observations in the original model. Over 64 requests containing 262,144 safe integer pairs, the JSON payload decreased from 2,630,957 to 11,971 bytes and the median decision time fell from 61.47 to 19.14 ms. The CLI still requires complete, stable observations under the replay contract. This measurement covers replay decisions separately from extraction.

The [audit data and paired samples](../evidence/m1/yuku-runtime-parity.json) include exact checkout revisions. The warm measurement uses `node --expose-gc scripts/bench-extraction.mjs BASELINE_MODULE GIT_CHECKOUT` after `npm run build:native -- --pgo`. The [native profile integration test](../test/native-profile.integration.mjs) includes regular builds on systems without a matching Clang and `llvm-profdata`.

## Production extraction without Yuku or Oxc

The installed runtime uses Low★ first and uses its existing TypeScript dependency for declined files. Yuku is the development reference. Across 8,549 tracked TS/TSX files in the five pinned checkouts, both settings of the JSX logical rule produced the same source acceptance and ordered candidate fields as the reference. Low★ extracted 2,163 of 2,968 candidates across 3,786 valid files and reported five duplicate-declaration diagnostics. The compatibility parser retains source byte ranges and can use different diagnostic wording and recovery.

| Checkout | All candidates | Low★ | TypeScript compatibility |
| --- | ---: | ---: | ---: |
| Vite | 201 | 159 | 42 |
| Preact | 1 | 0 | 1 |
| TypeScript corpus | 562 | 115 | 447 |
| mreact | 1,550 | 1,339 | 211 |
| tachyon-dom | 654 | 550 | 104 |

The 37 JavaScript implementation files under Preact's root and package `src/` directories produced 43 identical candidates in both logical modes, with 12 from Low★. A separate audit of 3,303 captured inputs also found agreement on all source acceptance decisions and ordered candidate fields.

| Warm extraction workload | Yuku runtime `8592705` | TypeScript cutover `5c60b31` | After reducing AST traversal |
| --- | ---: | ---: | ---: |
| Vite | 24.51 ms | 150.58 ms | 143.40 ms |
| mreact | 87.63 ms | 419.52 ms | 408.53 ms |
| tachyon-dom | 40.72 ms | 214.89 ms | 204.64 ms |

Each experiment alternates nine warm samples on an Apple M5 Max with Node 24.14.0 and measures extraction from in-memory buffers. The traversal experiment uses the TypeScript cutover as its paired baseline and reduces the three medians by 3.4%, 1.8%, and 1.7%. The current compatibility path still costs more than the former Yuku path on these workloads. The [audit and timing evidence](../evidence/m1/typescript-runtime-cutover.json) includes the paired samples and exact checkout revisions.

## Low★ arrow parameter expressions

At `2a8a993`, Low★ extracts 1,964 of 2,968 candidates across 3,490 of 8,549 files, including 1,200 in mreact and 498 in tachyon-dom. The ordinary and logical audits match all candidate fields and ordered diagnostics. Five diagnostic files also complete in Low★.

| Warm extraction workload | Previous C-only build `4be72f5` | Expanded arrow defaults |
| --- | ---: | ---: |
| Vite | 25.16 ms | 24.71 ms |
| mreact | 105.21 ms | 98.29 ms |
| tachyon-dom | 54.31 ms | 45.59 ms |

These are nine alternating warm samples over identical buffers. The [audit and samples](../evidence/m1/low-arrow-default-expressions.json) record fallback counts and fixed revisions.

## Low★ callable and mapped type coverage

At `a9c789c`, Low★ extracts 1,843 of 2,968 candidates across 3,472 of 8,549 files. Overloads, object accessors, generic function and constructor types, and mapped types moved 205 candidates to Low★ since `89f96fd`. The complete ordered candidate records and diagnostics match Yuku across the five pinned checkouts in both JSX logical modes.

| Checkout | All candidates | Low★ | Yuku fallback |
| --- | ---: | ---: | ---: |
| Vite | 201 | 159 | 42 |
| Preact | 1 | 0 | 1 |
| TypeScript corpus | 562 | 107 | 455 |
| mreact | 1,550 | 1,191 | 359 |
| tachyon-dom | 654 | 386 | 268 |

| Warm extraction workload | Oxc-linked baseline `b42c79a` | Low★ and Yuku `a9c789c` |
| --- | ---: | ---: |
| Vite | 17.71 ms | 25.34 ms |
| mreact | 83.83 ms | 109.38 ms |
| tachyon-dom | 35.48 ms | 58.38 ms |

Each pair uses nine alternating warm runs over the same input buffers on an Apple M5 Max with Node 24.14.0. The C-only addon still takes longer on all three workloads. The [measurements](../evidence/m1/low-type-coverage.json) include corpus revisions and samples.

## Low★ coverage after Oxc removal

At `89f96fd`, the Low★ parser extracts 1,638 of 2,968 candidates across 3,271 of 8,549 files in the same five checkouts. The first C-only build extracted 1,212. The complete ordered candidate records and diagnostics match Yuku with the JSX logical rule enabled and disabled.

| Checkout | Low★ at Oxc removal | Low★ after grammar expansion | Yuku fallback |
| --- | ---: | ---: | ---: |
| Vite | 99 | 128 | 73 |
| Preact | 0 | 0 | 1 |
| TypeScript corpus | 56 | 107 | 455 |
| mreact | 883 | 1,062 | 488 |
| tachyon-dom | 174 | 341 | 313 |

Packed candidate transfer reduced time by 2.7–2.9× in synthetic inputs with 16, 512 or 4,096 sites per file. In the three complete repository workloads, the medians stayed within roughly 2.2% of the unoptimized transfer. Those workloads still spend a substantial share of extraction time in the parser and compatibility route.

| Warm extraction workload | Earlier Oxc build | Expanded Low★ with Yuku fallback |
| --- | ---: | ---: |
| Vite | 19.21 ms | 29.52 ms |
| mreact | 84.19 ms | 123.00 ms |
| tachyon-dom | 33.14 ms | 66.57 ms |

These are extraction timings over identical pinned source inputs, from nine alternating samples. The analyzer's test execution is outside these measurements. See the [audit, benchmark samples and verification](../evidence/m1/low-workload-after-oxc.json).


## Native runtime without Oxc

At `5078acc`, the default build and packaged addon use the generated C parser without Rust or Cargo. Low★ accepts 2,946 of 8,549 tracked TS/TSX files in the pinned corpora. Complete candidate records and diagnostics match Yuku with the JSX logical rule enabled and disabled.

| Checkout | Candidates | Low★ | Yuku fallback |
| --- | ---: | ---: | ---: |
| Vite | 201 | 99 | 102 |
| Preact | 1 | 0 | 1 |
| TypeScript corpus | 562 | 56 | 506 |
| mreact | 1,550 | 883 | 667 |
| tachyon-dom | 654 | 174 | 480 |

The macOS ARM64 addon shrank from 2,113,064 to 170,344 bytes. Routing every Low★ refusal to Yuku increased warm extraction time in the three measured workloads. The median uses nine alternating samples over the same inputs and includes parsing and candidate conversion.

| Workload | Oxc build | C-only build with Yuku fallback |
| --- | ---: | ---: |
| Vite | 19.42 ms | 34.74 ms |
| mreact | 83.11 ms | 165.83 ms |
| tachyon-dom | 35.43 ms | 86.19 ms |

The standalone `--low-only` build also runs without Yuku for files within the Low★ grammar. At that revision, the standard build used Yuku for the other files. See the [corpus audits and samples](../evidence/m1/oxc-removal.json).

## macOS link-time optimization and symbol visibility

On an Apple M5 Max with Node 24.14.0, full LTO and hidden visibility shortened the median standard extraction time from 31.34 to 26.30ms for Vite and from 171.33 to 137.94ms for mreact. This experiment used the same source and Oxc-linked addon before removal. The native API and candidate results matched across builds. The build probes whether the selected compiler can link a bundle with LTO and keeps hidden visibility if LTO is unavailable. See the [nine-sample measurements](../evidence/m1/oxc-removal.json).

## Earlier Oxc-linked measurements

The rest of this page records the extraction routes in earlier revisions with Oxc in the addon.

## Low★ classes, binding scopes, and tagged templates

Against `91b9af3`, Low★ accepted 2,893 of 8,549 tracked TS/TSX files, up from 2,401. It extracted 1,090 of 2,968 comparison candidates, up from 1,020. The byte spans, candidate order and diagnostics matched Yuku in both settings of the JSX logical rule.

| Checkout | Previous Low★ candidates | Current Low★ candidates | Oxc candidates | Yuku candidates |
| --- | ---: | ---: | ---: | ---: |
| Vite | 85 | 88 | 113 | 0 |
| Preact | 0 | 0 | 1 | 0 |
| TypeScript corpus | 47 | 56 | 496 | 10 |
| mreact | 720 | 776 | 710 | 64 |
| tachyon-dom | 168 | 170 | 480 | 4 |

In Vite's 118-file production scope, Low★ accepted 67 files and produced 55 of 160 candidates. The wider name table added Vite's `node/server/middlewares/indexHtml.ts` and mreact's `emit-server.ts` and `emit-server-stream.ts`. Module type/value namespaces and local type and variable declarations moved seven candidates off Yuku. A standalone build reproduced all 1,090 fast-path candidates in 335 files without Cargo, Oxc or npm dependencies. [Corpus and verification data](../evidence/m1/low-scope-expansion.json)

## Linux link-time optimization and symbol visibility

On Linux ARM64, GCC 12.2 and Node 24.21.0, a single-core benchmark compared builds from the same native source with identical candidate records. Each value is the median of nine warm measurements over the same Vite buffers. Both Node-API registration symbols remained visible.

| Workload | Baseline | Hidden visibility plus LTO |
| --- | ---: | ---: |
| Vite, Low★ native call | 26.88 ms | 11.03 ms |
| Vite production, Low★ native call | 9.41 ms | 3.80 ms |
| Vite, native routes including Oxc | 34.91 ms | 23.31 ms |
| Vite production, native routes including Oxc | 19.98 ms | 15.46 ms |

The build retains hidden visibility if the selected Linux compiler cannot link a shared library with LTO. The native-route timings include the Node-API calls but exclude the JavaScript Yuku fallback and test execution. [Compiler experiment data](../evidence/m1/low-scope-expansion.json)

## Low★ binding, module, and statement coverage

Against `3589d6e`, the AST-free route grew from 1,934 to 2,401 of 8,549 tracked TS/TSX files and from 808 to 1,020 of 2,968 comparison candidates. Both logical-rule settings matched Yuku on the complete diagnostics and ordered candidate records, including exact byte spans.

| Checkout | Baseline Low★ files | Current Low★ files | Baseline Low★ candidates | Current Low★ candidates |
| --- | ---: | ---: | ---: | ---: |
| Vite | 300 | 382 | 45 | 85 |
| Preact | 5 | 5 | 0 | 0 |
| TypeScript corpus | 767 | 866 | 47 | 47 |
| mreact | 704 | 931 | 591 | 720 |
| tachyon-dom | 158 | 217 | 125 | 168 |

In Vite's 118-file production scope, Low★ accepted 64 files and extracted 52 of 160 candidates, up from 53 files and 24 candidates. The newly covered sources include the five comparisons in `packages/vite/src/node/plugins/manifest.ts` and eleven in `packages/vite/src/node/plugins/importMetaGlob.ts`. The standard addon still routes 1,863 candidates through Oxc and 85 through Yuku. The Yuku total includes 67 mreact candidates, four tachyon-dom candidates, and fourteen TypeScript fixture candidates.

A standalone build with only the generated C and Node-API adapter reproduced all 1,020 candidates across 312 files. The build omitted Cargo, Oxc sources, and npm dependencies.

| Warm extraction workload | Baseline median | Current median |
| --- | ---: | ---: |
| Vite | 188.32 ms | 145.65 ms |
| Vite production source | 64.20 ms | 62.92 ms |
| mreact | 525.89 ms | 436.98 ms |
| tachyon-dom | 155.05 ms | 129.39 ms |

The benchmark alternated the two builds over the same source buffers for nine warm samples on an Apple M5 Max. The interquartile ranges overlap for Vite production source, mreact, and tachyon-dom. The measurements cover extraction with the standard runtime, including its fallback paths. The [audit and benchmark data](../evidence/m1/low-frontier-expansion.json) include exact standalone candidate records, corpus revisions, and all samples.

## Low★ exceptions, function forms, and regular expressions

Against `acc4149`, the AST-free route increased from 1,139 to 1,934 of 8,549 tracked TS/TSX files and from 196 to 808 of 2,968 comparison candidates. Both logical-rule settings matched Yuku on complete ordered candidate records and diagnostics.

| Checkout | Baseline Low★ files | Current Low★ files | Baseline Low★ candidates | Current Low★ candidates |
| --- | ---: | ---: | ---: | ---: |
| Vite | 145 | 300 | 11 | 45 |
| Preact | 4 | 5 | 0 | 0 |
| TypeScript compiler fixtures | 586 | 767 | 41 | 47 |
| mreact | 322 | 704 | 105 | 591 |
| tachyon-dom | 82 | 158 | 39 | 125 |

In the 118-file Vite production scope, Low★ accepted 53 files and emitted 24 of 160 candidates, up from eight files and two candidates. These include all eight comparisons in `packages/vite/src/node/plugins/reporter.ts` and all five in `packages/vite/src/node/server/transformRequest.ts`. A clean standalone build reproduced all 808 candidates in 243 files without the Oxc source tree, Cargo, or npm dependencies. The original 85 Yuku candidates still use Yuku, including 67 in mreact and four in tachyon-dom.

| Warm extraction workload | Baseline median | Current median |
| --- | ---: | ---: |
| Vite | 76.39 ms | 64.66 ms |
| Vite production source | 32.08 ms | 29.42 ms |
| mreact | 425.70 ms | 447.30 ms |
| mreact repeat | 381.46 ms | 337.90 ms |
| tachyon-dom | 96.72 ms | 90.26 ms |

Each measurement uses nine alternating samples on the same source buffers. The first mreact run has overlapping interquartile ranges, and the repeat favored the current parser. The [audit and benchmark data](../evidence/m1/low-statements-and-regex.json) include the samples and standalone candidate spans.

## Low★ control, TSX, and type syntax expansion

Against `3612949`, the AST-free route increased from 554 to 1,139 of 8,549 tracked TS/TSX files and from 40 to 196 of 2,968 comparison candidates. Both logical-rule settings agreed with Yuku on ordered candidates, all byte spans, and complete diagnostic output.

| Checkout | Baseline Low★ files | Current Low★ files | Baseline Low★ candidates | Current Low★ candidates |
| --- | ---: | ---: | ---: | ---: |
| Vite | 70 | 145 | 6 | 11 |
| Preact | 1 | 4 | 0 | 0 |
| TypeScript compiler fixtures | 339 | 586 | 12 | 41 |
| mreact | 122 | 322 | 17 | 105 |
| tachyon-dom | 22 | 82 | 5 | 39 |

The newly covered files include Vite's `client/env.ts` and `node/plugins/pluginFilter.ts` under `packages/vite/src/`, mreact's `packages/router/src/navigation-marker.ts` with 28 candidates, and tachyon-dom's `src/html-raw-text.ts` with five. Low★ extracted two of the 160 candidates in the Vite production-source scope. A clean standalone build reproduced all 196 candidates in 77 files without Cargo, Oxc sources, or npm dependencies. The compiler fixture `circularOptionalityRemoval.ts` moved one candidate from Yuku to Low★. The ordinary build routes 67 mreact candidates, four tachyon-dom candidates, and fourteen TypeScript compiler fixture candidates through Yuku.

| Warm extraction workload | Baseline median | Current median |
| --- | ---: | ---: |
| Vite | 54.91 ms | 50.31 ms |
| Vite production source | 24.28 ms | 23.43 ms |
| mreact | 304.80 ms | 287.67 ms |
| tachyon-dom | 79.42 ms | 76.47 ms |

Nine alternating samples used the same source buffers on an Apple M5 Max with Node.js 24.14.0. These measurements cover extraction. The paired samples and standalone candidate spans are in the [audit and benchmark data](../evidence/m1/low-extended-grammar.json).

## Typed modules, callbacks, and collection loops in Low★

The Low★ path accepts 554 of 8,549 tracked TS/TSX files and extracts 40 of 2,968 candidates. At baseline `54649cb` it accepted 321 files and extracted 16 candidates. Both settings of the JSX logical rule matched Yuku on every ordered candidate field and the full diagnostic output.

| Checkout | Baseline Low★ files | Current Low★ files | Baseline Low★ candidates | Current Low★ candidates |
| --- | ---: | ---: | ---: | ---: |
| Vite | 57 | 70 | 2 | 6 |
| Preact | 1 | 1 | 0 | 0 |
| TypeScript compiler fixtures | 232 | 339 | 3 | 12 |
| mreact | 27 | 122 | 8 | 17 |
| tachyon-dom | 4 | 22 | 3 | 5 |

A clean standalone build extracted all 40 candidates in 25 files without Cargo, Oxc sources, or npm dependencies. The transferred candidates previously used Oxc. The ordinary build still uses Yuku for 67 mreact candidates and four tachyon-dom candidates. Among Vite production sources under `packages/vite/src/`, Low★ accepted three files with zero comparison candidates, and Oxc handled the remaining 115 files and all 160 candidates.

| Warm extraction workload | Baseline median | Current median |
| --- | ---: | ---: |
| Vite | 34.67 ms | 34.65 ms |
| Vite production source | 15.66 ms | 16.27 ms |
| mreact | 270.43 ms | 273.68 ms |
| tachyon-dom | 49.79 ms | 50.47 ms |

The benchmark alternates nine runs on the same input buffers. These medians range from approximately flat to 3.9% slower. The [audit and benchmark data](../evidence/m1/low-typed-expansion.json) record revisions, every standalone candidate span, and all timing samples.

## Expanded Low★ expression and module grammar

The expanded Low★ path handled 321 of 8,549 tracked TS/TSX files, up from 81 at `ca1bc93`. It produced 16 candidates, up from four. All candidate fields and diagnostics in the five checkouts matched Yuku with the JSX logical rule disabled and enabled.

| Checkout | Previous Low★ files | Current Low★ files | Previous Low★ candidates | Current Low★ candidates |
| --- | ---: | ---: | ---: | ---: |
| Vite | 9 | 57 | 0 | 2 |
| Preact | 0 | 1 | 0 | 0 |
| TypeScript compiler fixtures | 70 | 232 | 3 | 3 |
| mreact | 2 | 27 | 1 | 8 |
| tachyon-dom | 0 | 4 | 0 | 3 |

A clean `--low-only` build extracted all 16 candidates across ten files without Cargo, Oxc sources, or npm dependencies. The Vite candidates came from HMR playground modules, and the tachyon-dom candidates came from `tests/whitespace-policy-types.ts`. The normal build still uses Yuku for 67 mreact candidates and four tachyon-dom candidates.

Nine alternating warm samples against `ca1bc93` measured median extraction times of 33.74 to 32.86 ms on Vite, 189.49 to 188.28 ms on mreact, and 49.68 to 49.74 ms on tachyon-dom. The mreact and tachyon-dom interquartile ranges overlap.

The [audit and benchmark data](../evidence/m1/low-expression-expansion.json) include the exact revisions, operand spans, and timing samples.

## Standalone Low★ extraction

The [standalone extraction run](../evidence/m1/standalone-low-extraction.json) adds typed modules, generic type references, and method calls to the Low★ path. A clean build without npm dependencies, Cargo or Oxc sources extracted the comparison in mreact's `packages/router/src/navigation-history-cache.ts` directly from bytes. The macOS arm64 standalone addon was 86,776 bytes.

The expanded Low★ path extracted one mreact candidate and three TypeScript compiler fixture candidates. The ordinary build still sends 67 mreact candidates and four tachyon-dom candidates through Yuku. Across 8,549 files, all comparison and diagnostic results agreed with Yuku in both logical-rule settings. Warm medians against `d7e6384` were 193.99 ms and 196.86 ms on mreact, and 55.61 ms and 54.98 ms on tachyon-dom, with overlapping interquartile ranges for each checkout.

## Native TS and TSX module extraction

The addon tries the AST-free Low★ grammar first. Oxc handles broader module syntax with a native AST and returns only candidates to JavaScript. The extraction audit compares ordered candidate records and full diagnostics with Yuku 0.19.0, with the JSX logical rule both disabled and enabled.

| Checkout and scope | Files extracted without Yuku | Candidates extracted without Yuku | Previous median | Current median |
| --- | ---: | ---: | ---: | ---: |
| Vite production source | 118 / 118 | 160 / 160 | 38.58 ms | 14.60 ms |
| Vite tracked TS/TSX | 481 / 482 | 201 / 201 | | |
| Preact tracked TS/TSX | 22 / 22 | 1 / 1 | | |
| TypeScript compiler fixtures | 4,680 / 6,479 | 547 / 562 | | |
| mreact tracked TS/TSX | 1,185 / 1,193 | 1,483 / 1,550 | 336.82 ms | 177.36 ms |
| tachyon-dom tracked TS/TSX | 372 / 373 | 650 / 654 | 125.95 ms | 51.56 ms |

Each timing is the median of nine alternating warm samples on an Apple M5 Max, using commit `9a9d333` as the baseline. The samples measure extraction of the same in-memory buffers and exclude test execution. A separate fresh process parsed the Vite production files while a Node load hook rejected any attempt to resolve Yuku.

The Vite-wide run used Yuku on one file to obtain its diagnostic. The compiler test checkout contains 952 diagnosed files, including nine invalid UTF-8 files rejected before parsing. Resource refusals, compatibility guards, and syntax revisions that Oxc declines also use Yuku. The macOS arm64 addon grew from 71,528 to 2,011,272 bytes with the statically linked parser.

The [recorded runs](../evidence/m1/broad-native-extraction.json) include revisions, scope, route counts, and all timing samples. To reproduce, build the native addon at `9a9d333` in a separate checkout and run the audit and benchmark against the pinned sources.

```sh
npm run audit:extraction -- --logical /path/to/vite /path/to/preact /path/to/typescript /path/to/mreact /path/to/tachyon-dom
npm run audit:extraction -- --prefix packages/vite/src/ --source-only /path/to/vite
node --expose-gc scripts/bench-extraction.mjs --prefix packages/vite/src/ --source-only BASELINE/src/extract.mjs /path/to/vite
```

## Earlier measurements

The generated Low★ parser consumes the original byte buffer. Node's `buffer.isUtf8` validates byte inputs using simdutf. The native path can return candidates without constructing a UTF-16 string. On fallback the AST walker uses identity offsets for ASCII input, and builds a UTF-16-to-byte table for non-ASCII input. Both changes preserve candidate edits and diagnostics.

That version of the runtime used Yuku as its syntax fallback. An extraction-only run over 1,585 tracked TS/TSX files from this repository, mreact, and tachyon-dom produced identical paths and candidate spans with Yuku and Babel. Three files used the native path. The median of nine alternating warm passes was 0.46 s with Yuku 0.19.0 and 0.86 s with Babel 7.29.15 on macOS arm64 and Node.js 24.14.0.

Against commit `8e81bed` on those 1,585 files, the token precheck and single-pass location scan reduced median extraction time from 466 ms to 432 ms and candidate collection from 601 ms to 534 ms. All 2,211 candidate records, diagnostics and report positions matched. A generated file with 4,096 candidates went from 353 ms to 17 ms for collection. These measurements exclude test execution. The [recorded runs](../evidence/performance/candidate-pipeline.json) include all nine samples for each version.

The shipping fixture used four Vitest invocations with deterministic literal-threshold replay, down from five. Both versions reported the same mutation verdicts, and audit reexecution agreed with the new prediction.

On the pinned Vite checkout, the validated token path extracted five candidates from four production files. Nine alternating warm samples on macOS arm64 reduced the median for those four files from 0.353 ms to 0.121 ms against `a4ecee8`. Across all 118 production files in the same scope, the medians were 40.0 ms and 38.3 ms with overlapping interquartile ranges. The [recorded extraction runs](../evidence/m1/control-extraction.json) include the scope, paths, and samples.

```sh
npm run audit:extraction -- /path/to/vite /path/to/preact /path/to/typescript
npm run audit:extraction -- --prefix packages/vite/src/ --source-only /path/to/vite
node --expose-gc scripts/bench-extraction.mjs --prefix packages/vite/src/ --source-only --token-subset BASELINE/src/extract.mjs /path/to/vite
```

For `--since` selection over 1,000 tracked TypeScript files with one edited line, five alternating runs measured a median of 11.49 s before batched path lookup and 54 ms afterward. Both versions selected the same file and line. The measured path includes Git processes and source selection through `selectScope`.

Two historical changes exercised witness discovery in mreact and tachyon-dom. Both selected suites passed. The changed lines contained one and two comparison candidates respectively, all extracted by Yuku. Neither change matched an automatic witness source rule, so there were no proposals to assess for adoption. A positive control from this repository produced a confirmed one-literal edit. The [recorded study](../evidence/dogfood/pr-witnesses.json) includes source and test scopes, revisions, and counts.

The [extraction benchmark](../evidence/performance/extraction.json) compares the earlier extractor from commit `3bcf31c` and the generated parser with the revised input handling. Each implementation sees the same buffers, dialects and rules. The script checks candidate fields and paths before timing them. A warm nine-repetition run on an Apple M5 Max took a median of 98.27 ms before and 75.51 ms after on 482 Vite files. All those files used Yuku fallback. The 120-file controlled L1 TSX corpus took 0.99 ms before and 0.74 ms after. The results measure the product path, including its JavaScript processing and actual fallback. They do not compare native parser throughput against Yuku's Zig AST walker.

To reproduce, check out the baseline revision in a separate directory, install its dependencies and run its native build. Then run the command below in the current checkout, giving it both the baseline module path and the pinned Vite checkout.

```sh
npm run build:native
npm run bench:extraction -- BASELINE/src/extract.mjs /path/to/vite
npm run bench:analysis
```

The [Vitest analysis benchmark](../evidence/performance/analysis.json) compares source and Lean replay on the same eligibility fixture and candidate. Each sample starts a new CLI process. The Lean path replaces a source trial with a repeated disabled trace and a call to the compiled decision executable. This one-candidate workload mainly measures language and test-runner startup. The audit separately confirms that the predicted result matched the full rewrite.

In that run the full-scope source replay took 799 ms and the Lean path took 818 ms, with equal verdicts. The one-candidate workload saves one rewrite, and the extra disabled recording uses another runner invocation. It does not show a net replay speedup.
