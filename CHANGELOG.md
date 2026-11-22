# Changelog

## 0.1.0

First public release.

- `targeted-mutation` command with the alias `tmts`: `analyze`, `extract` and `prototype`.
- Focused comparison and threshold edits, the witness profile, and the standard StrykerJS mutator set for Vitest; focused edits for Playwright.
- `--mutators operators`: built-in equality, logical and arithmetic operator edits with no extra package.
- Text report on a terminal, JSON report (`schemaVersion: 1`) when piped, `--format` to choose.
- Prebuilt native parser and Lean decision executable for macOS and Linux (glibc) on arm64 and x64.
