# Changelog

## 0.5.0

- Enable `--type-check` automatically when a nearest or Project References `tsconfig.json` has `strictNullChecks` enabled, lazily creating the TypeScript program only when a file actually queries `nullish-fallback/v1` or `nullish-equality/v1` (skipping `&&`-only files) and falling back silently when inactive. Add `--no-type-check` (`"typeCheck": false`) and `--no-copy-exclude-gitignore` (`"copyExcludeGitignore": false`) to opt out or override project configuration.
- Preserve soundness under automatic type checking by consulting declared types for mutable `let`/`var`/parameter/destructured bindings and guarded properties so closure mutations cannot hide non-equivalent nullish mutants.
- Extend `--suggest-assertions` beyond pure literal-argument subject calls:
  - Pass 1 now also observes bound subject calls with non-literal arguments (`const res = fn(arg)`) and safe read-only expressions inside weak `expect(<expr>).<weakMatcher>(...)` statements.
  - Pass 2 compares observable end-of-test local state when Pass 1 finds no diff (reserving a slot within the 4-trial per-gap budget), generating concrete assertions for Proxy stores (`expect(store.dirty).toBe(true)` without emitting broken whole-object `toStrictEqual` on partial/Proxy objects), DOM elements (`childElementCount`, `scrollTop`, `scrollLeft`, `style.*`, `getAttribute(...)`, `textContent`, and `children[i]` while guarding truncated attributes/styles), and callback/event variables.
- Fix Vitest 4.1 compatibility in `src/standard-session.mjs`: clear Vitest's internal `filesMap`/`idMap`/`taskFileMap`/`reportedTasksMap`/errors state before each `run()` and `runInThread()` round so stale failed/dynamic test modules from an earlier trial do not leak into subsequent `bail: 1` `onTestRunEnd(modules)` snapshots.

## 0.4.2

- Include all `targeted` value-aware rules in `--mutators full` across Vitest sessions, `--list`, and source-rewrite runners (`--audit` / Playwright), lifting inner built-in expression switches outside observed probes so no live mutant is dropped when both sets coexist.
- Recognize single-argument global `Boolean(expr)` calls as truthiness-only contexts in `onlyTruthUsed` (with shadowing detection for declarations, `import = require`, Unicode escapes, and assignments while ignoring type-only imports), preventing false `ASSERTION GAP` classifications on `Boolean(a || b)` when both operands are `undefined`.
- Also exclude element accesses wrapped in erased TypeScript assertions (`satisfies`, `as`, `<T>`) when called or deleted so `sequence-end/v1` probes preserve `this` binding and `delete` semantics.
- Guide users toward `--copy-exclude-gitignore` and `"copyExcludeGitignore": true` in both the large-copy warning and `--help`.

## 0.4.1

- Reuse the temporary project copy created for `--related` discovery in the subsequent mutation analysis session instead of copying the project twice, with single-consumer ownership (`claim()`), workspace mutation detection (falling back to a fresh copy if Vitest config/plugins modify the workspace), and TLA+ lifecycle verification (`CopyReuseLifecycle.tla`).
- Emit both incremental in-worker mutant completion counts and time-based elapsed progress heartbeats (default every 5s) under `--progress` so long-running mutation files remain visibly active.
- Narrow `nullish-fallback/v1` missing-input advice using TypeScript type information when `--type-check` is enabled (e.g. `number | undefined` with `?? 0` suggests only `NaN`, and literal `0 | undefined` with `?? 0` suggests `-0`), while preserving local `NaN` bindings.
- Tailor the large `--related` test-selection warning (`> 20` files) to suggest only options supported by the active execution mode (`--witnesses`, `--audit`, or default Vitest session).

## 0.4.0

- Render full details for comparison-derived `ASSERTION GAP` findings in text output, including the surviving comparison edit, affected test names, witness operands, and assertion advice.
- Resolve nearest and TypeScript Project References `tsconfig.json` files per target file under `--type-check`, add `--tsconfig <FILE>` (and `tsconfig` config), and warn on `stderr` whenever `--type-check` is inactive instead of silently skipping type-based suppression.
- Register active temporary project copies for `SIGINT`/`SIGTERM` cleanup (stopping spawned worker process groups and removing `tmt-*` directories before exit, verified with TLA+ `CopyCleanupLifecycle.tla`), warn on large copies with `--copy-exclude` / `targeted-mutation.config.json` guidance, and emit incremental `--progress` updates for copying, baseline execution, and mutant completion.
- Allow combining `--related` with `--test <file|glob>` to intersect related Vitest specs, add `--baseline-timeout <SECONDS>` and `--baseline-workers <N>` (plus `baselineTimeout` / `baselineWorkers` config) independent of mutant trial concurrency, and warn when `--related` selects a large number of test files.
- Make text output compact by hiding `killed` rows by default, add `--verbose` and `--only-gaps`, clarify multiline `switch` `case`/`default` body-removal edits (`(empty)`), and add `--fail-on-gaps` (and `failOnGaps: true` config) to exit with code `2` when test gaps are reported.

## 0.3.0

- Add `--related` (and `related: true` config) for Vitest to automatically select only test files (and Vitest projects) related to the scoped source files inside a supervised temporary copy, failing with a clear `--test <FILE>` hint when no related tests match.
- Add `--json-out FILE` and `--sarif-out FILE` to write JSON and/or SARIF reports alongside terminal text output, with pre-run output path collision checks across `--json-out`, `--sarif-out`, `--write-baseline`, and `--checkpoint`.
- Improve `--mutators full` summary wording to distinguish non-targeted survivors (`N targeted gap(s) (M other survivor(s))`) and fix singular/plural forms (`1 edit`, `1 test gap`, `1 baseline test`, `1 gap`).
- Improve `nullish-fallback/v1` advice to omit the right-side falsy literal itself (`""`, `0`, `0n`, `false`, `NaN`) from the suggested candidate list, and add `--type-check` (and `typeCheck: true` config) to skip statically equivalent `nullish-fallback/v1` and `nullish-equality/v1` edits under `strictNullChecks`.

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
