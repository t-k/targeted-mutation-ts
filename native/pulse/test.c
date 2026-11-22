#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "parser.h"

enum { SPACE, IDENTIFIER, DECIMAL_DIGITS };

static bool matches(uint8_t cls, uint8_t byte)
{
  bool digit = byte >= '0' && byte <= '9';
  if (cls == SPACE) return byte == ' ' || byte == '\t' || byte == '\r' || byte == '\n';
  if (cls == DECIMAL_DIGITS) return digit;
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

static const uint8_t valid[] = { ' ', 'a', '9' };

static void check_matrix(const char *path)
{
  FILE *matrix = fopen(path, "r");
  char header[128], name[32], start[32], run[32];
  assert(matrix && fgets(header, sizeof(header), matrix));
  int count = 0;
  while (fscanf(matrix, "%31s %31s %31s", name, start, run) == 3)
  {
    uint8_t cls = strcmp(name, "Space") == 0 ? SPACE
      : strcmp(name, "Identifier") == 0 ? IDENTIFIER : DECIMAL_DIGITS;
    uint8_t buffer[8];
    memset(buffer, valid[cls], sizeof(buffer));
    if (strcmp(run, "Stop") == 0) buffer[3] = '@';
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

int main(int argc, char **argv)
{
  uint8_t buffer[258];
  assert(argc == 4);
  check_matrix(argv[1]);
  check_primitives(argv[2]);
  check_publication(argv[3]);
  check_parser_publication();
  for (uint8_t cls = SPACE; cls <= DECIMAL_DIGITS; cls++)
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
  puts("Pulse matched the byte-class reference for all bytes and all three classes");
}
