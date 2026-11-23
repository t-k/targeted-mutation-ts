#ifndef TMT_COMPILER_LOWERING_H
#define TMT_COMPILER_LOWERING_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

char *tmt_lower_runtime(uint8_t *source, uint32_t size, bool jsx, bool typescript, bool classic,
  bool mixed, size_t *length, bool *complete);

bool tmt_unbound_export(uint8_t *source, uint32_t size);
bool tmt_plain_script(uint8_t *source, uint32_t size);
bool tmt_module_marker(uint8_t *source, uint32_t size, bool validate);
char *tmt_emit_annotated_module(uint8_t *source, uint32_t size, bool enums, size_t *length, bool *checked, bool *complete);
bool tmt_leading_directive(uint8_t *source, uint32_t size);

#endif
