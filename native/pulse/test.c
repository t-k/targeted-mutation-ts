#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "parser.h"

#if defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))
#include "tmt_simd_scan.h"

static void check_jsx_blocks(void)
{
  uint8_t bytes[16];
  for (unsigned lane = 0; lane < sizeof(bytes); lane++) {
    for (unsigned byte = 0; byte < 256; byte++) {
      memset(bytes, 'a', sizeof(bytes));
      bytes[lane] = (uint8_t)byte;
      const bool quote = byte >= 32 && byte != '"' && byte != '\\';
      const bool decode = quote && byte != '&' && byte != 226;
      const bool text = byte > 32 && byte < 128 && byte != '<' && byte != '>' && byte != '{' && byte != '}';
      assert(tmt_jsx_quote_run(bytes, false) == quote);
      assert(tmt_jsx_quote_run(bytes, true) == decode);
      assert(tmt_jsx_text_run(bytes) == text);
    }
  }
  puts("SIMD JSX predicates matched all bytes in every lane");
}

static void check_type_blocks(void)
{
  uint8_t input[18], output[18];
  for (unsigned lane = 0; lane < 16; lane++) {
    for (unsigned byte = 0; byte < 256; byte++) {
      memset(input, 'a', sizeof(input));
      memset(output, 0xc7, sizeof(output));
      input[lane + 1] = (uint8_t)byte;
      assert(tmt_erase_type_run(output + 1, input + 1) == (byte < 128));
      for (unsigned offset = 0; offset < sizeof(output); offset++) {
        uint8_t expected = 0xc7;
        if (byte < 128 && offset > 0 && offset < 17) {
          const uint8_t source = input[offset];
          expected = source == '\n' || source == '\r' ? source : ' ';
        }
        assert(output[offset] == expected);
      }
    }
  }
  puts("SIMD type masking matched all bytes in every lane");
}

static void check_map_runs(void)
{
  uint8_t from[16], to[16];
  for (unsigned lane = 0; lane < 16; lane++) {
    for (unsigned byte = 0; byte < 256; byte++) {
      memset(from, 'a', sizeof(from));
      memset(to, ' ', sizeof(to));
      from[lane] = (uint8_t)byte;
      const bool ascii_line = byte < 128 && byte != '\n' && byte != '\r';
      assert(tmt_ascii_line_run(from) == ascii_line);
      assert(tmt_map_blank_run(from, to) == ascii_line);
      to[lane] = (uint8_t)byte;
      assert(tmt_map_blank_run(from, to) == (ascii_line && byte == ' '));
      memset(from, 'a', sizeof(from));
      memset(to, 'a', sizeof(to));
      from[lane] = (uint8_t)byte;
      to[lane] = (uint8_t)byte;
      const bool word = ((byte | 32u) - 'a') < 26u || (byte - '0') < 10u || byte == '_' || byte == '$';
      assert(tmt_map_word_run(from, to) == word);
      from[lane] = (uint8_t)(byte ^ 1u);
      assert(!tmt_map_word_run(from, to));
    }
  }
  puts("SIMD source-map runs matched all bytes in every lane");
}

