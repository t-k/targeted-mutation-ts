# Analyzing a project

Install the locked dependencies with `npm ci` and build the native extractor with `npm run build:native`. Build the Lean decision executable with `npm run build:lean` using the pinned Lean toolchain. The analysis runs the binaries in `build/` directly.

```sh
node bin/tmt.mjs analyze fixtures/eligibility src/eligibility.ts --spec spec.json --deterministic --audit
node bin/tmt.mjs analyze . --lines src/eligibility.ts:1-8 --audit
node bin/tmt.mjs analyze . --since "$(git merge-base origin/main HEAD)"
```

Arguments after the project root select source files. Without files, the CLI discovers TypeScript and TSX sources. The scope comes from explicit line ranges and added or changed lines relative to a Git commit. The CLI parses each selected file before filtering candidate operator positions. Output is JSON with a schema version, extraction outcomes, candidate IDs, trial verdicts and diagnostics. An extraction diagnostic or a baseline failure exits with status 1. A successful analysis exits with status 0.

The Vitest path runs an original baseline, a disabled-instrumentation baseline, and one isolated source rewrite for each trial. Instrumentation passes both evaluated operands to a comparison with the original operator. It records only JavaScript safe-integer pairs for prediction. The report identifies a Vitest test by project, relative file and task ID. Unattributed, unsupported or inconsistent observations keep the trial on the full-suite path. The product produces threshold replacements for directly callable exported unary arrows with a safe integer literal. It groups adjacent alternatives that agree on the safe integer domain. A matching specification entry with a rationale can supply the expected result and domain for the proposed test.

`--deterministic` declares that tests run from the same initial state and external inputs, and that a comparison influences execution only through its outcome. Tests that inspect source text or compare elapsed time are outside that contract. The runner compares two disabled traces and requires a complete, attributed observation from every passing test for the selected comparison. The compiled Lean executable validates the batch; missing tools, malformed data, retries, overlapping test options, or any rejected decision require a real run. `evidence: "predicted"` is a Lean-backed replay decision. `evidence: "reexecuted"` describes a source trial. The `--audit` option runs a full source rewrite and, where available, an independently activated probe, recording the agreement. The Lean theorem models deterministic comparison-driven executions, with JS instrumentation and run identity in the trusted runtime boundary.

The [recorded eligibility and shipping reports](../evidence/m2) show the standard boundary mutation and the generated threshold-shift rule. `npm test` also checks the distinction between reaching the boundary and asserting the returned value.
