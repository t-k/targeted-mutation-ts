# Changelog

## 0.10.0

- Add `--copy-include <PATH>` (`"copyInclude"` in `targeted-mutation.config.json`) to re-include generated files or nested directories excluded by `--copy-exclude` or `--copy-exclude-gitignore`, and emit actionable `baseline.hints` when a baseline import-resolution failure matches a gitignored exclusion.
- Add `--exclude <PATTERN>` (`"exclude"` in `targeted-mutation.config.json`) and `!PATTERN` entries in `files` to exclude files, directories, or globs from mutation while keeping them in temporary copies so tests can import them.
- Automatically default `[PROJECT]` to `.` in `targeted-mutation analyze [PROJECT] [FILE...]` when the first positional argument is a file, glob, negated pattern, or non-project subdirectory inside the current project, while preserving explicit `analyze DIR FILE|GLOB` invocations and project-directory resolution.
- Surface isolated fallback reasons across mutant results (`fallback`), `trials.fallbackReasons` counts in JSON reports, and `--progress` output (`isolated fallback: <reason>`), including `isolated-trials` and `baseline-records-unmatched` alongside per-mutant session reasons.
- Replace `"Stryker was here!"` / `` `Stryker was here!` `` / `["Stryker was here"]` built-in mutation literals with `"tmt-mutated"` / `` `tmt-mutated` `` / `["tmt-mutated"]`.
- Support an optional `reason` field on baseline v2 findings, preserve existing user-written reasons across `--write-baseline` rewrites (refusing to silently overwrite malformed baseline files), and expose suppressed reasons in `report.suppressed.reasons`.
- Add Node.js 26 LTS to the GitHub Actions CI test matrix (`ubuntu-24.04` and `macos-15`).

## 0.9.2

- Persist settled Vitest warm verdicts into the durable `--checkpoint` file before entering isolated fallback:
  - Poll and flush settled warm results to `--checkpoint` in `analyzeConventional` (even when `--progress` is omitted) prior to emitting `isolated fallback` progress updates, waiting for settled result events so `observed` diagnostics are never missed, propagating checkpoint write errors cleanly, and flushing any remaining completed events on `SIGINT`/`SIGTERM` before removing the temporary workspace.
  - Respect `--verify-trials` verification sampling so warm results awaiting fresh comparison remain pending until verified, and include `--verify-trials` in the checkpoint campaign context hash so changing it never bypasses verification with unverified cached outcomes.
- Preserve both `--project` and `--test` filters in Playwright source-rewrite fallbacks:
  - Pass `--project=<name>` ahead of non-variadic `--output` and anchor resolved test file paths (`^...$`) across both source-rewrite and session paths so Playwright's variadic `--project` flag never consumes positional test paths, suffix-matching specs are excluded, leading-dash spec filenames are not parsed as CLI flags, and generated `--spec` witness files are included during witness verification runs.
- Flag unconfirmed source application when Playwright falls back from `no-runtime-switch-observations` (such as an external daemon serving an unchanged prebuilt UI bundle):
  - Preserve `sessionFallbackReason: "no-runtime-switch-observations"` on the report, scope source-rewrite confirmation to files with at least one `killed` trial or specific sites with verified `--spec` witnesses (`baselineWithWitness: "passed"` and `rewriteWithWitness: "failed"`), downgrade unconfirmed `survived` edits to `unevaluated` (`sourceVerdict: "survived"`, `sourceApplication: "unconfirmed"`, `evaluation: "incomplete"`) while suppressing false test-gap recommendations, and print a source-serving warning in text output.

## 0.9.1

