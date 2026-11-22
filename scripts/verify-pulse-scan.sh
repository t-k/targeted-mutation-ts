#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
fstar=${FSTAR_PULSE_EXE:-docs.local/toolchains/fstar/bin/fstar.exe}
build=build/pulse-scan
mkdir -p "$build"
scratch=$(mktemp -d "$build/.verify-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
"$fstar" --include proof/fstar --cache_checked_modules --cache_dir "$scratch" proof/fstar/TmtGrammar.fst
"$fstar" --include proof/fstar --cache_checked_modules --cache_dir "$scratch" proof/fstar/TmtPulseScan.fst
"$fstar" --include proof/fstar --cache_dir "$scratch" --codegen C --custard_entry TmtPulseScan.scan_class \
  -o "$scratch/TmtPulseScan.c" proof/fstar/TmtPulseScan.fst
"${CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror -Wno-parentheses -Inative/generated -Inative/runtime -I"$scratch" \
  native/pulse/test.c native/pulse/scan-adapter.c native/generated/TmtGrammar.c "$scratch/TmtPulseScan.c" -o "$scratch/scanner-test"
"$scratch/scanner-test" verification/pict/pulse-scan.tsv
mv "$scratch/TmtPulseScan.c" "$scratch/TmtPulseScan.h" "$build/"
