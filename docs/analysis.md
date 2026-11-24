# Analyzing a project

Install `targeted-mutation` in the project as described in the [README](../README.md). The examples below use files from this repository's `fixtures/`. In a checkout of this repository, build with `npm ci`, `npm run build:native` and `npm run build:lean`, and run `npx targeted-mutation` in place of `targeted-mutation`.

```sh
npx targeted-mutation analyze fixtures/eligibility src/eligibility.ts --spec spec.json --deterministic --audit
npx targeted-mutation analyze . --lines src/eligibility.ts:1-8 --audit
npx targeted-mutation analyze . --since "$(git merge-base origin/main HEAD)"
```

Arguments after the project root select source files. Without files, the CLI discovers TypeScript and TSX sources. The scope comes from explicit line ranges and added or changed lines relative to a Git commit. The CLI parses each selected file before filtering candidate operator positions. The JSON report has a schema version, extraction outcomes, candidate IDs, trial verdicts and diagnostics. A terminal shows a text summary of the same report; a pipe or `--format json` receives the JSON. `--lines FILE:N` selects a single line. A failed baseline lists the failed tests and their messages under `baseline.failedTests`. An extraction diagnostic or a baseline failure exits with status 1. A successful analysis exits with status 0.

### Limit a dogfood or CI run

```sh
npx targeted-mutation analyze . packages/example/src/ranges.ts --since HEAD^ \
  --config vitest.config.ts --test packages/example/test/ranges.test.ts \
  --copy-exclude benchmarks --audit
```

`--config` selects a project-relative Vitest or Playwright config. Repeat `--test FILE` to run specific, project-relative test files in every phase, including witness runs. With Playwright the files are passed to `playwright test` as path filters, so a suite with several browsers and many specs can start with the one spec that covers the source. The report records the selection and errors if the config collects missing or additional test files. Any conclusions from a selected suite apply to that suite. Repeat `--copy-exclude PATH` to omit local assets or build caches from every temporary copy while leaving the original checkout intact. A selected suite should retain the files and build outputs it needs. The runner already omits `.worktree` and `.worktrees`. Source discovery skips excluded paths. Provide exclusions inside the project without traversing symbolic links, and keep `node_modules` available for the test runner.

Automatic scope includes JavaScript and TypeScript source, including JSX and module-specific extensions. It skips conventional test, spec, declaration and runner configuration filenames. With `--since`, Git supplies tracked and changed paths in bulk. Only changed tracked files in scope need a line diff. A new, untracked file counts as changed unless Git ignores it: generated clients and build output under `.gitignore` are left out of discovery, and naming such a file on the command line still selects it.

A comparison belongs to a line scope, from `--since` or `--lines`, when any line from its left operand to its right operand is in it. Changing only a threshold that sits on the line after its operator selects that comparison.

`--timeout SECONDS` sets the time limit for one run of the suite (default 60). It applies to each Vitest or Playwright start of the focused analysis and of `--witnesses`, and to the baseline and each fresh run of a session.

A trial in which the runner itself breaks down, so that there is neither a passing nor a failing suite to read, gets the status `error`. Such a trial is not a kill: the report's `evaluation` becomes `incomplete` and the command exits with 1, as it does for a failed baseline. In a session, an error raised outside any test while a mutation is active (for example in `afterAll`) is also reported as `error` for that mutation, and there the evaluation stays `evaluated`, because the suite did react to the mutation.

Project-internal symbolic links resolve inside each trial copy. Installed dependency directories remain available at their original positions relative to the project root, including workspace package directories. A copy exclusion can omit an entire package-local dependency directory. External links and installed dependencies are shared inputs. On POSIX, Vitest watchdog timeouts terminate the runner's process group.

Install Vitest or `@playwright/test` in the target project or its workspace before running the corresponding profile. TMT uses that runner's installed version and the target project's configuration. If the suite imports other dependencies hoisted above the target directory, analyze from the workspace root and scope the source and tests to the package.

