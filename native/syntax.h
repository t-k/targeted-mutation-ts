#ifndef TMT_SYNTAX_H
#define TMT_SYNTAX_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t operator;
  uint32_t edit[2];
  uint32_t left[2];
  uint32_t right[2];
  uint32_t expression[2];
} tmt_syntax_candidate;

typedef struct {
  tmt_syntax_candidate *rows;
  size_t len;
  uint32_t ast_nodes;
  uint32_t max_depth;
} tmt_syntax_result;

bool tmt_syntax_parse(const uint8_t *source, size_t size, bool tsx, bool logical, tmt_syntax_result *result);
void tmt_syntax_free(tmt_syntax_candidate *rows, size_t len);

#endif
