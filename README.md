# Targeted Mutation Testing for TypeScript

Targeted Mutation Testing watches the inputs exercised by tests and proposes a concrete wrong implementation and a test that would catch it.

## Shipping threshold experiment

Use Node.js 24 and run `npm ci`, then `npm test` or `npm run evidence:m0`. The experiment runs Vitest against original, instrumented, and actually rewritten source in temporary project copies. It also reproduces the comparison with StrykerJS 10.1.1 and Vitest 4.0.18.

```sh
node bin/tmt.mjs prototype fixtures/shipping src/shipping.ts --spec spec.json
npm run evidence:m0
```

The [recorded runs](evidence/m0) used Node.js 24.14.0 on macOS arm64. Both StrykerJS reports contain five killed mutants. In both reports the generated replacements are `true`, `false`, `yen > 5000`, `yen < 5000`, and `() => undefined`. TMT observed orders of ¥4,800 and ¥5,000. The existing tests passed against the original and the nearest alternative, `yen >= 4999`. The added ¥4,999 case passed against the original and failed against the alternative. Within the stated whole-yen domain it detects every feasible alternative threshold from ¥4,801 through ¥4,999.

The prototype accepts exported unary arrow functions with an expression body of the form `parameter >= integer`. A report without a matching specification uses the current implementation as the source of an expected value. The generated witness runs in the project's `test` directory. The report marks its outcome unconfirmed when the runner does not execute that test alongside the original suite. The runner executes the project's test code and configuration locally.
