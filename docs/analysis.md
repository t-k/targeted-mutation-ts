# Analyzing a project

Install the locked dependencies with `npm ci` and build the native extractor with `npm run build:native`. Build the Lean decision executable with `npm run build:lean` using the pinned Lean toolchain. The analysis runs the binaries in `build/` directly.

```sh
node bin/tmt.mjs analyze fixtures/eligibility src/eligibility.ts --spec spec.json --deterministic --audit
node bin/tmt.mjs analyze . --lines src/eligibility.ts:1-8 --audit
node bin/tmt.mjs analyze . --since "$(git merge-base origin/main HEAD)"
```

Arguments after the project root select source files. Without files, the CLI discovers TypeScript and TSX sources. The scope comes from explicit line ranges and added or changed lines relative to a Git commit. The CLI parses each selected file before filtering candidate operator positions. Output is JSON with a schema version, extraction outcomes, candidate IDs, trial verdicts and diagnostics. An extraction diagnostic or a baseline failure exits with status 1. A successful analysis exits with status 0.

### Limit a dogfood or CI run

```sh
node bin/tmt.mjs analyze . packages/example/src/ranges.ts --since HEAD^ \
  --config vitest.config.ts --test packages/example/test/ranges.test.ts \
  --copy-exclude benchmarks --audit
```

`--config` selects a project-relative Vitest or Playwright config. Repeat `--test FILE` to run specific, project-relative Vitest files in every phase, including witness runs. The report records the selection and errors if the config collects missing or additional test files. Any conclusions from a selected suite apply to that suite. Repeat `--copy-exclude PATH` to omit local assets or build caches from every temporary copy while leaving the original checkout intact. A selected suite should retain the files and build outputs it needs. The runner already omits `.worktree` and `.worktrees`. Source discovery skips excluded paths. Provide exclusions inside the project without traversing symbolic links, and keep `node_modules` available for the test runner.

Automatic scope includes JavaScript and TypeScript source, including JSX and module-specific extensions. It skips conventional test, spec, declaration and runner configuration filenames. With `--since`, Git supplies tracked and changed paths in bulk. Only changed tracked files in scope need a line diff.

Project-internal symbolic links resolve inside each trial copy. Installed dependency directories remain available at their original positions relative to the project root, including workspace package directories. A copy exclusion can omit an entire package-local dependency directory. External links and installed dependencies are shared inputs. On POSIX, Vitest watchdog timeouts terminate the runner's process group.

Install Vitest or `@playwright/test` in the target project or its workspace before running the corresponding profile. TMT uses that runner's installed version and the target project's configuration. If the suite imports other dependencies hoisted above the target directory, analyze from the workspace root and scope the source and tests to the package.

The Vitest path runs an original baseline, a disabled-instrumentation baseline, and one isolated source rewrite for each trial. Instrumentation passes both evaluated operands to a comparison with the original operator. It records only JavaScript safe-integer pairs for prediction. The report identifies a Vitest test by project, relative file and task ID. Unattributed, unsupported or inconsistent observations keep the trial on the full-suite path. The product produces threshold replacements for directly callable exported unary arrows with a safe integer literal. It groups adjacent alternatives that agree on the safe integer domain. A matching specification entry with a rationale can supply the expected result and domain for the proposed test.

`--deterministic` declares that tests run from the same initial state and external inputs, and that a comparison influences execution only through its outcome. Tests that inspect source text or compare elapsed time are outside that contract. The runner compares two disabled traces and requires a complete, attributed observation from every passing test for the selected comparison. The compiled Lean executable validates the batch; missing tools, malformed data, retries, overlapping test options, or any rejected decision require a real run. `evidence: "predicted"` is a Lean-backed replay decision. `evidence: "reexecuted"` describes a source trial. The `--audit` option runs a full source rewrite and, where available, an independently activated probe, recording the agreement. For a callable threshold witness, audit also runs the generated Vitest assertion against original and rewritten source and checks both test inventories. The Lean theorem models deterministic comparison-driven executions, with JS instrumentation and run identity in the trusted runtime boundary.

The [recorded eligibility and shipping reports](../evidence/m2) show the standard boundary mutation and the generated threshold-shift rule. `npm test` also checks the distinction between reaching the boundary and asserting the returned value.

