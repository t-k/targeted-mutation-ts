# Analyzing a project

Install `targeted-mutation` in the project as described in the [README](../README.md). The examples below use files from this repository's `fixtures/`. In a checkout of this repository, build with `npm ci`, `npm run build:native` and `npm run build:lean`, and run `npx targeted-mutation` in place of `targeted-mutation`.

```sh
npx targeted-mutation analyze fixtures/eligibility src/eligibility.ts --spec spec.json --deterministic --audit
npx targeted-mutation analyze . --lines src/eligibility.ts:1-8 --audit
npx targeted-mutation analyze . --since "$(git merge-base origin/main HEAD)"
```

Arguments after the project root select source files. Without files, the CLI discovers TypeScript and TSX sources. The scope comes from explicit line ranges and added or changed lines relative to a Git commit. The CLI parses each selected file before filtering candidate operator positions. The JSON report has a schema version, extraction outcomes, candidate IDs, trial verdicts and diagnostics. A terminal shows a text summary of the same report; a pipe or `--format json` receives the JSON. Pass `--json-out FILE` and/or `--sarif-out FILE` to write machine-readable report files alongside terminal text output (all output paths, including `--write-baseline` and `--checkpoint`, must be distinct). Under `--mutators full`, the summary distinguishes targeted test gaps from non-targeted survivors (`N targeted gap(s) (M other survivor(s))`). `--lines FILE:N` selects a single line. A failed baseline lists the failed tests and their messages under `baseline.failedTests`. An extraction diagnostic or a baseline failure exits with status 1. A successful analysis exits with status 0.

### Limit a dogfood or CI run

```sh
npx targeted-mutation analyze . packages/example/src/ranges.ts --since HEAD^ \
  --config vitest.config.ts --test packages/example/test/ranges.test.ts \
  --copy-exclude benchmarks --audit
```

`--config` selects a project-relative Vitest or Playwright config. Repeat `--test FILE` to run specific, project-relative test files in every phase, including witness runs. For Vitest projects, `--related` (or `related: true` in project configuration) discovers only the test files and Vitest projects related to the scoped source files via Vitest's dependency graph inside a supervised temporary copy, failing with a clear `--test <FILE>` hint if no related tests exist. `--type-check` is enabled automatically when a nearest (or Project References) `tsconfig.json` has `strictNullChecks` enabled, lazily creating a TypeScript program only when a file contains `nullish-fallback/v1` or `nullish-equality/v1` candidates (use `--no-type-check` or `"typeCheck": false` to disable, or pass `--type-check` / `--tsconfig <FILE>` explicitly to warn if inactive). It skips statically equivalent `nullish-fallback/v1` and `nullish-equality/v1` edits (while preserving unsound cases such as `number | null` with `?? 0`, indexed access without `noUncheckedIndexedAccess`, `{}`, `void`, and shadowed `undefined`). With Playwright the files are passed to `playwright test` as path filters, so a suite with several browsers and many specs can start with the one spec that covers the source. The report records the selection and errors if the config collects missing or additional test files. Any conclusions from a selected suite apply to that suite. Repeat `--copy-exclude PATH` to omit local assets or build caches from every temporary copy while leaving the original checkout intact. Missing exclusion paths emit a single warning to `stderr` and are skipped so fixed scripts work on clean checkouts before build artifacts exist. A selected suite should retain the files and build outputs it needs. The runner already omits `.worktree` and `.worktrees`. Source discovery skips excluded paths. Provide exclusions inside the project without traversing symbolic links, and keep `node_modules` available for the test runner.

Automatic scope includes JavaScript and TypeScript source, including JSX and module-specific extensions. It skips conventional test, spec, declaration and runner configuration filenames. With `--since`, Git supplies tracked and changed paths in bulk. Only changed tracked files in scope need a line diff. A new, untracked file counts as changed unless Git ignores it: generated clients and build output under `.gitignore` are left out of discovery, and naming such a file on the command line still selects it.

A comparison belongs to a line scope, from `--since` or `--lines`, when any line from its left operand to its right operand is in it. Changing only a threshold that sits on the line after its operator selects that comparison.

`--timeout SECONDS` sets the time limit for one run of the suite (default 60). It applies to each Vitest or Playwright start of the focused analysis and of `--witnesses`, and to the baseline and each fresh run of a session.

A trial in which the runner itself breaks down, so that there is neither a passing nor a failing suite to read, gets the status `error`. Such a trial is not a kill: the report's `evaluation` becomes `incomplete` and the command exits with 1, as it does for a failed baseline. In a session, an error raised outside any test while a mutation is active (for example in `afterAll`) is also reported as `error` for that mutation, and there the evaluation stays `evaluated`, because the suite did react to the mutation.

