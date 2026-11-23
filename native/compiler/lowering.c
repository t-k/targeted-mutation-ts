#include "lowering.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "Custard.h"
#include "jsx-entities.h"

#if !defined(TMT_SCALAR_SCANS) && (defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__)))
#include "tmt_simd_scan.h"
#define TMT_SIMD_COMPILER 1
#endif

typedef struct {
  char *code;
  size_t length, capacity, limit;
  bool failed;
} writer;

typedef struct {
  TmtPulseMemory_tape input;
  uint32_t at;
  writer output;
  bool classic, mixed;
  unsigned helpers;
#ifndef TMT_DIRECT
  const TmtGrammar_span *jsx_spans, *expressions;
  size_t jsx_count, expression_count;
#endif
} lowering;

enum { jsx_one = 1, jsx_many = 2, jsx_fragment = 4, jsx_create = 8, jsx_create_first = 16 };

typedef struct {
  writer key;
  unsigned key_helpers;
  size_t count;
  bool has_key, create;
} jsx_props;

static void register_jsx_helper(lowering *lower, unsigned helper) {
  if (!lower->helpers && helper == jsx_create) lower->helpers = jsx_create_first;
  lower->helpers |= helper;
}

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

static bool tag_trivia(lowering *lower) {
  const uint8_t byte = peek(lower);
  return byte != '/' && byte < 128 && !space(byte) ? true : trivia(lower);
}

static bool same_bytes(const lowering *lower, TmtGrammar_span part, const char *word) {
  return part.last - part.first == strlen(word) &&
    !memcmp(lower->input.source + part.first, word, part.last - part.first);
}

static void source_bytes(lowering *lower, uint32_t first, uint32_t last) {
  if (first > last || last > lower->input.size) { lower->output.failed = true; return; }
  write_bytes(&lower->output, lower->input.source + first, last - first);
}

static size_t entity(const uint8_t *bytes, size_t limit, char escaped[16]) {
  if (limit < 3) return 0;
  size_t end = 1;
  uint32_t value = 0;
  if (bytes[end] == '#') {
    end++;
    const bool hex = bytes[end] == 'x';
    if (hex) end++;
    const size_t first = end;
    while (end < limit) {
      const uint8_t byte = bytes[end];
      uint32_t digit;
      if (byte >= '0' && byte <= '9') digit = byte - '0';
      else if (hex && byte >= 'a' && byte <= 'f') digit = byte - 'a' + 10;
      else if (hex && byte >= 'A' && byte <= 'F') digit = byte - 'A' + 10;
      else break;
      value = value * (hex ? 16 : 10) + digit;
      if (value > 0x10ffff) return 0;
      end++;
    }
    if (end == first || end == limit || bytes[end] != ';') return 0;
  } else {
    char name[10];
    while (end < limit && end < sizeof(name) && TmtGrammar_identifier_continue(bytes[end])) end++;
    if (end == 1 || end == limit || bytes[end] != ';') return 0;
    memcpy(name, bytes + 1, end - 1);
    name[end - 1] = '\0';
    size_t first = 0, last = sizeof(jsx_entities) / sizeof(*jsx_entities);
    while (first < last) {
      const size_t middle = first + (last - first) / 2;
      const int order = strcmp(name, jsx_entities[middle].name);
      if (order < 0) last = middle;
      else if (order > 0) first = middle + 1;
      else {
        value = jsx_entities[middle].value;
        break;
      }
    }
    if (!value) return 0;
  }
  if (value <= 0xffff) snprintf(escaped, 16, "\\u%04" PRIx32, value);
  else snprintf(escaped, 16, "\\u{%" PRIx32 "}", value);
  return end + 1;
}

