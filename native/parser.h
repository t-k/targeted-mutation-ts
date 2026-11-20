#ifndef TMT_PARSER_H
#define TMT_PARSER_H

#include <stdint.h>
#include "TmtGrammar.h"

typedef enum {
  TMT_DONE,
  TMT_UNSUPPORTED,
  TMT_SOURCE_LIMIT,
  TMT_DEPTH_LIMIT,
  TMT_CANDIDATE_LIMIT
} tmt_status;

typedef struct {
  tmt_status status;
  uint32_t count;
  uint32_t max_depth;
} tmt_result;

enum { TMT_SOURCE_MAX = 1048576, TMT_CANDIDATES_MAX = 4096 };

tmt_result tmt_parse(const uint8_t *source, uint32_t size, int tsx, int module,
                     TmtGrammar_candidate *output, uint32_t capacity);

#endif
