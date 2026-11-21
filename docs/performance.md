# Performance measurements

The generated Low★ parser consumes the original byte buffer. Node's `buffer.isUtf8` validates byte inputs using simdutf. The native path can return candidates without constructing a UTF-16 string. On fallback the AST walker uses identity offsets for ASCII input, and builds a UTF-16-to-byte table for non-ASCII input. Both changes preserve candidate edits and diagnostics.

The Babel fallback replaced Yuku in the runtime package. On a separate extraction-only run over 1,585 tracked TS/TSX files from this repository, mreact, and tachyon-dom, both versions produced identical paths and candidate spans. Three files used the native path. The median of nine warm passes was 0.64 s with Yuku and 1.23 s with Babel on macOS arm64 and Node.js 24.14.0.

The [extraction benchmark](../evidence/performance/extraction.json) compares the earlier extractor from commit `3bcf31c` and the generated parser with the revised input handling. Each implementation sees the same buffers, dialects and rules. The script checks candidate fields and paths before timing them. A warm nine-repetition run on an Apple M5 Max took a median of 98.27 ms before and 75.51 ms after on 482 Vite files. All those files used Yuku fallback. The 120-file controlled L1 TSX corpus took 0.99 ms before and 0.74 ms after. The results measure the product path, including its JavaScript processing and actual fallback. They do not compare native parser throughput against Yuku's Zig AST walker.

To reproduce, check out the baseline revision in a separate directory, install its dependencies and run its native build. Then run the command below in the current checkout, giving it both the baseline module path and the pinned Vite checkout.

```sh
npm run build:native
npm run bench:extraction -- BASELINE/src/extract.mjs /path/to/vite
npm run bench:analysis
```

The [Vitest analysis benchmark](../evidence/performance/analysis.json) compares source and Lean replay on the same eligibility fixture and candidate. Each sample starts a new CLI process. The Lean path replaces a source trial with a repeated disabled trace and a call to the compiled decision executable. This one-candidate workload mainly measures language and test-runner startup. The audit separately confirms that the predicted result matched the full rewrite.

In that run the full-scope source replay took 799 ms and the Lean path took 818 ms, with equal verdicts. The one-candidate workload saves one rewrite, and the extra disabled recording uses another runner invocation. It does not show a net replay speedup.
