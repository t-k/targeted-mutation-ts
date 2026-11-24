# Changelog

## 0.1.0

First public release.

- `targeted-mutation` command with the alias `tmts`: `analyze`, `extract` and `prototype`.
- Default `--mutators targeted` profile combining comparison boundaries (`<`, `<=`, `>`, `>=`), constant-RHS integer thresholds (`comparison-threshold/v1`), Lean-verified variable-RHS comparison margins (`comparison-margin/v1`), and twenty value-aware semantic rules (constant equality, ignored logical operand, `??`/`||` fallback, strict/loose nullish equality, arithmetic swap, `Math.min`/`Math.max`, rounding swap, clamp bound drop, sequence ends, numeric sort without comparator, `every`/`some` quantifier swap, literal-set element pruning, `startsWith`/`endsWith` to `includes`, `replace`/`replaceAll` multiplicity, regex anchor slack, defensive spread copy drop, spread-update individual property drop, merge precedence swap, dropped `await`, and dropped `finally` cleanup call).
- Observation-guided survivor diagnostics on Vitest separating `INPUT GAP` (exact missing input or boundary witness) from `ASSERTION GAP` (exact test that observed a difference and passed), plus newly reached / no-longer-reached expression `effects`.
- `--suggest-assertions`: runs unpinned calls in a warm Vitest session with and without the surviving edit, printing the exact assertion and narrowing multi-key plain objects to the single changed sibling property path (`expect(res.fee).toBe(600)`).
- `--undo-changes` with `--since REV`: reverts each changed Git hunk and independent AST sub-hunk (added `&&`/`||` terms and added object properties) to report `UNTESTED CHANGE`, with dynamic whole-file fallback when a single hunk fails to parse or load.
- `--mutators full`: the complete StrykerJS-compatible mutation set, built in, with no external instrumenter package.
- `--witnesses`: parallel witness search (`--concurrency N`, up to 8 by default), including paired round-trip and public-state contract checks.
- `// Stryker disable` and `// Stryker restore` comments are honoured by both `targeted` and `full` profiles.
- `--since` and `--lines` select a comparison when any of its lines is in scope, and `--since` leaves files that Git ignores out of discovery.
- Vitest 4 sessions decide mutations inside running workers, with an immediate post-trial control run and automatic fallback to a fresh Vitest run when worker state leaks. `--concurrency N`, `--verify-trials N`, `--isolated-trials`, `--timeout SECONDS`, and `--test FILE` control execution.
- Text report on a terminal, JSON report (`schemaVersion: 1`) when piped, `--format` to choose; runner breakdown marks evaluation `incomplete` and exits with status 1.
- Prebuilt native parser and Lean 4 decision executable (`tmt-decide`) for macOS and Linux (glibc) on arm64 and x64, with automatic TypeScript/JavaScript fallback on other platforms.