Project-internal symbolic links resolve inside each trial copy. Installed dependency directories remain available at their original positions relative to the project root, including workspace package directories. A copy exclusion can omit an entire package-local dependency directory. External links and installed dependencies are shared inputs. On POSIX, Vitest watchdog timeouts terminate the runner's process group.

Install Vitest or `@playwright/test` in the target project or its workspace before running the corresponding profile. TMT uses that runner's installed version and the target project's configuration. If the suite imports other dependencies hoisted above the target directory, analyze from the workspace root and scope the source and tests to the package.

The Vitest comparison path runs a baseline, a disabled-instrumentation trace, and switched or isolated source trials. Instrumentation passes both evaluated operands to a comparison with the original operator and records JavaScript safe-integer pairs for prediction. The report identifies a Vitest test by project, relative file and task ID. Unattributed, unsupported or inconsistent observations keep a trial on the full-suite execution path. Across all four comparison operators (`<`, `<=`, `>`, `>=`), the analyzer generates `comparison-threshold/v1` replacements for any comparison whose right-hand side evaluates to a constant safe integer across all observations — whether written as a literal (`18`) or a constant expression (`LIMIT`) — and `comparison-margin/v1` replacements for varying right-hand sides whose integer differences `lhs - rhs` leave an unpinned safe-integer margin (verified by `tmt-decide margins` via Lean 4 `Margin` theorems). Adjacent integer-literal alternatives that agree on the safe-integer domain with the boundary toggle are annotated with `equivalentOnSafeIntegers` instead of duplicated. For exported unary arrow functions (expression or block body) and exported unary `function` declarations, the report also generates a ready `suggestedTest` assertion; a matching specification entry with a rationale can supply the expected result and domain.

`--deterministic` declares that tests run from the same initial state and external inputs, and that a comparison influences execution only through its outcome. Tests that inspect source text or compare elapsed time are outside that contract. The runner compares two disabled traces. If only some tests reach a comparison, an independent counter in the second run must account for every entry to that comparison and match the observation count for each reaching test. Static, unknown and mismatched hits require a real execution. The compiled Lean 4 executable (`tmt-decide`) validates each replay batch across boundary flips and all four literal-threshold operators (`<`, `<=`, `>`, `>=`); missing tools, malformed data, retries, overlapping test options, or any rejected decision fall back to a real run. `evidence: "predicted"` is a Lean-checked replay decision. `evidence: "reexecuted"` describes an executed trial. The `--audit` option runs a full source rewrite and, where available, an independently activated probe, recording `agreed` for matching independent results, `mismatch` for a definitive disagreement, and `inconclusive` when an evaluation or its evidence is unavailable. For a callable threshold witness, audit also runs the generated Vitest assertion against original and rewritten source and checks both test inventories. In the trusted computing base (TCB), the Lean 4 proof covers the mathematical equivalence of the replay/threshold interval model and its extremal summary reduction, while JavaScript instrumentation, observation collection, extremal summary extraction, IPC serialization, and test/run identity remain in the trusted runtime boundary.

The [recorded eligibility and shipping reports](../evidence/m2) show the standard boundary mutation and the generated threshold-shift rule. `npm test` also checks the distinction between reaching the boundary and asserting the returned value.

Threshold suggestions use a batch call to the compiled Lean evaluator when available. Its theorems identify the closed interval of observationally feasible integer thresholds for all four operators (`<`, `<=`, `>`, `>=`) and prove that the reported adjacent witness separates every feasible alternative on its side. The JavaScript calculation provides the same report when the compiled evaluator is unavailable (for example on platforms without a prebuilt platform package).

The comparison probe preserves the execution format of CommonJS files and supports native `createRequire` calls. An activated probe must record the requested replacement at the selected comparison before its test verdict counts as audit evidence.

With `--deterministic` and complete, stable observations, the compiled replay decision can also skip reexecuting a generated integer-literal threshold alternative across `<`, `<=`, `>`, `>=`. `--audit` still runs the source rewrite and checks the result against the prediction.

Pass `--displace-thresholds` to try tightening strict comparisons by one integer step (for example `offset < source.length` to `offset < source.length - 1`). Shifts already covered by `comparison-threshold/v1` are deduplicated rather than run twice. The rule requires complete safe-integer observations with a representable shifted bound and complements constant-RHS threshold gaps on variable right-hand sides and observed-boundary assertion gaps. When the comparison is a directly callable exported unary function with an integer literal, an input gap includes a suggested assertion and `--audit` verifies it. Use an application-level test to confirm reachability and expected behavior for other comparisons.

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

