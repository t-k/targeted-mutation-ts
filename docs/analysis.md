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

The Vitest path runs an original baseline, a disabled-instrumentation baseline, and one isolated source rewrite for each trial. Instrumentation passes both evaluated operands to a comparison with the original operator. It records only JavaScript safe-integer pairs for prediction. The report identifies a Vitest test by project, relative file and task ID. Unattributed, unsupported or inconsistent observations keep the trial on the full-suite path. The product produces threshold replacements for directly callable exported unary arrows with a safe integer literal. It groups adjacent alternatives that agree on the safe integer domain. A matching specification entry with a rationale can supply the expected result and domain for the proposed test.

`--deterministic` declares that tests run from the same initial state and external inputs, and that a comparison influences execution only through its outcome. Tests that inspect source text or compare elapsed time are outside that contract. The runner compares two disabled traces and requires a complete, attributed observation from every passing test for the selected comparison. The compiled Lean executable validates the batch; missing tools, malformed data, retries, overlapping test options, or any rejected decision require a real run. `evidence: "predicted"` is a Lean-backed replay decision. `evidence: "reexecuted"` describes a source trial. The `--audit` option runs a full source rewrite and, where available, an independently activated probe, recording the agreement. For a callable threshold witness, audit also runs the generated Vitest assertion against original and rewritten source and checks both test inventories. The Lean theorem models deterministic comparison-driven executions, with JS instrumentation and run identity in the trusted runtime boundary.

The [recorded eligibility and shipping reports](../evidence/m2) show the standard boundary mutation and the generated threshold-shift rule. `npm test` also checks the distinction between reaching the boundary and asserting the returned value.

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