static void check_template_and_space_runs(void)
{
  uint8_t buf[16];
  for (unsigned lane = 0; lane < 16; lane++) {
    for (unsigned byte = 0; byte < 256; byte++) {
      memset(buf, 'a', sizeof(buf));
      buf[lane] = (uint8_t)byte;
      const unsigned expected_tpl = (byte == '`' || byte == '$' || byte == '\\') ? lane : 16U;
      assert(tmt_template_run(buf) == expected_tpl);

      memset(buf, ' ', sizeof(buf));
      buf[lane] = (uint8_t)byte;
      const bool is_ws = byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r';
      const bool is_nl = byte == '\n' || byte == '\r';
      bool nl = false;
      assert(tmt_space_run(buf, &nl) == (is_ws ? 16U : lane));
      assert(nl == is_nl);
      nl = true;
      assert(tmt_space_run(buf, &nl) == (is_ws ? 16U : lane));
      assert(nl == true);
    }
  }
  /* Verify newlines AFTER the first non-whitespace stop byte do not set `newline`,
     while newlines strictly BEFORE the stop byte do. */
  for (unsigned stop = 0; stop < 16; stop++) {
    for (unsigned nl_lane = 0; nl_lane < 16; nl_lane++) {
      if (nl_lane == stop) continue;
      for (unsigned k = 0; k < 2; k++) {
        memset(buf, ' ', sizeof(buf));
        buf[stop] = 'x';
        buf[nl_lane] = k == 0 ? '\n' : '\r';
        bool nl = false;
        assert(tmt_space_run(buf, &nl) == stop);
        assert(nl == (nl_lane < stop));
      }
    }
  }
  /* Verify multiple stop bytes in `tmt_template_run` always return the earliest lane. */
  for (unsigned first = 0; first < 16; first++) {
    for (unsigned second = first + 1; second < 16; second++) {
      memset(buf, 'a', sizeof(buf));
      buf[first] = '$';
      buf[second] = '`';
      assert(tmt_template_run(buf) == first);
    }
  }
  puts("SIMD template and whitespace runs matched all bytes in every lane");
}

/* The scalar block comment loop stops at a terminator and, before its first line break, at a line break start. */
static unsigned comment_run_reference(const uint8_t *bytes, bool newline)
{
  for (unsigned lane = 0; lane < 16; lane++) {
    if (bytes[lane] == '*' && bytes[lane + 1] == '/') return lane;
    if (!newline && (bytes[lane] == '\n' || bytes[lane] == '\r' || bytes[lane] == 226)) return lane;
  }
  return 16;
}

static void check_comment_runs(void)
{
  uint8_t bytes[17];
  for (unsigned lane = 0; lane < 16; lane++) {
    for (unsigned first = 0; first < 256; first++) {
      for (unsigned second = 0; second < 256; second++) {
        memset(bytes, 'q', sizeof(bytes));
        bytes[lane] = (uint8_t)first;
        bytes[lane + 1] = (uint8_t)second;
        for (unsigned newline = 0; newline < 2; newline++) {
          assert(tmt_comment_run(bytes, newline) == comment_run_reference(bytes, newline));
        }
      }
    }
  }
  static const char mixed[] = "* /*\n**/ *\r*/";
  for (unsigned start = 0; start + 17 <= sizeof(mixed) + 16; start++) {
    for (unsigned lane = 0; lane < sizeof(bytes); lane++) bytes[lane] = (uint8_t)mixed[(start + lane) % (sizeof(mixed) - 1)];
    for (unsigned newline = 0; newline < 2; newline++) {
      assert(tmt_comment_run(bytes, newline) == comment_run_reference(bytes, newline));
    }
  }
  puts("SIMD comment runs matched every byte pair in every lane for both line states");
}
#endif

#if defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))
static bool projection_candidates[256][256];

static void prepare_projection_reference(void)
{
  static const char *const words[] = {
    "as", "satisfies", "declare", "namespace", "type", "interface", "abstract",
    "enum", "readonly", "public", "private", "protected", "override", "implements",
  };
  for (unsigned first = 1; first <= UINT8_MAX; first++) {
    if (strchr("<\x22'/`\\", first)) memset(projection_candidates[first], 1, sizeof(projection_candidates[first]));
  }
  for (size_t word = 0; word < sizeof(words) / sizeof(*words); word++) {
    projection_candidates[(uint8_t)words[word][0]][(uint8_t)words[word][1]] = true;
  }
}

static void compare_projection_mask(const uint8_t *bytes, unsigned width)
{
  const uint64_t mask = tmt_projection_mask(bytes, width);
  for (unsigned lane = 0; lane < width; lane++) {
    const bool hit = (mask >> (lane << TMT_PROJECTION_LANE_SHIFT)) & 1U;
    assert(hit == projection_candidates[bytes[lane]][bytes[lane + 1]]);
  }
}

static void projection_example(unsigned width, unsigned lane, uint8_t first, uint8_t second)
{
  uint8_t bytes[33];
  memset(bytes, '_', sizeof(bytes));
  bytes[lane] = first;
  bytes[lane + 1] = second;
  compare_projection_mask(bytes, width);
}

