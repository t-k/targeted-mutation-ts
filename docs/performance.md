# Performance measurements

The generated Low★ parser consumes the original byte buffer. Node's `buffer.isUtf8` validates byte inputs using simdutf. The native path can return candidates without constructing a UTF-16 string. On fallback the AST walker uses identity offsets for ASCII input, and builds a UTF-16-to-byte table for non-ASCII input. Both changes preserve candidate edits and diagnostics.

The runtime package uses Yuku as its syntax fallback. An extraction-only run over 1,585 tracked TS/TSX files from this repository, mreact, and tachyon-dom produced identical paths and candidate spans with Yuku and Babel. Three files used the native path. The median of nine alternating warm passes was 0.46 s with Yuku 0.19.0 and 0.86 s with Babel 7.29.15 on macOS arm64 and Node.js 24.14.0.

Against commit `8e81bed` on those 1,585 files, the token precheck and single-pass location scan reduced median extraction time from 466 ms to 432 ms and candidate collection from 601 ms to 534 ms. All 2,211 candidate records, diagnostics and report positions matched. A generated file with 4,096 candidates went from 353 ms to 17 ms for collection. These measurements exclude test execution. The [recorded runs](../evidence/performance/candidate-pipeline.json) include all nine samples for each version.

The shipping fixture used four Vitest invocations with deterministic literal-threshold replay, down from five. Both versions reported the same mutation verdicts, and audit reexecution agreed with the new prediction.

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
