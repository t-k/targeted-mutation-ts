#!/bin/bash
# Usage: bench-stryker-comparison.sh PROJECT [ROUNDS]
# Alternates StrykerJS and this tool on one Vitest project and prints wall-clock times and verdict counts.
# PROJECT needs vitest, @stryker-mutator/core and @stryker-mutator/vitest-runner installed and a stryker.conf.json
# with the vitest runner and perTest coverage analysis.
P=$(cd "$1" && pwd); R=${2:-3}; T=$(cd "$(dirname "$0")/.." && pwd)/bin/tmt.mjs; O=$(mktemp -d)
now() { node -e 'console.log(Date.now())'; }
t() { local n=$1; shift; local s=$(now); "$@" > "$O/$n.out" 2> "$O/$n.err"; local rc=$?; local e=$(now); echo "$n rc=$rc $(( e - s )) ms"; }
sysctl -n vm.loadavg
for i in $(seq $R); do
  (cd "$P" && t stryker-default npx stryker run)
  t tmt-full node $T analyze "$P" --mutators full --format json
  (cd "$P" && t stryker-c1 npx stryker run --concurrency 1)
  t tmt-full-c1 node $T analyze "$P" --mutators full --concurrency 1 --format json
  t tmt-standard node $T analyze "$P" --mutators standard --format json
  t tmt-focused node $T analyze "$P" --format json
done
sysctl -n vm.loadavg
grep -E "All files" "$O/stryker-default.out" | tail -1
for n in tmt-full tmt-full-c1 tmt-standard tmt-focused; do node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c={};for(const m of r.mutants)c[m.status]=(c[m.status]||0)+1;console.log(process.argv[2],r.mutants.length,JSON.stringify(c),r.evaluation,JSON.stringify(r.trials??null))' "$O/$n.out" $n; done
