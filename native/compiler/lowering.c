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
  /* When set, every copy of source bytes is logged for a source map. */
  tmt_run_log *runs;
} writer;

typedef struct {
  TmtPulseMemory_tape input;
  uint32_t at;
  writer output;
  bool classic, mixed;
  /* The namespace whose exported enum is being written, or an empty span. */
  TmtGrammar_span owner;
  /*
   * The source as written and its full size, where the context has them: the input may be a projection with
   * the declared statements blanked, and its size may be cut to the statement being written.
   */
  const uint8_t *whole;
  uint32_t whole_size;
  /* Set while a namespace body is written: a name there may be a member of the namespace. */
  bool in_namespace;
  unsigned helpers;
  /* The helper module that TypeScript's transform would request first: none, the JSX runtime or createElement. */
  unsigned first_source;
#ifndef TMT_DIRECT
  const TmtGrammar_span *jsx_spans, *expressions;
  size_t jsx_count, expression_count;
#endif
} lowering;

enum { jsx_one = 1, jsx_many = 2, jsx_fragment = 4, jsx_create = 8 };
enum { source_none, source_runtime, source_create };

typedef struct {
  writer key;
  /* Copies inside the key expression, relative to the key's own buffer. */
  tmt_run_log key_runs;
  unsigned key_helpers;
  /* First helper module requested before this element, by its attributes and by its key expression. */
  unsigned first_before, first_attributes, first_key;
  size_t count;
  bool has_key, create;
} jsx_props;

static void register_jsx_helper(lowering *lower, unsigned helper) {
  lower->helpers |= helper;
  if (!lower->first_source) lower->first_source = helper == jsx_create ? source_create : source_runtime;
}

/*
 * TypeScript prints the helper imports in the reverse of the order in which its transform first
 * requests each module, and module order is evaluation order. For a runtime call it visits the
 * children, then the attributes, then the key, and requests the helper last. For createElement it
 * visits the attributes, requests the helper, and visits the children afterwards. This writer
 * renders attributes before children, so the element settles the first request by that rule.
 */