static void check_projection_blocks(const char *path, unsigned width)
{
  FILE *matrix = fopen(path, "r");
  char header[128], first[32], second[32], position[32];
  assert(matrix && fgets(header, sizeof(header), matrix));
  unsigned count = 0;
  while (fscanf(matrix, "%31s %31s %31s", first, second, position) == 3) {
    const uint8_t head = strcmp(first, "Lexical") == 0 ? '<' : strcmp(first, "PairHead") == 0 ? 'a' : '_';
    const uint8_t tail = strcmp(second, "Lexical") == 0 ? '/' : strcmp(second, "PairTail") == 0 ? 's' : '_';
    const unsigned lane = strcmp(position, "Start") == 0 ? 0 : strcmp(position, "End") == 0 ? width - 1 : width / 2;
    projection_example(width, lane, head, tail);
    count++;
  }
  assert(feof(matrix) && count > 0);
  fclose(matrix);
  uint8_t mixed[33];
  for (unsigned lane = 0; lane < sizeof(mixed); lane++) mixed[lane] = (uint8_t)"as/_satisfies"[lane % 13];
  compare_projection_mask(mixed, width);
  for (unsigned lane = 0; lane < width; lane++) {
    for (unsigned first_byte = 0; first_byte <= UINT8_MAX; first_byte++) {
      for (unsigned second_byte = 0; second_byte <= UINT8_MAX; second_byte++) {
        projection_example(width, lane, (uint8_t)first_byte, (uint8_t)second_byte);
      }
    }
  }
  printf("SIMD projection guard matched %u PICT cases and every byte pair in %u lanes\n", count, width);
}
#endif

enum { SPACE, IDENTIFIER, DECIMAL_DIGITS, HORIZONTAL_SPACE };