Threshold suggestions use a batch call to the compiled Lean evaluator when available. Its theorems identify the closed interval of observationally feasible integer thresholds and show that the reported adjacent witness separates every feasible alternative on its side. The JavaScript calculation provides the same report when the compiled evaluator is unavailable.

With `--deterministic` and complete, stable observations, the compiled replay decision can also skip reexecuting a generated integer-literal threshold alternative. `--audit` still runs the source rewrite and checks the result against the prediction.

Pass `--displace-thresholds` to try tightening strict comparisons by one integer step. For example, `measured.size > 0` becomes `measured.size > 1`, and `offset < source.length` becomes `offset < source.length - 1`. The rule requires complete safe-integer observations with a representable shifted bound and always runs the source rewrite. A surviving mutation can identify an observed result that changed or propose an operand pair to exercise. When the comparison is a directly callable exported unary arrow with an integer literal, an input gap includes a suggested assertion and `--audit` verifies it. Use an application-level test to confirm reachability and expected behavior for other comparisons.

### Standard mutation profile

`--mutators standard` enables the pinned StrykerJS instrumenter's default TypeScript and TSX mutation families, including source comments that disable mutation. The profile applies a line range to complete mutable syntax nodes. It runs a disabled-switch baseline and trials in a disposable project workspace with isolated Vitest workers. On Vitest 4.1, covered tests are selected by task ID. Import-time hits run the selected suite with the mutation active at module load. An unreached mutation uses baseline coverage evidence. A partial session reports any remaining trials as unevaluated and exits with an error.

This profile uses Vitest 4 worker pools. Install the compatibility instrumenter in the project or its workspace before using `standard` or `all`.

```sh
npm install -D @stryker-mutator/instrumenter@10.1.1
```

The `focused` profile uses the native extractor, Lean replay decisions and threshold diagnostics, and supports Playwright.

### Combined mutations and verified replay

`--mutators all` also runs one-unit tightenings of strict safe-integer comparisons in ECMAScript modules. It adds focused switches at matching, enabled comparison spans inside the standard mutation scope. It reports missing or unsafe observations as unsupported and can include operand values in gap examples. Each supported tightening is executed in Vitest. Use the focused profile for source-rewrite auditing and generated assertions for exported unary thresholds.

With `--mutators all --deterministic`, Lean can certify survival for a standard comparison variant when two disabled runs reproduce its covering test inventory and safe integer observations. The flag declares that input and execution order are deterministic and evaluating each compared operand has no observable side effects. This matters for substituting a constant condition, which omits operand evaluation. Choose the same profile without `--deterministic` to execute every reached variant and compare verdicts.

## Playwright projects

```sh
npx playwright install --only-shell chromium
node bin/tmt.mjs analyze . src/button.tsx --runner playwright --project chromium --audit
```

Use `--config` for a nonstandard Playwright config path. Each trial launches a separate Playwright runtime in a temporary checkout with one worker. The config wrapper disables web server reuse. Trial output identifies the attempt, runner process, project, browser, worker and test. A cooperating local server can write its process ID to `TMT_SERVER_PID_FILE`. A test whose attempt is unstable, timed out, has changed inventory or failed setup has a separate outcome.

The browser path currently uses full source rewrites. It supports the four comparison mutations and the left-operand deletion rule for a JSX `disabled` expression of the form `left || right`. It accepts an optional `playwright` array in the specification JSON. Each entry identifies a file, rule, operator and optional line, records an independent requirement, and points to a witness test relative to the root. The CLI runs the added test against both original and rewritten source and verifies the test inventory. The audit repeats the full source trial. Git scope correctly limits these runs to candidates on changed operator lines.

The fixture accepts a loopback port from `PORT`. The integration tests and the evidence script start their own instances of that fixture. Playwright's global timeout reserves time for orderly shutdown before the runner's process-group deadline.

Playwright needs a loopback `webServer` command rooted in each trial copy. If `use.baseURL` is set, its origin must match a managed server. The tool resolves Playwright from the target workspace. Server commands and tests must exercise the copied sources, including any paths they construct dynamically. A witness can set `witnessDirectory` when the relevant project collects tests outside the directory of the first passing baseline test.

For the pending Save fixture, StrykerJS 10.1.1's command runner killed its five generated mutants with both suites. Its replacement list did not include dropping the saving operand to get `!valid`. TMT ran that source rewrite against both suites, and the added pending-request test killed it. This comparison uses the StrykerJS command runner with coverage disabled, so it does not establish a relative runtime for StrykerJS with per-test runner coverage. The [JSON evidence](../evidence/m3) records both experiments.

