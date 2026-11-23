#ifndef TMT_SOURCE_MAP_H
#define TMT_SOURCE_MAP_H

/*
 * Source map mappings for a projection. A projection has the length of its source, and each byte
 * either equals the source byte or is a space, a semicolon or a parenthesis written over erased
 * syntax. An erased scalar of several bytes becomes white space of the same UTF-8 and UTF-16
 * width. Output byte i therefore comes from source byte i. Line terminators are kept, so both
 * sides agree on lines. Columns are UTF-16 code units, counted for each side from its own bytes.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char *text;
  size_t length, capacity;
} tmt_map_writer;

static inline bool tmt_map_reserve(tmt_map_writer *map, size_t extra) {
  if (map->capacity - map->length >= extra) return true;
  size_t capacity = map->capacity * 2;
  if (capacity < map->length + extra) capacity = map->length + extra;
  char *grown = realloc(map->text, capacity);
  if (!grown) return false;
  map->text = grown;
  map->capacity = capacity;
  return true;
}

/* The caller reserves seven bytes, the longest encoding of a 32-bit value. */
static inline void tmt_map_vlq(tmt_map_writer *map, int64_t value) {
  static const char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  uint64_t bits = value < 0 ? ((uint64_t)(-value) << 1) | 1 : (uint64_t)value << 1;
  do {
    unsigned digit = bits & 31;
    bits >>= 5;
    if (bits) digit |= 32;
    map->text[map->length++] = digits[digit];
  } while (bits);
}

static inline bool tmt_map_word(uint8_t byte) {
  return (byte | 32) - 'a' < 26u || byte - '0' < 10u || byte == '_' || byte == '$' || byte >= 0x80;
}

static inline bool tmt_map_blank(uint8_t byte) {
  return byte == ' ' || byte == '\t' || byte == '\v' || byte == '\f';
}

/* UTF-16 code units begun by a UTF-8 byte: none for a continuation byte, two for a four-byte lead. */
static inline uint32_t tmt_map_units(uint8_t byte) {
  return (byte & 0xC0) == 0x80 ? 0 : byte >= 0xF0 ? 2 : 1;
}

/* Returns NULL when the output is not a projection of the source or memory runs out. */
static inline char *tmt_projection_mappings(const uint8_t *source, const uint8_t *code, size_t size, size_t length,
  size_t *written)
{
  if (length != size) return NULL;
  tmt_map_writer map = { .capacity = size + size / 2 + 64 };
  map.text = malloc(map.capacity);
  if (!map.text) return NULL;
  uint32_t generated = 0, original = 0, line = 0;
  uint32_t last_generated = 0, last_original = 0, last_line = 0;
  bool first = true, boundary = true, word = false;
  for (size_t at = 0; at < size; at++) {
    const uint8_t from = source[at], to = code[at];
    if (from >= 0xC2) {
      /* The eraser writes U+00A0, U+2002 or a space and U+FEFF over a scalar of two, three or four bytes. */
      static const uint8_t blanks[5][4] = { { 0 }, { 0 }, { 0xC2, 0xA0 }, { 0xE2, 0x80, 0x82 }, { ' ', 0xEF, 0xBB, 0xBF } };
      const size_t width = from < 0xE0 ? 2 : from < 0xF0 ? 3 : 4;
      if (size - at < width) goto mismatch;
      if (memcmp(code + at, source + at, width)) {
        /* U+2028 and U+2029 end a line and must stay. */
        const bool terminator = from == 0xE2 && source[at + 1] == 0x80 && (source[at + 2] | 1) == 0xA9;
        if (terminator || memcmp(code + at, blanks[width], width)) goto mismatch;
        const uint32_t units = width == 4 ? 2 : 1;
        generated += units;
        original += units;
        at += width - 1;
        boundary = true;
        continue;
      }
    } else if (to != from && (from >= 0x80 || (to != ' ' && to != ';' && to != '(' && to != ')'))) goto mismatch;
    size_t terminator = 0;
    if (from == '\n') terminator = 1;
    else if (from == '\r') terminator = at + 1 < size && source[at + 1] == '\n' ? 2 : 1;
    else if (from == 0xE2 && at + 2 < size && source[at + 1] == 0x80 && (source[at + 2] | 1) == 0xA9) terminator = 3;
    if (terminator) {
      for (size_t index = 0; index < terminator; index++) {
        if (code[at + index] != source[at + index]) goto mismatch;
      }
      if (!tmt_map_reserve(&map, 1)) goto mismatch;
      map.text[map.length++] = ';';
      at += terminator - 1;
      line++;
      generated = original = last_generated = 0;
      first = boundary = true;
      continue;
    }
    if (tmt_map_blank(to)) boundary = true;
    else if ((to & 0xC0) != 0x80) {
      const bool kind = tmt_map_word(to);
      if (boundary || kind != word) {
        if (!tmt_map_reserve(&map, 30)) goto mismatch;
        if (!first) map.text[map.length++] = ',';
        tmt_map_vlq(&map, (int64_t)generated - last_generated);
        map.text[map.length++] = 'A';
        tmt_map_vlq(&map, (int64_t)line - last_line);
        tmt_map_vlq(&map, (int64_t)original - last_original);
        last_generated = generated;
        last_line = line;
        last_original = original;
        first = false;
      }
      word = kind;
      boundary = false;
    }
    generated += tmt_map_units(to);
    original += tmt_map_units(from);
  }
  *written = map.length;
  return map.text;
mismatch:
  free(map.text);
  return NULL;
}

#endif
