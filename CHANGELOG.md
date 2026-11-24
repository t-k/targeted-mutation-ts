# Changelog

## Unreleased

- `--mutators targeted`: edits that the values of the tests can tell apart (an equality that is always true or false, an operand of `&&`, `||` or `??` that never decides, `??` for `||`, `== null` for `=== null`, another arithmetic operator, `Math.min` for `Math.max`, another rounding, the other end of a list). A recording run notes per test whether each edit would have behaved differently, and a survivor is reported as an input gap with the missing input or as an assertion gap with the tests that had it.
- `--undo-changes` with `--since REV`: each change is put back as it was at `REV` and run against the suite. A change the tests pass without is reported as `UNTESTED CHANGE`.

## 0.1.0

First public release.

- `targeted-mutation` command with the alias `tmts`: `analyze`, `extract` and `prototype`.
- Focused comparison and threshold edits, the witness profile, and the standard StrykerJS mutator set for Vitest; focused edits for Playwright.
- `--mutators operators`: built-in equality, logical and arithmetic operator swaps with no extra package, run in one switched session with per-test coverage on Vitest 4.
- `--mutators full`: the complete StrykerJS mutator set, built in, with no extra package.
- `// Stryker disable` and `// Stryker restore` comments are honoured by the built-in mutation set and the default profile.
- `--since` and `--lines` select a comparison when any of its lines is in scope, and `--since` leaves files that Git ignores out of discovery.
- A trial in which the runner breaks down makes the evaluation `incomplete` and the command exit with 1.
- `--timeout SECONDS` for one run of the suite, and `--test FILE` for Playwright.
- `--witnesses` tries its candidates in project copies side by side (`--concurrency N`, up to 8 by default) and reports them in the planned order.
- Vitest 4 sessions decide mutations inside running workers, with a control run after each one and a fresh Vitest run for whatever a worker cannot decide. `--concurrency N`, `--verify-trials N` and `--isolated-trials` control this.
- Text report on a terminal, JSON report (`schemaVersion: 1`) when piped, `--format` to choose.
- Prebuilt native parser and a 2 MB Lean decision executable for macOS and Linux (glibc) on arm64 and x64.