## Distinguishing witnesses

`--witnesses` runs the Vitest witness profile. It searches for a source rewrite that survives the selected tests, then checks an input edit or assertion that distinguishes it. It runs each trial in a fresh copy and reports a confirmed gap when the original passes and the attributed assertion fails with the expected alternate value. Source and fixture edit offsets are half-open UTF-8 byte ranges.

```sh
node bin/tmt.mjs analyze fixtures/witnesses src/queries.ts --witnesses --test test/queries.test.ts
node bin/tmt.mjs analyze fixtures/witnesses src/text-order.ts --witnesses --test test/text-order.test.ts --spec order-spec.json
node bin/tmt.mjs analyze fixtures/witnesses src/contracts.ts --witnesses --test test/contracts.test.ts
```

The automatic rules handle same-type safe integer arguments and numeric fields of an inline object type in an ordered comparison, `indexOf` versus `lastIndexOf` on numeric arrays, any versus all bits in a nonnegative 31-bit mask, and one extra element in a `slice(0, count).reduce(...)` sum. They use direct Vitest calls with literal arguments and a scalar `toBe` assertion as seeds. Calls may appear inside nested `describe` or `suite` blocks with literal titles. JavaScript named exports can use JSDoc parameter annotations, and the numeric-array `indexOf` rule can use an unannotated function with literal numeric fixtures. A finding includes a minimized single-literal edit where the observed assertion still holds for the original implementation. Otherwise it can verify a separate assertion in the selected test file. Automatic expectations come from the original implementation. The automatic search evaluates up to 32 eligible rewrites and four one-edit proposals per surviving rewrite.

`witnessSearch` reports scoped single-rule source candidates, how many matched passing test seeds, how many were evaluated, and how many hit the evaluation cap. `unmatched` is null when a diagnostic or a failed baseline prevented matching. A matched seed can lack a supported distinguishing edit. Paired and public-state witness plans have separate evaluation results.

For string-length functions, ASCII assertions can seed a one-character witness. The profile compares `Array.from(text).length` with UTF-8 byte length and `text.length` with code-point length. For example, `é` distinguishes one code point from two bytes, and `😀` distinguishes two UTF-16 code units from one code point.

For sorts with inline record types, the profile supports `toSorted((a, b) => a.key - b.key)` and `[...rows].sort(...)` when the test observes order through a scalar `.map(row => row.id).join(...)` assertion. It changes one alternate-key value to reverse a pair's relative order. In `--spec`, each `sortConstraints` entry identifies a `file`, exported `function`, numeric `before` field, and numeric `after` field. The seed and proposal must satisfy `before <= after` on every row. Entries for selected files must resolve to a supported sort.

The profile discovers up to 32 additional state and pair plans. It can link matching 16- or 32-bit `DataView` byte-order edits when a selected passing test passes an encoder result to the decoder through a nested call or one immutable binding. For a rejected batch with an upfront `.some(...)` guard, it can borrow a map-backed public reader from a passing test for the same class in the same test module and use a key from the rejected batch. The report records both the donor's argument and the generated argument. These observations preserve the original behavior. Use an explicit plan when the expectation comes from an external contract.

With `--spec`, `witnessPlans` adds up to 32 explicit plans. Each plan supplies a name, requirement, project-relative test file, uniquely named existing seed test, one or two source edits, and a public observation. Each edit includes a project-relative source file, a one-based line, and exact original and replacement text. Every edit must be in scope and match exactly once on its line. The `observe` expression runs in the seed test module and can use its local imports. Supply distinct scalar `expected` and `alternate` values from a specification. A paired finding requires the same seed test to fail on each source edit alone, the original suite to pass with both edits applied, and the new assertion to distinguish the pair.

The [explicit witness fixture](../fixtures/witnesses/witness-spec.json) checks an atomic batch through a public read and a little-endian wire format through a fixed byte assertion. The runner executes project test code and the supplied witness expression. Reports can include fixture values, paths, and the supplied expression. The witness profile uses project scope and Vitest test/config selection. Use its reexecuted verdicts to inspect candidate source edits and the separately confirmed diagnostics to identify executable tests.
