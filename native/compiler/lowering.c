#include "lowering.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "Custard.h"

typedef struct {
  char *code;
  size_t length, capacity, limit;
  bool failed;
} writer;

typedef struct {
  TmtPulseMemory_tape input;
  uint32_t at;
  writer output;
  bool classic;
  unsigned helpers;
} lowering;

enum { jsx_one = 1, jsx_many = 2, jsx_fragment = 4 };

static void write_bytes(writer *out, const void *bytes, size_t size) {
  if (out->failed || !size) return;
  if (size > out->limit - out->length) { out->failed = true; return; }
  const size_t end = out->length + size;
  if (end > out->capacity) {
    size_t capacity = out->capacity ? out->capacity * 2 : 256;
    if (capacity > out->limit) capacity = out->limit;
    if (capacity < end) capacity = end;
    char *grown = realloc(out->code, capacity);
    if (!grown) { out->failed = true; return; }
    out->capacity = capacity;
    out->code = grown;
  }
  memcpy(out->code + out->length, bytes, size);
  out->length = end;
}

static void put(writer *out, const char *value) { write_bytes(out, value, strlen(value)); }

static uint8_t peek(const lowering *lower) {
  return lower->at < lower->input.size ? lower->input.source[lower->at] : 0;
}

static bool consume(lowering *lower, uint8_t byte) {
  if (lower->at >= lower->input.size || peek(lower) != byte) return false;
  lower->at++;
  return true;
}

static bool trivia(lowering *lower) {
  const TmtPulseParser_cursor found = TmtPulseParser_trivia(lower->input, lower->at);
  if (!found.ok || found.at > lower->input.size) return false;
  lower->at = found.at;
  return true;
}

