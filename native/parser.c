#include <stddef.h>
#include <string.h>

#include "parser.h"
#include "TmtScan.h"

typedef TmtGrammar_span span;

typedef struct {
  const uint8_t *source;
  uint32_t size;
  uint32_t pos;
  uint32_t depth;
  int tsx;
  TmtGrammar_candidate *output;
  uint32_t capacity;
  tmt_result result;
} parser;

static uint8_t at(const parser *p, uint32_t pos) {
  return TmtScan_peek(p->source, p->size, pos);
}

static uint8_t current(const parser *p) {
  return at(p, p->pos);
}

static int fail(parser *p, tmt_status reason) {
  if (p->result.status == TMT_DONE) p->result.status = reason;
  return 0;
}

static int require(parser *p, uint8_t byte) {
  if (p->pos >= p->size || current(p) != byte) return fail(p, TMT_UNSUPPORTED);
  p->pos++;
  return 1;
}

static int line_break(const parser *p, uint32_t pos) {
  uint8_t ch = at(p, pos);
  return ch == '\r' || ch == '\n' ||
         (ch == 0xe2 && at(p, pos + 1) == 0x80 &&
          (at(p, pos + 2) == 0xa8 || at(p, pos + 2) == 0xa9));
}

static void tag_space(parser *p) {
  p->pos = TmtScan_scan_class(p->source, p->size, p->pos, TmtGrammar_Space);
}

static int trivia(parser *p, int *newline) {
  int seen = 0;
  for (;;) {
    uint8_t ch = current(p);
    if (TmtGrammar_whitespace(ch)) {
      seen |= line_break(p, p->pos);
      p->pos++;
    } else if (ch == '/' && at(p, p->pos + 1) == '/') {
      p->pos += 2;
      while (p->pos < p->size && !line_break(p, p->pos)) {
        if (current(p) >= 0x80) return fail(p, TMT_UNSUPPORTED);
        p->pos++;
      }
    } else if (ch == '/' && at(p, p->pos + 1) == '*') {
      p->pos += 2;
      while (p->pos < p->size && !(current(p) == '*' && at(p, p->pos + 1) == '/')) {
        seen |= line_break(p, p->pos);
        p->pos++;
      }
      if (p->pos == p->size) return fail(p, TMT_UNSUPPORTED);
      p->pos += 2;
    } else {
      if (newline) *newline = seen;
      return 1;
    }
  }
}

static int spelling(const parser *p, uint32_t start, uint32_t end, const char *text) {
  size_t n = strlen(text);
  return end - start == n && memcmp(p->source + start, text, n) == 0;
}

static int keyword(parser *p, const char *word) {
  size_t len = strlen(word);
  if (len > p->size - p->pos || memcmp(p->source + p->pos, word, len) ||
      TmtGrammar_identifier_continue(at(p, p->pos + (uint32_t)len))) return 0;
  p->pos += (uint32_t)len;
  return 1;
}

typedef enum { EXPRESSION_NAME, BINDING_NAME, JSX_NAME } name_context;

static int name(parser *p, name_context context) {
  static const char *const reserved[] = {
    "await", "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
    "for", "function", "if", "implements", "import", "in", "instanceof", "interface", "let",
    "new", "null", "package", "private", "protected", "public", "return", "static", "super",
    "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield"
  };
  uint32_t start = p->pos;
  if (!TmtGrammar_identifier_start(current(p))) return fail(p, TMT_UNSUPPORTED);
  p->pos = TmtScan_scan_class(p->source, p->size, p->pos, TmtGrammar_Identifier);
  if (context == JSX_NAME) return 1;
  if (context == BINDING_NAME &&
      (spelling(p, start, p->pos, "eval") || spelling(p, start, p->pos, "arguments"))) return fail(p, TMT_UNSUPPORTED);
  for (size_t i = 0; i < sizeof reserved / sizeof *reserved; i++) {
    if (spelling(p, start, p->pos, reserved[i])) return fail(p, TMT_UNSUPPORTED);
  }
  return 1;
}

static int comparison(parser *p, span *range);

