#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
fstar=${FSTAR_EXE:-docs.local/toolchains/fstar-2025/fstar/bin/fstar.exe}
krml=${KARAMEL_EXE:-docs.local/toolchains/fstar/bin/krml}
mkdir -p build/fstar/c
"$fstar" --include proof/fstar --odir build/fstar --codegen krml --extract '+TmtGrammar +TmtScan +TmtParser' \
  proof/fstar/TmtGrammar.fst proof/fstar/TmtScan.fst proof/fstar/TmtParser.fst proof/fstar/TmtReference.fst proof/fstar/TmtReferenceExamples.fst
"$krml" -minimal -drop Prims -ftail-calls -add-early-include '"tmt_krml_runtime.h"' \
  -skip-compilation -tmpdir build/fstar/c build/fstar/out.krml
for path in TmtGrammar.c TmtGrammar.h TmtScan.c TmtScan.h TmtParser.c TmtParser.h; do
  # The invocation embeds machine-local and toolchain paths. Keep the generated code byte-stable.
  sed 's/[[:blank:]]*$//; /KaRaMeL invocation:/d' "build/fstar/c/$path" | awk 'NF { while (blank > 0) { print ""; blank-- }; print; next } { blank++ }' > "build/fstar/$path"
  if [ "${1:-}" = '--update' ]; then
    cp "build/fstar/$path" "native/generated/$path"
  else
    diff -u "native/generated/$path" "build/fstar/$path"
  fi
done