The Vitest path runs an original baseline, a disabled-instrumentation baseline, and one isolated source rewrite for each trial. Instrumentation passes both evaluated operands to a comparison with the original operator. It records only JavaScript safe-integer pairs for prediction. The report identifies a Vitest test by project, relative file and task ID. Unattributed, unsupported or inconsistent observations keep the trial on the full-suite path. The product produces threshold replacements for directly callable exported unary arrows with a safe integer literal. It groups adjacent alternatives that agree on the safe integer domain. A matching specification entry with a rationale can supply the expected result and domain for the proposed test.

`--deterministic` declares that tests run from the same initial state and external inputs, and that a comparison influences execution only through its outcome. Tests that inspect source text or compare elapsed time are outside that contract. The runner compares two disabled traces. If only some tests reach a comparison, an independent counter in the second run must account for every entry to that comparison and match the observation count for each reaching test. Static, unknown and mismatched hits require a source trial. The compiled Lean executable validates the batch; missing tools, malformed data, retries, overlapping test options, or any rejected decision require a real run. `evidence: "predicted"` is a Lean-backed replay decision. `evidence: "reexecuted"` describes a source trial. The `--audit` option runs a full source rewrite and, where available, an independently activated probe, recording `agreed` for matching independent results, `mismatch` for a definitive disagreement, and `inconclusive` when an evaluation or its evidence is unavailable. For a callable threshold witness, audit also runs the generated Vitest assertion against original and rewritten source and checks both test inventories. The Lean theorem models deterministic comparison-driven executions, with JS instrumentation and run identity in the trusted runtime boundary.

The [recorded eligibility and shipping reports](../evidence/m2) show the standard boundary mutation and the generated threshold-shift rule. `npm test` also checks the distinction between reaching the boundary and asserting the returned value.

Threshold suggestions use a batch call to the compiled Lean evaluator when available. Its theorems identify the closed interval of observationally feasible integer thresholds and show that the reported adjacent witness separates every feasible alternative on its side. The JavaScript calculation provides the same report when the compiled evaluator is unavailable.

The focused probe preserves the execution format of CommonJS files and supports native `createRequire` calls. An activated probe must record the requested replacement at the selected comparison before its test verdict counts as audit evidence.

With `--deterministic` and complete, stable observations, the compiled replay decision can also skip reexecuting a generated integer-literal threshold alternative. `--audit` still runs the source rewrite and checks the result against the prediction.

Pass `--displace-thresholds` to try tightening strict comparisons by one integer step. For example, `measured.size > 0` becomes `measured.size > 1`, and `offset < source.length` becomes `offset < source.length - 1`. The rule requires complete safe-integer observations with a representable shifted bound and always runs the source rewrite. A surviving mutation can identify an observed result that changed or propose an operand pair to exercise. When the comparison is a directly callable exported unary arrow with an integer literal, an input gap includes a suggested assertion and `--audit` verifies it. Use an application-level test to confirm reachability and expected behavior for other comparisons.

### The value an assertion should compare with

A test can make the very call that tells an edit from your code and still pass, because its assertion does not pin the result down: `expect(fee(200, 3)).toBeGreaterThan(0)`, `expect(bucket(3)).not.toBe('none')`, a call whose result is not looked at. With `--suggest-assertions`, each finding that names such tests gets up to four of their calls run where the test makes them, once as they are and once with the edit:

```text
ASSERTION GAP src/fees.ts:1:53  arithmetic-swap/v1
  `cents * rate` passes every test as `(cents + rate)`
  the edit gives another value in: test/fees.test.ts > charges (operands 200, 3)
  add an assertion on what this value decides
  test/fees.test.ts > charges calls `fee(200, 3)` without pinning its result: it gives 600, and 203 with the edit
  suggested test: expect(fee(200, 3)).toBe(600)
```

