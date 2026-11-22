#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "Custard.h"

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

int main(int argc, char **argv)
{
  uint8_t buffer[258];
  assert(argc == 3);
  check_matrix(argv[1]);
  check_primitives(argv[2]);
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
