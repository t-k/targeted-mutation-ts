# Changelog

## 0.2.3

- Warn once on `stderr` and skip missing `--copy-exclude` (and `copyExclude` config) paths instead of failing with `Copy exclusion does not exist`, so scripts excluding optional build/test outputs work on clean checkouts. Paths escaping the project, targeting `node_modules`, or traversing symbolic links (including missing targets under a symlink) are still rejected.

## 0.2.2

- Fix Vitest 4.1 `bail: 1` compatibility in `assessTrial`: allow uncollected sibling test modules when `reason` is `'failed'` as well as `'interrupted'`, preventing false `unstable` verdicts on killed static-activation mutants.
- Add npm, CI, and Apache-2.0 badges plus the "Targeted mutation testing for JavaScript and TypeScript" tagline to `README.md`.

## 0.2.1

- Populate `tests` on mutants classified as `killed` via `killedBy: "unhandled-error"` in `assessTrial`, ensuring downstream consumers always receive a non-empty `tests` array for killed mutants.
- Omit unset optional keys (`shardKeys`, `checkpointStore`, `exclude-rule`) when forwarding options from `analyzeOperators` to `analyzeConventional`.

## 0.2.0

- Add baseline management (`--baseline`, `--write-baseline`) with line-number-independent stable finding IDs (v2) and AST-aware inline suppression comments (`// tmt:ignore <reason>` on the same line or standalone line above).
- Add SARIF 2.1.0 (`--format sarif`) and NDJSON (`--format jsonl`) output formats alongside text and JSON.
- Add `--list` for dry-run candidate preview without running tests, `--shard K/N` (`--sharding slice|round-robin`) for CI sharding across Vitest and Playwright, and `--checkpoint <FILE>` for crash-safe JSONL resume (verified with TLA+ `CampaignCheckpoint.tla`).
- Add weakened-test detection under `--since REV`: when test files changed since `REV`, surviving mutants are replayed against the old tests and regressions are flagged as `weakened` (and as `weakened-test` in SARIF).
- Add impossible-value reachability filtering (`%`, `&`, `<<`, `.length`, and non-negative 0-based `for (let i = 0; ...; i++)` loop counters) and strict enclosing-site duplicate suppression.
- Add automatic witness rules `composite-key-omit/v1` (template literal and `[...].join(...)` composite keys) and `divide-before-multiply/v1` (`Math.floor`/`Math.trunc` integer rounding order).
- Add project configuration support (`targeted-mutation.config.json`, `targeted-mutation.config.mjs`, `package.json#targetedMutation`), glob expansion for `--test` and source paths, `--copy-exclude-gitignore`, `--exclude-rule`, `--no-config`, and `--progress`.
- Improve real-world ergonomics and accuracy: validate `--test`, `--config`, `--spec`, and source paths before temporary project copy; classify `Object.create(null)` in `copy-dropped/v1` as `nonPlain` (`spreadCoercion` advice); skip `nullish-equality/v1` for `typeof x === "object" && x !== null`; classify post-hit unhandled runtime errors as `killed` (`killedBy: "unhandled-error"`); and report actionable baseline timeout diagnostics without redundant plain-baseline re-runs.

## 0.1.1

- Fix `--witnesses` automatic contract discovery on Windows by preserving OS-native relative paths instead of TypeScript's `/`-normalized `fileName`, and canonicalize `importMatches` against 8.3 short paths and symlinks.
- Add a Windows (`windows-latest`) portable-package CI job and `--portable` mode in `scripts/test-package.mjs` to verify the pure-JS/TypeScript fallback runtime end-to-end on Windows.

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
