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
- Any platform supported by Node.js, including macOS, Linux (glibc and musl/Alpine), and Windows. On macOS (arm64, x64) and Linux with glibc (arm64, x64), npm installs the matching prebuilt binary package automatically as an accelerator for extraction and Lean-checked replay. On other platforms, `analyze` and `extract` fall back automatically to the bundled TypeScript parser and JavaScript threshold evaluator.

The tool copies the project to a temporary directory and runs the project's own test code and configuration there. Run it only on code you trust, as you would run the test suite.

## Use

```sh
npx targeted-mutation analyze                      # every source file in the current project (default: targeted)
npx targeted-mutation analyze . src/cart.ts        # selected files
npx targeted-mutation analyze --lines src/cart.ts:10-40
npx targeted-mutation analyze --since origin/main  # edits on lines changed since a revision
npx targeted-mutation analyze --since origin/main --undo-changes  # also: which changes do the tests pass without?
npx targeted-mutation analyze --suggest-assertions # also: the exact value a weak assertion should compare with
npx targeted-mutation analyze --mutators full      # full built-in StrykerJS mutation set
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
| (default) `--mutators targeted` | `<`, `<=`, `>`, `>=` boundaries and, on Vitest, integer thresholds across constant-RHS comparisons plus variable-RHS margin shifts (`comparison-margin/v1`) and fourteen value-aware rules: an equality that every test leaves true or false, an operand of `&&`, `\|\|` or `??` whose value never decides, `??` written as `\|\|`, `== null` written as `=== null`, another arithmetic operator, `Math.min` for `Math.max`, another rounding, the other end of a list, a numeric sort without its comparison, a call that is no longer awaited, a copy that is the original, a single dropped property in an object spread update, `startsWith`/`endsWith` relaxed to `includes`, and `replace` swapped with `replaceAll`. In a Vitest session with operand recording, each survivor is reported with the missing input or with the tests that had the input and asserted nothing. On Playwright (or when Vitest falls back to source rewrites without operand recording), edits run without operand recording, and Playwright reports survivor diagnostics only when paired with a `--spec` witness. Needs no extra package. |
| `--mutators full` | Comparison boundaries (and constant-RHS integer thresholds on Vitest), plus the complete built-in mutation set: every StrykerJS mutator (arithmetic, equality, logical, conditional, boolean, string, array, object, block, arrow function, assignment, unary, update, method, optional chaining, regular expression and call removal). Needs no extra package. Runs in one switched session on Vitest 4, or one source rewrite per mutation with Playwright. |
| `--witnesses` | Value substitutions such as a neighbouring field, the first or last index, or a sort key, each confirmed by a test that tells them apart. Reports `No edit sites` when a file has no such pattern. |

`// Stryker disable` and `// Stryker restore` comments exclude mutations in both the `targeted` and `full` profiles, with the reason you give after the colon.

On Vitest 4 the mutations are decided inside running Vitest workers, several at a time, with a control run after each one. `--concurrency N` sets the number of workers, `--verify-trials N` re-runs a sample of those decisions in fresh Vitest runs, and `--isolated-trials` starts a fresh Vitest run for every mutation instead; see [How mutations run on Vitest](docs/analysis.md#how-mutations-run-on-vitest).

`--deterministic` declares that the suite runs from the same state every time. Recorded comparison values then decide eligible comparison trials without re-running the tests, and each such decision is checked by `tmt-decide`, an executable extracted from a Lean 4 proof (with JavaScript instrumentation, observation collection, and test identity in the trusted runtime boundary). `--audit` re-runs those trials against the rewritten source and reports any disagreement.

The [analysis guide](docs/analysis.md) covers scope selection, specifications, Playwright projects and the witness profile in detail.

## Documentation

- [Analysis guide](docs/analysis.md)
- [Parser grammar and trust boundary](docs/l1.md)
- [Performance measurements](docs/performance.md)
- [Development and verification](docs/development.md)
- [Releasing](docs/releasing.md)

## License

[Apache-2.0](LICENSE). Third-party notices are in [NOTICE](NOTICE).
