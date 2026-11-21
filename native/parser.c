#include "parser.h"
#include "TmtParser.h"

tmt_result tmt_parse(const uint8_t *source, uint32_t size, int tsx, int module,
                     TmtGrammar_candidate *output, uint32_t capacity) {
  if (size > TMT_SOURCE_MAX) return (tmt_result){ TMT_SOURCE_LIMIT, 0, 0 };
  TmtGrammar_span bindings[128];
  const TmtParser_tape input = { source, size, output, capacity, bindings };
  const TmtParser_parser_state result = TmtParser_parse(input, tsx != 0, module != 0);
  return (tmt_result){ (tmt_status)result.status, result.count, result.depth };
}
