#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "TmtGrammar.h"
#include "TmtScan.h"

uint32_t TmtScan_scan_class_low(const uint8_t *source, uint32_t size, uint32_t start, TmtGrammar_byte_class cls);

static void compare(uint8_t *source, uint32_t size, uint32_t start, TmtGrammar_byte_class cls)
{
  uint8_t original[258];
  assert(size <= sizeof(original));
  memcpy(original, source, size);
  uint32_t expected = TmtScan_scan_class_low(source, size, start, cls);
  assert(TmtScan_scan_class(source, size, start, cls) == expected);
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
    TmtGrammar_byte_class cls = strcmp(name, "Space") == 0 ? TmtGrammar_Space
      : strcmp(name, "Identifier") == 0 ? TmtGrammar_Identifier : TmtGrammar_DecimalDigits;
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

int main(int argc, char **argv)
{
  uint8_t buffer[258];
  assert(argc == 2);
  check_matrix(argv[1]);
  for (uint8_t cls = TmtGrammar_Space; cls <= TmtGrammar_DecimalDigits; cls++)
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
  puts("Pulse and Low* agree for all bytes and scanner classes");
}
