#include <string.h>

#include "parser.h"

tmt_result tmt_parse(const uint8_t *source, uint32_t size, int tsx, int module,
                     TmtGrammar_candidate *output, uint32_t capacity) {
  if (size > TMT_SOURCE_MAX) return (tmt_result){ .status = TMT_SOURCE_LIMIT };
  if (capacity > TMT_CANDIDATES_MAX) capacity = TMT_CANDIDATES_MAX;
  // Pulse checks publication marks before any possibly uninitialized candidate is copied.
  TmtPulseMemory_binding_name bindings[2303] = {0};
  uint8_t marks[TMT_CANDIDATES_MAX];
  memset(marks, 0, capacity);
  const bool private_possible = size != 0 && memchr(source, '#', size) != NULL;
  const TmtPulseMemory_tape input = {
    .source = (uint8_t *)source, .size = size, .private_possible = private_possible,
    .output = output, .capacity = capacity, .bindings = bindings, .marks = marks,
  };
  const TmtPulseParser_parser_state result = TmtPulseParser_parse(input, tsx != 0, module != 0);
  tmt_result parsed = { .status = (tmt_status)result.status, .count = result.count, .max_depth = result.depth };
  if (parsed.status == TMT_DUPLICATE_LEXICAL) {
    const TmtPulseParser_lexical_conflict conflict = TmtPulseParser_lexical_duplicate(input);
    if (conflict.repeated_name.first == conflict.repeated_name.last) {
      parsed.status = TMT_UNSUPPORTED;
    } else {
      parsed.first_name = conflict.first_name;
      parsed.repeated_name = conflict.repeated_name;
    }
  }
  return parsed;
}
