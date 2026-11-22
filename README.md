# Targeted Mutation Testing for TypeScript

Targeted Mutation Testing watches the inputs exercised by tests and proposes a concrete wrong implementation and a test that would catch it.

## Shipping threshold experiment

Use Node.js 24.11 or later and run `npm ci`, then `npm test` or `npm run evidence:m0`. The experiment runs Vitest against original, instrumented, and actually rewritten source in temporary project copies. It also reproduces the comparison with StrykerJS 10.1.1 and Vitest 4.0.18.

```sh
node bin/tmt.mjs prototype fixtures/shipping src/shipping.ts --spec spec.json
npm run evidence:m0
```

The [recorded runs](evidence/m0) used Node.js 24.14.0 on macOS arm64. Both StrykerJS reports contain five killed mutants. In both reports the generated replacements are `true`, `false`, `yen > 5000`, `yen < 5000`, and `() => undefined`. TMT observed orders of ¥4,800 and ¥5,000. The existing tests passed against the original and the nearest alternative, `yen >= 4999`. The added ¥4,999 case passed against the original and failed against the alternative. Within the stated whole-yen domain it detects every feasible alternative threshold from ¥4,801 through ¥4,999.

The prototype accepts exported unary arrow functions with an expression body of the form `parameter >= integer`. A report without a matching specification uses the current implementation as the source of an expected value. The generated witness runs in the project's `test` directory. The report marks its outcome unconfirmed when the runner does not execute that test alongside the original suite. The runner executes the project's test code and configuration locally.

## Extract comparison candidates

```sh
npm run build:native
npm run build:typescript-syntax
node bin/tmt.mjs extract source.tsx
npm run verify:fstar
npm run audit:extraction -- /path/to/vite /path/to/preact /path/to/typescript
```

The native build uses a C compiler, the checked-in KaRaMeL C files, and Node-API headers. Set `TMT_NODE_INCLUDE` if Node's headers are outside the standard paths. The verification command uses F★ 2026.11.15 with Pulse and the KaRaMeL executable from the same release. Set `FSTAR_EXE` and `KARAMEL_EXE` to their paths. It verifies the parser and reference proofs, rejects admitted obligations, regenerates C, and compares both generated files with the checked-in copies. The F* proofs and generated C pull request check runs this command when proof and native extraction files change.

The [L1 grammar and trust boundary](docs/l1.md) describe the AST-free Pulse parser and TypeScript compatibility path. `build:typescript-syntax` prepares the smaller compatibility parser for local runs. The [performance measurements](docs/performance.md) cover the prior corpora and nine additional pinned JavaScript and TypeScript projects.

To build the standalone comparison extractor, run `npm run build:native -- --low-only` and then `node bin/tmt.mjs extract source.ts`. This build uses Node and a C compiler and writes `build/tmt.node`. Supported files use the generated Pulse parser directly, including typed modules, nested functions, exception handling, switch clauses, generic calls, async callbacks, nested bindings, computed object members, tagged templates, bounded class declarations, and nested TSX. Outside its grammar or resource limits, the standalone CLI exits with a diagnostic and no candidates. Run `npm run build:native` to restore the normal build with TypeScript compatibility parsing.

## Analyze a Vitest project

See the [analysis guide](docs/analysis.md) for project scope, Lean-backed replay, and source rewrite auditing.

The `--witnesses` profile finds source edits that survive the current suite and verifies a distinguishing test. Run `node bin/tmt.mjs analyze fixtures/witnesses src/queries.ts --witnesses` to see a first-versus-last index gap and the one-literal edit that exposes it.

```sh
npm run build:lean
node bin/tmt.mjs analyze fixtures/eligibility src/eligibility.ts --spec spec.json --deterministic --audit
```

## Analyze a Playwright project

```sh
node bin/tmt.mjs analyze . src/button.tsx --runner playwright --project chromium --audit
```

The [Playwright guide](docs/analysis.md#playwright-projects) describes runner isolation, witness specifications, and Git scope.

## Build a runtime package

```sh
npm ci
npm run pack:runtime
```

The archive written to `build/` has the OS and CPU in its filename and npm metadata. It contains the native parser, the generated TypeScript syntax parser and the Lean decision executable for the build machine's OS and architecture. The installed `tmt-ts` command runs them directly. Building another platform's package requires its C and pinned Lean toolchains. See [performance measurements](docs/performance.md) for the evaluated workloads.

The archive installs TypeScript for compatibility parsing and witness AST analysis. TMT uses the test runner installed in the target project or its workspace. The `standard` and `all` profiles also require `@stryker-mutator/instrumenter@10.1.1`.