static bool quote_contents(lowering *lower, TmtGrammar_span span, bool decode) {
  uint32_t run = span.first;
  for (uint32_t at = span.first; at < span.last; at++) {
#ifdef TMT_SIMD_COMPILER
    if (span.last - at >= 64 && tmt_jsx_quote_run(lower->input.source + at, decode)) {
      at += 15;
      continue;
    }
#endif
    const uint8_t byte = lower->input.source[at];
    const char *replacement;
    char escaped[16];
    size_t consumed = 1;
    if (decode && byte == 0xe2 && span.last - at >= 3 && lower->input.source[at + 1] == 0x80 &&
        (lower->input.source[at + 2] == 0xa8 || lower->input.source[at + 2] == 0xa9)) return false;
    if (byte == '"') replacement = "\\\"";
    else if (byte == '\\') replacement = "\\\\";
    else if (byte == '\t') replacement = "\\t";
    else if (byte == '&' && decode) {
      consumed = entity(lower->input.source + at, span.last - at, escaped);
      if (!consumed) continue;
      replacement = escaped;
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

#ifndef TMT_DIRECT
static size_t span_at_or_after(const TmtGrammar_span *spans, size_t count, uint32_t first) {
  size_t lo = 0, hi = count;
  while (lo < hi) {
    const size_t middle = lo + (hi - lo) / 2;
    if (spans[middle].first < first) lo = middle + 1;
    else hi = middle;
  }
  return lo;
}

static bool source_jsx(lowering *lower, uint32_t first, uint32_t last, uint32_t depth) {
  for (size_t index = span_at_or_after(lower->jsx_spans, lower->jsx_count, first); index < lower->jsx_count; index++) {
    const TmtGrammar_span span = lower->jsx_spans[index];
    if (span.first >= last) break;
    if (span.first < first) continue;
    if (span.last > last || span.last <= span.first) return false;
    source_bytes(lower, first, span.first);
    lower->at = span.first;
    if (!jsx_element(lower, depth) || lower->at != span.last) return false;
    first = span.last;
  }
  source_bytes(lower, first, last);
  return !lower->output.failed;
}
#endif

static bool jsx_value(lowering *lower, uint32_t depth) {
  if (!trivia(lower)) return false;
#ifndef TMT_DIRECT
  if (lower->jsx_spans) {
    const size_t index = span_at_or_after(lower->expressions, lower->expression_count, lower->at);
    if (index == lower->expression_count) return false;
    const TmtGrammar_span span = lower->expressions[index];
    if (span.first != lower->at || span.last <= lower->at || span.last >= lower->input.size) return false;
    put(&lower->output, "(");
    if (!source_jsx(lower, span.first, span.last, depth)) return false;
    put(&lower->output, ")");
    lower->at = span.last;
  } else
#endif
  if (peek(lower) == '<') {
    if (!jsx_element(lower, depth)) return false;
#ifndef TMT_DIRECT
  } else if (lower->mixed) {
    const TmtPulseParser_cursor end = TmtPulseCompiler_jsx_expression_end(lower->input, lower->at);
    if (!end.ok || end.at <= lower->at || end.at >= lower->input.size) return false;
    put(&lower->output, "(");
    source_bytes(lower, lower->at, end.at);
    put(&lower->output, ")");
    lower->at = end.at;
#endif
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

static bool jsx_property_value(lowering *lower, uint32_t depth, uint32_t name_end) {
  if (!tag_trivia(lower)) return false;
  if (!consume(lower, '=')) {
    lower->at = name_end;
    put(&lower->output, "true");
    return !lower->output.failed;
  }
  if (!tag_trivia(lower)) return false;
  if (peek(lower) == '"' || peek(lower) == '\'') return jsx_quoted(lower);
  if (peek(lower) == '<') return jsx_element(lower, depth);
  return consume(lower, '{') && jsx_value(lower, depth) && !lower->output.failed;
}

static bool jsx_attributes(lowering *lower, uint32_t depth, jsx_props *properties) {
  bool spread = false;
  for (;;) {
    const uint32_t previous = lower->at;
    if (!tag_trivia(lower)) return false;
    if (peek(lower) == '/' || peek(lower) == '>') return true;
    if (previous == lower->at || properties->count == 4096) return false;
    if (consume(lower, '{')) {
      if (!trivia(lower) || !consume(lower, '.') || !consume(lower, '.') || !consume(lower, '.') || !trivia(lower)) return false;
      if (properties->count++ != 0) put(&lower->output, ",");
      put(&lower->output, "...");
      if (peek(lower) == '{') return false;
      spread = true;
      if (!jsx_value(lower, depth)) return false;
      continue;
    }
    const uint32_t first = lower->at;
    const TmtPulseParser_cursor prop = TmtPulseParser_jsx_attribute_name(lower->input, first);
    if (!prop.ok || prop.at <= first || prop.at > lower->input.size) return false;
    lower->at = prop.at;
    const TmtGrammar_span key = { first, prop.at };
    if (same_bytes(lower, key, "__proto__")) return false;
    if (!lower->classic && same_bytes(lower, key, "key")) {
      if (properties->has_key) return false;
      properties->has_key = true;
      properties->create = spread;
      if (!spread) {
        lowering saved = *lower;
        saved.output = (writer){ .limit = lower->output.limit };
        saved.helpers = 0;
        const bool accepted = jsx_property_value(&saved, depth, prop.at);
        properties->key = saved.output;
        properties->key_helpers = saved.helpers;
        if (!accepted) return false;
        lower->at = saved.at;
        continue;
      }
    }
    if (properties->count++ != 0) put(&lower->output, ",");
    if (!quote(lower, key, false)) return false;
    put(&lower->output, ":");
    if (!jsx_property_value(lower, depth, prop.at)) return false;
  }
}

static void put_jsx_key(lowering *lower, const jsx_props *props) {
  if (props->key.length) {
    put(&lower->output, ",");
    write_bytes(&lower->output, props->key.code, props->key.length);
    if (!lower->helpers) lower->helpers = props->key_helpers;
    else lower->helpers |= props->key_helpers & ~jsx_create_first;
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
#ifdef TMT_SIMD_COMPILER
    if ((lower->at & 15U) == 0 && lower->input.size - lower->at >= 16 && tmt_jsx_text_run(source + lower->at)) {
      *visible = true;
      lower->at += 16;
      continue;
    }
#endif
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

static bool jsx_children(lowering *lower, TmtGrammar_span tag, uint32_t depth, const jsx_props *props,
  size_t helper_offset, bool classic)
{
  writer *out = &lower->output;
  size_t children = 0, array_open = 0;
  for (;;) {
    if (lower->at >= lower->input.size || out->failed) return false;
    const bool element = peek(lower) == '<';
    if (element && lower->at + 1 < lower->input.size && lower->input.source[lower->at + 1] == '/') {
      lower->at += 2;
      if (!trivia(lower)) return false;
      if (tag.first != tag.last) {
        TmtGrammar_span close;
        if (!jsx_name(lower, &close) || close.last - close.first != tag.last - tag.first ||
          memcmp(lower->input.source + close.first, lower->input.source + tag.first, tag.last - tag.first)) return false;
      }
      tag_space(lower);
      if (!consume(lower, '>')) return false;
      if (!classic) {
        if (children > 1) {
          out->code[helper_offset + 7] = 's';
          put(out, "]");
        } else {
          if (children) out->code[array_open] = ' ';
        }
        put(out, "}");
        put_jsx_key(lower, props);
        register_jsx_helper(lower, children > 1 ? jsx_many : jsx_one);
      } else if (props->create) register_jsx_helper(lower, jsx_create);
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
    if (classic || children) put(out, ",");
    else {
      if (props->count) put(out, ",");
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
  if (!tag_trivia(lower)) return false;
  const bool fragment = peek(lower) == '>';
  TmtGrammar_span tag = { lower->at, lower->at };
  if (!fragment && !jsx_name(lower, &tag)) return false;
  const size_t helper_offset = out->length;
  put(out, lower->classic ? "React.createElement(" : "_tmtJsx0(");
  if (fragment) {
    put(out, lower->classic ? "React.Fragment" : "_tmtFragment");
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
  jsx_props props = {0};
  bool accepted = false;
  if (!fragment && !jsx_attributes(lower, depth - 1, &props)) goto done;
  const bool self_closed = !fragment && consume(lower, '/');
  if (self_closed) tag_space(lower);
  if (!consume(lower, '>')) goto done;
  const bool classic = lower->classic || props.create;
  if (classic) {
    if (props.create && !out->failed) memcpy(out->code + helper_offset, "_tmtElem", 8);
    if (props.count) put(out, "}");
    else if (!out->failed) { out->length = props_open; put(out, "null"); }
  }
  if (self_closed) {
    if (!classic) {
      put(out, "}");
      put_jsx_key(lower, &props);
      register_jsx_helper(lower, jsx_one);
    } else if (props.create) register_jsx_helper(lower, jsx_create);
    put(out, ")");
    accepted = !out->failed;
  } else {
    accepted = jsx_children(lower, tag, depth - 1, &props, helper_offset, classic);
  }
  if (accepted && fragment && !classic) register_jsx_helper(lower, jsx_fragment);

done:
  free(props.key.code);
  return accepted;
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
  uint32_t groups = 0;
  while (consume(lower, '(')) {
    if (++groups > 32 || !trivia(lower)) return false;
  }
  source_bytes(lower, cursor, lower->at);
  if (!jsx_element(lower, 32)) return false;
  while (groups) {
    const uint32_t close = lower->at;
    if (!trivia(lower) || !consume(lower, ')')) return false;
    source_bytes(lower, close, lower->at);
    groups--;
  }
  if (head.kind == 4) {
    uint32_t tail = lower->at;
    if (!trivia(lower)) return false;
    if (consume(lower, ';')) {
      source_bytes(lower, tail, lower->at);
      tail = lower->at;
      if (!trivia(lower)) return false;
    } else put(&lower->output, ";");
    if (!consume(lower, '}')) return false;
    source_bytes(lower, tail, lower->at);
  } else put(&lower->output, ";");
  return !lower->output.failed;
}

static bool inject_jsx_runtime(lowering *lower, size_t at) {
  if (!lower->helpers) return true;
  writer *out = &lower->output;
  const bool one = (lower->helpers & jsx_one) != 0;
  const bool many = (lower->helpers & jsx_many) != 0;
  const bool fragment = (lower->helpers & jsx_fragment) != 0;
  const char *create = lower->helpers & jsx_create ? "import{createElement as _tmtElem}from\"react\";\n" : "";
  const bool create_first = (lower->helpers & jsx_create_first) != 0;
  char import[192];
  const int size = snprintf(import, sizeof(import), "%s%s%s%s%s%s%s%s",
    create_first ? create : "", one || many || fragment ? "import{" : "",
    one ? "jsx as _tmtJsx0" : "", one && many ? "," : "", many ? "jsxs as _tmtJsxs" : "",
    fragment ? (one || many ? ",Fragment as _tmtFragment" : "Fragment as _tmtFragment") : "",
    one || many || fragment ? "}from\"react/jsx-runtime\";\n" : "", create_first ? "" : create);
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
    .count_only = true,
    .output = memory->comparisons, .capacity = sizeof(memory->comparisons) / sizeof(*memory->comparisons),
    .bindings = memory->bindings, .marks = memory->marks,
  };
}

static uint32_t find_marker(TmtPulseMemory_tape input, uint32_t at, bool jsx) {
  while (at < input.size) {
    if (TmtPulseCompiler_runtime_module_marker(input, at)) return at;
    const uint32_t next = TmtPulseCompiler_next_module_item(input, jsx, at);
    if (next <= at || next > input.size) break;
    at = next;
  }
  return input.size;
}

static bool module_after_prelude(uint8_t *source, uint32_t size, uint32_t at, bool first, bool validate) {
  module_workspace memory = {0};
  const TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  return (!validate || TmtPulseCompiler_supported_module(input, false)) && (first || find_marker(input, at, false) < input.size);
}

bool tmt_module_marker(uint8_t *source, uint32_t size, bool validate) {
  const TmtPulseMemory_tape input = { .source = source, .size = size };
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok || first.at == size) return false;
  const bool initial = TmtPulseCompiler_runtime_module_marker(input, first.at);
  if (initial && !validate) return true;
  return module_after_prelude(source, size, first.at, initial, validate);
}

#ifdef TMT_V8_VALIDATOR
#ifdef TMT_AUDIT_V8
bool tmt_audit_javascript_module(const char *code, size_t length, const char *phase);
#define validate_emission(code, length, phase) tmt_audit_javascript_module(code, length, phase)
#else
bool tmt_valid_javascript_module(const char *code, size_t length);
#define validate_emission(code, length, phase) tmt_valid_javascript_module(code, length)
#endif
static bool unambiguous_projection(TmtPulseMemory_tape input, uint32_t records);

enum {
  type_annotation = 7,
  erased_type_statement = 8,
  runtime_module_statement = 9,
  type_arguments = 10,
  type_assertion = 11,
  type_marker = 12,
  runtime_enum = 13,
  erased_list_member = 14,
  class_modifiers = 15,
  generic_arrow = 16,
  lexical_text = 17,
  class_implements = 18,
  erased_local_type = 19,
  arrow_result = 20,
  default_overload = 21,
};

static uint32_t skip_js_literal_or_comment(TmtPulseMemory_tape input, uint32_t at, bool *certain) {
  if (!*certain) return at;
  const uint8_t byte = input.source[at];
  if (byte == '"' || byte == '\'') {
    const TmtPulseParser_cursor end = TmtPulseParser_string_end(input, at + 1, byte, input.size, false);
    if (end.ok) return end.at;
    *certain = false;
  } else if (byte == '/') {
    if (input.size - at >= 2 && (input.source[at + 1] == '/' || input.source[at + 1] == '*')) {
      const TmtPulseParser_cursor end = TmtPulseParser_trivia(input, at);
      if (end.ok) return end.at;
      *certain = false;
    }
    /* The committed lexical regions have already removed regex literals from the view. */
  } else if (byte == '`' || byte == '\\') {
    *certain = false;
  }
  return at;
}

static bool comparison_without_type_closer(TmtPulseMemory_tape input, uint32_t at) {
  const uint32_t full_size = input.size;
  if (input.size - at > 2048) input.size = at + 2048;
  uint8_t closing[32];
  size_t depth = 0;
  bool certain = true;
  while (at < input.size) {
    const uint32_t after = skip_js_literal_or_comment(input, at, &certain);
    if (!certain) return false;
    if (after != at) {
      at = after;
      continue;
    }
    const uint8_t byte = input.source[at++];
    if (byte == '>') return false;
    if (byte == ';' && !depth) return true;
    if (!depth && (byte == '&' || byte == '|') && at < input.size && input.source[at] == byte) return true;
    if (byte == ')' || byte == ']' || byte == '}') {
      if (!depth) return true;
      if (closing[--depth] != byte) return false;
    } else if (byte == '(' || byte == '[' || byte == '{') {
      if (depth == sizeof(closing)) return false;
      closing[depth++] = byte == '(' ? ')' : byte == '[' ? ']' : '}';
    }
  }
  return input.size == full_size;
}

/* A comparison with no possible closing angle cannot be a type argument list. */
static bool comparison_angle(TmtPulseMemory_tape input, uint32_t at, bool certain) {
  const uint8_t *code = input.source;
  const uint32_t size = input.size;
  if (at < size && code[at] == '=') return true;
  bool token = false, gap = false, flat = true;
  while (at < size) {
    const uint8_t byte = code[at++];
    if (byte == ')' || byte == ']' || byte == '}' || byte == ';') return true;
    if (byte == '?' && token && flat && (at == size || (code[at] != '?' && code[at] != '.'))) return true;
    if ((byte == '&' || byte == '|') && token && flat && at < size && code[at] == byte) return true;
    if (space(byte)) gap = token;
    else if (TmtGrammar_identifier_continue(byte) || byte == '.') {
      flat = flat && !gap;
      token = true;
    } else return certain && comparison_without_type_closer(input, at - 1);
  }
  return true;
}

static bool value_keyword(const uint8_t *code, uint32_t size, uint32_t first, uint32_t end) {
  if (first && code[first - 1] == '.' && (first == 1 || code[first - 2] != '.')) return true;
  if (first && end < size && (code[end] == '"' || code[end] == '\'') && code[first - 1] == code[end]) end++;
  while (end < size && space(code[end])) end++;
  if (end == size) return false;
  const uint8_t byte = code[end];
  return byte == ':' || byte == '=' || byte == ',' || byte == ';' || byte == ')' || byte == '}' || byte == '.' ||
    (byte == '!' && size - end >= 2 && code[end + 1] == '=') ||
    ((byte == '&' || byte == '|') && size - end >= 2 && code[end + 1] == byte);
}

/* Some TypeScript constructs can also be valid JavaScript with a different meaning. */
static bool unambiguous_javascript(TmtPulseMemory_tape input, uint8_t *code, uint32_t records) {
  input.source = code;
  const uint32_t size = input.size;
  bool certain = size <= 1048576;
  uint32_t event = 0;
  static const char *const reserved[] = {
    "declare", "namespace", "type", "interface", "abstract", "enum",
    "readonly", "public", "private", "protected", "override", "implements",
  };
  for (uint32_t first = 0; first < size;) {
    const uint32_t literal = skip_js_literal_or_comment(input, first, &certain);
    if (literal != first) {
      first = literal;
      continue;
    }
    if (code[first] == '<' && !comparison_angle(input, first + 1, certain)) return false;
    if (!TmtGrammar_identifier_continue(code[first])) {
      first++;
      continue;
    }
    uint32_t end = first + 1;
    while (end < size && TmtGrammar_identifier_continue(code[end])) end++;
    const uint32_t width = end - first;
    bool needs_module_context = (width == 2 && !memcmp(code + first, "as", 2)) ||
      (width == 9 && !memcmp(code + first, "satisfies", 9));
    if (!needs_module_context && width >= 4 && width <= 10) {
      for (size_t index = 0; index < sizeof(reserved) / sizeof(*reserved); index++) {
        const char *word = reserved[index];
        if (code[first] == (uint8_t)word[0] && width == strlen(word) && !memcmp(code + first, word, width)) {
          needs_module_context = !value_keyword(code, size, first, end);
          break;
        }
      }
    }
    if (needs_module_context) {
      while (event < records &&
          (input.output[event].original != runtime_module_statement || input.output[event].left.last <= first)) event++;
      if (event == records || first < input.output[event].left.first || end > input.output[event].left.last) return false;
    }
    first = end;
  }
  return true;
}

static const char esm_marker[] = "\nexport {};\n";

static bool matches_word(const uint8_t *source, uint32_t available, const char *word, uint32_t width) {
  return width <= available && !memcmp(source, word, width) &&
    (width == available || !TmtGrammar_identifier_continue(source[width]));
}

static bool assertion_line_boundary(TmtPulseMemory_tape input, TmtPulseParser_cursor tail) {
  const uint8_t *word = input.source + tail.at;
  const uint32_t available = input.size - tail.at;
  if (!tail.newline || !TmtGrammar_identifier_start(*word)) return false;
  switch (*word) {
    case 'a': return !matches_word(word, available, "as", 2);
    case 'i': return !matches_word(word, available, "in", 2) && !matches_word(word, available, "instanceof", 10);
    case 'o': return !matches_word(word, available, "of", 2);
    case 's': return !matches_word(word, available, "satisfies", 9);
    default: return true;
  }
}

static bool erasable_expression_range(TmtPulseMemory_tape input, TmtGrammar_candidate event, uint32_t next_assertion) {
  const TmtGrammar_span span = event.left;
  const uint32_t kind = event.original;
  const uint8_t first = input.source[span.first];
  if (kind == type_annotation) return first == ':';
  if (kind == type_arguments || kind == generic_arrow) return first == '<' && input.source[span.last - 1] == '>';
  if (kind == type_marker) return span.last - span.first == 1 && (first == '?' || first == '!');
  if (first != 'a' && first != 's') return false;
  const TmtGrammar_span context = event.right;
  if (context.last < span.last || context.last > input.size ||
      (context.first != context.last && context.first != span.last)) return false;
  const TmtPulseParser_cursor tail = { .at = context.last, .ok = true, .newline = context.first != context.last };
  if (tail.at == input.size) return true;
  if (!tail.newline && tail.at == next_assertion) return true;
  const uint8_t byte = input.source[tail.at];
  return byte == ';' || byte == ',' || byte == ')' || byte == ']' || byte == '}' ||
    assertion_line_boundary(input, tail);
}

static bool delimited_annotation(TmtPulseMemory_tape input, uint32_t last) {
  const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, last);
  if (!tail.ok) return false;
  if (tail.at == input.size) return true;
  const uint8_t byte = input.source[tail.at];
  return byte == ';' || byte == ',' || byte == ')' || byte == ']' || byte == '}' || byte == '{' || byte == '=';
}

static bool blank_class_modifiers(TmtPulseMemory_tape input, TmtGrammar_span span, char *code) {
  for (uint32_t at = span.first; at < span.last;) {
    const TmtPulseParser_cursor token = TmtPulseParser_trivia(input, at);
    if (!token.ok || token.at > span.last) return false;
    if (token.at == span.last) break;
    at = token.at;
    while (at < span.last && TmtGrammar_identifier_continue(input.source[at])) at++;
    const uint32_t width = at - token.at;
    const uint8_t *word = input.source + token.at;
    if (width == 6 && !memcmp(word, "static", 6)) continue;
    if (!((width == 6 && !memcmp(word, "public", 6)) ||
          (width == 7 && !memcmp(word, "private", 7)) ||
          (width == 9 && !memcmp(word, "protected", 9)) ||
          (width == 8 && (!memcmp(word, "readonly", 8) || !memcmp(word, "override", 8))))) return false;
    memset(code + token.at, ' ', width);
  }
  return true;
}

static bool blank_ascii_lines(uint8_t *output, const uint8_t *source, uint32_t width) {
#ifdef TMT_SIMD_COMPILER
  for (; width >= 16; width -= 16, output += 16, source += 16) {
    if (!tmt_erase_type_run(output, source)) return false;
  }
#endif
  for (uint32_t at = 0; at < width; at++) {
    const uint8_t byte = source[at];
    if (byte >= 128) return false;
    output[at] = byte == '\n' || byte == '\r' ? byte : ' ';
  }
  return true;
}

static bool preserve_generic_arrow(TmtPulseMemory_tape input, TmtGrammar_span span, char *code) {
  const TmtPulseParser_cursor opening = TmtPulseParser_trivia(input, span.last);
  if (!opening.ok || opening.at == input.size || input.source[opening.at] != '(') return false;
  const size_t width = span.last - span.first;
  const uint8_t *types = input.source + span.first;
  if (opening.newline || memchr(types, '\n', width) || memchr(types, '\r', width)) {
    code[span.first] = '(';
    code[opening.at] = ' ';
  }
  return true;
}

static bool follows_lexical_exports(TmtPulseMemory_tape input, uint32_t first, uint32_t stop) {
  input.count_only = true;
  input.capture_types = false;
  input.capture_jsx = false;
  for (unsigned declarations = 0; declarations < 8 && first < stop; declarations++) {
    if (!TmtPulseParser_keyword(input, first, 6, UINT64_C(0x6578706f7274))) return false;
    const TmtPulseParser_cursor head = TmtPulseParser_trivia(input, first + 6);
    if (!head.ok || head.at >= stop) return false;
    if (TmtPulseParser_keyword(input, head.at, 5, UINT64_C(0x636f6e7374))) {
      const TmtPulseParser_cursor name = TmtPulseParser_trivia(input, head.at + 5);
      if (!name.ok || TmtPulseParser_keyword(input, name.at, 4, UINT64_C(0x656e756d))) return false;
    } else if (!TmtPulseParser_keyword(input, head.at, 3, UINT64_C(0x6c6574)) &&
               !TmtPulseParser_keyword(input, head.at, 3, UINT64_C(0x766172))) return false;
    const uint32_t end = TmtPulseCompiler_next_module_item(input, false, first);
    if (end <= first || end > stop) return false;
    const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, end);
    if (!tail.ok) return false;
    if (tail.at == stop) return true;
    first = tail.at;
  }
  return false;
}

static bool blank_type_records(TmtPulseMemory_tape input, uint32_t records, char **output, bool *remove_statement)
{
  char *code = NULL;
  uint32_t previous = 0;
  uint32_t prelude = TmtPulseCompiler_runtime_source_start(input).at;
  bool retained_module_statement = false;
  *remove_statement = false;
  *output = NULL;
  for (uint32_t index = 0; index < records; index++) {
    const TmtGrammar_candidate event = input.output[index];
    const bool member = event.original == erased_list_member || event.original == default_overload;
    const bool modifiers = event.original == class_modifiers;
    const bool arrow = event.original == generic_arrow;
    const bool result = event.original == arrow_result;
    const bool heritage = event.original == class_implements;
    const bool local_type = event.original == erased_local_type;
    if (!member && !modifiers && !arrow && !result && !heritage && !local_type &&
        (event.original < type_annotation || event.original > type_marker)) continue;
    const TmtGrammar_span span = event.left;
    if (span.first >= span.last || span.last > input.size) goto decline;
    const bool statement = event.original == erased_type_statement || event.original == runtime_module_statement;
    bool separate = false;
    if (statement) {
      const TmtPulseParser_cursor first = TmtPulseParser_trivia(input, prelude);
      if (first.ok && first.at == span.first) prelude = span.last;
      else if (event.original == erased_type_statement) {
        if (!retained_module_statement && (!first.ok || !follows_lexical_exports(input, first.at, span.first))) goto decline;
        retained_module_statement = true;
        separate = true;
        prelude = span.last;
      }
      if (event.original == runtime_module_statement) {
        retained_module_statement = true;
        continue;
      }
      *remove_statement = true;
    } else if (local_type) {
      const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, span.last);
      if (!tail.ok || (tail.at < input.size && (input.source[tail.at] == '"' || input.source[tail.at] == '\''))) goto decline;
      separate = true;
    } else if (!member && !modifiers && !heritage && !result) {
      uint32_t next_assertion = input.size;
      if (event.original == type_assertion && index + 1 < records && input.output[index + 1].original == type_assertion) {
        next_assertion = input.output[index + 1].left.first;
      }
      if (!erasable_expression_range(input, event, next_assertion)) goto decline;
    }
    if (span.first < previous) goto decline;
    const bool annotation = event.original == type_annotation;
    if (result && (event.right.first < previous || event.right.first >= span.first ||
        event.right.last != event.right.first + 1 || input.source[event.right.first] != ')' ||
        input.source[span.first] != ':')) goto decline;
    bool preserve_lines = statement || member || modifiers || arrow || result || heritage || local_type ||
      event.original == type_arguments || event.original == type_assertion;
    if (!preserve_lines || modifiers) {
      bool multiline = false, slash = false;
      for (uint32_t byte = span.first; byte < span.last; byte++) {
        const uint8_t value = input.source[byte];
        if (value >= 128) goto decline;
        if (value == '\n' || value == '\r') multiline = true;
        if (value == '/') slash = true;
      }
      if (!preserve_lines && multiline) {
        if (!annotation || !delimited_annotation(input, span.last)) goto decline;
        preserve_lines = true;
      } else if (!preserve_lines && slash) goto decline;
    }
    if (!code) {
      code = malloc((size_t)input.size + sizeof(esm_marker));
      if (!code) return false;
      memcpy(code, input.source, input.size);
    }
    if (modifiers) {
      if (!blank_class_modifiers(input, span, code)) goto decline;
    } else if (!preserve_lines) memset(code + span.first, ' ', span.last - span.first);
    else if (!blank_ascii_lines((uint8_t *)code + span.first, input.source + span.first, span.last - span.first)) goto decline;
    if (separate) code[span.first] = ';';
    if (arrow && !preserve_generic_arrow(input, span, code)) goto decline;
    if (result && (memchr(input.source + span.first, '\n', span.last - span.first) ||
                  memchr(input.source + span.first, '\r', span.last - span.first))) {
      code[event.right.first] = ' ';
      code[span.last - 1] = ')';
    }
    previous = span.last;
  }
  *output = code;
  return true;
decline:
  free(code);
  return false;
}

static bool emit_recorded_enum(lowering *lower, TmtGrammar_span span) {
  const uint32_t size = lower->input.size;
  if (span.first >= span.last || span.last > size) return false;
  lower->input.size = span.last;
  const TmtPulseCompiler_runtime_head head = TmtPulseCompiler_read_runtime_head(lower->input, span.first, false, true, true);
  lower->at = head.body;
  const bool emitted = (head.kind == 1 || head.kind == 3) && head.declaration == span.first && head.body < span.last &&
    emit_enum(lower, head.name_span, head.kind == 1) && lower->at == span.last;
  lower->input.size = size;
  return emitted;
}

static char *lower_recorded_enums(TmtPulseMemory_tape input, uint32_t records, size_t *length) {
  lowering lower = { .input = input, .output.limit = (size_t)input.size * 32 + 1024 };
  uint32_t copied = 0;
  for (uint32_t index = 0; index < records; index++) {
    if (input.output[index].original != runtime_enum) continue;
    const TmtGrammar_span span = input.output[index].left;
    if (span.first < copied || span.first >= span.last || span.last > input.size) goto decline;
    source_bytes(&lower, copied, span.first);
    if (!emit_recorded_enum(&lower, span)) goto decline;
    copied = span.last;
  }
  if (!copied) return NULL;
  lower.input.size = input.size;
  source_bytes(&lower, copied, input.size);
  if (lower.output.failed) goto decline;
  *length = lower.output.length;
  return lower.output.code;
decline:
  free(lower.output.code);
  return NULL;
}

static char *erase_annotation_records(TmtPulseMemory_tape input, uint32_t records, bool enums, bool esm,
  size_t *length, bool *complete)
{
  char *code = NULL;
  bool remove_statement;
  if (!blank_type_records(input, records, &code, &remove_statement)) goto enum_only;
  if (!code && !enums) return NULL;
  TmtPulseMemory_tape projected = input;
  if (code) projected.source = (uint8_t *)code;
  if (!unambiguous_projection(projected, records)) goto enum_only;
  *length = input.size;
  if (enums) {
    char *lowered = lower_recorded_enums(projected, records, length);
    if (lowered) {
      free(code);
      code = lowered;
    }
  }
  if (!code || *length > 1048576) goto enum_only;
  if (esm && remove_statement && !tmt_module_marker((uint8_t *)code, (uint32_t)*length, false)) {
    char *with_marker = realloc(code, *length + sizeof(esm_marker));
    if (!with_marker) goto enum_only;
    code = with_marker;
    memcpy(code + *length, esm_marker, sizeof(esm_marker) - 1);
    *length += sizeof(esm_marker) - 1;
  }
  if (!validate_emission(code, *length, "ts")) goto enum_only;
  *complete = true;
  return code;
enum_only:
  free(code);
  return enums ? lower_recorded_enums(input, records, length) : NULL;
}
#endif

char *tmt_emit_annotated_module(uint8_t *source, uint32_t size, bool enums, bool esm, size_t *length, bool *checked, bool *complete) {
  *checked = false;
  *complete = false;
#ifdef TMT_V8_VALIDATOR
  module_workspace memory = {0};
  TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok || find_marker(input, first.at, false) == size) return NULL;
  TmtGrammar_candidate *records = NULL;
  uint8_t *marks = NULL;
  if (size >= 4096) {
    input.capacity = size / 8 + 1;
    if (input.capacity > 16384) input.capacity = 16384;
    records = malloc(input.capacity * sizeof(*records));
    marks = calloc(input.capacity, sizeof(*marks));
    if (!records || !marks) {
      free(records);
      free(marks);
      return NULL;
    }
    input.output = records;
    input.marks = marks;
  }
  input.capture_types = true;
  input.count_only = false;
  const TmtPulseParser_parser_state parsed = TmtPulseParser_parse(input, false, true);
  char *code = NULL;
  if (parsed.status == 0 && parsed.count <= input.capacity) {
    *checked = true;
    code = erase_annotation_records(input, parsed.count, enums, esm, length, complete);
  }
  free(records);
  free(marks);
  return code;
#else
  (void)source;
  (void)size;
  (void)enums;
  (void)esm;
  (void)length;
  return NULL;
#endif
}

bool tmt_unbound_export(uint8_t *source, uint32_t size) {
  module_workspace memory = {0};
  TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  input.capture_jsx = true;
  return TmtPulseCompiler_unbound_runtime_export(input);
}

bool tmt_plain_script(uint8_t *source, uint32_t size) {
  module_workspace memory = {0};
  const TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  return first.ok && first.at < size && source[first.at] != '"' && source[first.at] != '\'' &&
    TmtPulseCompiler_supported_script(input);
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
  if (!first.ok || !TmtPulseCompiler_supported_module(input, jsx)) return NULL;
  const uint32_t marker = find_marker(input, first.at, jsx);
  if (marker == size) return NULL;
  lowering lower = { .input = input, .classic = classic, .mixed = true, .output.limit = (size_t)size * 32 + 1024 };
  uint32_t keep = 0;
  size_t runtime_at = SIZE_MAX;
  for (uint32_t cursor = first.at; cursor < size;) {
    if (cursor == marker) runtime_at = lower.output.length + marker - keep;
    const uint32_t end = TmtPulseCompiler_next_module_item(input, jsx, cursor);
    if (end <= cursor || end > size) goto decline;
    lower.input.size = end;
    const TmtPulseCompiler_runtime_head head = TmtPulseCompiler_read_runtime_head(lower.input, cursor, jsx, true, true);
    if (head.kind) {
      if (head.declaration < keep || head.body > end) goto decline;
      source_bytes(&lower, keep, head.declaration);
      lower.at = head.body;
      const bool emitted = head.kind == 1 || head.kind == 3 ? emit_enum(&lower, head.name_span, head.kind == 1) :
        emit_jsx(&lower, head);
      const uint32_t finish = lower.at;
      if (!emitted || !trivia(&lower)) goto decline;
      consume(&lower, ';');
      if (!trivia(&lower) || lower.at != end) goto decline;
      keep = finish;
    }
    cursor = end;
  }
  if (!keep || runtime_at == SIZE_MAX) goto decline;
  lower.input.size = size;
  source_bytes(&lower, keep, size);
  if (lower.output.failed || !inject_jsx_runtime(&lower, runtime_at)) goto decline;
  *length = lower.output.length;
  return lower.output.code;
decline:
  free(lower.output.code);
  return NULL;
}

static int compare_spans(const void *lhs, const void *rhs) {
  const TmtGrammar_span *a = lhs, *b = rhs;
  if (a->first != b->first) return a->first < b->first ? -1 : 1;
  if (a->last == b->last) return 0;
  return a->last > b->last ? -1 : 1;
}

static uint32_t jsx_script_prelude(TmtPulseMemory_tape input, uint32_t at) {
  while (at < input.size && (input.source[at] == '"' || input.source[at] == '\'')) {
    const TmtPulseParser_cursor string = TmtPulseParser_string_end(input, at + 1, input.source[at], input.size, false);
    if (!string.ok) break;
    const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, string.at);
    if (!tail.ok) break;
    if (tail.at == input.size) return input.size;
    const uint32_t boundary = TmtPulseCompiler_next_module_item(input, true, at);
    const bool semicolon = input.source[tail.at] == ';';
    if (!(semicolon ? boundary == tail.at + 1 : tail.newline && boundary == tail.at)) break;
    const TmtPulseParser_cursor next = TmtPulseParser_trivia(input, boundary);
    if (!next.ok) break;
    at = next.at;
  }
  return at;
}

static TmtPulseParser_parser_state capture_jsx(TmtPulseMemory_tape input, bool module) {
  input.capture_jsx = true;
  input.count_only = false;
  memset(input.marks, 0, input.capacity);
  return TmtPulseParser_parse(input, true, module);
}

static bool source_jsx_with_enums(lowering *lower, uint32_t first, uint32_t last,
  uint32_t records, uint32_t *index)
{
#ifdef TMT_V8_VALIDATOR
  while (*index < records) {
    const TmtGrammar_candidate event = lower->input.output[*index];
    if (event.original != runtime_enum) {
      (*index)++;
      continue;
    }
    const TmtGrammar_span span = event.left;
    if (span.first >= last) break;
    if (span.first < first || span.last > last || !source_jsx(lower, first, span.first, 32) ||
        !emit_recorded_enum(lower, span)) return false;
    first = span.last;
    (*index)++;
  }
#else
  (void)records;
  (void)index;
#endif
  return source_jsx(lower, first, last, 32);
}

static char *render_jsx_spans(TmtPulseMemory_tape input, const TmtGrammar_span *tags, size_t tag_count,
  const TmtGrammar_span *expressions, size_t expression_count, uint32_t insertion, bool classic, size_t *length,
  uint32_t enum_records)
{
  lowering lower = { .input = input, .classic = classic, .jsx_spans = tags, .jsx_count = tag_count,
    .expressions = expressions, .expression_count = expression_count,
    .output.limit = (size_t)input.size * 32 + 1024 };
  uint32_t enum_index = 0;
  if (source_jsx_with_enums(&lower, 0, insertion, enum_records, &enum_index)) {
    const size_t runtime_at = lower.output.length;
    if (source_jsx_with_enums(&lower, insertion, input.size, enum_records, &enum_index) &&
        enum_index == enum_records && inject_jsx_runtime(&lower, runtime_at)) {
      *length = lower.output.length;
      return lower.output.code;
    }
  }
  free(lower.output.code);
  return NULL;
}

#ifdef TMT_V8_VALIDATOR
typedef struct {
  TmtGrammar_span span;
  bool code;
} guard_region;

static int compare_regions(const void *lhs, const void *rhs) {
  const guard_region *a = lhs, *b = rhs;
  const int span_order = compare_spans(&a->span, &b->span);
  return span_order ? span_order : (int)b->code - (int)a->code;
}

/* Check only bytes that can become JavaScript syntax in the projection. */
static bool unambiguous_projection(TmtPulseMemory_tape input, uint32_t records) {
  guard_region *regions = malloc((size_t)records * sizeof(*regions));
  if (!regions && records) return false;
  size_t count = 0;
  for (uint32_t index = 0; index < records; index++) {
    const TmtGrammar_candidate event = input.output[index];
    const uint32_t kind = event.original;
    if (kind != 0 && kind != 5 && kind != lexical_text && kind != runtime_enum) continue;
    if (event.left.first > event.left.last || event.left.last > input.size) {
      free(regions);
      return false;
    }
    if (event.left.first != event.left.last) regions[count++] = (guard_region){ event.left, kind == 5 };
  }
  if (!count) {
    free(regions);
    return unambiguous_javascript(input, input.source, records);
  }
  uint8_t *view = malloc(input.size);
  if (!view) {
    free(regions);
    return false;
  }
  memcpy(view, input.source, input.size);
  qsort(regions, count, sizeof(*regions), compare_regions);
  uint32_t ends[128];
  size_t depth = 0;
  bool ordered = true;
  for (size_t index = 0; index < count; index++) {
    const guard_region region = regions[index];
    const TmtGrammar_span span = region.span;
    while (depth && ends[depth - 1] <= span.first) depth--;
    if ((depth && ends[depth - 1] < span.last) || (region.code && !depth) ||
        depth == sizeof(ends) / sizeof(*ends)) {
      ordered = false;
      break;
    }
    ends[depth++] = span.last;
    if (region.code) memcpy(view + span.first, input.source + span.first, span.last - span.first);
    else {
      for (uint32_t at = span.first; at < span.last; at++) {
        const uint8_t byte = input.source[at];
        view[at] = byte == '\n' || byte == '\r' ? byte : ' ';
      }
    }
  }
  const bool valid = ordered && unambiguous_javascript(input, view, records);
  free(view);
  free(regions);
  return valid;
}
#endif

static char *render_jsx_module(TmtPulseMemory_tape input, TmtGrammar_span *spans, uint32_t records,
  uint32_t insertion, bool typescript, bool classic, size_t *length, bool *complete)
{
  size_t elements = 0, expression_begin = records;
#ifdef TMT_V8_VALIDATOR
  uint32_t enum_records = 0;
#endif
  for (uint32_t index = 0; index < records; index++) {
    if (input.output[index].original == 0) spans[elements++] = input.output[index].left;
    else if (input.output[index].original == 5) spans[--expression_begin] = input.output[index].left;
#ifdef TMT_V8_VALIDATOR
    else if (input.output[index].original == runtime_enum) enum_records = records;
#endif
  }
  const size_t expression_count = records - expression_begin;
  TmtGrammar_span *expressions = spans + expression_begin;
  qsort(spans, elements, sizeof(*spans), compare_spans);
  qsort(expressions, expression_count, sizeof(*spans), compare_spans);
#ifdef TMT_V8_VALIDATOR
  if (!typescript) {
    char *code = render_jsx_spans(input, spans, elements, expressions, expression_count, insertion, classic, length, 0);
    if (code && validate_emission(code, *length, "jsx")) {
      *complete = true;
      return code;
    }
    free(code);
    return NULL;
  }
  if (input.capture_types) {
    char *masked;
    bool remove_statement;
    if (blank_type_records(input, records, &masked, &remove_statement)) {
      TmtPulseMemory_tape projected = input;
      if (masked) projected.source = (uint8_t *)masked;
      if (unambiguous_projection(projected, records)) {
        char *code = render_jsx_spans(projected, spans, elements, expressions, expression_count, insertion, classic, length, enum_records);
        if (code && (!remove_statement || (*length <= 1048576 && tmt_module_marker((uint8_t *)code, (uint32_t)*length, false))) &&
            validate_emission(code, *length, "tsx")) {
          *complete = true;
          free(masked);
          return code;
        }
        if (!masked && !enum_records) return code;
        free(code);
      }
      free(masked);
    }
  }
#else
  if (!typescript) return NULL;
  (void)complete;
#endif
  return render_jsx_spans(input, spans, elements, expressions, expression_count, insertion, classic, length, 0);
}

static char *lower_jsx_module(uint8_t *source, uint32_t size, bool typescript, bool classic, size_t *length, bool *complete) {
  module_workspace memory = {0};
  TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok) return NULL;
  const uint32_t marker = find_marker(input, first.at, true);
  const bool module = marker < size;
  if (!typescript && !module) return NULL;
  const uint32_t insertion = module ? marker : jsx_script_prelude(input, first.at);
#ifdef TMT_V8_VALIDATOR
  if (!typescript && !memchr(source, '<', size)) {
    if (!validate_emission((const char *)source, size, "passthrough")) return NULL;
    char *code = malloc(size);
    if (!code) return NULL;
    memcpy(code, source, size);
    *length = size;
    *complete = true;
    return code;
  }
  input.capture_types = typescript && module;
#endif
  if (size < 16 * 1024) {
    TmtPulseParser_parser_state small = capture_jsx(input, module);
    if (small.status != 0 && small.status != 4 && input.capture_types) {
      input.capture_types = false;
      small = capture_jsx(input, module);
    }
    if (small.status == 0 && small.count <= input.capacity) {
      TmtGrammar_span spans[sizeof(memory.marks)];
      return render_jsx_module(input, spans, small.count, insertion, typescript, classic, length, complete);
    }
    if (small.status != 4) return NULL;
  }
  uint32_t capacity = size / 3 + 1;
  if (capacity > 16384) capacity = 16384;
  input.output = malloc(capacity * sizeof(*input.output));
  input.marks = malloc(capacity);
  input.capacity = capacity;
  TmtGrammar_span *spans = malloc(capacity * sizeof(*spans));
  char *result = NULL;
  if (input.output && input.marks && spans) {
    TmtPulseParser_parser_state parsed = capture_jsx(input, module);
    if (parsed.status != 0 && input.capture_types) {
      input.capture_types = false;
      parsed = capture_jsx(input, module);
    }
    if (parsed.status == 0 && parsed.count <= capacity) {
      result = render_jsx_module(input, spans, parsed.count, insertion, typescript, classic, length, complete);
    }
  }
  free(input.output);
  free(input.marks);
  free(spans);
  return result;
}

#endif

char *tmt_lower_runtime(uint8_t *source, uint32_t size, bool jsx, bool typescript, bool classic,
  bool mixed, size_t *length, bool *complete)
{
  *complete = false;
  if (!size) return NULL;
  if (mixed) {
#ifdef TMT_DIRECT
    return NULL;
#else
    if (jsx) {
      char *general = lower_jsx_module(source, size, typescript, classic, length, complete);
      if (general || !typescript) return general;
    }
    return lower_mixed(source, size, jsx, classic, length);
#endif
  }
  return lower_one(source, size, jsx, typescript, classic, length);
}
