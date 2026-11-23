# Changelog

## 0.1.0

First public release.

- `targeted-mutation` command with the alias `tmts`: `analyze`, `extract` and `prototype`.
- Focused comparison and threshold edits, the witness profile, and the standard StrykerJS mutator set for Vitest; focused edits for Playwright.
- `--mutators operators`: built-in equality, logical and arithmetic operator swaps with no extra package, run in one switched session with per-test coverage on Vitest 4.
- `--mutators full`: the complete StrykerJS mutator set, built in, with no extra package.
- Vitest 4 sessions decide mutations inside running workers, with a control run after each one and a fresh Vitest run for whatever a worker cannot decide. `--concurrency N`, `--verify-trials N` and `--isolated-trials` control this.
- Text report on a terminal, JSON report (`schemaVersion: 1`) when piped, `--format` to choose.
- Prebuilt native parser and a 2 MB Lean decision executable for macOS and Linux (glibc) on arm64 and x64.
