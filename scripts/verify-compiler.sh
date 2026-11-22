#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
fstar=${FSTAR_EXE:-docs.local/toolchains/fstar/bin/fstar.exe}
krml=${KARAMEL_EXE:-docs.local/toolchains/fstar/bin/krml}
cache=build/compiler-proof
mkdir -p "$cache"
scratch=$(mktemp -d "$cache/extract.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
for module in TmtGrammar TmtPulseScan TmtPulseMemory TmtPulseParser TmtPulseCompiler; do
  "$fstar" --report_assumes error --warn_error -288 --include proof/fstar --cache_checked_modules --cache_dir "$cache" "proof/fstar/$module.fst"
done
"$fstar" --include proof/fstar --cache_dir "$cache" --codegen KrmlC \
  --custard_entry TmtPulseCompiler.read_plan --custard_entry TmtPulseCompiler.blank_range \
  -o "$scratch/compiler.krml" proof/fstar/TmtPulseCompiler.fst
"$krml" -minimal -drop Prims -ftail-calls -add-early-include '"tmt_krml_runtime.h"' \
  -skip-compilation -tmpdir "$scratch" "$scratch/compiler.krml"
if grep -q 'custard_init_globals' "$scratch/Custard.h"; then
  echo 'The compiler must not require shared mutable initialization' >&2
  exit 1
fi
mkdir "$scratch/stable"
for file in Custard.c Custard.h; do
  sed 's/[[:blank:]]*$//; /KaRaMeL invocation:/d; ${/^$/d;}' "$scratch/$file" > "$scratch/stable/$file"
done
if [ "${1:-}" = '--update' ]; then
  mkdir -p native/compiler/generated
  cp "$scratch/stable/Custard.c" "$scratch/stable/Custard.h" native/compiler/generated/
else
  diff -u native/compiler/generated/Custard.c "$scratch/stable/Custard.c"
  diff -u native/compiler/generated/Custard.h "$scratch/stable/Custard.h"
fi