- A call is taken when it calls a function the test file imports from the edited file (named, default, or namespace import `ns.fn(...)`, directly or through `tsconfig.json` `paths`/`baseUrl` aliases and barrel re-exports, without being shadowed by a local binding), optionally preceded by `await`, all its arguments are written values (numbers, text, `true`, `null`, arrays and objects of those), it stands on one line in a statement of the test itself (not in a loop, a branch or a callback), and its result is unused, bound to a variable, or checked by a matcher other than `toBe`, `toEqual`, `toStrictEqual`, `toBeNull`, `toBeUndefined`, `toBeNaN`, `toBeCloseTo`, `toMatchObject` and the snapshot matchers. A negated matcher pins nothing.
- The call (including any surrounding `await`) is wrapped in the test file of a project copy, so it is evaluated where the test makes it, after everything the test did before. Only that test file runs. On Vitest 4 and 5 (without `--isolated-trials`), all recordings share one temporary copy and one warm Vitest instance (`isolate: true` per run); otherwise candidate findings run concurrently in deterministic batches. Primitives (numbers, strings, booleans, `null`, `undefined`, bigints) suggest `toBe(...)`, and plain, acyclic, bounded same-realm arrays and objects (canonicalized by key order, inspected without invoking getters or Proxy traps) suggest `toStrictEqual(...)`. Exotic values (functions, class instances, Proxies, getters, null-prototype objects, cross-realm objects, array subclasses, sparse arrays, or oversized structures) are skipped.
- Each call's original value is recorded once and shared across findings. Each finding costs at most four edit runs, and at most 24 edit runs are made in all.
- The suggestion stands for the weak assertion or the bare call, at its place. Where the test keeps the result in a variable, the variable is compared (`expect(id).toBe(2)`), since calling again may give another value. When a multi-key plain object return value differs along a single sibling property path (present in both original and edited values), the suggestion narrows to that path (`expect(res.fee).toBe(600)` or `expect(res["net-fee"]).toBe(400)`) and records `path` on `strengthens`; multi-field diffs and missing-key diffs fall back to full `toStrictEqual(...)`. Where the edit keeps the test from making the call at all, or produces an unformattable value, nothing is suggested.
- The option applies to the `targeted` and `full` profiles on Vitest. In JSON the finding has `suggestedTest` and `strengthens` (`file`, `test`, `line`, `column`, `call`, `original`, `edited`).

### A change put back

With `--since REV`, `--undo-changes` also treats the code as it was as an edit. Each change in the selected source files is put back alone as it was at `REV`, and the suite runs against it in a fresh copy of the project. When every test passes, the tests do not tell the change from what was there before:

```text
src/session.ts:9:1  survived  change-undone/v1: return now - used < 30 && created <= used; as it was at 91e1dc927360

Test gaps:
UNTESTED CHANGE src/session.ts:9:1  change-undone/v1
  the tests pass with this change put back as it was at 91e1dc927360
  add a test that fails without the change
```

- A change is what Git reports as one hunk without context: changed lines next to each other are one change, and lines that were only removed are a change at the place they stood. Within a parseable hunk that adds multiple `&&`/`||` terms to a logical chain or multiple static properties to an object literal, the planner also emits independent sub-hunk trials (`subhunk: "logical-term"` or `"object-property"`) that revert one added term or property at a time without deleting pre-existing items.
- A change that leaves the code as it is (comments, spacing, blank lines, the indentation of text between JSX tags) is not tried: the tokens and the syntax tree of the file are compared, so a line end that ends a statement counts. A file that is new since `REV` has nothing to put back, and a renamed or deleted file is not followed.
- A change that does not parse when it is put back alone (one of two braces) is listed as `unsupported` and not run. When a file has such a change and others, the file's changes in scope are also put back together, as one more edit.
- A change that parses but fails to load a test module when put back alone (for example removing a helper or export referenced at module load time) is reported as `load_error` rather than falsely counted as `killed`. When a multi-hunk file hits `load_error` on a single hunk and has no combined trial yet, the analyzer dynamically runs one `together: true` trial reverting all in-scope hunks of that file together. Post-load unhandled errors or runner failures are reported as `error` and mark `evaluation: "incomplete"`. Nothing here checks types.
- The tests stay as they are: a changed file that the suite runs as a test is not put back. `--lines` limits the changes to those that touch the given lines; a removal belongs to the lines around it.
- When the surrounding analysis already ran an uninstrumented passing baseline (such as `--audit` or Playwright), `--undo-changes` reuses it instead of running a duplicate baseline; otherwise it runs its own plain baseline first. Each change then costs one run of the suite. A refactoring passes with the old code by design; such a finding is expected.
- The option works with `targeted` and `full` (not `--witnesses`), and with Playwright. In JSON the edits have the rule `change-undone/v1` and `since`, the report has `changesSince`, and a finding is a `diagnostics` entry of kind `UNTESTED CHANGE`.

