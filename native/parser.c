#include "parser.h"
#include "TmtParser.h"

tmt_result tmt_parse(const uint8_t *source, uint32_t size, int tsx, int module,
                     TmtGrammar_candidate *output, uint32_t capacity) {
  if (size > TMT_SOURCE_MAX) return (tmt_result){ .status = TMT_SOURCE_LIMIT };
  TmtParser_binding_name bindings[1536];
  const uint32_t region_width = (uint32_t)(sizeof(bindings) / sizeof(*bindings)) / 3;
  if (TmtParser_binding_region_width != region_width || TmtParser_export_region_base != 2 * region_width)
    return (tmt_result){ .status = TMT_UNSUPPORTED };
  const TmtParser_tape input = { source, size, output, capacity, bindings };
  const TmtParser_parser_state result = TmtParser_parse(input, tsx != 0, module != 0);
  tmt_result parsed = { .status = (tmt_status)result.status, .count = result.count, .max_depth = result.depth };
  if (parsed.status == TMT_DUPLICATE_LEXICAL) {
    const TmtParser_lexical_conflict conflict = TmtParser_lexical_duplicate(input);
    if (conflict.repeated_name.first == conflict.repeated_name.last) {
      parsed.status = TMT_UNSUPPORTED;
    } else {
      parsed.first_name = conflict.first_name;
      parsed.repeated_name = conflict.repeated_name;
    }
  }
  return parsed;
}