static int atom(parser *p, span *range) {
  if (!trivia(p, NULL)) return 0;
  range->first = p->pos;
  uint8_t ch = current(p);
  if (ch == '(') {
    if (p->depth == 64) return fail(p, TMT_DEPTH_LIMIT);
    p->depth++;
    if (p->depth > p->result.max_depth) p->result.max_depth = p->depth;
    p->pos++;
    span contents;
    if (!comparison(p, &contents) || !trivia(p, NULL) || !require(p, ')')) return 0;
    p->depth--;
  } else if (TmtGrammar_decimal_digit(ch)) {
    p->pos = TmtScan_scan_class(p->source, p->size, p->pos, TmtGrammar_DecimalDigits);
    if (ch == '0' && p->pos - range->first > 1) return fail(p, TMT_UNSUPPORTED);
  } else if (!name(p, EXPRESSION_NAME)) {
    return 0;
  }
  range->last = p->pos;
  return 1;
}

static int comparison(parser *p, span *range) {
  span left;
  if (!atom(p, &left) || !trivia(p, NULL)) return 0;
  *range = left;
  uint32_t op = TmtScan_source_boundary(p->source, p->size, p->pos);
  if (!op) return 1;
  if (p->result.count == p->capacity) return fail(p, TMT_CANDIDATE_LIMIT);
  uint32_t slot = p->result.count++;
  span edit = { p->pos, p->pos + ((op == 2 || op == 4) ? 2u : 1u) };
  p->pos = edit.last;
  span right;
  if (!atom(p, &right)) return 0;
  range->last = right.last;
  TmtScan_save_candidate(p->output, p->capacity, slot, TmtGrammar_make_candidate(op, edit, left, right));
  return 1;
}

static int element(parser *p) {
  if (!require(p, '<') || !name(p, JSX_NAME)) return 0;
  for (;;) {
    uint32_t before = p->pos;
    tag_space(p);
    if (current(p) == '/') return require(p, '/') && require(p, '>');
    if (before == p->pos || !name(p, JSX_NAME)) return fail(p, TMT_UNSUPPORTED);
    tag_space(p);
    if (!require(p, '=')) return 0;
    tag_space(p);
    uint8_t opener = current(p);
    if (opener == '"' || opener == '\'') {
      p->pos++;
      while (p->pos < p->size && current(p) != opener) p->pos++;
      if (!require(p, opener)) return 0;
    } else {
      span ignored;
      if (!require(p, '{') || !comparison(p, &ignored) || !trivia(p, NULL) || !require(p, '}')) return 0;
    }
  }
}

static int result(parser *p) {
  if (!trivia(p, NULL)) return 0;
  if (p->tsx && current(p) == '<') return element(p);
  span ignored;
  return comparison(p, &ignored);
}

static int initializer(parser *p) {
  if (!trivia(p, NULL)) return 0;
  if (current(p) != '(') return result(p);
  uint32_t start = p->pos++;
  if (trivia(p, NULL) && name(p, BINDING_NAME) && trivia(p, NULL) && current(p) == ':') {
    int newline = 0;
    p->pos++;
    if (!trivia(p, NULL) || !keyword(p, "number") || !trivia(p, NULL) || !require(p, ')') ||
        !trivia(p, &newline) || newline || !require(p, '=') || !require(p, '>')) return fail(p, TMT_UNSUPPORTED);
    return result(p);
  }
  p->pos = start;
  p->result.status = TMT_DONE;
  return result(p);
}

tmt_result tmt_parse(const uint8_t *source, uint32_t size, int tsx, int module,
                     TmtGrammar_candidate *output, uint32_t capacity) {
  if (size > TMT_SOURCE_MAX) return (tmt_result){ TMT_SOURCE_LIMIT, 0, 0 };
  parser p = { .source = source, .size = size, .tsx = tsx, .output = output, .capacity = capacity };
  if (!trivia(&p, NULL)) goto finish;
  if (p.pos == p.size) goto finish;
  if (keyword(&p, "export") && (!module || !trivia(&p, NULL))) {
    fail(&p, TMT_UNSUPPORTED);
    goto finish;
  }
  if (!keyword(&p, "const") || !trivia(&p, NULL) || !name(&p, BINDING_NAME) || !trivia(&p, NULL) ||
      !require(&p, '=') || !initializer(&p) || !trivia(&p, NULL)) {
    fail(&p, TMT_UNSUPPORTED);
    goto finish;
  }
  if (current(&p) == ';') {
    p.pos++;
    if (!trivia(&p, NULL)) goto finish;
  }
  if (p.pos != p.size) fail(&p, TMT_UNSUPPORTED);
finish:
  if (p.result.status != TMT_DONE) p.result.count = 0;
  return p.result;
}
