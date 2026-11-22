#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
fstar=${FSTAR_EXE:-${FSTAR_PULSE_EXE:-docs.local/toolchains/fstar/bin/fstar.exe}}
krml=${KARAMEL_EXE:-docs.local/toolchains/fstar/bin/krml}
build=build/fstar
mkdir -p "$build"
scratch=$(mktemp -d "$build/.verify-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
for module in TmtGrammar TmtPulseScan TmtPulseMemory TmtPulseParser TmtReference TmtReferenceExamples; do
  "$fstar" --warn_error -288 --include proof/fstar --cache_checked_modules --cache_dir "$scratch" "proof/fstar/$module.fst"
done
"$fstar" --include proof/fstar --cache_dir "$scratch" --codegen KrmlC \
  --custard_entry TmtPulseParser.parse --custard_entry TmtPulseParser.lexical_duplicate \
  --custard_entry TmtPulseScan.unicode_line_separator \
  -o "$scratch/parser.krml" proof/fstar/TmtPulseParser.fst
"$krml" -minimal -drop Prims -ftail-calls -add-early-include '"tmt_krml_runtime.h"' \
  -skip-compilation -tmpdir "$scratch" "$scratch/parser.krml"
if grep -q 'custard_init_globals' "$scratch/Custard.h"; then
  echo 'The parser must not require shared mutable initialization' >&2
  exit 1
fi
mkdir "$scratch/stable"
for file in Custard.c Custard.h; do
  # The invocation embeds machine-local paths. Keep the verified snapshots reproducible.
  sed 's/[[:blank:]]*$//; /KaRaMeL invocation:/d; ${/^$/d;}' "$scratch/$file" > "$scratch/stable/$file"
done
"${CC:-cc}" -std=c11 -O2 -I"$scratch/stable" -Inative/runtime \
  native/pulse/test.c "$scratch/stable/Custard.c" -o "$scratch/scanner-test"
"$scratch/scanner-test" verification/pict/pulse-scan.tsv verification/pict/pulse-primitives.tsv

if [ "${1:-}" = '--update' ]; then
  mkdir -p native/generated
  cp "$scratch/stable/Custard.c" "$scratch/stable/Custard.h" native/generated/
else
  diff -u native/generated/Custard.c "$scratch/stable/Custard.c"
  diff -u native/generated/Custard.h "$scratch/stable/Custard.h"
fi