### How mutations run on Vitest

Every profile on Vitest 4 and 5 with its default runner uses a test session. The session copies the project, rewrites each mutation into a runtime switch, and runs the suite once with every switch off to record which tests reach which switch. It then decides the mutations inside Vitest workers instead of starting one Vitest run per mutation.

For each test file, one worker takes that file's mutations in turn. A trial resets the module graph, restores timers, mocks and stubbed globals, loads the test file again, and runs only the tests that reach the mutation with its switch on. A mutation that the file reaches while loading is active from the load and runs all the file's tests. Directly after each trial the worker runs the same tests with every switch off. This control run must pass, with the same number of hits on the switch as in the baseline.

- When the control run differs, the worker itself has changed: a global, a counter inside a dependency, or anything else a module reset does not undo. That mutation gets a fresh Vitest run, and the test file's remaining mutations continue in a new worker. After eight such restarts the rest of that file's mutations get fresh runs too. A trial with an unhandled error or an error outside a test also gets a fresh run.
- A mutation that turns a loop endless stops at the hit limit, and one that leaves a promise unsettled stops at the test timeout. Both are `timeout`. A worker that stops answering altogether is replaced; its mutation is `timeout` with the reason `The worker stopped answering`, and the rest continue.
- A mutation is `killed` when any test file that reaches it fails, and `survived` when every such file passes with the switch on. Each mutation runs first in the test file where the baseline was cheapest for it, and the other test files run only the mutations that were not killed there, so a killed mutation usually lists the failing test of one file.
- A trial whose test file registers other tests than in the baseline is left to a fresh run. A worker that hangs in the control run, after a trial that finished, also leaves that mutation to a fresh run.

A mutation that a worker left to a fresh run carries the reason in `fallback`: `control-differs`, `worker-stopped` (the test file used up its restarts), `control-hung`, `unhandled-error`, `error-outside-tests`, `tests-changed`, `inconclusive` or `not-answered`.

Test files run beside each other, each in its own worker, unless the project sets `fileParallelism: false`. `--concurrency N` sets the number of workers (default: the CPU count minus one). The session starts with one Vitest instance and opens another only when, two seconds into the trials, one test file still has more than six seconds of measured work left. `--isolated-trials` gives every mutation a fresh Vitest run from the start; use it for a suite whose tests depend on state from earlier tests in ways a control run would not show. `--verify-trials N` runs N of the worker-decided mutations again in fresh runs, keeps the fresh verdict and lists any difference. The report's `trials` field counts these: `{ "workers": 1, "inWorker": 180, "isolated": 10, "verified": { "sampled": 5, "mismatches": [] } }`.