- A call is taken when it calls a function the test file imports by name from the edited file, all its arguments are written values (numbers, text, `true`, `null`, arrays and objects of those), it stands on one line in a statement of the test itself (not in a loop, a branch or a callback), and its result is unused, bound to a variable, or checked by a matcher other than `toBe`, `toEqual`, `toStrictEqual`, `toBeNull`, `toBeUndefined`, `toBeNaN`, `toBeCloseTo`, `toMatchObject` and the snapshot matchers. A negated matcher pins nothing.
- The call is wrapped in the test file of a project copy, so it is evaluated where the test makes it, after everything the test did before. Only that test file runs. A value that is a number, text, a boolean, `null`, `undefined` or a bigint can be suggested; for any other value nothing is.
- The value of a call as it is is taken once and shared by the findings that name it. Each finding then costs one run per call tried, up to four, and at most 24 such runs are made in all.
- The suggestion stands for the weak assertion or the bare call, at its place. Where the test keeps the result in a variable, the variable is compared (`expect(id).toBe(2)`), since calling again may give another value. Where the edit keeps the test from making the call at all, nothing is suggested: an assertion there would not run either.
- The option applies to the focused, targeted, operators and full profiles on Vitest. In JSON the finding has `suggestedTest` and `strengthens` (`file`, `test`, `line`, `column`, `call`, `original`, `edited`).

### A change put back

With `--since REV`, `--undo-changes` also treats the code as it was as an edit. Each change in the selected source files is put back alone as it was at `REV`, and the suite runs against it in a fresh copy of the project. When every test passes, the tests do not tell the change from what was there before:

```text
src/session.ts:9:1  survived  change-undone/v1: return now - used < 30 && created <= used; as it was at 91e1dc927360

Test gaps:
UNTESTED CHANGE src/session.ts:9:1  change-undone/v1
  the tests pass with this change put back as it was at 91e1dc927360
  add a test that fails without the change
```

- A change is what Git reports as one hunk without context: changed lines next to each other are one change, and lines that were only removed are a change at the place they stood.
- A change that leaves the code as it is (comments, spacing, blank lines, the indentation of text between JSX tags) is not tried: the tokens and the syntax tree of the file are compared, so a line end that ends a statement counts. A file that is new since `REV` has nothing to put back, and a renamed or deleted file is not followed.
- A change that does not parse when it is put back alone (one of two braces) is listed as `unsupported` and not run. When a file has such a change and others, the file's changes in scope are also put back together, as one more edit.
- A change that parses and fails at run time when put back alone (it calls a function that only another change adds) fails the tests, or keeps the suite from loading, and counts as `killed`. Nothing here checks types.
- The tests stay as they are: a changed file that the suite runs as a test is not put back. `--lines` limits the changes to those that touch the given lines; a removal belongs to the lines around it.
- Each change costs one run of the suite, after one baseline run of its own. A refactoring passes with the old code by design; such a finding is expected.
- The option works with every profile except `--witnesses`, and with Playwright. In JSON the edits have the rule `change-undone/v1` and `since`, the report has `changesSince`, and a finding is a `diagnostics` entry of kind `UNTESTED CHANGE`.

### How mutations run on Vitest

Every profile on Vitest 4 with its default runner uses a test session. The session copies the project, rewrites each mutation into a runtime switch, and runs the suite once with every switch off to record which tests reach which switch. It then decides the mutations inside Vitest workers instead of starting one Vitest run per mutation.

For each test file, one worker takes that file's mutations in turn. A trial resets the module graph, restores timers, mocks and stubbed globals, loads the test file again, and runs only the tests that reach the mutation with its switch on. A mutation that the file reaches while loading is active from the load and runs all the file's tests. Directly after each trial the worker runs the same tests with every switch off. This control run must pass, with the same number of hits on the switch as in the baseline.