- Recover cleanly from Vitest fresh trial timeouts without aborting the remaining mutation campaign:
  - Dispose the timed-out fresh Vitest lane (bounding cancellation and close within one shared deadline, using unique per-trial coverage destinations, and cleaning up completed trial files) and continue remaining queued mutants and threshold extras in a new lane, while aborting cleanly as `incomplete` if a timed-out lane cannot close or a fresh trial hits a runner error.
  - Persist all completed in-worker warm results before starting fresh fallback trials so interrupted campaigns can resume from `--checkpoint` without re-evaluating settled mutants.
  - Surface the active execution stage (`in-worker`, `isolated fallback`) and trial deadline seconds in `--progress` updates.
  - Store structured session failure details (`sessionFailure` with concise `reason`, `exitCode`/`signal`, and a bounded tail excerpt of `stderr`) once on incomplete Vitest and Playwright reports instead of duplicating large shared `stderr` logs on every `unevaluated` mutant row, and print a single `Session failure:` line in text output.
- Report reaching Playwright tests on runtime-switch trials:
  - Attach `reachedTests` (`{ id, project, file, name }[]`, restricted to tests with per-test baseline reachability evidence) to scheduled Playwright runtime-switch trials while keeping `tests` strictly for killing tests and omitting `reachedTests` on `unreached` edits, persisting `reachedTests` in checkpoints and rendering a compact `(reached by: ...)` hint in text output for survivors without a specialized gap diagnostic.
- Document Playwright mutation setups for external daemons with embedded UI bundles in `docs/analysis.md` (covering stale/prebuilt asset detection, report fields to verify, and a minimal loopback Vite proxy + backend readiness/cleanup wrapper) and display a prebuilt-assets hint in text output when every selected Playwright edit is `unreached`.

## 0.9.0

- Add first-class targeted mutation testing for Playwright E2E suites (`--runner playwright` without `--audit`, `operatorExecution: "session"`):
  - Instrument target sources once with pure-JavaScript runtime switches, value-aware agreement probes, and bounded safe-integer comparison operand recorders (`globalThis.__stryker__`, with `BigInt`-free exact base-4 difference extrema tracking beyond 1,024 loop iterations), requiring no Node-only imports inside client bundles, `<script type="module">`, or SSR modules.
  - Drive a warm Playwright `TestRunner` and headless browser server (`launchServer`) with an automatic worker fixture (`context.exposeBinding` + `context.addInitScript` across `pagehide`, `page.close()`, end-of-test frame flushes, and reused `BrowserContext` instances) and a loopback-authenticated Node `webServer` preload (`/__tmt_harvest__` + exit spooling) to collect dual-realm reachability and observations per E2E test.
  - Synthesize `comparison-threshold/v1`, `comparison-margin/v1`, and `--displace-thresholds` from recorded server and browser comparisons, skip provably identical comparison trials via Lean 4 `tmt-decide` under `--deterministic` (verified against independent per-test switch counts and excluding server-boot comparisons), skip unreached edits without running E2E trials, and separate survivors into `INPUT GAP` and `ASSERTION GAP` naming the exact Playwright E2E test.
  - Run only reaching test IDs (`maxFailures: 1`) followed by a mandatory switch-off control run verifying per-test switch hit counts, automatically restarting the server and falling back to an isolated fresh `webServer` trial on `control-differs` or `server-static` switches, with `--isolated-trials`, `--verify-trials N`, `--spec` witness verification, and `ps -o lstart=` PID-signature-verified teardown.
- Share trial execution and expand targeted diagnostics in `--mutators full` across Vitest and Playwright sessions:
  - Align `extreme-swap/v1` (`Math.min` <-> `Math.max`) to ECMA-262 `CallExpression` evaluation order (with lazy, descriptor-only `Math` checks that never invoke getters or trial calls) and share single trial executions between source-equivalent built-in and targeted mutations (`ArithmeticOperator` `+`<->`-` and `*`<->`/`, `MethodExpression` `Math.min`<->`Math.max` and `every`<->`some`, and `Regex` `.test()` anchor drops) while keeping all candidate IDs in reports, shards, and checkpoints.
  - Record receiver nullishness on `OptionalChaining` (`?.`, preserving unparenthesized vs parenthesized chain short-circuiting, `delete`, `with` bindings, indirect `eval?.()`, and erased TypeScript member/generic `this` bindings), condition outcomes on `ConditionalExpression` (`true`/`false`, distinguishing truthiness vs value contexts while always executing side-effecting conditions), and safe-integer trace inversions on complementary `EqualityOperator` (`>=` -> `<`, `<=` -> `>`, `>` -> `<=`, `<` -> `>=`), reporting actionable `INPUT GAP` and `ASSERTION GAP` diagnostics on surviving `full` edits.