static bool space(uint8_t byte) { return byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r'; }

static void tag_space(lowering *lower) {
  while (space(peek(lower))) lower->at++;
}

static bool same_bytes(const lowering *lower, TmtGrammar_span part, const char *word) {
  return part.last - part.first == strlen(word) &&
    !memcmp(lower->input.source + part.first, word, part.last - part.first);
}

static void source_bytes(lowering *lower, uint32_t first, uint32_t last) {
  if (first > last || last > lower->input.size) { lower->output.failed = true; return; }
  write_bytes(&lower->output, lower->input.source + first, last - first);
}

static const char *entity(const uint8_t *bytes, size_t limit, size_t *length) {
  static const struct { const char *name, *escaped; } entities[] = {
    { "&amp;", "&" }, { "&lt;", "<" }, { "&gt;", ">" }, { "&quot;", "\\\"" },
    { "&apos;", "'" }, { "&nbsp;", "\\u00a0" },
  };
  for (size_t index = 0; index < sizeof(entities) / sizeof(entities[0]); index++) {
    const size_t size = strlen(entities[index].name);
    if (size <= limit && memcmp(bytes, entities[index].name, size) == 0) {
      *length = size;
      return entities[index].escaped;
    }
  }
  return NULL;
}

static bool quote_contents(lowering *lower, TmtGrammar_span span, bool decode) {
  uint32_t run = span.first;
  for (uint32_t at = span.first; at < span.last; at++) {
    const uint8_t byte = lower->input.source[at];
    const char *replacement;
    size_t consumed = 1;
    if (decode && byte == 0xe2 && span.last - at >= 3 && lower->input.source[at + 1] == 0x80 &&
        (lower->input.source[at + 2] == 0xa8 || lower->input.source[at + 2] == 0xa9)) return false;
    if (byte == '"') replacement = "\\\"";
    else if (byte == '\\') replacement = "\\\\";
    else if (byte == '\t') replacement = "\\t";
    else if (byte == '&' && decode) {
      replacement = entity(lower->input.source + at, span.last - at, &consumed);
      if (!replacement) return false;
    } else {
      if (byte < 32) return false;
      continue;
    }
    source_bytes(lower, run, at);
    put(&lower->output, replacement);
    at += (uint32_t)consumed - 1;
    run = at + 1;
  }
  source_bytes(lower, run, span.last);
  return !lower->output.failed;
}

static bool quote(lowering *lower, TmtGrammar_span span, bool decode) {
  put(&lower->output, "\"");
  if (!quote_contents(lower, span, decode)) return false;
  put(&lower->output, "\"");
  return !lower->output.failed;
}

static bool literal_string(lowering *lower, uint32_t *last) {
  const uint8_t delimiter = peek(lower);
  if (delimiter != '"' && delimiter != '\'') return false;
  const TmtPulseParser_cursor stop = TmtPulseParser_string_end(lower->input, lower->at + 1,
    delimiter, lower->input.size, false);
  if (!stop.ok) return false;
  *last = stop.at;
  return true;
}

static bool enum_integer(lowering *lower, int64_t *value) {
  const bool negative = consume(lower, '-');
  if (!TmtGrammar_decimal_digit(peek(lower))) return false;
  const bool zero = peek(lower) == '0';
  uint64_t integer = 0;
  do {
    integer = integer * 10 + (peek(lower) - '0');
    if (integer > UINT64_C(9007199254740991)) return false;
    lower->at++;
    if (zero && TmtGrammar_decimal_digit(peek(lower))) return false;
  } while (TmtGrammar_decimal_digit(peek(lower)));
  *value = negative ? -(int64_t)integer : (int64_t)integer;
  return true;
}

static bool emit_enum(lowering *lower, TmtGrammar_span binding, bool exported) {
  writer *out = &lower->output;
  put(out, exported ? "export var " : "var ");
  source_bytes(lower, binding.first, binding.last);
  put(out, "; (function (");
  source_bytes(lower, binding.first, binding.last);
  put(out, ") {");
  int64_t next = 0;
  bool numeric = true;
  for (uint32_t index = 0; ; index++) {
    if (!trivia(lower)) return false;
    if (consume(lower, '}')) break;
    if (index == 4096) return false;
    const uint32_t key_start = lower->at;
    if (!TmtGrammar_identifier_start(peek(lower))) return false;
    do { lower->at++; } while (TmtGrammar_identifier_continue(peek(lower)));
    const TmtGrammar_span key = { key_start, lower->at };
    if (same_bytes(lower, key, "__proto__") || !trivia(lower)) return false;

    uint32_t value_start = 0, value_end = 0;
    if (consume(lower, '=')) {
      if (!trivia(lower)) return false;
      value_start = lower->at;
      numeric = peek(lower) != '"' && peek(lower) != '\'';
      if (numeric) {
        if (!enum_integer(lower, &next)) return false;
      } else if (!literal_string(lower, &lower->at)) return false;
      value_end = lower->at;
    } else if (!numeric || next > INT64_C(9007199254740991)) return false;

    source_bytes(lower, binding.first, binding.last);
    put(out, "[");
    if (numeric) {
      source_bytes(lower, binding.first, binding.last);
      put(out, "[");
    }
    if (!quote(lower, key, false)) return false;
    put(out, "]=");
    if (value_end && numeric && next == 0) put(out, "0");
    else if (value_end) source_bytes(lower, value_start, value_end);
    else {
      char value[32];
      snprintf(value, sizeof(value), "%" PRId64, next);
      put(out, value);
    }
    if (numeric) {
      put(out, "]=");
      if (!quote(lower, key, false)) return false;
      next++;
    }
    put(out, ";");
    if (out->failed || !trivia(lower)) return false;
    if (consume(lower, '}')) break;
    if (!consume(lower, ',')) return false;
  }
  put(out, "})(");
  source_bytes(lower, binding.first, binding.last);
  put(out, "||(");
  source_bytes(lower, binding.first, binding.last);
  put(out, "={}));");
  return !out->failed;
}

static bool js_atom(lowering *lower) {
  if (!trivia(lower)) return false;
  const uint32_t start = lower->at;
  uint32_t end;
  if (literal_string(lower, &end)) lower->at = end;
  else {
    const TmtPulseParser_cursor stop = TmtPulseCompiler_runtime_atom(lower->input, lower->at);
    if (!stop.ok || stop.at <= lower->at || stop.at > lower->input.size) return false;
    const bool member_base = TmtGrammar_identifier_start(peek(lower));
    lower->at = stop.at;
    if (member_base) {
      while (consume(lower, '.')) {
        if (!TmtGrammar_identifier_start(peek(lower))) return false;
        do { lower->at++; } while (TmtGrammar_identifier_continue(peek(lower)));
      }
    }
  }
  source_bytes(lower, start, lower->at);
  return true;
}

static bool jsx_element(lowering *lower, uint32_t depth);

static bool jsx_value(lowering *lower, uint32_t depth) {
  if (!trivia(lower)) return false;
  if (peek(lower) == '<') {
    if (!jsx_element(lower, depth)) return false;
  } else {
    if (!js_atom(lower) || !trivia(lower)) return false;
    if (peek(lower) == '<' || peek(lower) == '>') {
      const uint32_t start = lower->at++;
      consume(lower, '=');
      source_bytes(lower, start, lower->at);
      if (!js_atom(lower)) return false;
    }
  }
  return trivia(lower) && consume(lower, '}');
}

static bool jsx_quoted(lowering *lower) {
  const uint8_t delimiter = peek(lower);
  const uint32_t begin = ++lower->at;
  while (lower->at < lower->input.size && peek(lower) != delimiter) lower->at++;
  const TmtGrammar_span span = { begin, lower->at };
  return consume(lower, delimiter) && quote(lower, span, true);
}

static bool jsx_name(lowering *lower, TmtGrammar_span *span) {
  const uint32_t first = lower->at;
  const TmtPulseParser_cursor stop = TmtPulseCompiler_runtime_tag_name(lower->input, first);
  if (!stop.ok || stop.at <= first || stop.at > lower->input.size) return false;
  *span = (TmtGrammar_span){ first, stop.at };
  lower->at = stop.at;
  return true;
}

static bool jsx_attributes(lowering *lower, uint32_t depth, size_t *properties) {
  for (;;) {
    const uint32_t previous = lower->at;
    tag_space(lower);
    if (peek(lower) == '/' || peek(lower) == '>') return true;
    if (previous == lower->at || *properties == 4096) return false;
    if ((*properties)++ != 0) put(&lower->output, ",");
    if (consume(lower, '{')) {
      if (!trivia(lower) || !consume(lower, '.') || !consume(lower, '.') || !consume(lower, '.')) return false;
      put(&lower->output, "...");
      if (!jsx_value(lower, depth)) return false;
      continue;
    }
    const uint32_t first = lower->at;
    const TmtPulseParser_cursor prop = TmtPulseParser_name(lower->input, first, true, false);
    if (!prop.ok || prop.at <= first || prop.at > lower->input.size) return false;
    lower->at = prop.at;
    const TmtGrammar_span key = { first, prop.at };
    if (same_bytes(lower, key, "__proto__") || (!lower->classic && same_bytes(lower, key, "key"))) return false;
    if (!quote(lower, key, false)) return false;
    put(&lower->output, ":");
    tag_space(lower);
    if (!consume(lower, '=')) {
      lower->at = prop.at;
      put(&lower->output, "true");
      continue;
    }
    tag_space(lower);
    if (peek(lower) == '"' || peek(lower) == '\'') {
      if (!jsx_quoted(lower)) return false;
    } else if (!consume(lower, '{') || !jsx_value(lower, depth)) return false;
    if (lower->output.failed) return false;
  }
}

static bool jsx_newline(uint8_t byte) { return byte == '\r' || byte == '\n'; }

static uint32_t jsx_space_width(const uint8_t *bytes, uint32_t remaining) {
  if (*bytes == ' ' || *bytes == '\t' || *bytes == '\v' || *bytes == '\f') return 1;
  if (remaining >= 2 && bytes[0] == 0xc2 && (bytes[1] == 0x85 || bytes[1] == 0xa0)) return 2;
  if (remaining < 3) return 0;
  const unsigned triplet = ((unsigned)bytes[0] << 16) | ((unsigned)bytes[1] << 8) | bytes[2];
  return (triplet >= 0xe28080 && triplet <= 0xe2808b) || triplet == 0xe19a80 || triplet == 0xe280af ||
    triplet == 0xe2819f || triplet == 0xe38080 || triplet == 0xefbbbf ? 3 : 0;
}

static bool jsx_text(lowering *lower, TmtGrammar_span *text, bool *multiline, bool *visible) {
  *text = (TmtGrammar_span){ lower->at, lower->at };
  const uint8_t *source = lower->input.source;
  while (lower->at < lower->input.size && peek(lower) != '<' && peek(lower) != '{') {
    const uint8_t byte = peek(lower);
    if (byte == '}' || byte == '>') return false;
    if (jsx_newline(byte)) {
      *multiline = true;
      lower->at++;
    } else {
      const uint32_t width = jsx_space_width(source + lower->at, lower->input.size - lower->at);
      *visible |= !width;
      lower->at += width ? width : 1;
    }
  }
  text->last = lower->at;
  return text->first != text->last;
}

static bool quote_jsx_lines(lowering *lower, TmtGrammar_span text) {
  writer *out = &lower->output;
  const uint8_t *source = lower->input.source;
  bool first_line = true, written = false;
  uint32_t start = text.first;
  put(out, "\"");
  while (start < text.last) {
    uint32_t at = start, first = text.last, last = start;
    while (at < text.last && !jsx_newline(source[at])) {
      const uint32_t width = jsx_space_width(source + at, text.last - at);
      if (width) at += width;
      else {
        if (first == text.last) first = at;
        last = ++at;
      }
    }
    if (first != text.last) {
      if (written) put(out, " ");
      if (!quote_contents(lower, (TmtGrammar_span){ first_line ? start : first, at == text.last ? at : last }, true)) {
        return false;
      }
      written = true;
    }
    if (at == text.last) break;
    first_line = false;
    start = at + 1;
  }
  put(out, "\"");
  return !out->failed;
}

static bool jsx_children(lowering *lower, TmtGrammar_span tag, uint32_t depth, size_t props, size_t helper_offset) {
  writer *out = &lower->output;
  size_t children = 0, array_open = 0;
  for (;;) {
    if (lower->at >= lower->input.size || out->failed) return false;
    const bool element = peek(lower) == '<';
    if (element && lower->at + 1 < lower->input.size && lower->input.source[lower->at + 1] == '/') {
      lower->at += 2;
      if (tag.first != tag.last) {
        TmtGrammar_span close;
        if (!jsx_name(lower, &close) || close.last - close.first != tag.last - tag.first ||
          memcmp(lower->input.source + close.first, lower->input.source + tag.first, tag.last - tag.first)) return false;
      }
      tag_space(lower);
      if (!consume(lower, '>')) return false;
      if (!lower->classic) {
        if (children > 1) {
          out->code[helper_offset + 7] = 's';
          lower->helpers |= jsx_many;
          put(out, "]");
        } else {
          lower->helpers |= jsx_one;
          if (children) out->code[array_open] = ' ';
        }
        put(out, "}");
      }
      put(out, ")");
      return !out->failed;
    }
    const bool expression = !element && consume(lower, '{');
    TmtGrammar_span text = {0};
    bool multiline = false, visible = false;
    if (expression) {
      if (!trivia(lower)) return false;
      if (consume(lower, '}')) continue;
    } else if (!element) {
      if (!jsx_text(lower, &text, &multiline, &visible)) return false;
      if (multiline && !visible) continue;
    }
    if (lower->classic || children) put(out, ",");
    else {
      if (props) put(out, ",");
      put(out, "children:");
      array_open = out->length;
      put(out, "[");
    }
    children++;
    if (element) {
      if (!jsx_element(lower, depth)) return false;
    } else if (expression) {
      if (!jsx_value(lower, depth)) return false;
    } else if (multiline) {
      if (!quote_jsx_lines(lower, text)) return false;
    } else if (!quote(lower, text, true)) return false;
  }
}

static bool jsx_element(lowering *lower, uint32_t depth) {
  if (!depth || !consume(lower, '<')) return false;
  writer *out = &lower->output;
  const bool fragment = peek(lower) == '>';
  TmtGrammar_span tag = { lower->at, lower->at };
  if (!fragment && !jsx_name(lower, &tag)) return false;
  const size_t helper_offset = out->length;
  put(out, lower->classic ? "React.createElement(" : "_tmtJsx0(");
  if (fragment) {
    put(out, lower->classic ? "React.Fragment" : "_tmtFragment");
    if (!lower->classic) lower->helpers |= jsx_fragment;
  }
  else {
    const uint8_t *name = lower->input.source + tag.first;
    const size_t length = tag.last - tag.first;
    const bool dotted = memchr(name, '.', length) != NULL;
    const bool dashed = memchr(name, '-', length) != NULL;
    if (dotted) {
      if (dashed) return false;
      const uint8_t *dot = memchr(name, '.', length);
      const TmtGrammar_span root = { tag.first, (uint32_t)(dot - lower->input.source) };
      const TmtPulseParser_cursor start = TmtPulseParser_name(lower->input, root.first, false, false);
      if ((!start.ok || start.at != root.last) && !same_bytes(lower, root, "this")) return false;
    }
    if (!dotted && !same_bytes(lower, tag, "this") && ((name[0] >= 'a' && name[0] <= 'z') || dashed)) {
      if (!quote(lower, tag, false)) return false;
    } else source_bytes(lower, tag.first, tag.last);
  }
  put(out, ",");
  const size_t props_open = out->length;
  put(out, "{");
  size_t props = 0;
  if (!fragment && !jsx_attributes(lower, depth - 1, &props)) return false;
  const bool self_closed = !fragment && consume(lower, '/');
  if (!consume(lower, '>')) return false;
  if (lower->classic) {
    if (props) put(out, "}");
    else if (!out->failed) { out->length = props_open; put(out, "null"); }
  }
  if (self_closed) {
    if (!lower->classic) lower->helpers |= jsx_one;
    put(out, lower->classic ? ")" : "})");
    return !out->failed;
  }
  return jsx_children(lower, tag, depth - 1, props, helper_offset);
}

static bool emit_jsx(lowering *lower, TmtPulseCompiler_runtime_head head) {
  uint32_t cursor = head.declaration;
  const TmtGrammar_span erased[] = { head.binding_type, head.parameter_type, head.return_type };
  for (size_t index = 0; index < sizeof(erased) / sizeof(erased[0]); index++) {
    const TmtGrammar_span span = erased[index];
    if (span.first == span.last) continue;
    if (span.first < cursor || span.last > head.body || span.first > span.last) return false;
    source_bytes(lower, cursor, span.first);
    cursor = span.last;
  }
  source_bytes(lower, cursor, head.body);
  if (!jsx_element(lower, 32)) return false;
  put(&lower->output, ";");
  return !lower->output.failed;
}

static bool inject_jsx_runtime(lowering *lower, size_t at) {
  if (!lower->helpers) return true;
  writer *out = &lower->output;
  const bool one = (lower->helpers & jsx_one) != 0;
  const bool many = (lower->helpers & jsx_many) != 0;
  const bool fragment = (lower->helpers & jsx_fragment) != 0;
  char import[128];
  const int size = snprintf(import, sizeof(import), "import{%s%s%s%s%s}from\"react/jsx-runtime\";\n",
    one ? "jsx as _tmtJsx0" : "", one && many ? "," : "", many ? "jsxs as _tmtJsxs" : "",
    (one || many) && fragment ? "," : "", fragment ? "Fragment as _tmtFragment" : "");
  if (size < 0 || (size_t)size >= sizeof(import) || at > out->length) return false;
  const size_t before = out->length;
  write_bytes(out, import, (size_t)size);
  if (out->failed) return false;
  memmove(out->code + at + size, out->code + at, before - at);
  memcpy(out->code + at, import, (size_t)size);
  return true;
}

static char *lower_one(uint8_t *source, uint32_t size, bool jsx, bool typescript, bool classic, size_t *length) {
  const TmtPulseMemory_tape input = { .source = source, .size = size };
  const TmtPulseCompiler_runtime_head head = TmtPulseCompiler_read_runtime_head(input, 0, jsx, typescript, false);
  if (!head.kind) return NULL;
  lowering lower = { .input = input, .at = head.body, .classic = classic, .output.limit = (size_t)size * 32 + 1024 };
  source_bytes(&lower, 0, head.declaration);
  const bool emitted = head.kind == 1 ? emit_enum(&lower, head.name_span, true) : emit_jsx(&lower, head);
  const uint32_t suffix = lower.at;
  if (emitted && trivia(&lower)) {
    consume(&lower, ';');
    if (trivia(&lower) && lower.at == size && !lower.output.failed) {
      source_bytes(&lower, suffix, size);
      if (!lower.output.failed && inject_jsx_runtime(&lower, head.declaration)) {
        *length = lower.output.length;
        return lower.output.code;
      }
    }
  }
  free(lower.output.code);
  return NULL;
}

#ifndef TMT_DIRECT
typedef struct {
  TmtPulseMemory_binding_name bindings[2367];
  TmtGrammar_candidate comparisons[128];
  uint8_t marks[128];
} module_workspace;

static TmtPulseMemory_tape with_workspace(uint8_t *source, uint32_t size, module_workspace *memory) {
  return (TmtPulseMemory_tape){
    .source = source, .size = size, .private_possible = memchr(source, '#', size) != NULL,
    .output = memory->comparisons, .capacity = sizeof(memory->comparisons) / sizeof(*memory->comparisons),
    .bindings = memory->bindings, .marks = memory->marks,
  };
}

static bool find_marker(TmtPulseMemory_tape input, uint32_t at, bool jsx) {
  while (at < input.size) {
    if (TmtPulseCompiler_runtime_module_marker(input, at)) return true;
    const uint32_t next = TmtPulseCompiler_next_module_item(input, jsx, at);
    if (next <= at || next > input.size) return false;
    at = next;
  }
  return false;
}

static bool module_after_prelude(uint8_t *source, uint32_t size, uint32_t at, bool first, bool validate) {
  module_workspace memory = {0};
  const TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  return (!validate || TmtPulseCompiler_supported_module(input, false)) && (first || find_marker(input, at, false));
}

bool tmt_module_marker(uint8_t *source, uint32_t size, bool validate) {
  const TmtPulseMemory_tape input = { .source = source, .size = size };
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok || first.at == size) return false;
  const bool initial = TmtPulseCompiler_runtime_module_marker(input, first.at);
  if (initial && !validate) return true;
  return module_after_prelude(source, size, first.at, initial, validate);
}

