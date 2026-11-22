# SWC Next compiler reference

The benchmark calls the published SWC Next 0.7.0 native Rust transform with its transformation stage enabled. The Node.js package's source wrapper can parse and print source. The native adapter includes type erasure and generation in the measured call. The reference is used only by the benchmark.

Use a disposable Linux arm64 workspace with the Node headers and Rust 1.95.0. Keep the project snapshots and downloaded dependencies read-only in the measurement container. The following commands build the benchmark adapters after fetching the lockfile dependencies.

```sh
cargo build --manifest-path verification/compiler-comparison/Cargo.toml --target-dir build/swc-next-reference --locked --offline --release -j2
npm run build:compiler
cc -std=c11 -O3 -fPIC -shared -I/usr/local/include/node \
  verification/compiler-comparison/addon.c \
  build/swc-next-reference/release/libtmt_swc_next_reference.a \
  -ldl -lpthread -lm -o build/swc-next.node
```

Use `oxc-transform@0.159.0`, `yuku-parser@0.19.0`, `yuku-codegen@0.19.0` and `typescript@6.0.3` in that disposable workspace. Install with lifecycle scripts disabled. A corpus JSON file contains the repository-relative filename, a base64-encoded source string, and a module flag `mode: "module"`. Pinned Git input files for the parser benchmark already use this format.

```sh
NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=512" \
  NODE_DISABLE_COMPILE_CACHE=1 NODE_NO_WARNINGS=1 \
  node scripts/bench-compiler.mjs synthetic jsx enum \
  /inputs/vite.json /inputs/mreact.json /inputs/tachyon-dom.json \
  /inputs/mreact.tsx.json /inputs/tachyon-dom.tsx.json
```

The benchmark prints which inputs produced valid JavaScript on each route, exact checks for the synthetic fixtures, and warm and first-process samples. A common-input timing excludes a file if one engine produces no valid JavaScript. The coverage counts record every measured input before this restriction.

The `jsx` and `enum` workloads execute the generated fixtures against independent expected results. Files named `*.tsx.json` select a real TSX workload. These comparisons omit Yuku because the parser and code generator used here do not provide the corresponding JSX and enum lowering API. The benchmark never evaluates code from the real corpus or loads its configuration.