- Improve Playwright onboarding, monorepo workspace copies, and CLI usability:
  - Support `webServer.port` alongside `webServer.url` in Playwright configs (matching configured loopback `baseURL` origins while keeping strict single-origin checks on explicit `webServer.url` and stripping credentials from error messages), default `webServer.stderr` to `'pipe'`, and surface server startup `stderr` output on baseline errors.
  - Merge ancestor hoisted `node_modules` alongside local subpackage `node_modules` in `withCopy` (expanding symlinked `@scope` directories safely inside the temporary copy without touching external symlink targets).
  - Accept directory paths in `analyze [PROJECT] [FILE...]` and `"files"` config (respecting `--copy-exclude` and `--copy-exclude-gitignore`), guide users when `analyze <subdir>` omits `.` inside a project root, add `"projects"`, `"deterministic"`, `"displaceThresholds"`, `"isolatedTrials"`, `"verifyTrials"`, `"spec"`, and `"progress"` to `targeted-mutation.config.json` with unknown-key typo warnings, extend short-circuit guard absorption to primitive relational comparisons (`<`, `<=`, `>`, `>=` with `[[IsHTMLDDA]]` protection and `unsure` propagation on objects), clarify `ignored-operand/v1` fallback diagnostics on `??` literal defaults, stream real-time warm Playwright `--progress` updates, and print `--verify-trials` summaries in text output.

## 0.8.1

- Guide CLI users when `targeted-mutation analyze` receives a file path, glob pattern, or missing source file in place of `[PROJECT]` instead of failing with `ENOTDIR`: print a shell-quoted `targeted-mutation analyze . <file...>` hint (including `--` for leading-dash filenames) for paths inside the current directory and `targeted-mutation analyze <PROJECT> <FILE...>` for paths outside it.
- Summarize multiline and long expression edits consistently across `--list` candidate rows, mutant status rows, and `INPUT GAP` / `ASSERTION GAP` descriptions by eliding shared prefix/suffix context (accounting for added outer parentheses and preserving literal spacing) so the edited operand or operator remains visible while keeping full source strings in JSON, SARIF, and baseline IDs.
- Suppress false `ASSERTION GAP` reports on short-circuit conditions:
  - Statically skip equivalent `nullish-equality/v1` edits on declarative local bindings across De Morgan `typeof x !== "object"` / `typeof x === "object"` and explicit `null`/`undefined` short-circuit chains (barring intervening side effects, `with` statements, or lexical `undefined` bindings including named class expressions) while preserving `differsFor: "null"` (`!== undefined` / `=== undefined`) candidates.
  - Evaluate forward-only, switch-free pure short-circuit guard steps during baseline probing so leaf differences absorbed by an enclosing side-effect-free condition are classified as `INPUT GAP` (naming the guard the input must decide) rather than false `ASSERTION GAP`, without invoking getters, calls, `ToPrimitive` coercions, monkey-patched `Boolean`, or nested coverage switches.

## 0.8.0

- Add prebuilt Windows x64 native runtime support (`@targeted-mutation/tmt-win32-x64`) shipping both the native parser addon (`tmt.node`) and the Lean 4 decision executable (`tmt-decide.exe`), installed automatically as an optional dependency on Windows x64 Node.js while preserving the portable TypeScript/JavaScript fallback on other Windows architectures and `--omit=optional` installs.
- Build and verify the Windows x64 native package in CI (`windows-2025`) and the `Release` workflow, including transitive optional-dependency installation checks, clean-`PATH` (`System32`) binary smoke checks, and Windows path-leak checks.

## 0.7.0

