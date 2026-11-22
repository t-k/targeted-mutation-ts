# targeted-mutation

`targeted-mutation` finds the tests your suite is missing. It watches the values your tests actually pass through comparisons, tries the smallest wrong implementation those values cannot tell apart from yours, and prints the test that would catch it.

```ts
export const isAdult = (age: number) => age >= 18;
// tests check isAdult(20) and isAdult(10)
```

```text
src/cart.ts:15:45  survived  comparison-boundary/v1: >= -> >
src/cart.ts:15:45  survived  comparison-threshold/v1: replace with 17

Test gaps:
INPUT GAP src/cart.ts:15:45
  operands (18, 18): original true, edited false
  suggested test: expect(isAdult(18)).toBe(true)
INPUT GAP src/cart.ts:15:45
  operands (17, 18): original false, edited true
  suggested test: expect(isAdult(17)).toBe(false)
```

A conventional mutation run replaces `>=` with `>` or `<`. It does not try `age >= 17`, the nearest implementation that the inputs 10 and 20 leave open. The [shipping threshold experiment](docs/development.md#shipping-threshold-experiment) compares both approaches on the same suite.

## Install

```sh
npm install --save-dev targeted-mutation
```

Requirements:

- Node.js 22.18 or later in the 22 line, or 24.11 or later.
- [Vitest](https://vitest.dev/) or [Playwright](https://playwright.dev/) installed in the project or its workspace. Releases are tested with Vitest 4.0 and Playwright 1.65.
- macOS (arm64, x64) or Linux with glibc (arm64, x64). npm installs the matching prebuilt binary package automatically. `analyze` needs it and stops with a message on other platforms, including Windows and Alpine Linux; `extract` still works there through the TypeScript parser.

The tool copies the project to a temporary directory and runs the project's own test code and configuration there. Run it only on code you trust, as you would run the test suite.

## Use

```sh
npx targeted-mutation analyze                      # every source file in the current project
npx targeted-mutation analyze . src/cart.ts        # selected files
npx targeted-mutation analyze --lines src/cart.ts:10-40
npx targeted-mutation analyze --since origin/main  # lines changed since a revision
```

`tmts` is a short alias for the same command. `targeted-mutation --help` lists every option.

The exit status is 0 after a completed analysis, including one that reports gaps, and 1 when the suite fails before any edit, a file cannot be parsed, or the arguments are invalid.

### Reading the report

Each line is one source edit and what the suite did with it:

| Status | Meaning |
|--------|---------|
| `killed` | A test failed on the edit. The suite distinguishes it. |
| `survived` | Every test passed on the edit. A `Test gaps` entry shows the missing input. |
| `unreached` | No test executed the edited expression. |

A test gap gives the operand values that separate your code from the edit and, for an exported single-argument function, a ready assertion under `suggested test`.

On a terminal the report is text. When the output is piped or redirected it is JSON with a `schemaVersion`, so scripts can rely on it. `--format text` or `--format json` selects one explicitly.

### Profiles

| Option | What it edits |
|--------|---------------|
| (default) `--mutators focused` | `<`, `<=`, `>`, `>=` boundaries and integer thresholds, with the missing input for each survivor. |
| `--mutators operators` | `focused`, plus equality (`===` and `!==`, `==` and `!=`), logical (`&&`, `\|\|`, `??`) and arithmetic (`+`, `-`, `*`, `/`, `%`) operator swaps. Needs no extra package and works with Vitest and Playwright. Each edit costs one run of the suite. |
| `--witnesses` | Value substitutions such as a neighbouring field, the first or last index, or a sort key, each confirmed by a test that tells them apart. Reports `No edit sites` when a file has no such pattern. |
| `--mutators standard` | The full StrykerJS mutator set, run with per-test coverage (Vitest only). Install `@stryker-mutator/instrumenter@10.1.1` in the project first. |
| `--mutators all` | `standard` and `focused` together. |

`--deterministic` declares that the suite runs from the same state every time. Recorded comparison values then decide many trials without re-running the tests, and each such decision is checked by an executable extracted from a Lean proof. `--audit` re-runs those trials against the rewritten source and reports any disagreement.

The [analysis guide](docs/analysis.md) covers scope selection, specifications, Playwright projects and the witness profile in detail.

## Documentation

- [Analysis guide](docs/analysis.md)
- [Parser grammar and trust boundary](docs/l1.md)
- [Performance measurements](docs/performance.md)
- [Development and verification](docs/development.md)
- [Releasing](docs/releasing.md)

## License

[Apache-2.0](LICENSE). Third-party notices are in [NOTICE](NOTICE).
