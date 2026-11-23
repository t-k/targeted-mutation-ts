/*
 * libFuzzer target for the handwritten emitter. The parser is verified, but lowering.c is not, so
 * this target runs every emitter entry under AddressSanitizer and UndefinedBehaviorSanitizer on an
 * exactly sized copy of the input. V8 is not linked: the stub accepts every module, which keeps the
 * JSX and passthrough routes reachable.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lowering.h"

bool tmt_valid_javascript_module(const char *code, size_t length) {
  (void)code;
  (void)length;
  return true;
}

/* A projection of unchanged length may only blank bytes, add a separator or move a parenthesis. */
static void check_projection(const uint8_t *source, const char *code, size_t size) {
  for (size_t at = 0; at < size; at++) {
    const uint8_t before = source[at], after = (uint8_t)code[at];
    if (before == after) continue;
    if (before == '\n' || before == '\r') __builtin_trap();
    if (after != ' ' && after != ';' && after != '(' && after != ')' && after < 0x80) __builtin_trap();
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (size < 2 || size > 65537) return 0;
  const uint8_t flags = data[0];
  size--;
  /* An allocation of the exact size lets the sanitizer see any read past the source. */
  uint8_t *source = malloc(size);
  if (!source) return 0;
  memcpy(source, data + 1, size);
  const uint32_t width = (uint32_t)size;
  size_t length = 0;
  bool checked, complete, script;
  tmt_parameter_route property;
  const tmt_enum_hint hint = flags & 1 ? TMT_ENUMS_UNKNOWN : flags & 2 ? TMT_ENUMS_PRESENT : TMT_ENUMS_ABSENT;
  char *code = tmt_emit_annotated_module(source, width, hint, flags & 4, flags & 8, &length, &checked, &complete, &script, &property, NULL);
  if (code && complete && length == size) check_projection(source, code, size);
  free(code);
  code = tmt_lower_runtime(source, width, flags & 16, flags & 32, flags & 64, true, &length, &complete, NULL);
  free(code);
  code = tmt_lower_runtime(source, width, flags & 16, true, flags & 64, false, &length, &complete, NULL);
  free(code);
  (void)tmt_module_marker(source, width, flags & 128);
  (void)tmt_unbound_export(source, width);
  (void)tmt_plain_script(source, width);
  (void)tmt_leading_directive(source, width);
  (void)tmt_leading_triple_slash(source, width);
  free(source);
  return 0;
}
