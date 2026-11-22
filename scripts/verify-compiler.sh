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

extract() {
  flavor=$1
  destination=$2
  update=$3
  shift 3
  directory=$scratch/$flavor
  mkdir "$directory"
  "$fstar" --include proof/fstar --cache_dir "$cache" --codegen KrmlC "$@" \
    -o "$directory/compiler.krml" proof/fstar/TmtPulseCompiler.fst
  "$krml" -minimal -drop Prims -ftail-calls -add-early-include '"tmt_krml_runtime.h"' \
    -skip-compilation -tmpdir "$directory" "$directory/compiler.krml"
  if grep -q 'custard_init_globals' "$directory/Custard.h"; then
    echo 'The compiler must not require shared mutable initialization' >&2
    exit 1
  fi
  mkdir "$directory/stable"
  for file in Custard.c Custard.h; do
    sed 's/[[:blank:]]*$//; /KaRaMeL invocation:/d; ${/^$/d;}' "$directory/$file" > "$directory/stable/$file"
  done
  if [ "$update" = '--update' ]; then
    mkdir -p "$destination"
    cp "$directory/stable/Custard.c" "$directory/stable/Custard.h" "$destination/"
  else
    diff -u "$destination/Custard.c" "$directory/stable/Custard.c"
    diff -u "$destination/Custard.h" "$directory/stable/Custard.h"
  fi
}

set -- "${1:-}" \
  --custard_entry TmtPulseCompiler.read_plan --custard_entry TmtPulseCompiler.blank_range \
  --custard_entry TmtPulseCompiler.read_runtime_head --custard_entry TmtPulseCompiler.runtime_tag_name \
  --custard_entry TmtPulseCompiler.runtime_atom --custard_entry TmtPulseCompiler.runtime_source_start \
  --custard_entry TmtPulseParser.string_end

extract direct native/compiler/generated/direct "$@"
extract module native/compiler/generated "$@" \
  --custard_entry TmtPulseCompiler.type_only_module \
  --custard_entry TmtPulseCompiler.runtime_module_marker \
  --custard_entry TmtPulseCompiler.supported_module --custard_entry TmtPulseCompiler.next_module_item \
  --custard_entry TmtPulseCompiler.jsx_expression_end