- When the control run differs, the worker itself has changed: a global, a counter inside a dependency, or anything else a module reset does not undo. That mutation gets a fresh Vitest run, and the test file's remaining mutations continue in a new worker. After eight such restarts the rest of that file's mutations get fresh runs too. A trial with an unhandled error or an error outside a test also gets a fresh run.
- A mutation that turns a loop endless stops at the hit limit, and one that leaves a promise unsettled stops at the test timeout. Both are `timeout`. A worker that stops answering altogether is replaced; its mutation is `timeout` with the reason `The worker stopped answering`, and the rest continue.
- A mutation is `killed` when any test file that reaches it fails, and `survived` when every such file passes with the switch on. Each mutation runs first in the test file where the baseline was cheapest for it, and the other test files run only the mutations that were not killed there, so a killed mutation usually lists the failing test of one file.
- A trial whose test file registers other tests than in the baseline is left to a fresh run. A worker that hangs in the control run, after a trial that finished, also leaves that mutation to a fresh run.

A mutation that a worker left to a fresh run carries the reason in `fallback`: `control-differs`, `worker-stopped` (the test file used up its restarts), `control-hung`, `unhandled-error`, `error-outside-tests`, `tests-changed`, `inconclusive` or `not-answered`.

Test files run beside each other, each in its own worker, unless the project sets `fileParallelism: false`. `--concurrency N` sets the number of workers (default: the CPU count minus one). The session starts with one Vitest instance and opens another only when, two seconds into the trials, one test file still has more than six seconds of measured work left. `--isolated-trials` gives every mutation a fresh Vitest run from the start; use it for a suite whose tests depend on state from earlier tests in ways a control run would not show. `--verify-trials N` runs N of the worker-decided mutations again in fresh runs, keeps the fresh verdict and lists any difference. The report's `trials` field counts these: `{ "workers": 1, "inWorker": 180, "isolated": 10, "verified": { "sampled": 5, "mismatches": [] } }`.

