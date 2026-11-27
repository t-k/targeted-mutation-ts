#ifndef TMT_COMPILER_LOWERING_H
#define TMT_COMPILER_LOWERING_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* One copy of source bytes into the output. A log of them is the basis of a source map. */
typedef struct {
  uint32_t out, src, length;
} tmt_run;

typedef struct {
  tmt_run *items;
  size_t count, capacity;
  bool failed;
} tmt_run_log;

/* classic: 0 for the automatic runtime, 1 for the classic factory, 2 to keep JSX as written. */
char *tmt_lower_runtime(uint8_t *source, uint32_t size, bool jsx, bool typescript, unsigned classic,
  bool mixed, size_t *length, bool *complete, tmt_run_log *runs);

bool tmt_unbound_export(uint8_t *source, uint32_t size);
bool tmt_unbound_export_ws(void *ws, uint8_t *source, uint32_t size);
bool tmt_plain_script(uint8_t *source, uint32_t size);
bool tmt_valid_module_source(const char *source, size_t size);
bool tmt_module_marker(uint8_t *source, uint32_t size, bool validate);
bool tmt_module_marker_ws(void *ws, uint8_t *source, uint32_t size, bool validate);
bool tmt_blank_type_only_chunk_ws(void *ws, uint8_t *source, uint32_t size, char *out, bool separate);
void *tmt_workspace_bindings(void *ws);
typedef enum { TMT_PARAMETER_NONE, TMT_PARAMETER_NODE, TMT_PARAMETER_REFERENCE } tmt_parameter_route;
/* Whether the source matches \benum\b. An unknown hint is resolved only on the routes that need it. */
typedef enum { TMT_ENUMS_ABSENT, TMT_ENUMS_PRESENT, TMT_ENUMS_UNKNOWN } tmt_enum_hint;
/* all: 0 the records of legacy decorators, 1 every record, 2 every record of a reading that also records
   references and statement starts (kinds 43, 62, 66, 67 and 72). */
uint32_t *tmt_legacy_decorator_records(uint8_t *source, uint32_t size, unsigned all, bool jsx, uint32_t *count);
void *tmt_workspace_alloc(void);
void tmt_workspace_free(void *ws);
char *tmt_emit_annotated_module(uint8_t *source, uint32_t size, tmt_enum_hint enums, bool esm, bool allow_script,
  size_t *length, bool *checked, bool *complete, bool *script, tmt_parameter_route *property, tmt_run_log *runs);
char *tmt_emit_annotated_module_ws(void *ws, uint8_t *source, uint32_t size, tmt_enum_hint enums, bool esm, bool allow_script,
  size_t *length, bool *checked, bool *complete, bool *script, tmt_parameter_route *property, tmt_run_log *runs, bool *owned);
/*
 * The JSX pragma of a source. A supported pragma is one @jsxImportSource in a block comment before
 * the first token, with a plain package name, and no other @jsx text anywhere in the source.
 */
/* FACTORY: only @jsx or @jsxFrag, which name the classic factory and mean nothing under the automatic runtime. */
typedef enum { TMT_JSX_PRAGMA_ABSENT, TMT_JSX_PRAGMA_SOURCE, TMT_JSX_PRAGMA_OTHER, TMT_JSX_PRAGMA_FACTORY } tmt_jsx_pragma_kind;
tmt_jsx_pragma_kind tmt_jsx_pragma(const uint8_t *source, uint32_t size, uint32_t *first, uint32_t *last);
bool tmt_leading_directive(uint8_t *source, uint32_t size);
bool tmt_leading_triple_slash(uint8_t *source, uint32_t size);
/* Leading triple-slash comments: none, only notes and well-formed references, or something TypeScript has to judge. */
typedef enum { TMT_TRIPLE_SLASH_ABSENT, TMT_TRIPLE_SLASH_PLAIN, TMT_TRIPLE_SLASH_OTHER } tmt_triple_slash_kind;
tmt_triple_slash_kind tmt_triple_slash(uint8_t *source, uint32_t size);

#endif