static bool matches(uint8_t cls, uint8_t byte)
{
  bool digit = byte >= '0' && byte <= '9';
  if (cls == SPACE) return byte == ' ' || byte == '\t' || byte == '\r' || byte == '\n';
  if (cls == DECIMAL_DIGITS) return digit;
  if (cls == HORIZONTAL_SPACE) return byte == ' ' || byte == '\t';
  return digit || (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') || byte == '$' || byte == '_';
}

static void compare(uint8_t *source, uint32_t size, uint32_t start, uint8_t cls)
{
  uint8_t original[258];
  assert(size <= sizeof(original));
  memcpy(original, source, size);
  uint32_t expected = start;
  while (expected < size && matches(cls, source[expected])) expected++;
  assert(TmtPulseScan_scan_class(source, size, start, cls) == expected);
  assert(memcmp(original, source, size) == 0);
}

static const uint8_t valid[] = { ' ', 'a', '9', '\t' };

static void check_matrix(const char *path)
{
  FILE *matrix = fopen(path, "r");
  char header[128], name[32], start[32], run[32];
  assert(matrix && fgets(header, sizeof(header), matrix));
  int count = 0;
  while (fscanf(matrix, "%31s %31s %31s", name, start, run) == 3)
  {
    uint8_t cls = strcmp(name, "Space") == 0 ? SPACE
      : strcmp(name, "Identifier") == 0 ? IDENTIFIER
      : strcmp(name, "DecimalDigits") == 0 ? DECIMAL_DIGITS : HORIZONTAL_SPACE;
    uint8_t buffer[8];
    memset(buffer, valid[cls], sizeof(buffer));
    if (strcmp(run, "Stop") == 0) buffer[3] = cls == HORIZONTAL_SPACE ? '\n' : '@';
    if (strcmp(run, "NonAscii") == 0) buffer[3] = 0xe3;
    uint32_t size = strcmp(run, "Empty") == 0 ? 0 : sizeof(buffer);
    uint32_t offset = strcmp(start, "End") == 0 ? size : strcmp(start, "Middle") == 0 ? 2 : 0;
    compare(buffer, size, offset, cls);
    count++;
  }
  assert(feof(matrix) && count > 0);
  fclose(matrix);
  printf("Pulse scanner matched %d PICT cases\n", count);
}

static void check_primitives(const char *path)
{
  FILE *matrix = fopen(path, "r");
  char header[128], operation[32], length[32], position[32];
  assert(matrix && fgets(header, sizeof(header), matrix));
  int count = 0;
  uint8_t sources[][5] = { { 226, 128, 168, 0, 0 }, { 0, 0, 226, 128, 169 },
    { '<', '=', '>', '=', 0 }, { 226, 127, 168, 0, 0 } };
  while (fscanf(matrix, "%31s %31s %31s", operation, length, position) == 3)
  {
    uint32_t size = strcmp(length, "Empty") == 0 ? 0 : strcmp(length, "Short") == 0 ? 2 : 5;
    uint32_t offset = strcmp(position, "Start") == 0 ? 0 : strcmp(position, "Middle") == 0 ? 2
      : strcmp(position, "End") == 0 ? size : UINT32_MAX;
    if (strcmp(operation, "Save") == 0) {
      TmtGrammar_candidate records[5] = {0}, expected[5] = {0};
      TmtGrammar_candidate candidate = { 1, 2, { 8, 9 }, { 3, 6 }, { 11, 22 } };
      expected[offset] = candidate;
      TmtPulseScan_save_candidate(records, offset, candidate);
      assert(memcmp(expected, records, sizeof(records)) == 0);
    } else for (unsigned variant = 0; variant < sizeof(sources) / sizeof(sources[0]); variant++) {
      uint8_t *source = sources[variant];
      uint8_t first = offset < size ? source[offset] : 0;
      uint8_t next = offset < size && size - offset > 1 ? source[offset + 1] : 0;
      if (strcmp(operation, "Peek") == 0) {
        assert(TmtPulseScan_peek(source, size, offset) == first);
      } else if (strcmp(operation, "Separator") == 0) {
        bool separator = first == 226 && next == 128 && size - offset > 2 &&
          (source[offset + 2] == 168 || source[offset + 2] == 169);
        assert(TmtPulseScan_unicode_line_separator(source, size, offset) == separator);
      } else {
        uint32_t expected = first == '<' ? 1 : first == '>' ? 3 : 0;
        if (expected && next == '=') expected++;
        assert(TmtPulseScan_source_boundary(source, size, offset) == expected);
      }
    }
    count++;
  }
  assert(feof(matrix) && count > 0);
  fclose(matrix);
  printf("Pulse primitives matched %d PICT cases\n", count);
}

static void check_publication(const char *path)
{
  FILE *matrix = fopen(path, "r");
  char header[128], width[32], missing[32], suffix[32];
  assert(matrix && fgets(header, sizeof(header), matrix));
  int rows = 0;
  while (fscanf(matrix, "%31s %31s %31s", width, missing, suffix) == 3) {
    uint8_t marks[8] = {0};
    uint32_t count = strcmp(width, "Zero") == 0 ? 0 : strcmp(width, "Partial") == 0 ? 4 : 8;
    memset(marks, 1, strcmp(suffix, "Marked") == 0 ? sizeof(marks) : count);
    const bool complete = strcmp(missing, "None") == 0;
    if (!complete) {
      uint32_t hole = strcmp(missing, "First") == 0 ? 0 :
        strcmp(missing, "Middle") == 0 ? count / 2 : count - 1;
      marks[hole] = 0;
    }
    uint8_t before[8];
    memcpy(before, marks, sizeof(marks));
    assert(TmtPulseMemory_prefix_marked(marks, count) == complete);
    assert(memcmp(before, marks, sizeof(marks)) == 0);
    rows++;
  }
  assert(feof(matrix) && rows > 0);
  fclose(matrix);
  printf("Pulse publication matched %d PICT cases\n", rows);
}

static void check_parser_publication(void)
{
  const uint8_t source[] = "const x = (a < b) > (c <= d);\nconst y = e >= f;";
  const uint32_t size = sizeof(source) - 1;
  TmtGrammar_candidate output[4];
  tmt_result result = tmt_parse(source, size, false, true, output, 4);
  assert(result.status == TMT_DONE && result.count == 4);
  const uint32_t operators[] = { 1, 3, 2, 4 };
  for (uint32_t i = 0; i < result.count; ++i) {
    assert(output[i].original == operators[i]);
    if (i > 0) assert(output[i - 1].edit.first < output[i].edit.first);
  }
  result = tmt_parse(source, size, false, true, output, 3);
  assert(result.status == TMT_CANDIDATE_LIMIT && result.count == 0);
  const uint8_t empty[] = "";
  result = tmt_parse(empty, 0, false, true, NULL, 0);
  assert(result.status == TMT_DONE && result.count == 0);
}

static void check_assertion_cursors(const char *path)
{
  FILE *matrix = fopen(path, "r");
  assert(matrix);
  char line[256];
  assert(fgets(line, sizeof(line), matrix));
  unsigned rows = 0;
  while (fgets(line, sizeof(line), matrix)) {
    char op[16], gap[16], dialect[8];
    assert(sscanf(line, "%15s%15s%7s", op, gap, dialect) == 3);
    const char *separator = strcmp(gap, "Space") == 0 ? " " :
      strcmp(gap, "Comment") == 0 ? " /*keep*/ " :
      strcmp(gap, "LineFeed") == 0 ? "\n" :
      strcmp(gap, "BlockLine") == 0 ? "/*keep\nme*/" : "\xe2\x80\xa8";
    uint8_t source[96];
    const int size = snprintf((char *)source, sizeof(source), "export const value = (7 %s number%s);",
      strcmp(op, "As") == 0 ? "as" : "satisfies", separator);
    assert(size > 0 && (size_t)size < sizeof(source));
    TmtGrammar_candidate output[16];
    uint8_t marks[16] = {0};
    TmtPulseMemory_binding_name bindings[6975] = {0};
    TmtPulseMemory_tape input = {
      .source = source, .size = (uint32_t)size, .output = output, .capacity = 16,
      .bindings = bindings, .marks = marks, .capture_types = true,
    };
    const TmtPulseParser_parser_state parsed = TmtPulseParser_parse(input, strcmp(dialect, "TSX") == 0, true);
    assert(parsed.status == TMT_DONE && parsed.count == 1);
    assert(output[0].original == 11);
    const TmtGrammar_span span = output[0].left;
    const TmtPulseParser_cursor tail = TmtPulseParser_trivia(input, span.last);
    assert(tail.ok && source[tail.at] == ')');
    assert(tail.at == span.last + strlen(separator));
    assert(output[0].right.last == tail.at);
    assert(output[0].right.first == (tail.newline ? span.last : tail.at));
    rows++;
  }
  assert(feof(matrix) && rows > 0);
  fclose(matrix);
  printf("Pulse assertion cursors matched %u PICT cases\n", rows);
}

int main(int argc, char **argv)
{
  uint8_t buffer[258];
  assert(argc == 6);
  check_matrix(argv[1]);
  check_primitives(argv[2]);
  check_publication(argv[3]);
  check_assertion_cursors(argv[4]);
  check_parser_publication();
#if defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))
  check_jsx_blocks();
  check_type_blocks();
  check_map_runs();
  check_template_and_space_runs();
  check_comment_runs();
#endif
#if defined(__aarch64__)
  prepare_projection_reference();
  check_projection_blocks(argv[5], 16);
#elif defined(__x86_64__) && defined(__SSE2__)
  prepare_projection_reference();
  if (__builtin_cpu_supports("ssse3")) check_projection_blocks(argv[5], 16);
  if (__builtin_cpu_supports("avx2")) check_projection_blocks(argv[5], 32);
#endif
  for (uint8_t cls = SPACE; cls <= HORIZONTAL_SPACE; cls++)
  {
    compare(buffer, 0, 0, cls);
    for (unsigned byte = 0; byte < 256; byte++)
    {
      memset(buffer, valid[cls], sizeof(buffer));
      buffer[128] = (uint8_t)byte;
      compare(buffer, sizeof(buffer), 0, cls);
      compare(buffer, sizeof(buffer), 128, cls);
      compare(buffer, sizeof(buffer), sizeof(buffer), cls);
    }
  }
  puts("Pulse matched the byte-class reference for all bytes and all four classes");
}