- Add native `node:test` runner support (`--runner node`, also configurable via `"runner": "node"` in `targeted-mutation.config.json`):
  - Runs each mutation in an isolated temporary workspace and fresh Node process via `node:test`'s `run()` API and the `runner-process.mjs` supervisor (including Windows process-tree termination on timeout via `taskkill /T /F`), with `--test`, `--concurrency`, `--checkpoint` (incremental per-trial persistence), `--shard`, `--since --undo-changes`, `--baseline`, and SARIF/JSONL output.
  - Classifies nested `describe`/`it`/`t.test()`, duplicate test names, `skip`/`todo` statuses, helper-registered tests across files, `before`/`after` hook failures, module load failures (using baseline test inventory and captured `test:stderr` details so load failures are reported as `error` rather than false `killed`), and malformed/missing reports.
- Improve baseline failure diagnostics across Vitest, Playwright, and Node runners: record collected test files (`baseline.files`) and per-file error locations (`baseline.fileErrors`), and display them in text reports so miscollected specs or failing test files can be identified immediately.
- Improve gap prioritization for timeouts and rounding equivalence:
  - Preserve `statusReason` across Vitest session verdicts (`sessionVerdicts`), focused analysis (`completeAnalysis`), checkpoints, and source-rewrite runners, and render stop reasons (such as `Mutation hit limit reached`, `Vitest test timeout`, `The worker stopped answering`, or `Node test runner timed out`) directly on mutant lines in text output.
  - Detect soundly non-negative `Math.floor` <-> `Math.trunc` mutations as equivalent (`ignored` with `statusReason`), and annotate surviving domain-non-negative `floor`/`trunc` gaps (such as `Math.floor(items.length / total)`) with `equivalenceHint: "likely-equivalent"` and a note in text and SARIF output.

## 0.6.2

- Canonicalize Windows 8.3 short paths (such as `RUNNER~1` under `%TEMP%`) with `realpathSync.native` across project roots, temporary workspace copies, probes, and reporters so path comparisons match Vite and Vitest 5's native realpath resolution, and pass workspace-relative slash-normalized test filters to Vitest CLI runs.

## 0.6.1

- Fix Vitest 4 in-worker session fallback on Windows: resolve legacy `vitest/runners` as a `file://` URL in `src/standard-runner.mjs` so Vitest's Windows `VitestModuleEvaluator.convertIdToImportUrl` does not treat a bare dynamic import specifier as a relative path, and normalize Windows backslashes before calling `vitest.invalidateFile(...)` in warm `--suggest-assertions` sessions.

## 0.6.0

- Add Vitest 5 (tested with Vitest 5.1.2) compatibility alongside Vitest 4 across in-worker switched sessions, comparison tracing probes, warm `--suggest-assertions` sessions, and `--related` discovery:
  - Resolve `TestRunner.getCurrentTest` from `vitest` on Vitest 5 while preserving synchronous `vitest/suite` resolution for Vitest 4 and native CommonJS `require(esm)` preloads.
  - Support Vitest 5's `TestRunner` and `vitest/internal/browser` `startTests` entry via major-version dispatch (ignoring any foreign hoisted `@vitest/runner` 4.x in monorepo dependency trees), fall back cleanly to `source-rewrite` when `experimental.viteModuleRunner` is `false`, and classify `aroundEach`/`aroundAll` (setup, teardown, and post-trial control run) and `while waiting for ...` timeouts accurately.
  - Invalidate Vite 6/7 per-environment module graphs and `vitest.invalidateFile(...)` across warm `--suggest-assertions` trials (and after restoring original sources), while falling back to fresh runs when `globalSetup` is configured.
  - Isolate and disable Vitest 5's default `fsModuleCache` (`node_modules/.vitest-cache`) and Vitest 4.0.11+'s `experimental.fsModuleCache` (`node_modules/.experimental-vitest-cache`) across CLI and programmatic runs (including subprojects) so temporary copies never pollute shared `node_modules` directories.
- Expand the CI compatibility matrix and `scripts/test-package.mjs` to test Vitest 5.1 alongside Vitest 4.0 and 4.1, and update documentation and `docs/how-it-works.svg` for Vitest 4 & 5.

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
