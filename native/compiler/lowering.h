#ifndef TMT_COMPILER_LOWERING_H
#define TMT_COMPILER_LOWERING_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

char *tmt_lower_runtime(uint8_t *source, uint32_t size, bool jsx, bool typescript, bool classic,
  bool mixed, size_t *length, bool *complete);

bool tmt_unbound_export(uint8_t *source, uint32_t size);
bool tmt_plain_script(uint8_t *source, uint32_t size);
bool tmt_valid_module_source(const char *source, size_t size);
bool tmt_module_marker(uint8_t *source, uint32_t size, bool validate);
typedef enum { TMT_PARAMETER_NONE, TMT_PARAMETER_NODE, TMT_PARAMETER_REFERENCE } tmt_parameter_route;
/* Whether the source matches \benum\b. An unknown hint is resolved only on the routes that need it. */
typedef enum { TMT_ENUMS_ABSENT, TMT_ENUMS_PRESENT, TMT_ENUMS_UNKNOWN } tmt_enum_hint;
char *tmt_emit_annotated_module(uint8_t *source, uint32_t size, tmt_enum_hint enums, bool esm, bool allow_script,
  size_t *length, bool *checked, bool *complete, bool *script, tmt_parameter_route *property);
bool tmt_leading_directive(uint8_t *source, uint32_t size);
bool tmt_leading_triple_slash(uint8_t *source, uint32_t size);

#endif