#endif

bool tmt_leading_directive(uint8_t *source, uint32_t size) {
  const TmtPulseMemory_tape input = { .source = source, .size = size };
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok) return true;
  for (uint32_t index = 0; index + 2 < first.at; index++) {
    if (source[index] == '/' && source[index + 1] == '/' && source[index + 2] == '/') return true;
  }
  return false;
}

#ifndef TMT_DIRECT
static char *lower_mixed(uint8_t *source, uint32_t size, bool jsx, bool classic, size_t *length) {
  module_workspace memory = {0};
  const TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok || !TmtPulseCompiler_runtime_module_marker(input, first.at) ||
      !TmtPulseCompiler_supported_module(input, jsx)) return NULL;
  lowering lower = { .input = input, .classic = classic, .output.limit = (size_t)size * 32 + 1024 };
  uint32_t keep = 0;
  for (uint32_t cursor = first.at; cursor < size;) {
    const uint32_t end = TmtPulseCompiler_next_module_item(input, jsx, cursor);
    if (end <= cursor || end > size) goto decline;
    lower.input.size = end;
    const TmtPulseCompiler_runtime_head head = TmtPulseCompiler_read_runtime_head(lower.input, cursor, jsx, true, true);
    if (head.kind) {
      if (head.declaration < keep || head.body > end) goto decline;
      source_bytes(&lower, keep, head.declaration);
      lower.at = head.body;
      const bool emitted = head.kind == 2 ? emit_jsx(&lower, head) : emit_enum(&lower, head.name_span, head.kind == 1);
      const uint32_t finish = lower.at;
      if (!emitted || !trivia(&lower)) goto decline;
      consume(&lower, ';');
      if (!trivia(&lower) || lower.at != end) goto decline;
      keep = finish;
    }
    cursor = end;
  }
  if (!keep) return NULL;
  lower.input.size = size;
  source_bytes(&lower, keep, size);
  if (lower.output.failed || !inject_jsx_runtime(&lower, first.at)) goto decline;
  *length = lower.output.length;
  return lower.output.code;
decline:
  free(lower.output.code);
  return NULL;
}

#endif

char *tmt_lower_runtime(uint8_t *source, uint32_t size, bool jsx, bool typescript, bool classic,
  bool mixed, size_t *length)
{
  if (!size) return NULL;
  if (mixed) {
#ifdef TMT_DIRECT
    return NULL;
#else
    return lower_mixed(source, size, jsx, classic, length);
#endif
  }
  return lower_one(source, size, jsx, typescript, classic, length);
}