Two limits come with runtime switches, here as in StrykerJS. A test that reads source text or positions (`Function.prototype.toString`, stack frames, snapshot of an error's line, the message of a `TypeError` that quotes the expression) sees the switched code and not the mutated file. A Vite plugin that rewrites the project's source at build time receives the switched expression, so a compile-time transform may treat it differently from the mutation written out. `--audit` in the default profile, and the Playwright path, run the edit as plain source instead.

The default profile uses the same session. Its comparison boundaries, `>=` with `>` and `<=` with `<`, are decided in a worker. So are its threshold edits and the tightened comparisons of `--displace-thresholds`: every comparison gets one more switch that moves its right side by an integer chosen at run time, and once the recorded comparisons show which thresholds to try, the session runs them through that switch. `n >= 100` with a shift of 3 behaves as `n >= 103`. The profile starts Vitest once on its own, for the run that records the comparisons; that run also serves as its baseline when it passes, because the session runs the suite beside it. When the recording run does not pass, the plain baseline runs and is reported as before. `--audit` and Playwright run every edit against the rewritten source instead.

### Targeted edits (default)

`--mutators targeted` is the default profile. It combines comparison boundaries (`<`, `<=`, `>`, `>=`) and constant-RHS integer thresholds with eleven value-aware rules. Each rule replaces one expression by another that gives the same value for some operands and a different one for others, and still evaluates what the original evaluates.

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
| `copy-dropped/v1` | `[...list]`, `{ ...record }` as the whole literal | `(list)`, `(record)` | the tests change the copy and look at the original, compare the two objects, or rely on converting a non-array iterable / non-plain object |
| `spread-property-drop/v1` | `{ ...base, k1: v1, k2: v2 }` (single leading spread, static non-`__proto__` keys) | drop one explicit property at a time | `base[k]` is missing or differs from `v` under `Object.is` (impure same-value initializers are reported as uncertain) |
| `prefix-to-substring/v1` | `s.startsWith(p)`, `s.endsWith(p)` | `s.includes(p)` | `s` contains `p` somewhere other than the start or end |
| `replace-multiplicity/v1` | `s.replace(a, b)`, `s.replaceAll(a, b)` (non-RegExp-literal first arg) | the other of the two | `s` contains the searched text more than once |
| `clamp-bound/v1` | `Math.min(Math.max(x, lo), hi)`, `Math.max(Math.min(x, hi), lo)` | drop the outer (or literal inner) clamp bound | `x` exceeds the dropped upper or lower clamp bound |
| `literal-set-prune/v1` | `[v1, v2, ...].includes(x)` (2–16 primitive literals, unique under SameValueZero) | remove one literal element | `x` matches the removed element |
| `merge-precedence/v1` | `{ ...a, ...b }` | `{ ...b, ...a }` | `a` and `b` share an own key (string or Symbol) with different values |
| `quantifier-swap/v1` | `arr.every(fn)`, `arr.some(fn)` | the other of the two | `arr` is empty or has elements where `fn` gives both true and false |
| `regex-anchor-slack/v1` | `/^...$/.test(s)` | drop leading `^` or trailing `$` | `s` matches without the removed anchor |
| `cleanup-dropped/v1` | expression-statement call directly inside `try { ... } finally { ... }` | `;` | the tests assert on the cleanup side effect after `try` finishes or throws |

With Vitest 4 and 5 each such expression becomes a probe in the test session. While the baseline runs, the probe notes for every edit of the expression and for every test whether the edit would have given the same value after evaluating the same operands. The edits then run like any other switch, against the tests that reach them. A survivor is reported with what the recording says about it:

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
- The probe works an edit out again only where that has no effect: arithmetic on numbers, text and other plain values, the functions of `Math` on numbers, and the ends of arrays and of text (requiring plain search arguments and native `String.prototype.indexOf`/`lastIndexOf` so non-plain arguments cannot trigger side effects twice). If a non-logical expression throws during the baseline, or receives an object among arithmetic operands, a non-array/non-string target, or `find` on more than one element, the recording records `unsure` rather than `differ`. A survivor is then an `INPUT GAP` marked `uncertain`, with the tests in which that happened: they may already have the input and only lack the assertion.
- `await-dropped/v1` changes timing rather than a direct return value, so a survivor is an `ASSERTION GAP` with `advice` on observing the awaited effect. `copy-dropped/v1` safely inspects the spread operand at runtime (without triggering Proxy traps) to distinguish array copies, non-array iterable-to-array conversions (`[...set]`), plain object copies, and non-plain/nullish object spreads (`{ ...instance }`), tailoring its `advice` accordingly.
- A sort is edited only where its comparison is written as `(a, b) => a - b`. The probe sorts a copy of its own to compare, where the array is a built-in one with its own `sort` and every element is a number or text.
- `+` beside a string or template literal is left alone. `Math.max` and `Math.min` are edited with exactly two arguments. An element that is assigned, updated, deleted, called, or reached through `?.` is left alone, and `list[list.length - 1]` is taken for a last element only where `list` is a name or a chain of property names. When every baseline observation of `expr[0]` succeeds on a non-sequence object lacking `.at` (such as `Record<number, T>` or `arguments`), the `sequence-end/v1` edit is listed as `ignored` and not run.
- `??` and `||` give the same for `null`, `undefined` and every object. When no test gave the left side a number, a string or a boolean and the two never differed, the edit is listed as `ignored` and not run. `||` is not taken for `??` where only the truth of its value is used.
- The strict and loose comparison edits are offered only beside a written `null` or `undefined`.
- A logical expression whose right side contains `await` or `yield` gets no probe and no targeted edit.
- The proof in `proof/lean/Main.lean` (`Agreement.agreeing_edit_replays`) states the claim behind an input gap: an edit that gives the original's outcome at every probe of a run leaves that run as it is. It assumes what `--deterministic` declares, so every targeted edit is still run and the recording decides only what the report says about a survivor.
- When a session cannot start (or with `--runner node` or `--audit`), the edits are source rewrites with one run of the suite each, and nothing is recorded: a survivor is listed without an operand-level gap.
- `// Stryker disable all` and its other forms apply; the rule names contain a slash and cannot be named in such a comment.

### Complete built-in mutation set

`--mutators full` combines comparison boundaries and constant-RHS integer thresholds with every StrykerJS mutator without requiring any StrykerJS package: ArithmeticOperator, ArrayDeclaration, ArrowFunction, AssignmentOperator, BlockStatement, BooleanLiteral, CallExpression (removal of a call or `throw new` statement), ConditionalExpression, EqualityOperator, LogicalOperator, MethodExpression, ObjectLiteral, OptionalChaining, Regex, StringLiteral, UnaryOperator and UpdateOperator. The mutations are found in the TypeScript syntax tree and reported with the StrykerJS mutator names, the original text and the replacement. The repository's tests compare the set with the StrykerJS instrumenter's on TypeScript, TSX and JavaScript sources.

With Vitest 4 and 5 (default runner) and with Playwright, the tool rewrites mutations into runtime switches and drives one switched test session with per-test coverage (`operatorExecution: "session"`). Source-equivalent built-in mutations (`ArithmeticOperator` `+`↔`-` and `*`↔`/`, `MethodExpression` `Math.min`↔`Math.max` and `every`↔`some`, and `Regex` `.test()` anchor drops) share their trial execution with the matching targeted probe while keeping both candidate IDs in the report, and surviving `OptionalChaining`, complementary safe-integer `EqualityOperator` (`>=`→`<`, `<=`→`>`, `>`→`<=`, `<`→`>=`), and `ConditionalExpression` (`true`/`false`) edits receive `INPUT GAP` or `ASSERTION GAP` diagnostics from the baseline observations. With `--audit`, `--runner node`, or when a session cannot start (another Vitest major, a custom runner, `experimental.viteModuleRunner: false`, Vitest browser mode, Vitest type checking, or a Playwright server without runtime switch activity), each mutation is a source rewrite followed by one run of the suite (`operatorExecution: "source-rewrite"`). A comparison boundary such as `>=` to `>` is reported once, with its missing input.

`// Stryker disable all`, `// Stryker disable next-line EqualityOperator: reason`, `// Stryker restore all` and their other forms are read as StrykerJS reads them. A comment counts when it leads a statement or expression, so one placed directly before a closing brace has no effect. An ignored mutation is listed with the status `ignored` and its reason in `statusReason`, and gets no switch. A comparison boundary under such a comment is left out of the default `targeted` profile too, and the file's `extraction` entry counts it in `ignored`.

Differences from a StrykerJS run: a `for (;;)` loop directly under a label keeps its missing condition; a `case` clause that declares a `let`, `const`, class or function is not emptied, because later clauses can see that declaration; and like StrykerJS the set leaves types, imports, enums, ambient declarations, decorators, directives, property names and the inside of `x as T` alone.

## Playwright projects

```sh
npx playwright install --only-shell chromium
npx targeted-mutation analyze . src/button.tsx --runner playwright --project chromium
npx targeted-mutation analyze . src/button.tsx --runner playwright --project chromium --audit
```

Use `--config` for a nonstandard Playwright config path. Without `--audit`, `--runner playwright` drives a warm targeted session (`operatorExecution: "session"`):

- Target sources are instrumented once with pure JavaScript runtime switches and safe-integer comparison probes (`globalThis.__stryker__`), requiring no Node-only imports inside client bundles or SSR modules.
- Playwright's programmatic runner starts the managed `webServer` once (and keeps a warm headless browser server when all selected projects share a standard browser). A preload on Node `webServer` processes and an automatic Playwright fixture (`context.exposeBinding` + `context.addInitScript` with `pagehide` and end-of-test frame flushes) collect per-test reachability, comparison operands, and value-aware rule agreement across both SSR/API handlers and browser pages, including across multiple `page.goto()` navigations.
- From the recorded baseline, the analyzer synthesizes `comparison-threshold/v1`, `comparison-margin/v1`, and (when requested) `--displace-thresholds`, marks zero-hit edits as `unreached`, skips eligible comparison trials via `tmt-decide` under `--deterministic`, and separates surviving edits into `INPUT GAP` and `ASSERTION GAP` naming the exact Playwright E2E test.
- Each warm trial runs only the Playwright tests that reached the switch (stopping at the first failure) and is immediately followed by a switch-off control run of those tests. If the control run fails or its switch hit count differs from the baseline (for example because an edit mutated persistent server state), or if a switch executed during `webServer` startup before any test (`server-static`), the session restarts the server cleanly and evaluates that mutation in an isolated fresh `webServer` run. Pass `--isolated-trials` to run every mutation in a fresh server from the start, or `--verify-trials N` to verify a sample of warm verdicts against fresh runs.

With `--audit` (or when a session falls back to `source-rewrite`), each trial launches a separate Playwright CLI run in a temporary checkout with one worker and `reuseExistingServer: false`. Both session runs and `--audit` accept an optional `playwright` array in `--spec`: each entry identifies a `file`, `rule`, `operator`, and optional `line`, records an independent `requirement`, and points to a `witness` test relative to the root, verifying the added test against both original and edited source. Git scope (`--since`) and `--lines` limit runs to candidates in scope.

The fixture accepts a loopback port from `PORT`. The integration tests and the evidence script start their own instances of that fixture. Playwright's global timeout reserves time for orderly shutdown before the runner's process-group deadline.

Playwright needs a loopback `webServer` command (`url` or `port` on `localhost`, `127.0.0.1`, or `[::1]`) rooted in each trial copy. If `use.baseURL` is set, its port and protocol must match a managed loopback server. Monorepo subpackages without a local `node_modules` automatically inherit hoisted ancestor `node_modules` in trial copies. The tool resolves Playwright from the target workspace. Server commands and tests must exercise the copied sources, including any paths they construct dynamically. A witness can set `witnessDirectory` when the relevant project collects tests outside the directory of the first passing baseline test.

### External daemons and embedded UI bundles

When an application embeds a prebuilt frontend bundle inside an external backend daemon (for example a Rust or Go binary launched from `globalSetup`), the Playwright baseline can still pass while executing the prebuilt assets instead of the instrumented files in the temporary trial copy.

Check these report fields to verify that Playwright exercised the mutated sources in a warm session:

- `operatorExecution`: should be `"session"`. If it falls back to `"source-rewrite"` after a passing baseline, the browser and managed `webServer` observed no runtime switch activity from the copied sources.
- `trials`: `trials.inWorker + trials.isolated` should be greater than `0`.
- `mutants[*].status` and `mutants[*].reachedTests`: if every selected edit is `unreached` (zero hits) despite tests exercising that screen, Playwright is likely talking to prebuilt assets or an already-running server outside the trial copy.

To run mutations against an app backed by an external daemon, use a managed `webServer` script inside the repository that starts the external backend on a local port, serves (or rebuilds) the trial copy's UI sources through a dev server such as Vite, proxies API/WebSocket routes to the backend, and terminates the backend cleanly on exit:

```js
// scripts/playwright-mutation-server.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const uiPort = Number(process.env.PORT ?? 4173);
const apiPort = Number(process.env.BACKEND_PORT ?? 4174);
const daemon = spawn(process.env.APP_DAEMON_BIN, ['--listen', `127.0.0.1:${apiPort}`], {
  stdio: 'inherit',
});

const stopDaemon = () => new Promise(resolveStop => {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return resolveStop();
  const forceTimer = setTimeout(() => {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    resolveStop();
  }, 3000);
  daemon.once('exit', () => {
    clearTimeout(forceTimer);
    resolveStop();
  });
  daemon.kill('SIGTERM');
});

let vite;
let shuttingDown = false;
const shutdown = async (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  await vite?.close().catch(() => {});
  await stopDaemon();
  process.exit(code);
};
process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
daemon.once('exit', code => {
  if (!shuttingDown) void shutdown(code ?? 1);
});

try {
  vite = await createServer({
    server: {
      host: '127.0.0.1',
      port: uiPort,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, ws: true } },
    },
  });
  await vite.listen();
} catch (error) {
  console.error(error);
  await shutdown(1);
}
```

Point a mutation-specific Playwright config's `webServer` at that wrapper (`command: 'node scripts/playwright-mutation-server.mjs'`, `url: 'http://127.0.0.1:' + port`, `reuseExistingServer: false`, `gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }`) and pass it with `--config`. Keep the wrapper under the project root so it runs inside each temporary trial copy and compiles the mutated UI sources directly.

## Project configuration

Project defaults can be stored in `targeted-mutation.config.json`, `targeted-mutation.config.mjs` (default export), or the `"targetedMutation"` field of `package.json` (pass `--no-config` to ignore them; CLI flags always take precedence):

```json
{
  "runner": "playwright",
  "files": ["src"],
  "tests": ["e2e/**/*.spec.ts"],
  "projects": ["chromium"],
  "mutators": "targeted",
  "deterministic": true,
  "displaceThresholds": true,
  "copyExcludeGitignore": true,
  "excludeRules": [],
  "timeout": 60,
  "baselineTimeout": 90,
  "failOnGaps": false
}
```

Supported keys: `runner`, `files` (files, directories, or globs), `tests`, `projects`, `mutators`, `timeout`, `baselineTimeout`, `baselineWorkers`, `concurrency`, `config` (Vitest/Playwright config path), `tsconfig`, `spec`, `baseline`, `related`, `copyExclude`, `copyExcludeGitignore`, `excludeRules`, `typeCheck`, `deterministic`, `displaceThresholds`, `isolatedTrials`, `verifyTrials`, `progress`, `failOnGaps`, `verbose`, and `onlyGaps`. Unknown keys print a warning to `stderr`.

For the pending Save fixture, StrykerJS 10.1.1's command runner killed its five generated mutants with both suites. Its replacement list did not include dropping the saving operand to get `!valid`. TMT ran that source rewrite against both suites, and the added pending-request test killed it. This comparison uses the StrykerJS command runner with coverage disabled, so it does not establish a relative runtime for StrykerJS with per-test runner coverage. The [JSON evidence](../evidence/m3) records both experiments.

## Distinguishing witnesses

`--witnesses` runs the Vitest witness profile. It searches for a source rewrite that survives the selected tests, then checks an input edit or assertion that distinguishes it. It runs each trial in a fresh copy and reports a confirmed gap when the original passes and the attributed assertion fails with the expected alternate value. Source and fixture edit offsets are half-open UTF-8 byte ranges.

Every candidate is tried in its own copy of the project, and so is each run that verifies a proposed test. The copies are independent, so the profile runs several at once: up to eight by default, or the number given with `--concurrency N`. The report lists the candidates in the order they were planned, whatever order they finished in.

```sh
npx targeted-mutation analyze fixtures/witnesses src/queries.ts --witnesses --test test/queries.test.ts
npx targeted-mutation analyze fixtures/witnesses src/text-order.ts --witnesses --test test/text-order.test.ts --spec order-spec.json
npx targeted-mutation analyze fixtures/witnesses src/contracts.ts --witnesses --test test/contracts.test.ts
```

The automatic rules handle same-type safe integer arguments and numeric fields of an inline object type in an ordered comparison, `indexOf` versus `lastIndexOf` on numeric arrays, any versus all bits in a nonnegative 31-bit mask, one extra element in a `slice(0, count).reduce(...)` sum, integer rounding-order bugs (`Math.floor((a * b) / c)` / `Math.trunc((a * b) / c)` vs dividing before multiplying), and omitted parameters in composite keys (template literals and `[...].join(...)`). They use direct Vitest calls with literal arguments and a scalar `toBe` assertion as seeds. Calls may appear inside nested `describe` or `suite` blocks with literal titles. JavaScript named exports can use JSDoc parameter annotations, and the numeric-array `indexOf` rule can use an unannotated function with literal numeric fixtures. A finding includes a minimized single-literal edit where the observed assertion still holds for the original implementation. Otherwise it can verify a separate assertion in the selected test file. Automatic expectations come from the original implementation. The automatic search evaluates up to 32 eligible rewrites and four one-edit proposals per surviving rewrite.

`witnessSearch` reports scoped single-rule source candidates, how many matched passing test seeds, how many were evaluated, and how many hit the evaluation cap. `unmatched` is null when a diagnostic or a failed baseline prevented matching. A matched seed can lack a supported distinguishing edit. Paired and public-state witness plans have separate evaluation results.

For string-length functions, ASCII assertions can seed a one-character witness. The profile compares `Array.from(text).length` with UTF-8 byte length and `text.length` with code-point length. For example, `é` distinguishes one code point from two bytes, and `😀` distinguishes two UTF-16 code units from one code point.

For sorts with inline record types, the profile supports `toSorted((a, b) => a.key - b.key)` and `[...rows].sort(...)` when the test observes order through a scalar `.map(row => row.id).join(...)` assertion. It changes one alternate-key value to reverse a pair's relative order. In `--spec`, each `sortConstraints` entry identifies a `file`, exported `function`, numeric `before` field, and numeric `after` field. The seed and proposal must satisfy `before <= after` on every row. Entries for selected files must resolve to a supported sort.

The profile discovers up to 32 additional state and pair plans. It can link matching 16- or 32-bit `DataView` byte-order edits when a selected passing test passes an encoder result to the decoder through a nested call or one immutable binding. For a rejected batch with an upfront `.some(...)` guard, it can borrow a map-backed public reader from a passing test for the same class in the same test module and use a key from the rejected batch. The report records both the donor's argument and the generated argument. These observations preserve the original behavior. Use an explicit plan when the expectation comes from an external contract.

With `--spec`, `witnessPlans` adds up to 32 explicit plans. Each plan supplies a name, requirement, project-relative test file, uniquely named existing seed test, one or two source edits, and a public observation. Each edit includes a project-relative source file, a one-based line, and exact original and replacement text. Every edit must be in scope and match exactly once on its line. The `observe` expression runs in the seed test module and can use its local imports. Supply distinct scalar `expected` and `alternate` values from a specification. A paired finding requires the same seed test to fail on each source edit alone, the original suite to pass with both edits applied, and the new assertion to distinguish the pair.

The [explicit witness fixture](../fixtures/witnesses/witness-spec.json) checks an atomic batch through a public read and a little-endian wire format through a fixed byte assertion. The runner executes project test code and the supplied witness expression. Reports can include fixture values, paths, and the supplied expression. The witness profile uses project scope and Vitest test/config selection. Use its reexecuted verdicts to inspect candidate source edits and the separately confirmed diagnostics to identify executable tests.