Two limits come with runtime switches, here as in StrykerJS. A test that reads source text or positions (`Function.prototype.toString`, stack frames, snapshot of an error's line, the message of a `TypeError` that quotes the expression) sees the switched code and not the mutated file. A Vite plugin that rewrites the project's source at build time receives the switched expression, so a compile-time transform may treat it differently from the mutation written out. `--audit` in the default profile, and the Playwright path, run the edit as plain source instead.

The default profile uses the same session. Its comparison boundaries, `>=` with `>` and `<=` with `<`, are decided in a worker. So are its threshold edits and the tightened comparisons of `--displace-thresholds`: every comparison gets one more switch that moves its right side by an integer chosen at run time, and once the recorded comparisons show which thresholds to try, the session runs them through that switch. `n >= 100` with a shift of 3 behaves as `n >= 103`. The profile starts Vitest once on its own, for the run that records the comparisons; that run also serves as its baseline when it passes, because the session runs the suite beside it. When the recording run does not pass, the plain baseline runs and is reported as before. `--audit` and Playwright run every edit against the rewritten source instead.

### Targeted edits

`--mutators targeted` adds eleven rules to the focused profile. Each replaces one expression by another that gives the same value for some operands and a different one for others, and still evaluates what the original evaluates.

| Rule | Code | Edit | Differs when |
|------|------|------|--------------|
| `equality-constant/v1` | `a === b`, `!==`, `==`, `!=` | `(a, b, true)`, `(a, b, false)` | the comparison gives the other value |
| `ignored-operand/v1` | `a && b`, `a \|\| b`, `a ?? b` | `(a, b)`: the left side decides nothing | the original would not have evaluated `b` |
| | | `a && (b, true)`, `a \|\| (b, false)`, `a ?? (b, undefined)`: the right side's value is not used | `b` is evaluated and gives another value |
| `nullish-fallback/v1` | `a ?? b`, and `a \|\| b` where its value is used | `a \|\| b`, `a ?? b` | `a` is `0`, `0n`, `''`, `false` or `NaN` |
| `nullish-equality/v1` | `a === null`, `a !== undefined` | `a == null`, `a != undefined` | `a` is the other of `null` and `undefined` |
| | `a == null`, `a != null` | `a === null` and `a === undefined` | `a` is the one the edit leaves out |
| `arithmetic-swap/v1` | `a + b`, `-`, `*`, `/`, `%` | two other operators each: `+` to `-` and `*`, `-` to `+` and `/`, `*` to `/` and `+`, `/` to `*` and `%`, `%` to `/` and `+` | the two operators give different results (`fee` is not 0, `factor` is not 1) |
| `extreme-swap/v1` | `Math.max(a, b)`, `Math.min(a, b)` | the other of the two | the arguments differ |
| `rounding-swap/v1` | `Math.floor(x)`, `ceil`, `round`, `trunc` | `floor` to `ceil`, `round` and `trunc`; the others to `floor` and one more | `x` is not whole (for `floor` and `trunc`: negative and not whole) |
| `sequence-end/v1` | `list[0]`, `list.at(0)`, `list.at(-1)`, `list[list.length - 1]` | the other end | the first element is not the last |
| | `find` and `findLast`, `findIndex` and `findLastIndex`, `indexOf` and `lastIndexOf` | the other of the two | more than one element matches |
| `sort-order/v1` | `list.sort((a, b) => a - b)`, `list.toSorted((a, b) => a - b)` | `list.sort()`, `list.toSorted()` | numbers are in another order as text (9 and 10) |
| `await-dropped/v1` | `await save(x);` as a statement | `void save(x);` | the tests look at what the call has done before what follows it goes on |
| `copy-dropped/v1` | `[...list]`, `{ ...record }` as the whole literal | `(list)`, `(record)` | the tests change the copy and look at the original, or compare the two objects |

With Vitest 4 each such expression becomes a probe in the test session. While the baseline runs, the probe notes for every edit of the expression and for every test whether the edit would have given the same value after evaluating the same operands. The edits then run like any other switch, against the tests that reach them. A survivor is reported with what the recording says about it:

```text
INPUT GAP src/cart.ts:12:10  nullish-fallback/v1
  `count ?? 10` passes every test as `(count || 10)` (3 tests reach it)
  add a test in which `count` is 0, '', false or NaN
ASSERTION GAP src/form.ts:31:20  ignored-operand/v1
  `!saving && valid` passes every test as `(!saving, valid)`
  the edit gives another value in: test/form.test.ts > submits (operands false)
  add an assertion on what this value decides
```

An `INPUT GAP` means the edit agreed with the original at every evaluation in every passing test: no test has the input that tells them apart, and `missing` names it. An `ASSERTION GAP` lists the tests in which the edit went another way and that passed all the same, with the operands of the first such evaluation. In JSON the entries are in `diagnostics`, with `expression`, `missing`, `reachedBy`, `tests` and `example`.

For an edit that survived, the session also compares what each of its tests reached with the edit and without it. Where a test now evaluates an expression it did not reach before, or no longer evaluates one, the finding says so, for up to three expressions each way: `with the edit, \`rejects\` also evaluates \`value + 0\` (src/store.ts:5)`. Only expressions that carry a switch of the profile are seen. In JSON this is `effects`, with `nowRuns` and `noLongerRuns`.

- Where only the truth of the value is used (a condition, under `!`, or an operand of `&&` or `||` used that way), an ignored right operand counts as agreeing when the truth is the same. Elsewhere the values must be the same, and `0` is not `-0`.
- Beside a written literal on the right (`retries ?? 0`), an edit that evaluates the literal where the original does not agrees whenever the values are the same. Any other right side is not evaluated to compare.
- The probe works an edit out again only where that has no effect: arithmetic on numbers, text and other plain values, the functions of `Math` on numbers, and the ends of arrays and of text. With an object among arithmetic operands, with something that is neither an array nor text, and for `find` on more than one element (its callback would run again), the recording cannot tell. A survivor is then an `INPUT GAP` marked `uncertain`, with the tests in which that happened: they may already have the input and only lack the assertion.
- The last two rules change when something happens and which object is which, not a value, so no recording can judge them. Their edits are run like the others, and a survivor is an `ASSERTION GAP` with `advice` on what to assert in place of a missing input.
- A sort is edited only where its comparison is written as `(a, b) => a - b`. The probe sorts a copy of its own to compare, where the array is a built-in one with its own `sort` and every element is a number or text.
- `+` beside a string or template literal is left alone. `Math.max` and `Math.min` are edited with exactly two arguments. An element that is assigned, updated, deleted, called, or reached through `?.` is left alone, and `list[list.length - 1]` is taken for a last element only where `list` is a name or a chain of property names.
- `??` and `||` give the same for `null`, `undefined` and every object. When no test gave the left side a number, a string or a boolean and the two never differed, the edit is listed as `ignored` and not run. `||` is not taken for `??` where only the truth of its value is used.
- The strict and loose comparison edits are offered only beside a written `null` or `undefined`.
- A logical expression whose right side contains `await` or `yield` gets no probe and no targeted edit.
- The proof in `proof/lean/Main.lean` (`Agreement.agreeing_edit_replays`) states the claim behind an input gap: an edit that gives the original's outcome at every probe of a run leaves that run as it is. It assumes what `--deterministic` declares, so every targeted edit is still run and the recording decides only what the report says about a survivor.
- With Playwright, or when the session cannot start, the edits are source rewrites with one run of the suite each, and nothing is recorded: a survivor is listed without a gap.
- `// Stryker disable all` and its other forms apply; the rule names contain a slash and cannot be named in such a comment.

### Built-in operator edits

`--mutators operators` adds fixed operator swaps to the focused profile: `===` and `!==`, `==` and `!=`, `&&` and `||`, `??` to `&&`, `+` and `-`, `*` and `/`, and `%` to `*`. The sites come from the TypeScript syntax tree, so operator spellings in types, strings, comments and JSX text are ignored. `+` with a string or template literal operand, a `??` chained directly with another `??`, and enum member initializers are left alone. A swap replaces the operator of one expression and keeps that expression's grouping: in `a && b && c` the first swap means `(a || b) && c`. The profile needs no extra package.

With Vitest 4 and its default runner, the tool rewrites each operator into a switch, `on(id) ? edited : (cover(id), original)`, and drives one test session: a baseline run records which tests reach each switch, and every swap then runs only those tests with its switch on. A swap that no test reaches is reported as `unreached`. Comparison edits in the same scope still go through the focused analysis, including Lean replay and threshold diagnostics. That analysis records its comparisons while the session runs and takes the session's verdict for each comparison boundary. The report's `operatorExecution` is `session`.

With Playwright, or when the session cannot start (another Vitest major, a custom runner, browser mode or type checking), each swap is a source rewrite followed by one run of the suite, and `operatorExecution` is `source-rewrite`. Reach is not measured on that path, so a swap in code that no test executes is reported as `survived`. Use `--lines` or `--since` to bound the number of runs.

### Complete built-in mutation set

`--mutators full` adds every StrykerJS mutator to the focused profile without the StrykerJS packages: ArithmeticOperator, ArrayDeclaration, ArrowFunction, AssignmentOperator, BlockStatement, BooleanLiteral, CallExpression (removal of a call or `throw new` statement), ConditionalExpression, EqualityOperator, LogicalOperator, MethodExpression, ObjectLiteral, OptionalChaining, Regex, StringLiteral, UnaryOperator and UpdateOperator. The mutations are found in the TypeScript syntax tree and reported with the StrykerJS mutator names, the original text and the replacement. The repository's tests compare the set with the StrykerJS instrumenter's on TypeScript, TSX and JavaScript sources.

Execution is the same as for `operators`: on Vitest 4 one switched session with per-test coverage, otherwise one source rewrite per mutation (`operatorExecution` tells which). A comparison boundary such as `>=` to `>` is reported once, by the focused analysis, with its missing input.

`// Stryker disable all`, `// Stryker disable next-line EqualityOperator: reason`, `// Stryker restore all` and their other forms are read as StrykerJS reads them. A comment counts when it leads a statement or expression, so one placed directly before a closing brace has no effect. An ignored mutation is listed with the status `ignored` and its reason in `statusReason`, and gets no switch. A comparison boundary under such a comment is left out of the default profile too, and the file's `extraction` entry counts it in `ignored`.

Differences from a StrykerJS run: a `for (;;)` loop directly under a label keeps its missing condition; a `case` clause that declares a `let`, `const`, class or function is not emptied, because later clauses can see that declaration; and like StrykerJS the set leaves types, imports, enums, ambient declarations, decorators, directives, property names and the inside of `x as T` alone.

### Standard mutation profile

`--mutators standard` enables the pinned StrykerJS instrumenter's default TypeScript and TSX mutation families, including source comments that disable mutation. The profile applies a line range to complete mutable syntax nodes. It runs a disabled-switch baseline and trials in a disposable project workspace, as described under [How mutations run on Vitest](#how-mutations-run-on-vitest). Import-time hits run the file's tests with the mutation active at module load. An unreached mutation uses baseline coverage evidence. A partial session reports any remaining trials as unevaluated and exits with an error.

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
npx targeted-mutation analyze . src/button.tsx --runner playwright --project chromium --audit
```

Use `--config` for a nonstandard Playwright config path. Each trial launches a separate Playwright runtime in a temporary checkout with one worker. The config wrapper disables web server reuse. Trial output identifies the attempt, runner process, project, browser, worker and test. A cooperating local server can write its process ID to `TMT_SERVER_PID_FILE`. A test whose attempt is unstable, timed out, has changed inventory or failed setup has a separate outcome.

The browser path currently uses full source rewrites. It supports the four comparison mutations and the left-operand deletion rule for a JSX `disabled` expression of the form `left || right`. It accepts an optional `playwright` array in the specification JSON. Each entry identifies a file, rule, operator and optional line, records an independent requirement, and points to a witness test relative to the root. The CLI runs the added test against both original and rewritten source and verifies the test inventory. The audit repeats the full source trial. Git scope correctly limits these runs to candidates on changed operator lines.

The fixture accepts a loopback port from `PORT`. The integration tests and the evidence script start their own instances of that fixture. Playwright's global timeout reserves time for orderly shutdown before the runner's process-group deadline.

Playwright needs a loopback `webServer` command rooted in each trial copy. If `use.baseURL` is set, its origin must match a managed server. The tool resolves Playwright from the target workspace. Server commands and tests must exercise the copied sources, including any paths they construct dynamically. A witness can set `witnessDirectory` when the relevant project collects tests outside the directory of the first passing baseline test.

For the pending Save fixture, StrykerJS 10.1.1's command runner killed its five generated mutants with both suites. Its replacement list did not include dropping the saving operand to get `!valid`. TMT ran that source rewrite against both suites, and the added pending-request test killed it. This comparison uses the StrykerJS command runner with coverage disabled, so it does not establish a relative runtime for StrykerJS with per-test runner coverage. The [JSON evidence](../evidence/m3) records both experiments.

## Distinguishing witnesses

`--witnesses` runs the Vitest witness profile. It searches for a source rewrite that survives the selected tests, then checks an input edit or assertion that distinguishes it. It runs each trial in a fresh copy and reports a confirmed gap when the original passes and the attributed assertion fails with the expected alternate value. Source and fixture edit offsets are half-open UTF-8 byte ranges.

Every candidate is tried in its own copy of the project, and so is each run that verifies a proposed test. The copies are independent, so the profile runs several at once: up to eight by default, or the number given with `--concurrency N`. The report lists the candidates in the order they were planned, whatever order they finished in.

```sh
npx targeted-mutation analyze fixtures/witnesses src/queries.ts --witnesses --test test/queries.test.ts
npx targeted-mutation analyze fixtures/witnesses src/text-order.ts --witnesses --test test/text-order.test.ts --spec order-spec.json
npx targeted-mutation analyze fixtures/witnesses src/contracts.ts --witnesses --test test/contracts.test.ts
```

The automatic rules handle same-type safe integer arguments and numeric fields of an inline object type in an ordered comparison, `indexOf` versus `lastIndexOf` on numeric arrays, any versus all bits in a nonnegative 31-bit mask, and one extra element in a `slice(0, count).reduce(...)` sum. They use direct Vitest calls with literal arguments and a scalar `toBe` assertion as seeds. Calls may appear inside nested `describe` or `suite` blocks with literal titles. JavaScript named exports can use JSDoc parameter annotations, and the numeric-array `indexOf` rule can use an unannotated function with literal numeric fixtures. A finding includes a minimized single-literal edit where the observed assertion still holds for the original implementation. Otherwise it can verify a separate assertion in the selected test file. Automatic expectations come from the original implementation. The automatic search evaluates up to 32 eligible rewrites and four one-edit proposals per surviving rewrite.

`witnessSearch` reports scoped single-rule source candidates, how many matched passing test seeds, how many were evaluated, and how many hit the evaluation cap. `unmatched` is null when a diagnostic or a failed baseline prevented matching. A matched seed can lack a supported distinguishing edit. Paired and public-state witness plans have separate evaluation results.

For string-length functions, ASCII assertions can seed a one-character witness. The profile compares `Array.from(text).length` with UTF-8 byte length and `text.length` with code-point length. For example, `é` distinguishes one code point from two bytes, and `😀` distinguishes two UTF-16 code units from one code point.

For sorts with inline record types, the profile supports `toSorted((a, b) => a.key - b.key)` and `[...rows].sort(...)` when the test observes order through a scalar `.map(row => row.id).join(...)` assertion. It changes one alternate-key value to reverse a pair's relative order. In `--spec`, each `sortConstraints` entry identifies a `file`, exported `function`, numeric `before` field, and numeric `after` field. The seed and proposal must satisfy `before <= after` on every row. Entries for selected files must resolve to a supported sort.

The profile discovers up to 32 additional state and pair plans. It can link matching 16- or 32-bit `DataView` byte-order edits when a selected passing test passes an encoder result to the decoder through a nested call or one immutable binding. For a rejected batch with an upfront `.some(...)` guard, it can borrow a map-backed public reader from a passing test for the same class in the same test module and use a key from the rejected batch. The report records both the donor's argument and the generated argument. These observations preserve the original behavior. Use an explicit plan when the expectation comes from an external contract.

With `--spec`, `witnessPlans` adds up to 32 explicit plans. Each plan supplies a name, requirement, project-relative test file, uniquely named existing seed test, one or two source edits, and a public observation. Each edit includes a project-relative source file, a one-based line, and exact original and replacement text. Every edit must be in scope and match exactly once on its line. The `observe` expression runs in the seed test module and can use its local imports. Supply distinct scalar `expected` and `alternate` values from a specification. A paired finding requires the same seed test to fail on each source edit alone, the original suite to pass with both edits applied, and the new assertion to distinguish the pair.

The [explicit witness fixture](../fixtures/witnesses/witness-spec.json) checks an atomic batch through a public read and a little-endian wire format through a fixed byte assertion. The runner executes project test code and the supplied witness expression. Reports can include fixture values, paths, and the supplied expression. The witness profile uses project scope and Vitest test/config selection. Use its reexecuted verdicts to inspect candidate source edits and the separately confirmed diagnostics to identify executable tests.