static void settle_first_source(lowering *lower, const jsx_props *props, bool create) {
  if (props->first_before) lower->first_source = props->first_before;
  else if (create) lower->first_source = props->first_attributes ? props->first_attributes : source_create;
  else if (!lower->first_source) {
    lower->first_source = props->first_attributes ? props->first_attributes : props->first_key ? props->first_key : source_runtime;
  }
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

static __attribute__((noinline, cold)) void log_run(tmt_run_log *runs, size_t out, uint32_t src, uint32_t length) {
  if (runs->failed || out > UINT32_MAX) { runs->failed = true; return; }
  if (runs->count) {
    tmt_run *last = &runs->items[runs->count - 1];
    if (last->out + last->length == out && last->src + last->length == src) { last->length += length; return; }
  }
  if (runs->count == runs->capacity) {
    const size_t capacity = runs->capacity ? runs->capacity * 2 : 32;
    tmt_run *grown = realloc(runs->items, capacity * sizeof(*grown));
    if (!grown) { runs->failed = true; return; }
    runs->items = grown;
    runs->capacity = capacity;
  }
  runs->items[runs->count++] = (tmt_run){ (uint32_t)out, src, length };
}

/* Text inserted at an output offset moves every later copy, and splits a copy that spans the offset. */
static __attribute__((noinline, cold)) void shift_runs(tmt_run_log *runs, size_t at, size_t width) {
  for (size_t index = 0; index < runs->count && !runs->failed; index++) {
    tmt_run *run = &runs->items[index];
    if (run->out >= at) run->out += (uint32_t)width;
    else if (run->out + run->length > at) {
      const uint32_t head = (uint32_t)(at - run->out);
      const tmt_run tail = { (uint32_t)(at + width), run->src + head, run->length - head };
      run->length = head;
      if (runs->count == runs->capacity) {
        const size_t capacity = runs->capacity * 2;
        tmt_run *grown = realloc(runs->items, capacity * sizeof(*grown));
        if (!grown) { runs->failed = true; return; }
        runs->items = grown;
        runs->capacity = capacity;
      }
      memmove(runs->items + index + 2, runs->items + index + 1, (runs->count - index - 1) * sizeof(*runs->items));
      runs->items[index + 1] = tail;
      runs->count++;
      index++;
    }
  }
}

static void source_bytes(lowering *lower, uint32_t first, uint32_t last) {
  if (first > last || last > lower->input.size) { lower->output.failed = true; return; }
  if (lower->output.runs && first < last && !lower->output.failed) log_run(lower->output.runs, lower->output.length, first, last - first);
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
    /* The string of a JSX attribute may run over lines; TypeScript writes the line breaks as escapes. */
    else if (byte == '\n' && decode) replacement = "\\n";
    else if (byte == '\r' && decode) replacement = "\\r";
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

/*
 * Constant enum initializers. TypeScript folds an initializer made of integer literals, earlier
 * numeric members, parentheses and the arithmetic and bitwise operators, and prints the result.
 * The evaluator follows JavaScript: arithmetic stays within the exactly representable integers,
 * bitwise operators work on 32-bit values. It declines what it cannot print as a plain integer:
 * a fraction, a negative zero, a value beyond 2^53 - 1, and every other kind of expression.
 */
typedef struct {
  TmtGrammar_span key;
  int64_t value;
  bool numeric;
} enum_member;

enum { enum_inline_members = 24 };

typedef struct {
  enum_member *items;
  size_t count, capacity;
  TmtGrammar_span binding;
  /* Most enums fit here, so the common case allocates nothing. */
  enum_member inline_items[enum_inline_members];
} enum_scope;

enum { enum_safe_limit_shift = 53, enum_depth = 48 };

static bool enum_safe(int64_t value) {
  const int64_t limit = (INT64_C(1) << enum_safe_limit_shift) - 1;
  return value >= -limit && value <= limit;
}

static int32_t enum_int32(int64_t value) { return (int32_t)(uint32_t)(uint64_t)value; }

static bool enum_literal(lowering *lower, int64_t *value, bool *decimal) {
  const uint8_t *source = lower->input.source;
  const uint32_t size = lower->input.size;
  uint32_t at = lower->at;
  unsigned base = 10;
  if (source[at] == '0' && at + 1 < size) {
    const uint8_t prefix = source[at + 1] | 32;
    base = prefix == 'x' ? 16 : prefix == 'o' ? 8 : prefix == 'b' ? 2 : 10;
    if (base != 10) at += 2;
    else if (TmtGrammar_decimal_digit(source[at + 1])) return false;
  }
  const uint32_t digits = at;
  uint64_t integer = 0;
  for (; at < size; at++) {
    const uint8_t byte = source[at];
    const unsigned digit = byte >= '0' && byte <= '9' ? byte - '0' : (byte | 32) >= 'a' && (byte | 32) <= 'f' ? (byte | 32) - 'a' + 10 : 16;
    if (digit >= base) break;
    integer = integer * base + digit;
    if (integer > (UINT64_C(1) << enum_safe_limit_shift) - 1) return false;
  }
  /* A fraction, an exponent, a separator, a BigInt suffix or a stray digit ends the native route. */
  if (at == digits || (at < size && (TmtGrammar_identifier_continue(source[at]) || source[at] == '.'))) return false;
  lower->at = at;
  *value = (int64_t)integer;
  *decimal = base == 10;
  return true;
}

/* A member may be named like a literal or an operator word, which a bare reference would not reach. */
static bool enum_reserved(const uint8_t *word, uint32_t width) {
  static const char *const words[] = { "true", "false", "null", "this", "undefined", "NaN", "Infinity", "void", "typeof",
    "new", "delete", "await", "yield", "super", "in", "instanceof", "function", "class", "async", "import",
    /* The remaining reserved words are syntax errors as a bare reference. */
    "break", "case", "catch", "const", "continue", "debugger", "default", "do", "else", "enum", "export", "extends",
    "finally", "for", "if", "return", "switch", "throw", "try", "var", "while", "with", "let", "static", "implements",
    "interface", "package", "private", "protected", "public" };
  for (size_t index = 0; index < sizeof(words) / sizeof(*words); index++) {
    if (strlen(words[index]) == width && !memcmp(word, words[index], width)) return true;
  }
  return false;
}

static bool enum_reference(lowering *lower, const enum_scope *scope, int64_t *value) {
  const uint8_t *source = lower->input.source;
  uint32_t first = lower->at;
  do { lower->at++; } while (TmtGrammar_identifier_continue(peek(lower)));
  uint32_t last = lower->at;
  const uint32_t binding = scope->binding.last - scope->binding.first;
  const bool qualified = last - first == binding && !memcmp(source + first, source + scope->binding.first, binding) && peek(lower) == '.';
  if (!qualified && enum_reserved(source + first, last - first)) return false;
  if (qualified) {
    lower->at++;
    first = lower->at;
    if (!TmtGrammar_identifier_start(peek(lower))) return false;
    do { lower->at++; } while (TmtGrammar_identifier_continue(peek(lower)));
    last = lower->at;
  }
  for (size_t index = scope->count; index-- > 0;) {
    const enum_member member = scope->items[index];
    if (member.key.last - member.key.first != last - first || memcmp(source + member.key.first, source + first, last - first)) continue;
    *value = member.value;
    return member.numeric;
  }
  return false;
}

static bool enum_binary(lowering *lower, const enum_scope *scope, unsigned minimum, unsigned depth, int64_t *value, bool *plain);

static bool enum_primary(lowering *lower, const enum_scope *scope, unsigned depth, int64_t *value, bool *plain) {
  if (!depth || !trivia(lower)) return false;
  const uint8_t byte = peek(lower);
  if (TmtGrammar_decimal_digit(byte)) {
    bool decimal;
    if (!enum_literal(lower, value, &decimal)) return false;
    if (!decimal) *plain = false;
    return true;
  }
  if (byte == '-') {
    lower->at++;
    /* A second sign directly after the first would be a decrement. */
    if (peek(lower) == '-' || !enum_primary(lower, scope, depth - 1, value, plain) || *value == 0) return false;
    *value = -*value;
    return true;
  }
  *plain = false;
  if (byte == '(') {
    lower->at++;
    return enum_binary(lower, scope, 1, depth - 1, value, plain) && trivia(lower) && consume(lower, ')');
  }
  if (byte == '+') {
    lower->at++;
    return peek(lower) != '+' && enum_primary(lower, scope, depth - 1, value, plain);
  }
  if (byte == '~') {
    lower->at++;
    if (!enum_primary(lower, scope, depth - 1, value, plain)) return false;
    *value = ~enum_int32(*value);
    return true;
  }
  return TmtGrammar_identifier_start(byte) && enum_reference(lower, scope, value);
}

/* Operator strengths follow JavaScript: | ^ & shift additive multiplicative, all left associative. */
static unsigned enum_operator(const lowering *lower, uint32_t *width) {
  const uint8_t *source = lower->input.source + lower->at;
  const uint32_t rest = lower->input.size - lower->at;
  const uint8_t first = rest ? source[0] : 0, second = rest > 1 ? source[1] : 0, third = rest > 2 ? source[2] : 0;
  *width = 1;
  if (second == '=') return 0;
  switch (first) {
    case '|': return second == '|' ? 0 : 1;
    case '^': return 2;
    case '&': return second == '&' ? 0 : 3;
    case '<': if (second != '<' || third == '=') return 0; *width = 2; return 4;
    case '>':
      if (second != '>') return 0;
      *width = third == '>' ? 3 : 2;
      return rest > *width && source[*width] == '=' ? 0 : 4;
    /* A doubled sign is an update operator, which is not constant. */
    case '+': case '-': return second == first ? 0 : 5;
    case '*': return second == '*' ? 0 : 6;
    case '/': case '%': return 6;
    default: return 0;
  }
}

static bool enum_apply(uint8_t operator, uint32_t width, int64_t left, int64_t right, int64_t *value) {
  const uint32_t count = (uint32_t)enum_int32(right) & 31;
  switch (operator) {
    case '|': *value = enum_int32(left) | enum_int32(right); return true;
    case '^': *value = enum_int32(left) ^ enum_int32(right); return true;
    case '&': *value = enum_int32(left) & enum_int32(right); return true;
    case '<': *value = (int32_t)((uint32_t)enum_int32(left) << count); return true;
    case '>':
      if (width == 3) *value = (uint32_t)enum_int32(left) >> count;
      else {
        /* An arithmetic shift of a negative value, written without relying on the compiler's choice. */
        const int32_t operand = enum_int32(left);
        *value = operand < 0 ? ~(~operand >> count) : operand >> count;
      }
      return true;
    case '+': *value = left + right; return enum_safe(*value);
    case '-': *value = left - right; return enum_safe(*value);
    case '*':
      /* Both operands are below 2^53, so a product that leaves the 64-bit range is caught by the division. */
      if (left == 0 || right == 0) { *value = 0; return left >= 0 && right >= 0; }
      if ((left < 0 ? -left : left) > ((INT64_C(1) << enum_safe_limit_shift) - 1) / (right < 0 ? -right : right)) return false;
      *value = left * right;
      return true;
    case '/':
      if (right == 0 || left % right != 0 || (left == 0 && right < 0)) return false;
      *value = left / right;
      return true;
    default:
      if (right == 0) return false;
      *value = left % right;
      /* A zero remainder of a negative dividend is negative zero. */
      return *value != 0 || left >= 0;
  }
}

static bool enum_binary(lowering *lower, const enum_scope *scope, unsigned minimum, unsigned depth, int64_t *value, bool *plain) {
  if (!depth || !enum_primary(lower, scope, depth, value, plain)) return false;
  for (;;) {
    const uint32_t end = lower->at;
    uint32_t width;
    if (!trivia(lower)) return false;
    const unsigned strength = enum_operator(lower, &width);
    if (strength < minimum || !strength) {
      lower->at = end;
      return true;
    }
    const uint8_t operator = peek(lower);
    lower->at += width;
    int64_t right;
    *plain = false;
    if (!enum_binary(lower, scope, strength + 1, depth - 1, &right, plain) || !enum_apply(operator, width, *value, right, value)) return false;
  }
}

/* Evaluates a numeric initializer. A plain decimal literal keeps its source text in the output. */
static bool enum_numeric(lowering *lower, const enum_scope *scope, int64_t *value, bool *folded) {
  bool plain = true;
  if (!enum_binary(lower, scope, 1, enum_depth, value, &plain)) return false;
  *folded = !plain;
  return true;
}

/* Two members of one name resolve differently in TypeScript's own emit, so the pair is left to it. */
static bool enum_declared(const lowering *lower, const enum_scope *scope, TmtGrammar_span key) {
  const uint8_t *source = lower->input.source;
  for (size_t index = 0; index < scope->count; index++) {
    const TmtGrammar_span other = scope->items[index].key;
    if (other.last - other.first == key.last - key.first && !memcmp(source + other.first, source + key.first, key.last - key.first)) return true;
  }
  return false;
}

static bool enum_remember(enum_scope *scope, TmtGrammar_span key, int64_t value, bool numeric) {
  if (scope->count == scope->capacity) {
    const size_t capacity = scope->capacity * 2;
    const bool inline_ = scope->items == scope->inline_items;
    enum_member *grown = realloc(inline_ ? NULL : scope->items, capacity * sizeof(*grown));
    if (!grown) return false;
    if (inline_) memcpy(grown, scope->inline_items, scope->count * sizeof(*grown));
    scope->items = grown;
    scope->capacity = capacity;
  }
  scope->items[scope->count++] = (enum_member){ key, value, numeric };
  return true;
}

static bool emit_enum_members(lowering *lower, TmtGrammar_span binding, bool exported, bool local, enum_scope *scope);

static bool emit_enum(lowering *lower, TmtGrammar_span binding, bool exported, bool local) {
  enum_scope scope;
  scope.items = scope.inline_items;
  scope.count = 0;
  scope.capacity = enum_inline_members;
  scope.binding = binding;
  const bool emitted = emit_enum_members(lower, binding, exported, local, &scope);
  if (scope.items != scope.inline_items) free(scope.items);
  return emitted;
}

/* The place behind white space and comments. */
static uint32_t past_trivia(TmtPulseMemory_tape input, uint32_t at, uint32_t last) {
  for (;;) {
    while (at < last && (input.source[at] == ' ' || input.source[at] == '\t' || input.source[at] == '\n' || input.source[at] == '\r')) at++;
    if (at + 1 < last && input.source[at] == '/' && input.source[at + 1] == '/') {
      while (at < last && input.source[at] != '\n' && input.source[at] != '\r') at++;
    } else if (at + 1 < last && input.source[at] == '/' && input.source[at + 1] == '*') {
      at += 2;
      while (at + 1 < last && !(input.source[at] == '*' && input.source[at + 1] == '/')) at++;
      at = at + 1 < last ? at + 2 : last;
    } else return at;
  }
}

/*
 * How often the source as written declares a name with one of the keywords: enum alone, or also namespace,
 * module and an import alias. A member of such a name may be a constant that TypeScript writes as its value.
 * The keyword is found wherever it stands, also in a comment or a string, which only declines more.
 */
static uint32_t keyword_declarations(const lowering *lower, const uint8_t *name, uint32_t width, bool enum_only) {
  const TmtPulseMemory_tape whole = { .source = (uint8_t *)lower->whole, .size = lower->whole_size };
  uint32_t count = 0;
  for (uint32_t at = 0; at < whole.size; at++) {
    if (whole.source[at] >= 128 || !TmtGrammar_identifier_start(whole.source[at])) continue;
    uint32_t end = at;
    while (end < whole.size && whole.source[end] < 128 && TmtGrammar_identifier_continue(whole.source[end])) end++;
    const uint32_t length = end - at;
    const bool before = at > 0 && whole.source[at - 1] >= 128;
    const bool after = end < whole.size && whole.source[end] >= 128;
    const bool enumeration = length == 4 && !memcmp(whole.source + at, "enum", 4);
    const bool alias = length == 6 && !memcmp(whole.source + at, "import", 6);
    const bool space = (length == 9 && !memcmp(whole.source + at, "namespace", 9)) || (length == 6 && !memcmp(whole.source + at, "module", 6));
    if (!before && !after && (enumeration || (!enum_only && (alias || space)))) {
      uint32_t named = past_trivia(whole, end, whole.size);
      if (alias && whole.size - named > 4 && !memcmp(whole.source + named, "type", 4) &&
          (whole.source[named + 4] == ' ' || whole.source[named + 4] == '\t' || whole.source[named + 4] == '\n' || whole.source[named + 4] == '\r' || whole.source[named + 4] == '/')) {
        const uint32_t typed = past_trivia(whole, named + 4, whole.size);
        if (typed < whole.size && whole.source[typed] != '=') named = typed;
      }
      if (whole.size - named >= width && !memcmp(whole.source + named, name, width) &&
          (named + width == whole.size || (whole.source[named + width] < 128 && !TmtGrammar_identifier_continue(whole.source[named + width])))) {
        if (!alias) count++;
        else {
          const uint32_t equals = past_trivia(whole, named + width, whole.size);
          if (equals < whole.size && whole.source[equals] == '=') count++;
        }
      }
    }
    at = end - 1;
  }
  return count;
}

/* The closing brace of an enum body, or the size of the input. Strings and comments are passed over. */
static uint32_t enum_body_end(TmtPulseMemory_tape input, uint32_t at) {
  while (at < input.size && input.source[at] != '}') {
    const uint8_t byte = input.source[at];
    if (byte == '"' || byte == '\'' || byte == '`') {
      at++;
      while (at < input.size && input.source[at] != byte) at += input.source[at] == '\\' ? 2 : 1;
      at++;
    } else if (byte == '/' && at + 1 < input.size && (input.source[at + 1] == '/' || input.source[at + 1] == '*')) {
      const uint32_t behind = past_trivia(input, at, input.size);
      at = behind > at ? behind : at + 1;
    } else at++;
  }
  return at < input.size ? at : input.size;
}

/*
 * An initializer that is a member of something the file does not declare, `Other.Member`: TypeScript cannot
 * know its value in one file and writes the expression, with the reverse mapping of a number. The reference
 * ends the initializer.
 *
 * The root is no member of the enum (TypeScript writes that as a property of the enum), the enum is declared
 * once, and the file declares the root neither as an enum, a namespace nor an import alias. In a namespace
 * body the root may be a member of the namespace, so nothing is taken there.
 */
static bool enum_foreign_member(lowering *lower, TmtGrammar_span binding, uint32_t body) {
  const TmtPulseMemory_tape input = lower->input;
  const uint32_t first = lower->at;
  if (!lower->whole || lower->in_namespace || lower->owner.first != lower->owner.last) return false;
  const TmtPulseParser_cursor root = TmtPulseParser_name(input, first, false, false);
  if (!root.ok || root.at <= first || root.at >= input.size || input.source[root.at] != '.') return false;
  for (uint32_t at = first; at < root.at; at++) if (input.source[at] >= 128) return false;
  const uint32_t width = root.at - first;
  /* The enum's own name would name its members, which are constants. */
  if (width == binding.last - binding.first && !memcmp(input.source + first, input.source + binding.first, width)) return false;
  /* Through the global object TypeScript reaches the enums of the file. */
  static const char *const globals[] = { "globalThis", "window", "self", "global" };
  for (size_t index = 0; index < sizeof(globals) / sizeof(*globals); index++) {
    if (width == strlen(globals[index]) && !memcmp(input.source + first, globals[index], width)) return false;
  }
  if (keyword_declarations(lower, input.source + first, width, false) != 0) return false;
  if (keyword_declarations(lower, input.source + binding.first, binding.last - binding.first, true) != 1) return false;
  /* Every other occurrence of the word in the body may be a member's name; a reference is followed by a dot. */
  const uint32_t closing = enum_body_end(input, body);
  for (uint32_t at = body; at + width <= closing; at++) {
    if (memcmp(input.source + at, input.source + first, width)) continue;
    if (at > 0 && (input.source[at - 1] >= 128 || TmtGrammar_identifier_continue(input.source[at - 1]))) continue;
    if (at + width < closing && (input.source[at + width] >= 128 || TmtGrammar_identifier_continue(input.source[at + width]))) continue;
    if (at + width >= closing || input.source[at + width] != '.') return false;
  }
  uint32_t at = root.at;
  while (at < input.size && input.source[at] == '.') {
    at++;
    if (at >= input.size || !TmtGrammar_identifier_start(input.source[at])) return false;
    while (at < input.size && input.source[at] < 128 && TmtGrammar_identifier_continue(input.source[at])) at++;
    if (at < input.size && input.source[at] >= 128) return false;
  }
  lower->at = at;
  const uint32_t end = at;
  if (!trivia(lower) || (peek(lower) != ',' && peek(lower) != '}')) return false;
  lower->at = end;
  return true;
}

/*
 * An initializer that is a fraction written the way JavaScript prints it: 0.75, -1.5. TypeScript prints the
 * value, which is then the text. The member behind it needs a value of its own.
 */
static bool enum_fraction(lowering *lower) {
  const uint8_t *source = lower->input.source;
  const uint32_t size = lower->input.size, first = lower->at;
  uint32_t at = first;
  if (at < size && source[at] == '-') at++;
  const uint32_t whole = at;
  while (at < size && TmtGrammar_decimal_digit(source[at])) at++;
  if (at == whole || (source[whole] == '0' && at - whole > 1) || at >= size || source[at] != '.') return false;
  const uint32_t point = at++;
  while (at < size && TmtGrammar_decimal_digit(source[at])) at++;
  /*
   * At most fifteen digits, and at most six behind the point (a smaller number is printed with an exponent),
   * so that the text is what the number prints as.
   */
  if (at == point + 1 || source[at - 1] == '0' || at - whole > 16 || at - point > 7) return false;
  if (at < size && (source[at] >= 128 || source[at] == '.' || TmtGrammar_identifier_continue(source[at]))) return false;
  lower->at = at;
  const bool ends = trivia(lower) && (peek(lower) == ',' || peek(lower) == '}');
  lower->at = ends ? at : first;
  return ends;
}

/* A template without a hole whose text can stand between double quotation marks as it is. */
static bool enum_plain_template(lowering *lower, uint32_t *last) {
  const uint8_t *source = lower->input.source;
  if (peek(lower) != '`') return false;
  uint32_t at = lower->at + 1;
  while (at < lower->input.size && source[at] != '`') {
    const uint8_t byte = source[at++];
    if (byte < 32 || byte >= 127 || byte == '"' || byte == '\\' || byte == '$') return false;
  }
  if (at >= lower->input.size) return false;
  *last = at + 1;
  return true;
}

static bool emit_enum_members(lowering *lower, TmtGrammar_span binding, bool exported, bool local, enum_scope *scope) {
  writer *out = &lower->output;
  /* TypeScript declares an enum inside a block with let, so it is scoped to the block like the source. */
  put(out, exported ? "export var " : local ? "let " : "var ");
  source_bytes(lower, binding.first, binding.last);
  put(out, "; (function (");
  source_bytes(lower, binding.first, binding.last);
  put(out, ") {");
  int64_t next = 0;
  bool numeric = true;
  const uint32_t body = lower->at;
  /* Set behind a member whose value is not known here: the next member needs a value of its own. */
  bool unknown = false;
  for (uint32_t index = 0; ; index++) {
    if (!trivia(lower)) return false;
    if (consume(lower, '}')) break;
    if (index == 4096) return false;
    TmtGrammar_span key = { lower->at, lower->at };
    const uint8_t opener = peek(lower);
    if (opener == '"' || opener == '\'') {
      /* A quoted name is taken as written when it needs no escape in the output and is not numeric. */
      uint32_t at = lower->at + 1;
      key.first = at;
      while (at < lower->input.size && lower->input.source[at] != opener) {
        const uint8_t byte = lower->input.source[at++];
        if (byte < 32 || byte >= 127 || byte == '"' || byte == '\'' || byte == '\\') return false;
      }
      if (at >= lower->input.size || at == key.first || TmtGrammar_decimal_digit(lower->input.source[key.first]) ||
          lower->input.source[key.first] == '-') return false;
      key.last = at;
      lower->at = at + 1;
    } else {
      if (!TmtGrammar_identifier_start(opener)) return false;
      do { lower->at++; } while (TmtGrammar_identifier_continue(peek(lower)));
      key.last = lower->at;
    }
    if (same_bytes(lower, key, "__proto__") || !trivia(lower)) return false;

    uint32_t value_start = 0, value_end = 0;
    bool folded = false, foreign = false, template_ = false;
    if (consume(lower, '=')) {
      if (!trivia(lower)) return false;
      value_start = lower->at;
      numeric = peek(lower) != '"' && peek(lower) != '\'' && peek(lower) != '`';
      if (numeric) {
        if (enum_fraction(lower)) foreign = true;
        else if (!enum_numeric(lower, scope, &next, &folded)) {
          lower->at = value_start;
          if (!enum_foreign_member(lower, binding, body)) return false;
          foreign = true;
        }
      } else if (peek(lower) == '`') {
        if (!enum_plain_template(lower, &lower->at)) return false;
        template_ = true;
      } else if (!literal_string(lower, &lower->at)) return false;
      value_end = lower->at;
      unknown = foreign;
    } else if (!numeric || unknown || next > INT64_C(9007199254740991)) return false;

    source_bytes(lower, binding.first, binding.last);
    put(out, "[");
    if (numeric) {
      source_bytes(lower, binding.first, binding.last);
      put(out, "[");
    }
    if (!quote(lower, key, false)) return false;
    put(out, "]=");
    if (template_) {
      put(out, "\"");
      source_bytes(lower, value_start + 1, value_end - 1);
      put(out, "\"");
    } else if (value_end && (foreign || !numeric || (next != 0 && !folded))) source_bytes(lower, value_start, value_end);
    else {
      char value[32];
      snprintf(value, sizeof(value), "%" PRId64, next);
      put(out, value);
    }
    /* A member without a known value is remembered as a string is: a later member cannot compute with it. */
    if (enum_declared(lower, scope, key) || !enum_remember(scope, key, next, numeric && !foreign)) return false;
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
  if (lower->owner.first != lower->owner.last) {
    /* An enum exported from a namespace: (E=N.E||(N.E={})) */
    put(out, "=");
    for (int twice = 0; twice < 2; twice++) {
      write_bytes(out, lower->input.source + lower->owner.first, lower->owner.last - lower->owner.first);
      put(out, ".");
      source_bytes(lower, binding.first, binding.last);
      put(out, twice ? "={}));" : "||(");
    }
    return !out->failed;
  }
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
    TmtPulseMemory_tape probe = lower->input;
    probe.count_only = true;
    const TmtPulseParser_cursor end = TmtPulseCompiler_jsx_expression_end(probe, lower->at);
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

static bool jsx_blank(char byte) { return byte == ' ' || byte == '\t' || byte == '\r' || byte == '\n'; }

/*
 * A spread of an object literal, {...{ a: 1 }}. TypeScript writes the members of the literal among the other
 * properties, so a getter stays a getter and a later key attribute does not switch to createElement. The literal
 * is written to a buffer of its own, and the text between its braces is appended without a trailing comma.
 * A literal that names __proto__ keeps its spread in TypeScript, and a comment could hide a trailing comma, so
 * both are declined.
 */
static bool jsx_literal_spread(lowering *lower, uint32_t depth, jsx_props *properties, bool *inner_spread) {
  const uint32_t first = lower->at;
  tmt_run_log runs = { 0 };
  const writer outer = lower->output;
  lower->output = (writer){ .limit = outer.limit, .runs = outer.runs ? &runs : NULL };
  bool accepted = jsx_value(lower, depth) && !lower->output.failed;
  const writer literal = lower->output;
  lower->output = outer;
  const uint32_t last = lower->at;
  if (accepted) {
    /* The literal has to be the whole value: { a: 1 } || b also starts and ends with a brace. */
#ifdef TMT_DIRECT
    /* The direct build reads only simple operands, so it leaves the literal to the module build. */
    accepted = false;
#else
    /* This parse must not write into the records the emitter is reading. */
    TmtPulseMemory_tape probe = lower->input;
    probe.count_only = true;
    const TmtPulseParser_cursor closing = TmtPulseCompiler_jsx_operand_end(probe, first);
    accepted = closing.ok && closing.at + 1 == last;
#endif
  }
  for (uint32_t at = first; accepted && at + 1 < last; at++) {
    const uint8_t *text = lower->input.source + at;
    if ((text[0] == '/' && (text[1] == '/' || text[1] == '*')) || (last - at >= 9 && !memcmp(text, "__proto__", 9))) accepted = false;
    if (text[0] == '.' && text[1] == '.') *inner_spread = true;
  }
  size_t begin = 0, end = literal.length;
  if (accepted && end && literal.code[0] == '(' && literal.code[end - 1] == ')') { begin++; end--; }
  if (accepted && end - begin >= 2 && literal.code[begin] == '{' && literal.code[end - 1] == '}') { begin++; end--; }
  else accepted = false;
  if (accepted) {
    while (begin < end && jsx_blank(literal.code[begin])) begin++;
    while (begin < end && jsx_blank(literal.code[end - 1])) end--;
    if (begin < end && literal.code[end - 1] == ',') end--;
    while (begin < end && jsx_blank(literal.code[end - 1])) end--;
    /* A line separator outside ASCII may still hide a trailing comma. */
    if (begin < end && (unsigned char)literal.code[end - 1] >= 0x80) accepted = false;
    /* A classic factory receives {} for an empty literal, where a tag without attributes passes null. */
    if (begin == end && lower->classic) accepted = false;
    if (begin < end) {
      if (properties->count++ != 0) put(&lower->output, ",");
      if (lower->output.runs && !lower->output.failed) {
        if (runs.failed) lower->output.runs->failed = true;
        for (size_t index = 0; index < runs.count; index++) {
          tmt_run run = runs.items[index];
          /* Keep the part of each copy that lies between the braces. */
          if (run.out < begin) {
            const size_t cut = begin - run.out;
            if (cut >= run.length) continue;
            run.out += cut; run.src += cut; run.length -= cut;
          }
          if (run.out >= end) continue;
          if (run.out + run.length > end) run.length = end - run.out;
          log_run(lower->output.runs, lower->output.length + run.out - begin, run.src, run.length);
        }
      }
      write_bytes(&lower->output, literal.code + begin, end - begin);
    }
  }
  free(literal.code);
  free(runs.items);
  return accepted && !lower->output.failed;
}

static bool jsx_attributes(lowering *lower, uint32_t depth, jsx_props *properties) {
  bool spread = false;
  /* A literal with a spread among its members. TypeScript then treats a later key as it does after a spread. */
  bool literal_spread = false;
  for (;;) {
    const uint32_t previous = lower->at;
    if (!tag_trivia(lower)) return false;
    if (peek(lower) == '/' || peek(lower) == '>') return true;
    if (previous == lower->at || properties->count == 4096) return false;
    if (consume(lower, '{')) {
      if (!trivia(lower) || !consume(lower, '.') || !consume(lower, '.') || !consume(lower, '.') || !trivia(lower)) return false;
      if (peek(lower) == '{') {
        if (!jsx_literal_spread(lower, depth, properties, &literal_spread)) return false;
        continue;
      }
      if (properties->count++ != 0) put(&lower->output, ",");
      put(&lower->output, "...");
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
      if (properties->has_key || (literal_spread && !spread)) return false;
      properties->has_key = true;
      properties->create = spread;
      if (!spread) {
        lowering saved = *lower;
        saved.output = (writer){ .limit = lower->output.limit, .runs = lower->output.runs ? &properties->key_runs : NULL };
        saved.helpers = 0;
        saved.first_source = source_none;
        const bool accepted = jsx_property_value(&saved, depth, prop.at);
        properties->key = saved.output;
        properties->key_helpers = saved.helpers;
        properties->first_key = saved.first_source;
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
    if (lower->output.runs && !lower->output.failed) {
      if (props->key_runs.failed) lower->output.runs->failed = true;
      for (size_t index = 0; index < props->key_runs.count; index++) {
        const tmt_run run = props->key_runs.items[index];
        log_run(lower->output.runs, lower->output.length + run.out, run.src, run.length);
      }
    }
    write_bytes(&lower->output, props->key.code, props->key.length);
    lower->helpers |= props->key_helpers;
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
        settle_first_source(lower, props, false);
        register_jsx_helper(lower, children > 1 ? jsx_many : jsx_one);
      } else if (props->create) {
        settle_first_source(lower, props, true);
        register_jsx_helper(lower, jsx_create);
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

/*
 * Type arguments behind a tag name, `<Select<string> />`. The parser has read them as types; here their
 * extent is found by their brackets. An arrow's angle closes nothing, and a string is passed over.
 */
static bool jsx_type_arguments(lowering *lower) {
  char stack[32];
  uint32_t depth = 0;
  for (uint32_t at = lower->at; at < lower->input.size; at++) {
    const uint8_t byte = lower->input.source[at];
    if (byte == '"' || byte == '\'' || byte == '`') {
      for (at++; at < lower->input.size && lower->input.source[at] != byte; at++) {
        if (lower->input.source[at] == '\\' || lower->input.source[at] == '\n') return false;
      }
    } else if (byte == '<' || byte == '(' || byte == '[' || byte == '{') {
      if (depth == sizeof(stack)) return false;
      stack[depth++] = byte == '<' ? '>' : byte == '(' ? ')' : byte == '[' ? ']' : '}';
    } else if (byte == ')' || byte == ']' || byte == '}' || (byte == '>' && lower->input.source[at - 1] != '=')) {
      if (depth == 0 || stack[--depth] != (char)byte) return false;
      if (depth == 0) {
        lower->at = at + 1;
        return true;
      }
    }
  }
  return false;
}

static bool jsx_element(lowering *lower, uint32_t depth) {
  if (!depth || !consume(lower, '<')) return false;
  writer *out = &lower->output;
  if (!tag_trivia(lower)) return false;
  const bool fragment = peek(lower) == '>';
  TmtGrammar_span tag = { lower->at, lower->at };
  if (!fragment && !jsx_name(lower, &tag)) return false;
  /* Only a TypeScript file has type arguments there. */
  if (!fragment && peek(lower) == '<' && (!lower->input.capture_types || !jsx_type_arguments(lower))) return false;
  /* A keyword may touch the opening angle. The helper name must not extend it. */
  if (out->length && TmtGrammar_identifier_continue((uint8_t)out->code[out->length - 1])) put(out, " ");
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
  const unsigned first_before = lower->first_source;
  if (!fragment && !jsx_attributes(lower, depth - 1, &props)) goto done;
  props.first_before = first_before;
  if (!first_before) {
    /* The children report their own first request. */
    props.first_attributes = lower->first_source;
    lower->first_source = source_none;
  }
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
      settle_first_source(lower, &props, false);
      register_jsx_helper(lower, jsx_one);
    } else if (props.create) {
      settle_first_source(lower, &props, true);
      register_jsx_helper(lower, jsx_create);
    }
    put(out, ")");
    accepted = !out->failed;
  } else {
    accepted = jsx_children(lower, tag, depth - 1, &props, helper_offset, classic);
  }
  if (accepted && fragment && !classic) register_jsx_helper(lower, jsx_fragment);

done:
  free(props.key.code);
  free(props.key_runs.items);
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

static bool pragma_text(const uint8_t *text, uint32_t available, const char *word) {
  const uint32_t width = (uint32_t)strlen(word);
  if (available < width) return false;
  for (uint32_t index = 0; index < width; index++) {
    if ((text[index] | 32) != (uint8_t)word[index] && text[index] != (uint8_t)word[index]) return false;
  }
  return true;
}

/*
 * TypeScript reads pragmas from the block comments before the first token and lower-cases their
 * names. The import source is the first word after @jsxImportSource on its line. This reader
 * accepts the plain case only and reports every other @jsx text as unsupported, so that the
 * TypeScript emitter decides it.
 */
static bool pragma_space(uint8_t byte) {
  return byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r' || byte == '\v' || byte == '\f';
}

/*
 * TypeScript finds tags in a comment with the pattern @(\S+)(\s+(?:\S.*)?)?$ and continues after each
 * match. A match takes the tag, the white space after it across line breaks, and the rest of the line
 * that follows. A pragma inside the text of an earlier match is therefore not seen. Non-ASCII text
 * before the pragma is not followed here and counts as hiding it.
 */
static bool pragma_hidden(const uint8_t *source, uint32_t comment, uint32_t pragma, uint32_t limit) {
  for (uint32_t index = comment; index < pragma; index++) {
    if (source[index] >= 0x80) return true;
  }
  uint32_t at = comment;
  while (at < pragma) {
    const uint8_t *tag = memchr(source + at, '@', pragma - at);
    if (!tag) return false;
    uint32_t end = (uint32_t)(tag - source) + 1;
    if (end >= limit || pragma_space(source[end])) {
      at = end;
      continue;
    }
    while (end < limit && !pragma_space(source[end])) end++;
    uint32_t text = end;
    while (text < limit && pragma_space(source[text])) text++;
    if (text > end && text < limit) {
      while (text < limit && source[text] != '\n' && source[text] != '\r') text++;
      end = text;
    }
    if (pragma < end) return true;
    at = end;
  }
  return false;
}

tmt_jsx_pragma_kind tmt_jsx_pragma(const uint8_t *source, uint32_t size, uint32_t *first, uint32_t *last) {
  uint32_t found = size, count = 0, factories = 0;
  for (const uint8_t *at = memchr(source, '@', size); at; ) {
    const uint32_t offset = (uint32_t)(at - source);
    const uint32_t available = size - offset - 1;
    if (pragma_text(at + 1, available, "jsx")) {
      /* @jsx and @jsxFrag name the classic factory. Under the automatic runtime TypeScript ignores them. */
      const bool factory = (available > 3 && pragma_space(at[4])) ||
        (pragma_text(at + 1, available, "jsxfrag") && available > 7 && pragma_space(at[8]));
      if (factory) factories++;
      else {
        found = offset;
        if (++count > 1) return TMT_JSX_PRAGMA_OTHER;
      }
    }
    at = offset + 1 < size ? memchr(at + 1, '@', size - offset - 1) : NULL;
  }
  if (!count) return factories ? TMT_JSX_PRAGMA_FACTORY : TMT_JSX_PRAGMA_ABSENT;
  if (factories) return TMT_JSX_PRAGMA_OTHER;
  /* A line or paragraph separator ends a line comment too; the walk below does not follow them. */
  for (uint32_t index = 0; index + 2 < size; index++) {
    if (source[index] == 0xE2 && source[index + 1] == 0x80 && (source[index + 2] == 0xA8 || source[index + 2] == 0xA9)) return TMT_JSX_PRAGMA_OTHER;
  }
  /* Walk the trivia before the first token and require the pragma inside one of its block comments. */
  uint32_t at = size >= 3 && source[0] == 0xEF && source[1] == 0xBB && source[2] == 0xBF ? 3 : 0;
  if (size - at >= 2 && source[at] == '#' && source[at + 1] == '!') {
    while (at < size && source[at] != '\n' && source[at] != '\r') at++;
  }
  bool inside = false, line = false;
  while (at < size && !inside) {
    const uint8_t byte = source[at];
    if (byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r' || byte == '\v' || byte == '\f') at++;
    else if (byte == '/' && at + 1 < size && source[at + 1] == '/') {
      const uint32_t start = at;
      while (at < size && source[at] != '\n' && source[at] != '\r') at++;
      /* TypeScript reads these pragmas from block comments only: in a line comment the text is no pragma. */
      if (found > start && found < at) line = true;
    } else if (byte == '/' && at + 1 < size && source[at + 1] == '*') {
      uint32_t end = at + 2;
      while (end + 1 < size && !(source[end] == '*' && source[end + 1] == '/')) end++;
      if (end + 1 >= size) return TMT_JSX_PRAGMA_OTHER;
      inside = found > at && found < end;
      if (inside && pragma_hidden(source, at, found, end + 2)) return TMT_JSX_PRAGMA_OTHER;
      at = end + 2;
    } else break;
  }
  if (!inside && line) return factories ? TMT_JSX_PRAGMA_FACTORY : TMT_JSX_PRAGMA_ABSENT;
  if (!inside || !pragma_text(source + found + 1, size - found - 1, "jsximportsource")) return TMT_JSX_PRAGMA_OTHER;
  uint32_t name = found + 16;
  if (name >= size || (source[name] != ' ' && source[name] != '\t')) return TMT_JSX_PRAGMA_OTHER;
  while (name < size && (source[name] == ' ' || source[name] == '\t')) name++;
  uint32_t end = name;
  while (end < size) {
    const uint8_t byte = source[end];
    if (!(((byte | 32) >= 'a' && (byte | 32) <= 'z') || (byte >= '0' && byte <= '9') || byte == '@' || byte == '/' ||
          byte == '.' || byte == '_' || byte == '~' || byte == '-')) break;
    end++;
  }
  /* The name ends at white space. A name that runs into the comment's end would include it. */
  if (end == name || end - name > 96 || end >= size ||
      (source[end] != ' ' && source[end] != '\t' && source[end] != '\n' && source[end] != '\r')) return TMT_JSX_PRAGMA_OTHER;
  *first = name;
  *last = end;
  return TMT_JSX_PRAGMA_SOURCE;
}

static bool inject_jsx_runtime(lowering *lower, size_t at) {
  if (!lower->helpers) return true;
  writer *out = &lower->output;
  const bool one = (lower->helpers & jsx_one) != 0;
  const bool many = (lower->helpers & jsx_many) != 0;
  const bool fragment = (lower->helpers & jsx_fragment) != 0;
  /* The helpers come from react unless the source names another package in a pragma. */
  uint32_t name_first = 0, name_last = 0;
  const char *package = "react";
  int package_width = 5;
  if (memchr(lower->input.source, '@', lower->input.size)) {
    const tmt_jsx_pragma_kind pragma = tmt_jsx_pragma(lower->input.source, lower->input.size, &name_first, &name_last);
    if (pragma == TMT_JSX_PRAGMA_OTHER || (pragma == TMT_JSX_PRAGMA_FACTORY && lower->classic)) return false;
    if (pragma == TMT_JSX_PRAGMA_SOURCE) {
      package = (const char *)lower->input.source + name_first;
      package_width = (int)(name_last - name_first);
    }
  }
  char create[160] = "";
  if (lower->helpers & jsx_create) {
    snprintf(create, sizeof(create), "import{createElement as _tmtElem}from\"%.*s\";\n", package_width, package);
  }
  /* The module requested first is printed last. */
  const bool create_first = lower->first_source == source_runtime;
  char runtime[160] = "";
  if (one || many || fragment) snprintf(runtime, sizeof(runtime), "}from\"%.*s/jsx-runtime\";\n", package_width, package);
  /* A statement without a semicolon ends at its last token, so the import needs a separator of its own. */
  if (at > out->length) return false;
  size_t token = at;
  while (token != 0 && (out->code[token - 1] == ' ' || out->code[token - 1] == '\t')) token--;
  const bool separate = token != 0 && out->code[token - 1] != ';' && out->code[token - 1] != '\n' && out->code[token - 1] != '\r';
  char import[448];
  const int size = snprintf(import, sizeof(import), "%s%s%s%s%s%s%s%s%s", separate ? ";" : "",
    create_first ? create : "", one || many || fragment ? "import{" : "",
    one ? "jsx as _tmtJsx0" : "", one && many ? "," : "", many ? "jsxs as _tmtJsxs" : "",
    fragment ? (one || many ? ",Fragment as _tmtFragment" : "Fragment as _tmtFragment") : "",
    runtime, create_first ? "" : create);
  if (size < 0 || (size_t)size >= sizeof(import) || at > out->length) return false;
  const size_t before = out->length;
  write_bytes(out, import, (size_t)size);
  if (out->failed) return false;
  memmove(out->code + at + size, out->code + at, before - at);
  memcpy(out->code + at, import, (size_t)size);
  if (out->runs) shift_runs(out->runs, at, (size_t)size);
  return true;
}

static char *lower_one(uint8_t *source, uint32_t size, bool jsx, bool typescript, bool classic, size_t *length,
  tmt_run_log *runs)
{
  const TmtPulseMemory_tape input = { .source = source, .size = size };
  const TmtPulseCompiler_runtime_head head = TmtPulseCompiler_read_runtime_head(input, 0, jsx, typescript, false);
  if (!head.kind) return NULL;
  lowering lower = { .input = input, .at = head.body, .classic = classic, .output.limit = (size_t)size * 32 + 1024,
    .output.runs = runs, .whole = source, .whole_size = size };
  source_bytes(&lower, 0, head.declaration);
  const bool emitted = head.kind == 1 ? emit_enum(&lower, head.name_span, true, false) : emit_jsx(&lower, head);
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

/* An import or an export at this item, also an exported class behind decorators. */
static bool module_marker_at(TmtPulseMemory_tape input, uint32_t at, bool jsx) {
  /* A decorated class is found by parsing. That parse must not write into records a caller is still reading. */
  input.count_only = true;
  if (TmtPulseCompiler_runtime_module_marker(input, at)) return true;
  const TmtPulseParser_cursor head = TmtPulseParser_trivia(input, at);
  return head.ok && head.at < input.size && input.source[head.at] == '@' && TmtPulseCompiler_decorated_module_marker(input, jsx, at);
}

static uint32_t find_marker(TmtPulseMemory_tape input, uint32_t at, bool jsx) {
  /* The scan reads the same grammar as the emitting parse, including the forms that only that parse records. */
  input.capture_types = true;
  input.count_only = true;
  while (at < input.size) {
    if (module_marker_at(input, at, jsx)) return at;
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
bool tmt_valid_module_source(const char *source, size_t size) {
  return validate_emission(source, size, "javascript");
}

/*
 * A certified projection contains only bytes the Pulse parse accepted as JavaScript, so the
 * ordinary build publishes it without a second parse. An uncertified projection keeps
 * TypeScript-only syntax and is declined. The audit build asks V8 about both and reports the
 * decision first, which lets the audit fail on any certified projection that V8 rejects.
 */
#ifdef TMT_AUDIT_V8
void tmt_audit_certification(const char *phase, bool certified);
void tmt_audit_guard(const char *phase, bool accepts);
#define publishable(certified, code, length, phase) \
  (tmt_audit_certification(phase, certified), validate_emission(code, length, phase) && (certified))
/*
 * The projection guard scanned every output for TypeScript words and angle brackets outside the
 * committed records. The parse now marks or declines those shapes itself. The audit build still
 * runs the scan and reports its verdict, and the audit compares each objection with TypeScript.
 */
#define audit_projection_guard(projected, records, phase) tmt_audit_guard(phase, unambiguous_projection(projected, records))
#else
#define publishable(certified, code, length, phase) (certified)
#define audit_projection_guard(projected, records, phase) ((void)0)
#endif

#ifdef TMT_AUDIT_V8
static bool unambiguous_projection(TmtPulseMemory_tape input, uint32_t records);
#endif

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
  erased_overload = 21,
  terminated_class_field = 22,
  parameter_property = 23,
  parameter_class = 24,
  parameter_base_constructor = 25,
  parameter_derived_constructor = 26,
  parameter_super = 27,
  contextual_reference = 28,
  uncertified_syntax = 29,
  decorated_modifiers = 30,
  prefix_assertion = 31,
  local_enum = 32,
  /* `export =` up to its equals sign, written as `module.exports =`. */
  export_assignment = 33,
  /*
   * A namespace that exists at run time: its head through the opening brace, `export const ` up to the name,
   * `export ` before a function or a class, the closing brace of that declaration, and the closing brace of
   * the namespace.
   */
  namespace_head = 34,
  namespace_variable = 35,
  namespace_declaration = 36,
  namespace_declaration_end = 37,
  namespace_end = 38,
  /* An enum exported from a namespace, from `export` to its closing brace. */
  namespace_enum = 39,
  /* The keyword of `import x = require("m")`, written as const, and of `import A = B.C`, written as var. */
  import_require = 40,
  import_alias = 41,
  /* `export var x: T;` in a namespace: no value, so TypeScript writes nothing. The whole statement goes. */
  namespace_bare_variable = 42,
  /* The head of a namespace whose name a namespace, a class or a function in front of it declares already. */
  namespace_head_merged = 44,
};

typedef struct {
  bool remove_statement;
  /* The parser kept TypeScript-only syntax, or a name whose runtime binding only V8 can decide. */
  bool uncertified;
  bool runtime_enums;
  /* An enum inside a block. Beside parameter properties TypeScript declares it with var, so that pair is declined. */
  bool local_enums;
  /* `export =`, which only a CommonJS consumer can load. An ECMAScript output reports it as an error. */
  bool export_assigned;
  uint32_t properties;
} projection_facts;

#ifdef TMT_AUDIT_V8
static uint32_t skip_js_literal_or_comment(TmtPulseMemory_tape input, uint32_t at, bool *certain) {
  if (!*certain) return at;
  const uint8_t byte = input.source[at];
  if (byte == '"' || byte == '\'') {
    const TmtPulseParser_cursor end = TmtPulseParser_string_end(input, at + 1, byte, input.size, true);
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
    // After a flat operand, a second '>' excludes an expression type-argument closer.
    if (byte == '>' && token && flat && certain && at < size && code[at] == '>') return true;
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

static bool dotted_property(const uint8_t *code, uint32_t first) {
  return first && code[first - 1] == '.' && (first == 1 || code[first - 2] != '.');
}

static bool assertion_keyword_value(const uint8_t *code, uint32_t size, uint32_t first, uint32_t end) {
  if (dotted_property(code, first)) return true;
  while (end < size && space(code[end])) end++;
  return end < size && code[end] == ':';
}

static bool value_keyword(const uint8_t *code, uint32_t size, uint32_t first, uint32_t end) {
  if (dotted_property(code, first)) return true;
  if (first && end < size && (code[end] == '"' || code[end] == '\'') && code[first - 1] == code[end]) end++;
  while (end < size && space(code[end])) end++;
  if (end == size) return false;
  const uint8_t byte = code[end];
  return byte == ':' || byte == '=' || byte == ',' || byte == ';' || byte == ')' || byte == '}' || byte == '.' || byte == ']' || byte == '?' || byte == '(' ||
    (byte == '!' && size - end >= 2 && code[end + 1] == '=') ||
    ((byte == '&' || byte == '|') && size - end >= 2 && code[end + 1] == byte);
}

/* Some TypeScript constructs can also be valid JavaScript with a different meaning. */
static bool unambiguous_javascript(TmtPulseMemory_tape input, uint8_t *code, uint32_t records) {
  input.source = code;
  const uint32_t size = input.size;
  bool certain = size <= 1048576;
  uint32_t event = 0;
#ifdef TMT_SIMD_COMPILER
  const unsigned width = tmt_projection_width();
  uint32_t block = 0, limit = 0;
  uint64_t lanes = 0;
#endif
  // The mask keeps the two-byte prefixes of these words and the assertion keywords.
  static const char *const reserved[] = {
    "declare", "namespace", "type", "interface", "abstract", "enum",
    "readonly", "public", "private", "protected", "override", "implements",
  };
  for (uint32_t first = 0; first < size;) {
#ifdef TMT_SIMD_COMPILER
    while (width && (first < limit || size - first > width)) {
      if (first >= limit) {
        block = first;
        limit = first + width;
        lanes = tmt_projection_mask(code + first, width);
      }
      const uint64_t remaining = lanes >> ((first - block) << TMT_PROJECTION_LANE_SHIFT);
      if (remaining) {
        first += (unsigned)__builtin_ctzll(remaining) >> TMT_PROJECTION_LANE_SHIFT;
        break;
      }
      first = limit;
    }
#endif
    const uint32_t literal = skip_js_literal_or_comment(input, first, &certain);
    if (literal != first) {
      first = literal;
      continue;
    }
    if (code[first] == '<') {
      if (size - first >= 3 && code[first + 1] == '<') {
        const TmtPulseParser_cursor operand = TmtPulseParser_trivia(input, first + 2);
        /* A generic function type needs its type parameters before the opening parenthesis. */
        if (operand.ok && operand.at < size && code[operand.at] == '(') {
          first = operand.at;
          continue;
        }
      }
      if (!comparison_angle(input, first + 1, certain)) return false;
    }
    bool identifier = TmtGrammar_identifier_continue(code[first]);
#ifdef TMT_SIMD_COMPILER
    if (width) identifier = identifier && (!first || !TmtGrammar_identifier_continue(code[first - 1]));
#endif
    if (!identifier) {
      first++;
      continue;
    }
    uint32_t end = first + 1;
    while (end < size && TmtGrammar_identifier_continue(code[end])) end++;
    const uint32_t width = end - first;
    const bool assertion_keyword = (width == 2 && !memcmp(code + first, "as", 2)) ||
      (width == 9 && !memcmp(code + first, "satisfies", 9));
    bool needs_module_context = false;
    if (assertion_keyword) {
      needs_module_context = !assertion_keyword_value(code, size, first, end);
    } else if (width >= 4 && width <= 10) {
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
          ((input.output[event].original != runtime_module_statement && input.output[event].original != contextual_reference) ||
           input.output[event].left.last <= first)) event++;
      if (event == records) return false;
      const TmtGrammar_candidate context = input.output[event];
      if (context.original == contextual_reference) {
        if (context.left.first != first || context.left.last != end) return false;
      } else if (first < context.left.first || end > context.left.last) return false;
    }
    first = end;
  }
  return true;
}

#endif

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
  if (kind == terminated_class_field) return first == ':' || (first == '?' && span.last - span.first == 1);
  if (kind == type_arguments || kind == generic_arrow || kind == prefix_assertion) return first == '<' && input.source[span.last - 1] == '>';
  if (kind == type_marker) return span.last - span.first == 1 && (first == '?' || first == '!');
  if (first != 'a' && first != 's') return false;
  const TmtGrammar_span context = event.right;
  if (context.last < span.last || context.last > input.size ||
      (context.first != context.last && context.first != span.last)) return false;
  const TmtPulseParser_cursor tail = { .at = context.last, .ok = true, .newline = context.first != context.last };
  if (tail.at == input.size) return true;
  if (!tail.newline && tail.at == next_assertion) return true;
  const uint8_t byte = input.source[tail.at];
  if (byte == ';' || byte == ',' || byte == ':' || byte == ')' || byte == ']' || byte == '}') return true;
  /*
   * An operator that binds no tighter than the assertion: the asserted operand holds only operators that bind
   * tighter, so it groups the same without the assertion. Assignment operators are no continuation at all
   * (TypeScript reports them), and `<`, `>` and the arithmetic operators are left out: the first two meet the
   * type, the others would take the last operand of the asserted expression.
   */
  if (!tail.newline && tail.at + 2 < input.size) {
    const uint8_t second = input.source[tail.at + 1], third = input.source[tail.at + 2];
    if ((byte == '|' && second == '|') || (byte == '&' && second == '&') || (byte == '?' && second == '?')) return third != '=';
    if ((byte == '=' || byte == '!') && second == '=') return true;
    if (byte == '^') return second != '=';
    if (byte == '?') return second != '.';
  }
  return assertion_line_boundary(input, tail);
}

static bool delimited_annotation(TmtPulseMemory_tape input, uint32_t last) {
  const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, last);
  if (!tail.ok) return false;
  if (tail.at == input.size) return true;
  const uint8_t byte = input.source[tail.at];
  return byte == ';' || byte == ',' || byte == ')' || byte == ']' || byte == '}' || byte == '{' || byte == '=' ||
    (tail.newline && TmtGrammar_identifier_start(byte));
}

/*
 * A class member that starts with `[`, `*`, `in` or `instanceof` continues a field initializer on
 * the line before it when nothing else separates the two. In the source an erased modifier or an
 * erased member stood between them, so the eraser has to leave a separator in its place.
 */
static bool continues_initializer(TmtPulseMemory_tape input, uint32_t after) {
  const TmtPulseParser_cursor next = TmtPulseParser_trivia(input, after);
  if (!next.ok || next.at >= input.size) return false;
  const uint8_t *word = input.source + next.at;
  const uint32_t rest = input.size - next.at;
  if (*word == '[' || *word == '*') return true;
  if (rest > 2 && !memcmp(word, "in", 2) && !TmtGrammar_identifier_continue(word[2])) return true;
  return rest > 10 && !memcmp(word, "instanceof", 10) && !TmtGrammar_identifier_continue(word[10]);
}

static bool blank_class_modifiers(TmtPulseMemory_tape input, TmtGrammar_span span, char *code, bool separate) {
  uint32_t leading = span.last;
  bool kept = false;
  for (uint32_t at = span.first; at < span.last;) {
    const TmtPulseParser_cursor token = TmtPulseParser_trivia(input, at);
    if (!token.ok || token.at > span.last) return false;
    if (token.at == span.last) break;
    at = token.at;
    while (at < span.last && TmtGrammar_identifier_continue(input.source[at])) at++;
    const uint32_t width = at - token.at;
    const uint8_t *word = input.source + token.at;
    if (width == 6 && !memcmp(word, "static", 6)) {
      kept = true;
      continue;
    }
    if (!kept && leading == span.last) leading = token.at;
    if (!((width == 6 && !memcmp(word, "public", 6)) ||
          (width == 7 && !memcmp(word, "private", 7)) ||
          (width == 9 && !memcmp(word, "protected", 9)) ||
          (width == 8 && (!memcmp(word, "readonly", 8) || !memcmp(word, "override", 8) ||
                          !memcmp(word, "abstract", 8))))) return false;
    memset(code + token.at, ' ', width);
  }
  /* A leading modifier was erased and no static stands before it, so the member name follows the line before. */
  if (separate && leading < span.last && continues_initializer(input, span.last)) code[leading] = ';';
  return true;
}

static unsigned blank_unicode_scalar(uint8_t *output, const uint8_t *source, uint32_t remaining) {
  const uint8_t leading = source[0];
  if (leading < 0xc2 || leading > 0xf4) return 0;
  const unsigned width = leading < 0xe0 ? 2 : leading < 0xf0 ? 3 : 4;
  if (width > remaining) return 0;
  for (unsigned i = 1; i < width; i++) {
    if ((source[i] & 0xc0) != 0x80) return 0;
  }
  if ((leading == 0xe0 && source[1] < 0xa0) || (leading == 0xed && source[1] >= 0xa0) ||
      (leading == 0xf0 && source[1] < 0x90) || (leading == 0xf4 && source[1] >= 0x90)) return 0;

  /* Match Node's eraser while retaining both byte and UTF-16 offsets. */
  if (width == 2) memcpy(output, "\xc2\xa0", 2);
  else if (width == 4) memcpy(output, " \xef\xbb\xbf", 4);
  else if (leading == 0xe2 && source[1] == 0x80 && (source[2] == 0xa8 || source[2] == 0xa9)) {
    memcpy(output, source, 3);
  } else memcpy(output, "\xe2\x80\x82", 3);
  return width;
}

static bool blank_lines(uint8_t *output, const uint8_t *source, uint32_t width, bool unicode) {
  for (uint32_t at = 0; at < width;) {
#ifdef TMT_SIMD_COMPILER
    if (width - at >= 16 && tmt_erase_type_run(output + at, source + at)) {
      at += 16;
      continue;
    }
#endif
    const uint8_t byte = source[at];
    if (byte < 128) {
      output[at] = byte == '\n' || byte == '\r' ? byte : ' ';
      at++;
    } else {
      if (!unicode) return false;
      const unsigned step = blank_unicode_scalar(output + at, source + at, width - at);
      if (!step) return false;
      at += step;
    }
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

/* A retained declaration ends the directive prologue. */
static bool begins_runtime_declaration(TmtPulseMemory_tape input, uint32_t at) {
  if (TmtPulseParser_keyword(input, at, 6, UINT64_C(0x6578706f7274))) {
    const TmtPulseParser_cursor declaration = TmtPulseParser_trivia(input, at + 6);
    if (!declaration.ok) return false;
    at = declaration.at;
  }
  if (TmtPulseParser_keyword(input, at, 5, UINT64_C(0x636f6e7374))) {
    const TmtPulseParser_cursor name = TmtPulseParser_trivia(input, at + 5);
    return name.ok && !TmtPulseParser_keyword(input, name.at, 4, UINT64_C(0x656e756d));
  }
  return TmtPulseParser_keyword(input, at, 3, UINT64_C(0x6c6574)) ||
    TmtPulseParser_keyword(input, at, 3, UINT64_C(0x766172)) ||
    TmtPulseParser_keyword(input, at, 8, UINT64_C(0x66756e6374696f6e)) ||
    TmtPulseParser_keyword(input, at, 5, UINT64_C(0x636c617373)) ||
    /* A namespace or an enum that reaches this point is lowered, not erased, and is as much a declaration. */
    TmtPulseParser_keyword(input, at, 4, UINT64_C(0x656e756d)) ||
    (TmtPulseParser_keyword(input, at, 8, UINT64_C(0x6e616d6573706163)) == false && input.size - at > 9 &&
      !memcmp(input.source + at, "namespace", 9) && !TmtGrammar_identifier_continue(input.source[at + 9])) ||
    /* The older spelling of a namespace: `module` in front of a name. */
    (input.size - at > 7 && !memcmp(input.source + at, "module", 6) && (input.source[at + 6] == ' ' || input.source[at + 6] == '\t') &&
      TmtGrammar_identifier_start(input.source[at + 7]));
}

/*
 * Erasing an assertion in front of `{`, `function`, `class` or `async` leaves that token where the assertion
 * began. At the start of a statement or of an arrow body it would then open a block or a declaration. The
 * erasure is kept only behind a token that can only be followed by an expression.
 */
static bool assertion_exposes_statement(TmtPulseMemory_tape input, TmtGrammar_span span) {
  const TmtPulseParser_cursor operand = TmtPulseParser_trivia(input, span.last);
  if (!operand.ok || operand.at >= input.size) return true;
  const uint8_t *word = input.source + operand.at;
  const uint32_t rest = input.size - operand.at;
  const bool opens = *word == '{' ||
    (rest > 8 && !memcmp(word, "function", 8) && !TmtGrammar_identifier_continue(word[8])) ||
    (rest > 5 && !memcmp(word, "class", 5) && !TmtGrammar_identifier_continue(word[5])) ||
    (rest > 5 && !memcmp(word, "async", 5) && !TmtGrammar_identifier_continue(word[5]));
  if (!opens) return false;
  uint32_t at = span.first;
  while (at && (input.source[at - 1] == ' ' || input.source[at - 1] == '\t')) at--;
  if (!at) return true;
  const uint8_t before = input.source[at - 1];
  if (before == '(' || before == ',' || before == '[' || before == '?' || before == '&' || before == '|' || before == '+' ||
      before == '-' || before == '*' || before == '!' || before == '~' || before == '%' || before == '^') return false;
  /* An equals sign that is not the head of an arrow. */
  if (before == '=') return false;
  static const char *const words[] = { "return", "typeof", "void", "await", "yield", "throw" };
  for (size_t index = 0; index < sizeof(words) / sizeof(*words); index++) {
    const uint32_t width = (uint32_t)strlen(words[index]);
    if (at >= width && !memcmp(input.source + at - width, words[index], width) &&
        (at == width || !TmtGrammar_identifier_continue(input.source[at - width - 1]))) return false;
  }
  return true;
}

/* An enum at module level or inside a block. */
/* A record whose text is replaced: an enum at module level or inside a block, or the head of an export assignment. */
static bool opens_namespace(uint32_t kind) { return kind == namespace_head || kind == namespace_head_merged; }

static bool namespace_record(uint32_t kind) {
  return (kind >= namespace_head && kind <= namespace_enum) || kind == namespace_bare_variable || kind == namespace_head_merged;
}

static bool enum_record(uint32_t kind) {
  return kind == runtime_enum || kind == local_enum || kind == export_assignment || namespace_record(kind) ||
    kind == import_require || kind == import_alias;
}

static bool blank_type_records(TmtPulseMemory_tape input, uint32_t records, char **output, bool allow_properties,
  projection_facts *facts)
{
  char *code = NULL;
  uint32_t previous = 0;
  uint32_t prelude = TmtPulseCompiler_runtime_source_start(input).at;
  bool retained_module_statement = false;
  *facts = (projection_facts){0};
  *output = NULL;
  for (uint32_t index = 0; index < records; index++) {
    const TmtGrammar_candidate event = input.output[index];
    if (event.original == uncertified_syntax) facts->uncertified = true;
    if (enum_record(event.original)) facts->runtime_enums = true;
    if (event.original == local_enum) facts->local_enums = true;
    if (event.original == export_assignment) facts->export_assigned = true;
    if (event.original == parameter_property) {
      if (!allow_properties || facts->properties == 512) goto decline;
      facts->properties++;
    }
    const bool member = event.original == erased_list_member || event.original == erased_overload;
    const bool modifiers = event.original == class_modifiers || event.original == parameter_property ||
      event.original == decorated_modifiers;
    const bool arrow = event.original == generic_arrow;
    const bool result = event.original == arrow_result;
    const bool heritage = event.original == class_implements;
    const bool local_type = event.original == erased_local_type;
    const bool field = event.original == terminated_class_field;
    const bool prefix = event.original == prefix_assertion;
    /* Behind the colon of a property (kind 63, recorded by the parser) an assertion begins a value. */
    const bool property_value = prefix && index > 0 && input.output[index - 1].original == 63 &&
      input.output[index - 1].left.last <= event.left.first && event.left.first - input.output[index - 1].left.last <= 1;
    if (prefix && !property_value && assertion_exposes_statement(input, event.left)) goto decline;
    if (!member && !modifiers && !arrow && !result && !heritage && !local_type && !field && !prefix &&
        (event.original < type_annotation || event.original > type_marker)) continue;
    const TmtGrammar_span span = event.left;
    if (span.first >= span.last || span.last > input.size) goto decline;
    const bool statement = event.original == erased_type_statement || event.original == runtime_module_statement;
    bool separate = field;
    if (statement) {
      const TmtPulseParser_cursor first = TmtPulseParser_trivia(input, prelude);
      if (first.ok && first.at == span.first) prelude = span.last;
      else if (event.original == erased_type_statement) {
        if (!retained_module_statement && (!first.ok || !begins_runtime_declaration(input, first.at))) goto decline;
        retained_module_statement = true;
        separate = true;
        prelude = span.last;
      }
      if (event.original == runtime_module_statement) {
        retained_module_statement = true;
        continue;
      }
      facts->remove_statement = true;
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
    bool preserve_lines = statement || member || modifiers || arrow || result || heritage || local_type || field ||
      event.original == type_arguments || event.original == type_assertion;
    if (!preserve_lines || modifiers) {
      bool multiline = false, slash = false, unicode = false;
      for (uint32_t byte = span.first; byte < span.last; byte++) {
        const uint8_t value = input.source[byte];
        if (value >= 128) {
          if (!annotation) goto decline;
          unicode = true;
        }
        if (value == '\n' || value == '\r') multiline = true;
        if (value == '/') slash = true;
      }
      if (!preserve_lines && (multiline || slash || unicode)) {
        if (!annotation || !delimited_annotation(input, span.last)) goto decline;
        preserve_lines = true;
      }
    }
    if (!code) {
      code = malloc((size_t)input.size + sizeof(esm_marker));
      if (!code) return false;
      memcpy(code, input.source, input.size);
    }
    if (modifiers) {
      /* A decorator already separates its member from the one before. */
      if (!blank_class_modifiers(input, span, code, event.original != decorated_modifiers)) goto decline;
    } else if (!preserve_lines) memset(code + span.first, ' ', span.last - span.first);
    else if (!blank_lines((uint8_t *)code + span.first, input.source + span.first, span.last - span.first,
                          statement || local_type || annotation || event.original == erased_overload)) goto decline;
    /* Only a signature can be an erased class member. A receiver parameter or a list entry takes no separator. */
    if (separate || (event.original == erased_overload && continues_initializer(input, span.last))) code[span.first] = ';';
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

typedef struct {
  uint32_t at;
  TmtGrammar_span name;
  bool field, separate;
} parameter_insertion;

static bool encloses(TmtGrammar_span outer, TmtGrammar_span inner) {
  return outer.first <= inner.first && inner.last <= outer.last;
}

static const TmtGrammar_candidate *property_constructor(TmtPulseMemory_tape input, uint32_t count,
  TmtGrammar_span parameter)
{
  const TmtGrammar_candidate *constructor = NULL;
  for (uint32_t index = 0; index < count; index++) {
    const TmtGrammar_candidate *entry = input.output + index;
    if ((entry->original == parameter_base_constructor || entry->original == parameter_derived_constructor) &&
        encloses(entry->left, parameter) && (!constructor || encloses(constructor->left, entry->left))) {
      constructor = entry;
    }
  }
  return constructor;
}

static bool property_anchors(TmtPulseMemory_tape input, uint32_t count, TmtGrammar_candidate property,
  parameter_insertion *field, parameter_insertion *assignment)
{
  const TmtGrammar_span name = property.right;
  if (name.first != property.left.last || name.last <= name.first || name.last > input.size) return false;
  const TmtGrammar_span parameter = { property.left.first, name.last };
  const TmtGrammar_candidate *constructor = property_constructor(input, count, parameter);
  if (!constructor) return false;
  const TmtGrammar_span body = constructor->right;
  if (constructor->left.last > body.first || body.first >= body.last || body.last > input.size ||
      input.source[body.first] != '{' || input.source[body.last - 1] != '}') return false;
  const TmtGrammar_span method = { constructor->left.first, body.last };
  const TmtGrammar_span *class_ = NULL;
  for (uint32_t index = 0; index < count; index++) {
    const TmtGrammar_candidate *entry = input.output + index;
    if (entry->original == parameter_class && encloses(entry->left, method) &&
        (!class_ || encloses(*class_, entry->left))) class_ = &entry->left;
  }
  if (!class_ || class_->first >= method.first || class_->last <= method.last ||
      class_->last > input.size || input.source[class_->first] != '{') return false;
  *field = (parameter_insertion){ class_->first + 1, name, true, false };
  *assignment = (parameter_insertion){ body.first + 1, name, false, false };

  TmtPulseParser_cursor first = TmtPulseParser_trivia(input, body.first + 1);
  if (!first.ok || first.at >= body.last) return false;
  const uint8_t first_byte = input.source[first.at];
  if (constructor->original == parameter_base_constructor) return first_byte != '"' && first_byte != '\'';

  for (uint32_t index = 0; index < count; index++) {
    const TmtGrammar_candidate entry = input.output[index];
    if (entry.original != parameter_super || entry.left.first < first.at || entry.left.first >= body.last) continue;
    /*
     * TypeScript writes the assignments behind the first super call that is a statement of the body itself.
     * Statements may stand before it: each is read as a whole, and the walk has to arrive at the call exactly.
     */
    uint32_t statement = first.at;
    /* The walk parses again. It must not write into the records this function is reading. */
    TmtPulseMemory_tape walk = input;
    walk.capture_types = true;
    walk.count_only = true;
    while (statement < entry.left.first) {
      const uint32_t next = TmtPulseCompiler_next_module_item(walk, false, statement);
      if (next <= statement || next > entry.left.first) return false;
      const TmtPulseParser_cursor following = TmtPulseParser_trivia(input, next);
      if (!following.ok) return false;
      statement = following.at;
    }
    if (statement != entry.left.first) return false;
    const uint32_t end = entry.left.last;
    if (end <= first.at || end >= body.last || input.source[end - 1] != ')') return false;
    const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, end);
    if (!tail.ok || tail.at >= body.last) return false;
    const uint8_t byte = input.source[tail.at];
    if (byte == ';') assignment->at = tail.at + 1;
    else if (byte == '}' || (tail.newline && assertion_line_boundary(input, tail))) {
      assignment->at = end;
      assignment->separate = true;
    } else return false;
    return true;
  }
  return false;
}

static int compare_insertions(const void *lhs, const void *rhs) {
  const parameter_insertion *a = lhs, *b = rhs;
  if (a->at != b->at) return a->at < b->at ? -1 : 1;
  return a->name.first < b->name.first ? -1 : a->name.first > b->name.first;
}

static bool emit_recorded_enum(lowering *lower, TmtGrammar_span span, uint32_t kind);
typedef struct namespace_scope namespace_scope;
static bool emit_namespace_record(lowering *lower, uint32_t records, uint32_t index, namespace_scope *scope);
static void namespace_bytes(lowering *lower, namespace_scope *scope, uint32_t first, uint32_t last);
static bool namespace_record(uint32_t kind);
static bool inside_namespace(const namespace_scope *scope);
static namespace_scope *new_namespace_scope(uint8_t *original, bool module);
static bool close_namespace_scope(namespace_scope *scope);

/* Copies a range of the projection and lowers the enum declarations recorded inside it. */
/*
 * Copies a range of the source and lowers the enums and namespaces in it. A namespace may hold classes with
 * parameter properties, so its records are written here as well, between the statements this pass inserts.
 */
static bool copy_lowering_enums(lowering *lower, namespace_scope *scope, uint32_t records, uint32_t *enum_index, uint32_t first, uint32_t last, bool enums) {
  while (enums && *enum_index < records) {
    const TmtGrammar_candidate event = lower->input.output[*enum_index];
    if (!enum_record(event.original)) {
      (*enum_index)++;
      continue;
    }
    const TmtGrammar_span span = event.left;
    if (span.first >= last) break;
    if (span.first < first || span.last > last) return false;
    namespace_bytes(lower, scope, first, span.first);
    if (namespace_record(event.original)) {
      if (!emit_namespace_record(lower, records, *enum_index, scope)) return false;
    } else if (event.original == import_alias && inside_namespace(scope)) {
      /* An alias in a namespace body is an ordinary variable. */
      put(&lower->output, "var");
    } else {
      lower->in_namespace = scope && inside_namespace(scope);
      const bool emitted = emit_recorded_enum(lower, span, event.original);
      lower->in_namespace = false;
      if (!emitted) return false;
    }
    first = span.last;
    (*enum_index)++;
  }
  namespace_bytes(lower, scope, first, last);
  return true;
}

static char *emit_parameter_properties(TmtPulseMemory_tape input, const char *projected, uint32_t records,
  uint32_t properties, bool enums, bool module, size_t *length, tmt_run_log *runs)
{
  uint8_t *const original = input.source;
  parameter_insertion *edits = malloc((size_t)properties * 2 * sizeof(*edits));
  if (!edits) return NULL;
  uint32_t used = 0;
  size_t reserve = input.size;
  for (uint32_t index = 0; index < records; index++) {
    const TmtGrammar_candidate event = input.output[index];
    if (event.original != parameter_property) continue;
    if (used >= properties * 2 || !property_anchors(input, records, event, edits + used, edits + used + 1)) {
      free(edits);
      return NULL;
    }
    const size_t width = event.right.last - event.right.first;
    /* A class cannot declare a field named constructor. */
    if (width == 11 && !memcmp(input.source + event.right.first, "constructor", 11)) {
      free(edits);
      return NULL;
    }
    reserve += 3 * width + (sizeof("\n;") - 1) + (sizeof(";\nthis. = ;") - 1);
    used += 2;
  }
  qsort(edits, used, sizeof(*edits), compare_insertions);
  // Resolve statement boundaries in the original source. Copy only projected bytes.
  input.source = (uint8_t *)projected;
  lowering lower = { .input = input, .output.limit = enums ? (size_t)input.size * 32 + 1024 : 1048576, .output.runs = runs,
    .whole = original, .whole_size = input.size };
  if (reserve > lower.output.limit) {
    free(edits);
    return NULL;
  }
  lower.output.code = malloc(reserve);
  if (!lower.output.code) {
    free(edits);
    return NULL;
  }
  lower.output.capacity = reserve;
  namespace_scope *scope = new_namespace_scope(original, module);
  if (!scope) {
    free(edits);
    free(lower.output.code);
    return NULL;
  }
  uint32_t copied = 0, enum_index = 0;
  for (uint32_t index = 0; index < used; index++) {
    const parameter_insertion edit = edits[index];
    if (!copy_lowering_enums(&lower, scope, records, &enum_index, copied, edit.at, enums)) lower.output.failed = true;
    if (edit.separate && copied != edit.at) put(&lower.output, ";");
    put(&lower.output, "\n");
    if (!edit.field) put(&lower.output, "this.");
    source_bytes(&lower, edit.name.first, edit.name.last);
    if (!edit.field) {
      put(&lower.output, " = ");
      source_bytes(&lower, edit.name.first, edit.name.last);
    }
    put(&lower.output, ";");
    copied = edit.at;
  }
  if (!copy_lowering_enums(&lower, scope, records, &enum_index, copied, input.size, enums)) lower.output.failed = true;
  /* Every namespace that was opened has to be closed. */
  if (!close_namespace_scope(scope)) lower.output.failed = true;
  free(edits);
  if (lower.output.failed) {
    free(lower.output.code);
    return NULL;
  }
  *length = lower.output.length;
  return lower.output.code;
}

static bool emit_recorded_enum(lowering *lower, TmtGrammar_span span, uint32_t kind) {
  const uint32_t size = lower->input.size;
  const bool local = kind == local_enum;
  if (span.first >= span.last || span.last > size) return false;
  /* A namespace is lowered only where no other lowering shares the file. */
  if (namespace_record(kind)) return false;
  /* An export assignment is written only by the pass that knows the output may be CommonJS. */
  if (kind == export_assignment || kind == import_require || kind == import_alias) return false;
  lower->input.size = span.last;
  const TmtPulseCompiler_runtime_head head = TmtPulseCompiler_read_runtime_head(lower->input, span.first, false, true, true);
  lower->at = head.body;
  const bool emitted = (head.kind == 1 || head.kind == 3) && head.declaration == span.first && head.body < span.last &&
    !(local && head.kind == 1) && emit_enum(lower, head.name_span, head.kind == 1, local) && lower->at == span.last;
  lower->input.size = size;
  return emitted;
}

static bool plain_name(TmtPulseMemory_tape input, TmtGrammar_span name) {
  if (name.first >= name.last || name.last > input.size || !TmtGrammar_identifier_start(input.source[name.first])) return false;
  for (uint32_t at = name.first; at < name.last; at++) {
    if (input.source[at] >= 128 || !TmtGrammar_identifier_continue(input.source[at])) return false;
  }
  return true;
}

/* How often a name stands as a whole word in a range, property accesses aside. Text in strings and comments counts as well. */
static uint32_t word_count(TmtPulseMemory_tape input, uint32_t first, uint32_t last, TmtGrammar_span name) {
  const uint32_t width = name.last - name.first;
  uint32_t count = 0;
  for (uint32_t at = first; at + width <= last; at++) {
    if (memcmp(input.source + at, input.source + name.first, width)) continue;
    /* A name behind a single dot is a property, not a reference. */
    const bool property = at > first + 1 && input.source[at - 1] == '.' && input.source[at - 2] != '.';
    if (property) continue;
    const bool before = at > first && (input.source[at - 1] >= 128 || TmtGrammar_identifier_continue(input.source[at - 1]));
    const bool after = at + width < last && (input.source[at + width] >= 128 || TmtGrammar_identifier_continue(input.source[at + width]));
    if (before || after) continue;
    /*
     * A word with the same quotation mark on both sides is the whole of a string, or stands in a comment or
     * a longer string: in no case is it a name. `export const mode = 'mode'` is the common form.
     */
    const uint8_t quote = at > first ? input.source[at - 1] : 0;
    if ((quote == '\'' || quote == '"' || quote == '`') && at + width < last && input.source[at + width] == quote) continue;
    count++;
  }
  return count;
}

/* A name is copied from the source, so a source map can lead back to it. */
static void put_name(lowering *lower, TmtGrammar_span name) {
  source_bytes(lower, name.first, name.last);
}

static bool skip_word(TmtPulseMemory_tape input, uint32_t *at, const char *word) {
  const uint32_t width = (uint32_t)strlen(word);
  if (input.size - *at <= width || memcmp(input.source + *at, word, width) ||
      TmtGrammar_identifier_continue(input.source[*at + width])) return false;
  *at += width;
  return true;
}

/* The namespaces that are open while their records are written, outermost first. */
struct namespace_scope {
  TmtGrammar_span names[8];
  /* Whether the namespace is a member that its parent exports. */
  bool exported[8];
  /* Whether the namespace was opened by the same head as the one around it: the later names of `A.B.C`. */
  bool joined[8];
  /* The records of the namespace's members: behind its head, up to its end. */
  uint32_t first_member[8], last_member[8];
  uint32_t depth;
  /*
   * The names that are read as expressions, in source order, once a namespace needs them: a reference to a
   * variable that a namespace exports is written as a property of that namespace.
   */
  TmtGrammar_span *references;
  uint32_t reference_count, next_reference;
  /* Where a reference is a shorthand property (kind 62): `{ name }` is written `{ name: N.name }`. */
  uint32_t *shorthands;
  uint32_t shorthand_count;
  bool references_read;
  uint8_t *original;
  bool module;
  /* The count of records, and the head at the top of the file that is open. */
  uint32_t records, top;
};

static int by_position(const void *left, const void *right) {
  const uint32_t a = ((const TmtGrammar_span *)left)->first, b = ((const TmtGrammar_span *)right)->first;
  return a < b ? -1 : a > b;
}

/*
 * Reads the source once more with a tape that records every name read as an expression (kind 43). The reading
 * has a workspace of its own, since the records of the first reading are still in use. False when it fails.
 */
static bool read_references(namespace_scope *scope, uint32_t size) {
  if (scope->references_read) return scope->references != NULL;
  scope->references_read = true;
#ifndef TMT_DIRECT
  module_workspace *memory = calloc(1, sizeof(*memory));
  const uint32_t capacity = size / 2 + 64;
  TmtGrammar_candidate *records = malloc((size_t)capacity * sizeof(*records));
  uint8_t *marks = calloc(capacity, sizeof(*marks));
  if (memory && records && marks && scope->original) {
    TmtPulseMemory_tape again = with_workspace(scope->original, size, memory);
    again.output = records;
    again.marks = marks;
    again.capacity = capacity;
    again.capture_types = true;
    again.count_only = false;
    again.capture_references = true;
    const TmtPulseParser_parser_state parsed = TmtPulseParser_parse(again, false, scope->module);
    if (parsed.status == 0 && parsed.count <= capacity) {
      uint32_t kept = 0;
      uint32_t marked = 0;
      for (uint32_t index = 0; index < parsed.count; index++) {
        kept += records[index].original == 43 || records[index].original == 62;
        marked += records[index].original == 62;
      }
      TmtGrammar_span *spans = malloc(((size_t)kept + 1) * sizeof(*spans));
      uint32_t *shorthands = malloc(((size_t)marked + 1) * sizeof(*shorthands));
      if (!spans || !shorthands) {
        free(spans);
        free(shorthands);
        spans = NULL;
      }
      if (spans) {
        uint32_t count = 0;
        scope->shorthands = shorthands;
        for (uint32_t index = 0; index < parsed.count; index++) {
          if (records[index].original != 43 && records[index].original != 62) continue;
          spans[count++] = records[index].left;
          if (records[index].original == 62) shorthands[scope->shorthand_count++] = records[index].left.first;
        }
        qsort(spans, count, sizeof(*spans), by_position);
        /* A part of the source that was read twice gives its names twice. */
        uint32_t unique = 0;
        for (uint32_t index = 0; index < count; index++) {
          if (unique == 0 || spans[unique - 1].first != spans[index].first) spans[unique++] = spans[index];
        }
        scope->references = spans;
        scope->reference_count = unique;
      }
    }
  }
  free(memory);
  free(records);
  free(marks);
#else
  (void)size;
#endif
  return scope->references != NULL;
}

static bool same_name(TmtPulseMemory_tape input, TmtGrammar_span left, TmtGrammar_span right) {
  return left.last - left.first == right.last - right.first &&
    !memcmp(input.source + left.first, input.source + right.first, left.last - left.first);
}

/* How many of the recorded references in a range spell a name. */
static uint32_t reference_count(const namespace_scope *scope, TmtPulseMemory_tape input, uint32_t first, uint32_t last, TmtGrammar_span name) {
  uint32_t count = 0;
  for (uint32_t index = 0; index < scope->reference_count; index++) {
    const TmtGrammar_span reference = scope->references[index];
    if (reference.first >= first && reference.last <= last && same_name(input, reference, name)) count++;
  }
  return count;
}

static bool walk_siblings(namespace_scope *scope, TmtPulseMemory_tape input, uint32_t self, TmtGrammar_span name,
  uint32_t body_first, uint32_t body_last, TmtGrammar_span wanted);

/* The innermost open namespace that exports the name itself, or the outermost when another declaration of it does; else NULL. */
static const TmtGrammar_span *exporting_namespace(const namespace_scope *scope, TmtPulseMemory_tape input, TmtGrammar_span name) {
  /* The name of an open namespace is its parameter. */
  for (uint32_t depth = 0; depth < scope->depth; depth++) if (same_name(input, scope->names[depth], name)) return NULL;
  for (uint32_t depth = scope->depth; depth-- > 0;) {
    /* The later names of a dotted head share the members of the last one. */
    uint32_t inner = 0;
    for (uint32_t member = scope->first_member[depth]; member < scope->last_member[depth]; member++) {
      const uint32_t kind = input.output[member].original;
      if (opens_namespace(kind)) { inner++; continue; }
      if (kind == namespace_end) { inner--; continue; }
      if (inner != 0 || (kind != namespace_variable && kind != namespace_bare_variable)) continue;
      if (same_name(input, input.output[member].right, name)) return &scope->names[depth];
    }
  }
  /* A member that another declaration of the outermost namespace exports. */
  if (scope->depth != 0 && scope->records != 0 &&
      walk_siblings((namespace_scope *)scope, input, scope->top, scope->names[0], 0, 0, name)) return &scope->names[0];
  return NULL;
}

/* Copies source bytes, with the namespace in front of every reference to a variable it exports. */
static void namespace_bytes(lowering *lower, namespace_scope *scope, uint32_t first, uint32_t last) {
  if (scope->depth != 0 && scope->references) {
    while (scope->next_reference < scope->reference_count && scope->references[scope->next_reference].first < first) scope->next_reference++;
    while (scope->next_reference < scope->reference_count && scope->references[scope->next_reference].last <= last) {
      const TmtGrammar_span reference = scope->references[scope->next_reference++];
      const TmtGrammar_span *owner = exporting_namespace(scope, lower->input, reference);
      if (!owner) continue;
      source_bytes(lower, first, reference.first);
      for (uint32_t index = 0; index < scope->shorthand_count; index++) {
        if (scope->shorthands[index] != reference.first) continue;
        write_bytes(&lower->output, lower->input.source + reference.first, reference.last - reference.first);
        put(&lower->output, ":");
        break;
      }
      put_name(lower, *owner);
      put(&lower->output, ".");
      first = reference.first;
    }
  }
  source_bytes(lower, first, last);
}

static bool inside_namespace(const namespace_scope *scope) { return scope->depth != 0; }

static namespace_scope *new_namespace_scope(uint8_t *original, bool module) {
  namespace_scope *scope = calloc(1, sizeof(*scope));
  if (scope) {
    scope->original = original;
    scope->module = module;
  }
  return scope;
}

/* Frees the scope. False when a namespace is still open. */
static bool close_namespace_scope(namespace_scope *scope) {
  const bool closed = scope->depth == 0;
  free(scope->references);
  free(scope->shorthands);
  free(scope);
  return closed;
}

/*
 * Whether every use of a name in a range reads the name: it is followed by a dot, or the parser recorded it as
 * a name read as an expression (`value instanceof N`, `new N()`). Any other occurrence may declare the name.
 */
static bool only_qualified(namespace_scope *scope, TmtPulseMemory_tape input, uint32_t first, uint32_t last, TmtGrammar_span name) {
  const uint32_t width = name.last - name.first;
  for (uint32_t at = first; at + width <= last; at++) {
    if (memcmp(input.source + at, input.source + name.first, width)) continue;
    const bool property = at > first + 1 && input.source[at - 1] == '.' && input.source[at - 2] != '.';
    if (property) continue;
    const bool before = at > first && (input.source[at - 1] >= 128 || TmtGrammar_identifier_continue(input.source[at - 1]));
    const bool after = at + width < last && (input.source[at + width] >= 128 || TmtGrammar_identifier_continue(input.source[at + width]));
    if (before || after) continue;
    uint32_t next = at + width;
    while (next < last && (input.source[next] == ' ' || input.source[next] == '\t')) next++;
    if (next < last && input.source[next] == '.' && !(next + 1 < last && input.source[next + 1] == '.')) continue;
    if (!read_references(scope, input.size)) return false;
    bool read = false;
    for (uint32_t index = 0; index < scope->reference_count && !read; index++) {
      read = scope->references[index].first == at && scope->references[index].last == at + width;
    }
    if (!read) return false;
  }
  return true;
}

/* The name that a function or class declaration behind `export` declares, from the place behind `export`. */
static TmtGrammar_span declared_name(TmtPulseMemory_tape input, uint32_t at) {
  for (;;) {
    while (at < input.size && (input.source[at] == ' ' || input.source[at] == '\t' || input.source[at] == '\n' || input.source[at] == '\r')) at++;
    if (at < input.size && input.source[at] == '*') at++;
    else if (!skip_word(input, &at, "async") && !skip_word(input, &at, "function") && !skip_word(input, &at, "class") &&
        !skip_word(input, &at, "abstract") && !skip_word(input, &at, "const") && !skip_word(input, &at, "enum") &&
        !skip_word(input, &at, "export")) break;
  }
  TmtGrammar_span name = { at, at };
  while (name.last < input.size && input.source[name.last] < 128 && TmtGrammar_identifier_continue(input.source[name.last])) name.last++;
  return name;
}

static bool exported_head(TmtPulseMemory_tape input, TmtGrammar_candidate head) {
  return input.size - head.left.first > 6 && !memcmp(input.source + head.left.first, "export", 6);
}

/* The place behind white space and comments. */
static uint32_t behind_trivia(TmtPulseMemory_tape input, uint32_t at, uint32_t last) {
  for (;;) {
    while (at < last && (input.source[at] == ' ' || input.source[at] == '\t' || input.source[at] == '\n' || input.source[at] == '\r')) at++;
    if (at + 1 < last && input.source[at] == '/' && input.source[at + 1] == '/') {
      while (at < last && input.source[at] != '\n' && input.source[at] != '\r') at++;
    } else if (at + 1 < last && input.source[at] == '/' && input.source[at + 1] == '*') {
      at += 2;
      while (at + 1 < last && !(input.source[at] == '*' && input.source[at + 1] == '/')) at++;
      at = at + 1 < last ? at + 2 : last;
    } else return at;
  }
}

/* Whether a declared namespace of this name stands among the erased statements. */
static bool erased_namespace(TmtPulseMemory_tape input, uint32_t records, TmtGrammar_span name) {
  for (uint32_t index = 0; index < records; index++) {
    const TmtGrammar_candidate event = input.output[index];
    if (event.original != erased_type_statement) continue;
    uint32_t at = event.left.first;
    bool ambient = false;
    for (;;) {
      at = behind_trivia(input, at, event.left.last);
      if (skip_word(input, &at, "declare")) ambient = true;
      else if (!skip_word(input, &at, "export")) break;
    }
    /* A namespace that is erased without being declared holds types alone, and no member a body could name. */
    if (!ambient || (!skip_word(input, &at, "namespace") && !skip_word(input, &at, "module"))) continue;
    at = behind_trivia(input, at, event.left.last);
    TmtGrammar_span declared = { at, at };
    while (declared.last < event.left.last && input.source[declared.last] < 128 && TmtGrammar_identifier_continue(input.source[declared.last])) declared.last++;
    if (same_name(input, declared, name)) return true;
  }
  return false;
}

/* The further name of a dotted head at a position: the name behind the dot there, or an empty span. */
static TmtGrammar_span dotted_part(TmtPulseMemory_tape input, TmtGrammar_candidate head, uint32_t at) {
  TmtGrammar_span part = { at, at };
  if (at >= head.left.last || input.source[at] != '.') return part;
  part.first = part.last = at + 1;
  while (part.last < head.left.last && input.source[part.last] < 128 && TmtGrammar_identifier_continue(input.source[part.last])) part.last++;
  return part;
}

/*
 * What a record of another declaration of the namespace gives the namespace: a member that every declaration
 * sees (1), a name that only a namespace inside shares (2), or nothing (0). `depth` counts the namespaces open
 * around the record inside that declaration, the dotted names of its head included.
 */
static int sibling_member(TmtPulseMemory_tape input, TmtGrammar_candidate event, uint32_t depth, TmtGrammar_span *member) {
  if (opens_namespace(event.original)) {
    *member = event.right;
    const bool exported = input.size - event.left.first > 6 && !memcmp(input.source + event.left.first, "export", 6);
    return depth == 1 && exported ? 1 : 2;
  }
  if (event.original == namespace_variable || event.original == namespace_bare_variable) *member = event.right;
  else if (event.original == namespace_declaration_end || event.original == namespace_enum) *member = declared_name(input, event.right.first);
  else return 0;
  return depth == 1 ? 1 : 2;
}

/* Whether every occurrence of a name in a range is a reference that the parser read as an expression. */
static bool only_references(namespace_scope *scope, TmtPulseMemory_tape input, uint32_t first, uint32_t last, TmtGrammar_span name) {
  const uint32_t words = word_count(input, first, last, name);
  return words == 0 || (read_references(scope, input.size) && words == reference_count(scope, input, first, last, name));
}

/*
 * Walks the other declarations of a namespace: the heads of its name at the top of the file. Two declarations
 * share the members they export, and TypeScript writes a reference from one body to a member of the other as
 * a property of the namespace. With `body_last` set, this checks a body: a member may be named in it only by
 * references, and a name that only a namespace inside shares, down to the names of a dotted head, not at all.
 * Otherwise it looks for a member of the name `wanted` and says whether there is one.
 */
static bool walk_siblings(namespace_scope *scope, TmtPulseMemory_tape input, uint32_t self, TmtGrammar_span name,
  uint32_t body_first, uint32_t body_last, TmtGrammar_span wanted)
{
  const bool checking = body_last != 0;
  uint32_t depth = 0, joined = 0;
  bool sibling = false;
  for (uint32_t index = 0; index < scope->records; index++) {
    const TmtGrammar_candidate event = input.output[index];
    if (event.original == namespace_end) {
      if (depth != 0 && --depth == 0) joined = 0;
      continue;
    }
    const bool head = opens_namespace(event.original);
    if (head && depth == 0) {
      /* An exported declaration and one that is not exported do not share their members. */
      sibling = index != self && same_name(input, event.right, name) &&
        exported_head(input, event) == exported_head(input, input.output[self]);
      depth = 1;
      if (!sibling) continue;
      /* The names behind the first of a dotted head: the second is a member, the others lie deeper. */
      for (TmtGrammar_span part = dotted_part(input, event, event.right.last); part.first != part.last; part = dotted_part(input, event, part.last)) {
        if (!plain_name(input, part)) { if (checking) return false; break; }
        if (checking) {
          if (joined == 0 ? !only_references(scope, input, body_first, body_last, part) : word_count(input, body_first, body_last, part) != 0) return false;
        } else if (joined == 0 && same_name(input, part, wanted)) return true;
        joined++;
      }
      continue;
    }
    if (depth == 0 || !sibling) { if (head) depth++; continue; }
    TmtGrammar_span member;
    const int kind = sibling_member(input, event, depth + joined, &member);
    if (head) {
      /* The further names of a dotted head inside lie deeper still. */
      if (checking) {
        for (TmtGrammar_span part = dotted_part(input, event, event.right.last); part.first != part.last; part = dotted_part(input, event, part.last)) {
          if (!plain_name(input, part) || word_count(input, body_first, body_last, part) != 0) return false;
        }
      }
      depth++;
    }
    if (kind == 0) continue;
    if (!plain_name(input, member)) { if (checking) return false; continue; }
    if (checking) {
      if (kind == 1 ? !only_references(scope, input, body_first, body_last, member) : word_count(input, body_first, body_last, member) != 0) return false;
    } else if (kind == 1 && same_name(input, member, wanted)) return true;
  }
  return checking;
}

/*
 * Writes the text TypeScript gives a namespace: var N;(function (N) { ... })(N||(N={}));
 * and for a namespace inside another: let M;(function (M) { ... })(M=N.M||(N.M={})); when it is exported,
 * let M;(function (M) { ... })(M||(M={})); when it is not.
 * An exported variable is written as a property of its namespace. If its name stood anywhere else in the body,
 * that reference would need the namespace in front of it as well, so such a namespace is declined. The
 * namespace's own name may stand in its body only in front of a dot: any other use may be a declaration, for
 * which TypeScript renames the parameter.
 */
static bool emit_namespace_record(lowering *lower, uint32_t records, uint32_t index, namespace_scope *scope) {
  const TmtPulseMemory_tape input = lower->input;
  const TmtGrammar_candidate event = input.output[index];
  const TmtGrammar_span span = event.left;
  if (opens_namespace(event.original)) {
    const TmtGrammar_span name = event.right;
    const bool merged = event.original == namespace_head_merged;
    if (scope->depth == 8 || !plain_name(input, name) || (merged && scope->depth != 0)) return false;
    /* A dotted name: the further names follow the first, each behind a dot, up to the brace. */
    TmtGrammar_span further[6];
    uint32_t dotted = 0, head_at = name.last;
    while (head_at < span.last && input.source[head_at] == '.') {
      TmtGrammar_span part = { head_at + 1, head_at + 1 };
      while (part.last < span.last && input.source[part.last] < 128 && TmtGrammar_identifier_continue(input.source[part.last])) part.last++;
      if (dotted == 6 || scope->depth + dotted + 1 >= 8 || !plain_name(input, part)) return false;
      further[dotted++] = part;
      head_at = part.last;
    }
    while (head_at < span.last && (input.source[head_at] == ' ' || input.source[head_at] == '\t' || input.source[head_at] == '\n' || input.source[head_at] == '\r')) head_at++;
    if (head_at + 1 != span.last || input.source[head_at] != '{') return false;
    /*
     * A namespace is a variable in the body of the one around it, whose parameter bears that one's name, and
     * a reference inside is written with the name of the namespace that owns the member. For a namespace
     * named like one around it TypeScript renames a parameter.
     */
    for (uint32_t outer = 0; outer < scope->depth; outer++) {
      if (same_name(input, scope->names[outer], name)) return false;
      for (uint32_t part = 0; part < dotted; part++) if (same_name(input, scope->names[outer], further[part])) return false;
    }
    for (uint32_t part = 0; part < dotted; part++) {
      if (same_name(input, name, further[part])) return false;
      for (uint32_t earlier = 0; earlier < part; earlier++) if (same_name(input, further[earlier], further[part])) return false;
    }
    /* The end of this namespace, behind the namespaces inside it. */
    uint32_t tail = index + 1, inner = 0;
    while (tail < records && (inner != 0 || input.output[tail].original != namespace_end)) {
      if (opens_namespace(input.output[tail].original)) inner++;
      else if (input.output[tail].original == namespace_end) inner--;
      tail++;
    }
    if (tail == records) return false;
    const uint32_t body_last = input.output[tail].left.first;
    if (body_last < span.last || !only_qualified(scope, input, span.last, body_last, name)) return false;
    for (uint32_t part = 0; part < dotted; part++) if (!only_qualified(scope, input, span.last, body_last, further[part])) return false;
    /* The search for references reads bytes. A character outside ASCII may be a line separator or part of a name. */
    for (uint32_t at = span.last; at < body_last; at++) if (input.source[at] >= 128) return false;
    /* The variables this namespace exports itself; those of a namespace inside are checked with that one. */
    inner = 0;
    for (uint32_t member = index + 1; member < tail; member++) {
      const uint32_t kind = input.output[member].original;
      if (opens_namespace(kind)) { inner++; continue; }
      if (kind == namespace_end) { inner--; continue; }
      if (inner != 0 || (kind != namespace_variable && kind != namespace_bare_variable)) continue;
      const TmtGrammar_span variable = input.output[member].right;
      if (!plain_name(input, variable)) return false;
      /*
       * Every other occurrence of the name has to be a reference that the parser read as an expression: then
       * none of them is a declaration that hides the variable, a key, a label or a word of a string, and each
       * is written with the namespace in front of it.
       */
      uint32_t words = word_count(input, span.last, body_last, variable);
      /*
       * The name of an enum member is no occurrence of the variable: `Ready` as a member of `Type` beside
       * `export const Ready` is the common form. Only a word where a member's name stands is left out, behind
       * the opening brace or a comma; a value that names the variable still counts and declines the namespace.
       */
      for (uint32_t other = index + 1; other < tail && words > 1; other++) {
        const TmtGrammar_candidate inside = input.output[other];
        if (inside.original != namespace_enum && inside.original != local_enum) continue;
        if (inside.left.first < span.last || inside.left.last > body_last) continue;
        uint32_t brace = inside.left.first;
        while (brace < inside.left.last && input.source[brace] != '{') brace++;
        const uint32_t width = variable.last - variable.first;
        for (uint32_t at = brace + 1; at + width <= inside.left.last && words > 1; at++) {
          if (memcmp(input.source + at, input.source + variable.first, width)) continue;
          if (input.source[at - 1] >= 128 || TmtGrammar_identifier_continue(input.source[at - 1]) || input.source[at - 1] == '.') continue;
          if (at + width < inside.left.last && (input.source[at + width] >= 128 || TmtGrammar_identifier_continue(input.source[at + width]))) continue;
          uint32_t before = at;
          while (before > brace && (input.source[before - 1] == ' ' || input.source[before - 1] == '\t' || input.source[before - 1] == '\n' || input.source[before - 1] == '\r')) before--;
          if (input.source[before - 1] == '{' || input.source[before - 1] == ',') words--;
        }
      }
      if (words != 1 && (!read_references(scope, input.size) ||
          words != 1 + reference_count(scope, input, span.last, body_last, variable))) return false;
    }
    const bool exported = input.size - span.first > 6 && !memcmp(input.source + span.first, "export", 6);
    /*
     * A namespace of this name elsewhere in the file shares its exported members with this one, and TypeScript
     * writes a reference to such a member as a property. That is not done here: no member that another
     * declaration of the namespace exports may be named in this body.
     */
    if (scope->depth == 0) {
      scope->records = records;
      scope->top = index;
      /* A declared namespace of the name is erased, and its members are not known here. */
      /* The text of an erased statement stands in the source as written, not in its projection. */
      TmtPulseMemory_tape written = input;
      if (scope->original) written.source = scope->original;
      if (erased_namespace(written, records, name)) return false;
      if (!walk_siblings(scope, input, index, name, span.last, body_last, name)) return false;
    }
    if (merged) {
      /* The name is declared already. A semicolon keeps the function from being read as arguments of what precedes it. */
      put(&lower->output, ";(function (");
    } else {
      put(&lower->output, scope->depth != 0 ? "let " : exported ? "export var " : "var ");
      put_name(lower, name);
      put(&lower->output, ";(function (");
    }
    put_name(lower, name);
    put(&lower->output, ") {");
    scope->names[scope->depth] = name;
    scope->exported[scope->depth] = scope->depth != 0 && exported;
    scope->joined[scope->depth] = false;
    /* The members belong to the last name of a dotted head. */
    scope->first_member[scope->depth] = dotted != 0 ? tail : index + 1;
    scope->last_member[scope->depth] = tail;
    scope->depth++;
    /* TypeScript declares the further names of a dotted head as it declares the first: var at the top, let inside. */
    const bool top = scope->depth == 1;
    for (uint32_t part = 0; part < dotted; part++) {
      put(&lower->output, top ? "var " : "let ");
      put_name(lower, further[part]);
      put(&lower->output, ";(function (");
      put_name(lower, further[part]);
      put(&lower->output, ") {");
      scope->names[scope->depth] = further[part];
      scope->exported[scope->depth] = true;
      scope->joined[scope->depth] = true;
      scope->first_member[scope->depth] = part + 1 == dotted ? index + 1 : tail;
      scope->last_member[scope->depth] = tail;
      scope->depth++;
    }
    return !lower->output.failed;
  }
  if (scope->depth == 0) return false;
  const TmtGrammar_span owner = scope->names[scope->depth - 1];
  if (event.original == namespace_variable) {
    /* The variable needs a value: `export let c;` declares nothing that TypeScript would write. */
    uint32_t at = event.right.last;
    while (at < input.size && (input.source[at] == ' ' || input.source[at] == '\t' || input.source[at] == '\n' || input.source[at] == '\r')) at++;
    if (at + 1 >= input.size || input.source[at] != '=' || input.source[at + 1] == '=' || input.source[at + 1] == '>') return false;
    put_name(lower, owner);
    put(&lower->output, ".");
    return !lower->output.failed;
  }
  if (event.original == namespace_declaration) return true;
  if (event.original == namespace_bare_variable) {
    /* The statement goes, its end stays: the statement before it may have none of its own. */
    put(&lower->output, ";");
    return !lower->output.failed;
  }
  if (event.original == namespace_enum) {
    const uint32_t size = lower->input.size;
    lower->input.size = span.last;
    const TmtPulseCompiler_runtime_head head = TmtPulseCompiler_read_runtime_head(lower->input, event.right.first, false, true, true);
    lower->at = head.body;
    lower->owner = owner;
    const bool emitted = head.kind == 3 && head.declaration == event.right.first && head.body < span.last &&
      emit_enum(lower, head.name_span, false, true) && lower->at == span.last;
    lower->owner = (TmtGrammar_span){ 0, 0 };
    lower->input.size = size;
    return emitted;
  }
  if (event.original == namespace_declaration_end) {
    if (input.source[span.first] != '}') return false;
    const TmtGrammar_span name = declared_name(input, event.right.first);
    if (!plain_name(input, name)) return false;
    put(&lower->output, "}");
    put_name(lower, owner);
    put(&lower->output, ".");
    put_name(lower, name);
    put(&lower->output, "=");
    put_name(lower, name);
    put(&lower->output, ";");
    return !lower->output.failed;
  }
  /* The end of the namespace, and of those its head opened with it. */
  if (input.source[span.first] != '}') return false;
  for (bool more = true; more;) {
    scope->depth--;
    const TmtGrammar_span closing = scope->names[scope->depth];
    more = scope->joined[scope->depth];
    put(&lower->output, "})(");
    if (scope->exported[scope->depth]) {
      const TmtGrammar_span parent = scope->names[scope->depth - 1];
      put_name(lower, closing);
      put(&lower->output, "=");
      put_name(lower, parent);
      put(&lower->output, ".");
      put_name(lower, closing);
      put(&lower->output, "||(");
      put_name(lower, parent);
      put(&lower->output, ".");
      put_name(lower, closing);
      put(&lower->output, "={}));");
    } else {
      put_name(lower, closing);
      put(&lower->output, "||(");
      put_name(lower, closing);
      put(&lower->output, "={}));");
    }
  }
  return !lower->output.failed;
}

/* An export assignment is written only where the output may be CommonJS. */
static char *lower_recorded_enums(TmtPulseMemory_tape input, uint8_t *original, bool module, uint32_t records, bool commonjs,
  size_t *length, tmt_run_log *runs)
{
  lowering lower = { .input = input, .output.limit = (size_t)input.size * 32 + 1024, .output.runs = runs,
    .whole = original, .whole_size = input.size };
  uint32_t copied = 0;
  namespace_scope scope = { .depth = 0, .original = original, .module = module };
  for (uint32_t index = 0; index < records; index++) {
    if (!enum_record(input.output[index].original)) continue;
    const TmtGrammar_span span = input.output[index].left;
    if (span.first < copied || span.first >= span.last || span.last > input.size) goto decline;
    if (input.output[index].original == export_assignment) {
      if (!commonjs) goto decline;
      namespace_bytes(&lower, &scope, copied, span.first);
      put(&lower.output, "module.exports =");
      copied = span.last;
      continue;
    }
    if (input.output[index].original == import_require || input.output[index].original == import_alias) {
      /* require() exists only where the output may be CommonJS; an alias is an ordinary variable. */
      if (input.output[index].original == import_require && !commonjs) goto decline;
      namespace_bytes(&lower, &scope, copied, span.first);
      put(&lower.output, input.output[index].original == import_require ? "const" : "var");
      copied = span.last;
      continue;
    }
    namespace_bytes(&lower, &scope, copied, span.first);
    if (namespace_record(input.output[index].original)) {
      if (!emit_namespace_record(&lower, records, index, &scope)) goto decline;
      copied = span.last;
      continue;
    }
    if (!emit_recorded_enum(&lower, span, input.output[index].original)) goto decline;
    copied = span.last;
  }
  free(scope.references);
  scope.references = NULL;
  if (!copied) return NULL;
  lower.input.size = input.size;
  source_bytes(&lower, copied, input.size);
  if (lower.output.failed || scope.depth != 0) goto decline;
  *length = lower.output.length;
  return lower.output.code;
decline:
  /* A log without its output would describe another buffer. */
  if (runs) runs->failed = true;
  free(scope.references);
  free(lower.output.code);
  return NULL;
}

static bool retained_module_marker(TmtPulseMemory_tape input, uint32_t at, uint32_t records) {
  if (module_marker_at(input, at, false)) return true;
  for (uint32_t index = 0; index < records; index++) {
    const TmtGrammar_candidate event = input.output[index];
    if (event.original != erased_type_statement || at < event.left.first || at >= event.left.last) continue;
    const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, event.left.last);
    if (!tail.ok || tail.at >= input.size) return false;
    at = tail.at;
    if (module_marker_at(input, at, false)) return true;
  }
  return false;
}

static char *erase_annotation_records(TmtPulseMemory_tape input, uint32_t records, uint32_t marker, tmt_enum_hint enums, bool esm, bool module,
  size_t *length, bool *complete, tmt_run_log *runs)
{
  char *code = NULL;
  projection_facts facts;
  if (!blank_type_records(input, records, &code, true, &facts)) goto enum_only;
  TmtPulseMemory_tape projected = input;
  if (code) projected.source = (uint8_t *)code;
  if (module) audit_projection_guard(projected, records, "ts");
  *length = input.size;
  const bool needs_module_marker = code && esm && facts.remove_statement && !retained_module_marker(projected, marker, records);
  bool unlowered_enum = facts.runtime_enums;
  if (facts.export_assigned && (esm || !module)) goto enum_only;
  if (facts.properties) {
    if (facts.local_enums) goto enum_only;
    /* One pass inserts the property statements and lowers the enums between them. */
    char *lowered = emit_parameter_properties(input, code, records, facts.properties, facts.runtime_enums, module, length, runs);
    if (!lowered) goto enum_only;
    free(code);
    code = lowered;
    unlowered_enum = false;
  } else if (enums != TMT_ENUMS_ABSENT) {
    /* A committed enum record implies the word, so an unknown hint needs no scan here. */
    char *lowered = lower_recorded_enums(projected, input.source, module, records, module && !esm, length, runs);
    if (lowered) {
      free(code);
      code = lowered;
      unlowered_enum = false;
    }
  }
  /* JavaScript reserves enum, so a module that keeps a declaration can never validate. */
  if (unlowered_enum && module) goto enum_only;
  if (*length > 1048576) goto enum_only;
  if (needs_module_marker && !tmt_module_marker((uint8_t *)code, (uint32_t)*length, false)) {
    char *with_marker = realloc(code, *length + sizeof(esm_marker));
    if (!with_marker) goto enum_only;
    code = with_marker;
    /* The marker follows a projection of the whole source unless a lowering already logged its copies. */
    if (runs && !runs->count && *length == input.size) log_run(runs, 0, 0, input.size);
    memcpy(code + *length, esm_marker, sizeof(esm_marker) - 1);
    *length += sizeof(esm_marker) - 1;
  }
  const bool certified = !facts.uncertified;
  if (module && !publishable(certified, code ? code : (const char *)input.source, *length, "ts")) goto enum_only;
  if (!code) {
    code = malloc(*length);
    if (!code) return NULL;
    memcpy(code, input.source, *length);
  }
  *complete = true;
  return code;
enum_only:
  free(code);
  if (runs) runs->failed = true;
  /*
   * This text still holds its types and goes on to another eraser, which decides by the words import and export
   * whether it is a module. A require call or module.exports written here would hide that, so they are not.
   */
  return enums != TMT_ENUMS_ABSENT ? lower_recorded_enums(input, input.source, module, records, false, length, NULL) : NULL;
}
#endif

/*
 * The places of legacy decorators in a module: five numbers per record, the kind (50 decorator, 51 class head, 60 the head of a class below module level,
 * 52 member, 53 parameter, 54 class end, 55 and 56 the body of any class) and the two spans the parser wrote. NULL when the parser does not take
 * the source. The caller rewrites the source from them and compiles the result.
 */
/* Kind 21 is a class member that is erased whole; a class rewritten as an expression must lose it in the source. */
/* Kind 36, the `export` of a declaration in a namespace body, tells the lowering that a namespace takes the class. */
static bool legacy_record(uint32_t kind) {
  /* Type arguments, type parameter lists and implements clauses: what of a class's head is erased. */
  return (kind >= 50 && kind <= 56) || kind == 60 || kind == 64 || kind == 65 || kind == 21 || kind == namespace_declaration ||
    kind == type_arguments || kind == class_implements || kind == 59;
}

/* With all set, every record of the reading is returned: the metadata of the decorators is written from type records too. */
uint32_t *tmt_legacy_decorator_records(uint8_t *source, uint32_t size, bool all, bool jsx, uint32_t *count) {
  *count = 0;
#ifdef TMT_V8_VALIDATOR
  module_workspace memory = {0};
  TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  input.capacity = size / 2 + 64;
  TmtGrammar_candidate *records = malloc(input.capacity * sizeof(*records));
  uint8_t *marks = calloc(input.capacity, sizeof(*marks));
  uint32_t *found = NULL;
  if (records && marks) {
    input.output = records;
    input.marks = marks;
    input.capture_types = true;
    input.count_only = false;
    input.legacy_decorators = true;
    const TmtPulseParser_parser_state parsed = TmtPulseParser_parse(input, jsx, true);
    if (parsed.status == 0 && parsed.count <= input.capacity) {
      /* The names bound at module level stand in the first region of the binding table. */
      const uint32_t region = 512;
      uint32_t kept = 0;
      for (uint32_t index = 0; index < parsed.count; index++) kept += all || legacy_record(records[index].original);
      found = malloc((kept + (all ? region : 0) + 1) * 5 * sizeof(*found));
      if (found) {
        for (uint32_t index = 0; index < parsed.count; index++) {
          const TmtGrammar_candidate entry = records[index];
          if (!all && !legacy_record(entry.original)) continue;
          uint32_t *row = found + 5 * (*count)++;
          row[0] = entry.original; row[1] = entry.left.first; row[2] = entry.left.last;
          row[3] = entry.right.first; row[4] = entry.right.last;
        }
        /*
         * Kind 61: a name of the module and what declares it, for the metadata of the decorators:
         * 1 a class, 2 an interface, 3 a type-only import, 4 an import or another name with both meanings,
         * 5 a value, 9 anything else.
         */
        for (uint32_t index = 0; all && index < region; index++) {
          const TmtPulseMemory_binding_name name = memory.bindings[index];
          if (name.span.first >= name.span.last || name.span.last > size) continue;
          uint32_t *row = found + 5 * (*count)++;
          row[0] = 61; row[1] = name.span.first; row[2] = name.span.last; row[4] = 0;
          switch (name.namespace0) {
            case TmtPulseMemory_ClassName: row[3] = 1; break;
            case TmtPulseMemory_InterfaceName: case TmtPulseMemory_ExportedInterfaceName: row[3] = 2; break;
            case TmtPulseMemory_TypeOnlyImport: row[3] = 3; break;
            case TmtPulseMemory_BothNames: case TmtPulseMemory_EnumName: row[3] = 4; break;
            case TmtPulseMemory_ValueName: case TmtPulseMemory_LocalVarName: case TmtPulseMemory_FunctionImplementation: row[3] = 5; break;
            default: row[3] = 9; break;
          }
        }
      }
    }
  }
  free(records);
  free(marks);
  return found;
#else
  (void)source; (void)size;
  return NULL;
#endif
}

char *tmt_emit_annotated_module(uint8_t *source, uint32_t size, tmt_enum_hint enums, bool esm, bool allow_script,
  size_t *length, bool *checked, bool *complete, bool *script, tmt_parameter_route *property, tmt_run_log *runs)
{
  *checked = false;
  *complete = false;
  *script = false;
  if (runs) {
    runs->count = 0;
    runs->failed = false;
  }
  *property = TMT_PARAMETER_NONE;
#ifdef TMT_V8_VALIDATOR
  module_workspace memory = {0};
  TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok) return NULL;
  const uint32_t marker = find_marker(input, first.at, false);
  const bool module = marker < size;
  /* A script is read as strict code and published with the directive, so its enums are lowered like a module's. */
  if (!module && (!allow_script || first.at == size)) return NULL;
  if (!module && (source[first.at] == '"' || source[first.at] == '\'')) {
    /*
     * A leading string decides the mode of the script. Only the strict directive itself, closed by a semicolon,
     * is taken: the script is then published as written.
     */
    uint32_t at = first.at + 11;
    if (size - first.at < 13 || memcmp(source + first.at + 1, "use strict", 10) || source[first.at + 11] != source[first.at]) return NULL;
    for (at++; at < size && (source[at] == ' ' || source[at] == '\t'); at++) {}
    if (at >= size || source[at] != ';') return NULL;
  }
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
  const TmtPulseParser_parser_state parsed = TmtPulseParser_parse(input, false, module);
  /* From here on the records are read. Every later call into the parser counts without writing. */
  input.count_only = true;
  char *code = NULL;
  if (parsed.status == 0 && parsed.count <= input.capacity) {
    *checked = module;
    code = erase_annotation_records(input, parsed.count, marker, enums, esm, module, length, complete, runs);
    *script = !module && *complete;
    if (!code && module) {
      for (uint32_t index = 0; index < parsed.count; index++) {
        const TmtGrammar_candidate entry = input.output[index];
        if (entry.original != parameter_property) continue;
        const TmtGrammar_span parameter = { entry.left.first, entry.right.last };
        const TmtGrammar_candidate *constructor = property_constructor(input, parsed.count, parameter);
        if (!constructor || constructor->original == parameter_derived_constructor) {
          *property = TMT_PARAMETER_REFERENCE;
          break;
        }
        *property = TMT_PARAMETER_NODE;
      }
    }
  }
  free(records);
  free(marks);
  return code;
#else
  (void)source;
  (void)size;
  (void)enums;
  (void)esm;
  (void)allow_script;
  (void)length;
  (void)runs;
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

/* One line after its three slashes: a note without markup, or a reference with one known attribute and a quoted value. */
static bool plain_triple_slash_line(const uint8_t *line, uint32_t width) {
  uint32_t at = 0;
  if (!memchr(line, '<', width)) return true;
  while (at < width && line[at] == ' ') at++;
  if (width - at < 11 || memcmp(line + at, "<reference ", 11)) return false;
  at += 11;
  while (at < width && line[at] == ' ') at++;
  static const char *const names[] = { "types", "path", "lib" };
  uint32_t name = 0;
  for (; name < 3; name++) {
    const uint32_t length = (uint32_t)strlen(names[name]);
    if (width - at >= length && !memcmp(line + at, names[name], length)) { at += length; break; }
  }
  if (name == 3) return false;
  /* TypeScript allows spaces around the equals sign. */
  while (at < width && line[at] == ' ') at++;
  if (at >= width || line[at] != '=') return false;
  at++;
  while (at < width && line[at] == ' ') at++;
  if (at >= width || (line[at] != '"' && line[at] != '\'')) return false;
  const uint8_t quote = line[at++];
  const uint32_t value = at;
  while (at < width && line[at] != quote && line[at] != '<' && line[at] != '>' && line[at] >= 32 && line[at] < 127) at++;
  if (at == value || at >= width || line[at] != quote) return false;
  at++;
  while (at < width && line[at] == ' ') at++;
  if (width - at < 2 || line[at] != '/' || line[at + 1] != '>') return false;
  at += 2;
  while (at < width && (line[at] == ' ' || line[at] == '\t')) at++;
  return at == width;
}

/*
 * The triple-slash comments before the first token. TypeScript reports a malformed reference directive,
 * so only notes and well-formed references count as plain. Anything else, also a triple slash inside
 * another comment, leaves the decision to TypeScript.
 */
tmt_triple_slash_kind tmt_triple_slash(uint8_t *source, uint32_t size) {
  const TmtPulseMemory_tape input = { .source = source, .size = size };
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  const uint32_t limit = first.ok ? first.at : size;
  tmt_triple_slash_kind kind = TMT_TRIPLE_SLASH_ABSENT;
  uint32_t at = size >= 3 && source[0] == 0xEF && source[1] == 0xBB && source[2] == 0xBF ? 3 : 0;
  if (limit - at >= 2 && at < limit && source[at] == '#' && source[at + 1] == '!') {
    while (at < limit && source[at] != '\n' && source[at] != '\r') at++;
  }
  while (at < limit) {
    const uint8_t byte = source[at];
    if (byte == '/' && at + 1 < limit && source[at + 1] == '/') {
      uint32_t end = at;
      while (end < limit && source[end] != '\n' && source[end] != '\r') end++;
      if (end - at >= 3 && source[at + 2] == '/') {
        if (end - at >= 4 && source[at + 3] == '/') return TMT_TRIPLE_SLASH_OTHER;
        if (!plain_triple_slash_line(source + at + 3, end - at - 3)) return TMT_TRIPLE_SLASH_OTHER;
        kind = TMT_TRIPLE_SLASH_PLAIN;
      } else {
        for (uint32_t index = at + 2; index + 2 < end; index++) {
          if (source[index] == '/' && source[index + 1] == '/' && source[index + 2] == '/') return TMT_TRIPLE_SLASH_OTHER;
        }
      }
      at = end;
    } else if (byte == '/' && at + 1 < limit && source[at + 1] == '*') {
      uint32_t end = at + 2;
      while (end + 1 < limit && !(source[end] == '*' && source[end + 1] == '/')) end++;
      for (uint32_t index = at; index + 2 < end + 2 && index + 2 < limit; index++) {
        if (source[index] == '/' && source[index + 1] == '/' && source[index + 2] == '/') return TMT_TRIPLE_SLASH_OTHER;
      }
      at = end + 2;
    } else if (byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r' || byte == '\v' || byte == '\f') at++;
    else return tmt_leading_triple_slash(source, size) ? TMT_TRIPLE_SLASH_OTHER : kind;
  }
  return kind;
}

/* Equals a triple slash anywhere in the source and a leading directive, without scanning ordinary files. */
bool tmt_leading_triple_slash(uint8_t *source, uint32_t size) {
  const TmtPulseMemory_tape input = { .source = source, .size = size };
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  const uint32_t limit = first.ok ? first.at : size;
  for (uint32_t index = 0; index + 2 < limit; index++) {
    if (source[index] == '/' && source[index + 1] == '/' && source[index + 2] == '/') return true;
  }
  return false;
}

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
/*
 * Whether erasing types could change which strings are directives. TypeScript erases declarations and type-only
 * imports and exports first and then writes the helper import behind the directives that remain. A string
 * statement behind such an item would become a directive there and not here, and a leading string that is more
 * than a literal, as in "use client" as string, would become one here and not there. Both are declined.
 * The scan follows the items at the start of the file for as long as they could be erased.
 */
/* Whether a quote stands where a statement can start: at the start of the text, of a line, or behind `;` or `}`. */
static bool statement_string_possible(const uint8_t *source, uint32_t size, uint8_t quote) {
  for (const uint8_t *found = memchr(source, quote, size); found; ) {
    uint32_t at = (uint32_t)(found - source);
    uint32_t before = at;
    while (before && (source[before - 1] == ' ' || source[before - 1] == '\t')) before--;
    if (!before || source[before - 1] == '\n' || source[before - 1] == '\r' || source[before - 1] == ';' ||
        source[before - 1] == '}' || source[before - 1] == '/' || source[before - 1] >= 128) return true;
    found = at + 1 < size ? memchr(source + at + 1, quote, size - at - 1) : NULL;
  }
  return false;
}

static bool directives_depend_on_erasure(TmtPulseMemory_tape input, uint32_t first) {
  static const char *const erasable[] = { "import", "export", "interface", "type", "declare", "abstract", "enum", "namespace", "module" };
  bool prologue = true;
  for (uint32_t at = first, items = 0; at < input.size && items < 4096; items++) {
    const TmtPulseParser_cursor item = TmtPulseParser_trivia(input, at);
    if (!item.ok || item.at >= input.size) return false;
    const uint8_t byte = input.source[item.at];
    if (byte == '"' || byte == '\'') {
      if (!prologue) return true;
      /* A directive is a string literal that is the whole statement. */
      const TmtPulseParser_cursor literal = TmtPulseParser_string_end(input, item.at + 1, byte, input.size, false);
      if (!literal.ok) return true;
      const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, literal.at);
      if (!tail.ok) return true;
      const bool ends = tail.at >= input.size || input.source[tail.at] == ';' || tail.newline;
      if (!ends) return true;
    } else {
      prologue = false;
      bool may_vanish = false;
      for (size_t word = 0; word < sizeof(erasable) / sizeof(*erasable) && !may_vanish; word++) {
        const uint32_t width = (uint32_t)strlen(erasable[word]);
        may_vanish = input.size - item.at > width && !memcmp(input.source + item.at, erasable[word], width) &&
          !TmtGrammar_identifier_continue(input.source[item.at + width]);
      }
      /*
       * An import or export stays unless a word of an erasable declaration follows it: `import x from`,
       * `export const` and `export {` are the usual first items, and the scan ends at them without parsing.
       */
      if (may_vanish && (byte == 'i' || byte == 'e') && input.size - item.at > 6 &&
          (!memcmp(input.source + item.at, "import", 6) || !memcmp(input.source + item.at, "export", 6))) {
        const TmtPulseParser_cursor word = TmtPulseParser_trivia(input, item.at + 6);
        may_vanish = false;
        for (size_t next = 2; word.ok && next < sizeof(erasable) / sizeof(*erasable) && !may_vanish; next++) {
          const uint32_t width = (uint32_t)strlen(erasable[next]);
          may_vanish = input.size - word.at > width && !memcmp(input.source + word.at, erasable[next], width) &&
            !TmtGrammar_identifier_continue(input.source[word.at + width]);
        }
        /* `export import A = B.C` and an import-equals of a type are erasable too. */
        if (!may_vanish && word.ok && input.size - word.at > 6 && !memcmp(input.source + word.at, "import", 6)) may_vanish = true;
        if (!may_vanish && byte == 'i' && word.ok) {
          /* import A = ...: the name is followed by an equals sign. */
          uint32_t end = word.at;
          while (end < input.size && TmtGrammar_identifier_continue(input.source[end])) end++;
          const TmtPulseParser_cursor after = TmtPulseParser_trivia(input, end);
          may_vanish = after.ok && after.at < input.size && input.source[after.at] == '=';
        }
      }
      /* Behind an item that stays, no later string can become a directive. */
      if (!may_vanish) return false;
    }
    /* Going on parses the item again, so it is done only for a source that could hold such a string at all. */
    if (!items && !statement_string_possible(input.source, input.size, '"') &&
        !statement_string_possible(input.source, input.size, '\'')) return false;
    const uint32_t next = TmtPulseCompiler_next_module_item(input, true, item.at);
    if (next <= item.at) return false;
    at = next;
  }
  return false;
}

static char *lower_mixed(uint8_t *source, uint32_t size, bool jsx, bool classic, size_t *length, tmt_run_log *runs) {
  module_workspace memory = {0};
  const TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok || !TmtPulseCompiler_supported_module(input, jsx)) return NULL;
  const uint32_t marker = find_marker(input, first.at, jsx);
  if (marker == size) return NULL;
  if (jsx && directives_depend_on_erasure(input, first.at)) return NULL;
  if (runs) runs->count = 0;
  lowering lower = { .input = input, .classic = classic, .mixed = true, .output.limit = (size_t)size * 32 + 1024,
    .output.runs = runs, .whole = source, .whole_size = size };
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
      const bool emitted = head.kind == 1 || head.kind == 3 ? emit_enum(&lower, head.name_span, head.kind == 1, false) :
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
    /* Without a semicolon the directive ends at its closing quote. */
    if (!(semicolon ? boundary == tail.at + 1 : tail.newline && boundary == string.at)) break;
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
    if (!enum_record(event.original)) {
      (*index)++;
      continue;
    }
    const TmtGrammar_span span = event.left;
    if (span.first >= last) break;
    if (span.first < first || span.last > last || !source_jsx(lower, first, span.first, 32) ||
        !emit_recorded_enum(lower, span, event.original)) return false;
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
  uint32_t enum_records, tmt_run_log *runs)
{
  /* Each attempt starts its own log. */
  if (runs) runs->count = 0;
  lowering lower = { .input = input, .classic = classic, .jsx_spans = tags, .jsx_count = tag_count,
    .expressions = expressions, .expression_count = expression_count,
    .output.limit = (size_t)input.size * 32 + 1024, .output.runs = runs };
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

#ifdef TMT_AUDIT_V8
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
    if (kind != 0 && kind != 5 && kind != lexical_text && !enum_record(kind)) continue;
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
  uint32_t insertion, bool typescript, bool classic, size_t *length, bool *complete, tmt_run_log *runs)
{
  size_t elements = 0, expression_begin = records;
#ifdef TMT_V8_VALIDATOR
  uint32_t enum_records = 0;
#endif
  for (uint32_t index = 0; index < records; index++) {
    if (input.output[index].original == 0) spans[elements++] = input.output[index].left;
    else if (input.output[index].original == 5) spans[--expression_begin] = input.output[index].left;
#ifdef TMT_V8_VALIDATOR
    else if (enum_record(input.output[index].original)) enum_records = records;
#endif
  }
  const size_t expression_count = records - expression_begin;
  TmtGrammar_span *expressions = spans + expression_begin;
  qsort(spans, elements, sizeof(*spans), compare_spans);
  qsort(expressions, expression_count, sizeof(*spans), compare_spans);
#ifdef TMT_V8_VALIDATOR
  if (!typescript) {
    char *code = render_jsx_spans(input, spans, elements, expressions, expression_count, insertion, classic, length, 0, runs);
    if (code && validate_emission(code, *length, "jsx")) {
      *complete = true;
      return code;
    }
    free(code);
    return NULL;
  }
  if (input.capture_types) {
    char *masked;
    projection_facts facts;
    if (blank_type_records(input, records, &masked, false, &facts)) {
      TmtPulseMemory_tape projected = input;
      if (masked) projected.source = (uint8_t *)masked;
      {
        audit_projection_guard(projected, records, "tsx");
        char *code = render_jsx_spans(projected, spans, elements, expressions, expression_count, insertion, classic, length, enum_records, runs);
        if (code && (!facts.remove_statement || retained_module_marker(projected, insertion, records) ||
                     (*length <= 1048576 && tmt_module_marker((uint8_t *)code, (uint32_t)*length, false))) &&
            publishable(!facts.uncertified, code, *length, "tsx")) {
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
  return render_jsx_spans(input, spans, elements, expressions, expression_count, insertion, classic, length, 0, runs);
}

static char *lower_jsx_module(uint8_t *source, uint32_t size, bool typescript, bool classic, size_t *length, bool *complete,
  tmt_run_log *runs)
{
  module_workspace memory = {0};
  TmtPulseMemory_tape input = with_workspace(source, size, &memory);
  const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(input);
  if (!first.ok) return NULL;
  const uint32_t marker = find_marker(input, first.at, true);
  const bool module = marker < size;
  if (!typescript && !module) return NULL;
#ifndef TMT_DIRECT
  if (typescript && module && directives_depend_on_erasure(input, first.at)) return NULL;
#endif
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
      return render_jsx_module(input, spans, small.count, insertion, typescript, classic, length, complete, runs);
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
      result = render_jsx_module(input, spans, parsed.count, insertion, typescript, classic, length, complete, runs);
    }
  }
  free(input.output);
  free(input.marks);
  free(spans);
  return result;
}

#endif

char *tmt_lower_runtime(uint8_t *source, uint32_t size, bool jsx, bool typescript, bool classic,
  bool mixed, size_t *length, bool *complete, tmt_run_log *runs)
{
  *complete = false;
  if (runs) {
    runs->count = 0;
    runs->failed = false;
  }
  if (!size) return NULL;
  if (mixed) {
#ifdef TMT_DIRECT
    return NULL;
#else
    if (jsx) {
      char *general = lower_jsx_module(source, size, typescript, classic, length, complete, runs);
      if (general || !typescript) return general;
    }
    return lower_mixed(source, size, jsx, classic, length, runs);
#endif
  }
  return lower_one(source, size, jsx, typescript, classic, length, runs);
}
