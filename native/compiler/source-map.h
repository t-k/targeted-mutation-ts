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

#include "lowering.h"
#include "tmt_simd_scan.h"

/* Map code runs only when a map is requested. Keeping it out of line keeps it off the pages a default compile touches,
 * while avoiding `cold` so the compiler still optimizes its inner loops for throughput. */
#if defined(__GNUC__) || defined(__clang__)
#define TMT_MAP_COLD __attribute__((noinline, unused))
#else
#define TMT_MAP_COLD
#endif

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
static inline char *tmt_map_vlq_ptr(char *p, int64_t value) {
  static const char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  uint64_t bits = value < 0 ? ((uint64_t)(-value) << 1) | 1 : (uint64_t)value << 1;
  if (__builtin_expect(bits < 32, 1)) {
    *p++ = digits[bits];
    return p;
  }
  do {
    unsigned digit = bits & 31;
    bits >>= 5;
    if (bits) digit |= 32;
    *p++ = digits[digit];
  } while (bits);
  return p;
}

static inline void tmt_map_vlq(tmt_map_writer *map, int64_t value) {
  map->length = (size_t)(tmt_map_vlq_ptr(map->text + map->length, value) - map->text);
}

static inline bool tmt_map_word(uint8_t byte) {
  return (unsigned)((byte | 32) - 'a') < 26u || (unsigned)(byte - '0') < 10u || byte == '_' || byte == '$' || byte >= 0x80;
}

static inline bool tmt_map_blank(uint8_t byte) {
  return byte == ' ' || byte == '\t' || byte == '\v' || byte == '\f';
}

/* UTF-16 code units begun by a UTF-8 byte: none for a continuation byte, two for a four-byte lead. */
static inline uint32_t tmt_map_units(uint8_t byte) {
  return (byte & 0xC0) == 0x80 ? 0 : byte >= 0xF0 ? 2 : 1;
}

typedef struct {
  uint32_t offset, line, column;
} tmt_map_point;

typedef struct {
  tmt_map_point at;
  /* marks[k] is the first position at or after byte k * 4096, so a copy of earlier text is found without a rescan. */
  tmt_map_point *marks;
  size_t count, capacity;
} tmt_map_source;

static inline bool tmt_map_mark(tmt_map_source *cursor) {
  if ((cursor->at.offset >> 12) < cursor->count) return true;
  if (cursor->count == cursor->capacity) {
    const size_t capacity = cursor->capacity ? cursor->capacity * 2 : 64;
    tmt_map_point *grown = realloc(cursor->marks, capacity * sizeof(*grown));
    if (!grown) return false;
    cursor->marks = grown;
    cursor->capacity = capacity;
  }
  cursor->marks[cursor->count++] = cursor->at;
  return true;
}

/* The width of the line terminator at a position, or zero. CRLF is one terminator. */
static inline size_t tmt_map_terminator(const uint8_t *text, size_t size, size_t at) {
  const uint8_t byte = text[at];
  if (byte == '\n') return 1;
  if (byte == '\r') return at + 1 < size && text[at + 1] == '\n' ? 2 : 1;
  if (byte == 0xE2 && at + 2 < size && text[at + 1] == 0x80 && (text[at + 2] | 1) == 0xA9) return 3;
  return 0;
}

/* Moves the source position to a byte offset. A target inside a terminator is rejected. */
static inline bool tmt_map_seek(tmt_map_source *cursor, const uint8_t *source, size_t size, uint32_t target) {
  if (target > size) return false;
  if (target < cursor->at.offset) {
    size_t index = target >> 12;
    if (index >= cursor->count) index = cursor->count - 1;
    if (cursor->marks[index].offset > target) index--;
    cursor->at = cursor->marks[index];
  }
  while (cursor->at.offset < target) {
    if (!tmt_map_mark(cursor)) return false;
#if (defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))) && !defined(TMT_SCALAR_SCANS)
    if (target - cursor->at.offset >= 16 &&
        ((cursor->at.offset + 16) >> 12) == (cursor->at.offset >> 12)) {
      const unsigned n = tmt_ascii_line_count(source + cursor->at.offset);
      if (n != 0U) {
        cursor->at.column += n;
        cursor->at.offset += n;
        continue;
      }
    }
#endif
    const size_t terminator = tmt_map_terminator(source, size, cursor->at.offset);
    if (terminator) {
      cursor->at.offset += (uint32_t)terminator;
      cursor->at.line++;
      cursor->at.column = 0;
    } else {
      cursor->at.column += tmt_map_units(source[cursor->at.offset]);
      cursor->at.offset++;
    }
  }
  return cursor->at.offset == target;
}

/*
 * Mappings for an output assembled from copies of the source. Each run names the output offset,
 * the source offset and the length of one copy. Inside a run the output is a projection of the
 * source bytes, which is checked here. Text between runs was generated. Where it follows a
 * mapped copy, on the same line or at the start of a later one, a segment without a source
 * position ends the copy's mapping, so a reader that looks back for the nearest segment does not
 * attribute the generated text to that copy.
 * Returns NULL when a run is not a projection, when runs overlap in the output, or when memory
 * runs out.
 */
static TMT_MAP_COLD char *tmt_run_mappings(const uint8_t *source, size_t size, const uint8_t *code, size_t length,
  const tmt_run *runs, size_t count, size_t *written)
{
  tmt_map_writer map = { .capacity = length + length / 2 + 64 };
  tmt_map_source cursor = { 0 };
  map.text = malloc(map.capacity);
  if (!map.text) return NULL;
  uint32_t generated = 0, last_generated = 0, last_original = 0, last_line = 0;
  size_t done = 0;
  bool first = true, mapped = false;
  for (size_t index = 0; index <= count; index++) {
    /* Generated text up to the next run only moves the output position. */
    const size_t next = index < count ? runs[index].out : length;
    if (next < done || next > length) goto mismatch;
    while (done < next) {
#if (defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))) && !defined(TMT_SCALAR_SCANS)
      if (!mapped && next - done >= 16) {
        const unsigned n = tmt_ascii_line_count(code + done);
        if (n != 0U) {
          done += n;
          generated += n;
          continue;
        }
      }
#endif
      const size_t terminator = tmt_map_terminator(code, length, done);
      if (terminator) {
        if (done + terminator > next || !tmt_map_reserve(&map, 1)) goto mismatch;
        map.text[map.length++] = ';';
        done += terminator;
        generated = last_generated = 0;
        first = true;
      } else {
        if (mapped) {
          /* A one-field segment marks generated text. */
          if (!tmt_map_reserve(&map, 9)) goto mismatch;
          if (!first) map.text[map.length++] = ',';
          tmt_map_vlq(&map, (int64_t)generated - last_generated);
          last_generated = generated;
          first = false;
          mapped = false;
        }
        generated += tmt_map_units(code[done++]);
      }
    }
    if (index == count) break;
    const tmt_run run = runs[index];
    if (run.length > length - done || run.length > size || run.src > size - run.length ||
        !tmt_map_seek(&cursor, source, size, run.src)) goto mismatch;
    const uint8_t *from_bytes = source + run.src, *to_bytes = code + done;
    bool boundary = true, word = false;
    for (size_t at = 0; at < run.length; at++) {
      if (!tmt_map_mark(&cursor)) goto mismatch;
#if (defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))) && !defined(TMT_SCALAR_SCANS)
      if (run.length - at >= 16 && ((cursor.at.offset + 16) >> 12) == (cursor.at.offset >> 12)) {
        if (to_bytes[at] == ' ' && to_bytes[at + 1] == ' ') {
          const unsigned n = tmt_map_blank_count(from_bytes + at, to_bytes + at);
          if (n != 0U) {
            generated += n;
            cursor.at.column += n;
            cursor.at.offset += n;
            at += n - 1;
            boundary = true;
            continue;
          }
        }
        if (!boundary && word && to_bytes[at] == from_bytes[at] && to_bytes[at] < 0x80 && tmt_map_word(to_bytes[at])) {
          const unsigned n = tmt_map_word_count(from_bytes + at, to_bytes + at);
          if (n != 0U) {
            generated += n;
            cursor.at.column += n;
            cursor.at.offset += n;
            at += n - 1;
            continue;
          }
        }
      }
#endif
      const uint8_t from = from_bytes[at], to = to_bytes[at];
      if (from >= 0xC2) {
        /* The eraser writes U+00A0, U+2002 or a space and U+FEFF over a scalar of two, three or four bytes. */
        static const uint8_t blanks[5][4] = { { 0 }, { 0 }, { 0xC2, 0xA0 }, { 0xE2, 0x80, 0x82 }, { ' ', 0xEF, 0xBB, 0xBF } };
        const size_t width = from < 0xE0 ? 2 : from < 0xF0 ? 3 : 4;
        if (run.length - at < width) goto mismatch;
        if (memcmp(to_bytes + at, from_bytes + at, width)) {
          /* U+2028 and U+2029 end a line and must stay. */
          const bool terminator = from == 0xE2 && from_bytes[at + 1] == 0x80 && (from_bytes[at + 2] | 1) == 0xA9;
          if (terminator || memcmp(to_bytes + at, blanks[width], width)) goto mismatch;
          const uint32_t units = width == 4 ? 2 : 1;
          generated += units;
          cursor.at.column += units;
          cursor.at.offset += (uint32_t)width;
          at += width - 1;
          boundary = true;
          continue;
        }
      } else if (to != from && (from >= 0x80 || (to != ' ' && to != ';' && to != '(' && to != ')'))) goto mismatch;
      const size_t terminator = tmt_map_terminator(from_bytes, run.length, at);
      if (terminator) {
        /* A copy that ends between CR and LF would count the line twice. */
        if (terminator == 1 && from == '\r' && run.src + at + 1 < size && source[run.src + at + 1] == '\n') goto mismatch;
        for (size_t part = 0; part < terminator; part++) {
          if (to_bytes[at + part] != from_bytes[at + part]) goto mismatch;
        }
        if (!tmt_map_reserve(&map, 1)) goto mismatch;
        map.text[map.length++] = ';';
        at += terminator - 1;
        cursor.at.offset += (uint32_t)terminator;
        cursor.at.line++;
        cursor.at.column = 0;
        generated = last_generated = 0;
        first = boundary = true;
        continue;
      }
      if (to != from && !tmt_map_blank(to)) {
        /* A separator or a parenthesis written over erased text is generated, like the text between runs. */
        if (mapped) {
          if (!tmt_map_reserve(&map, 9)) goto mismatch;
          if (!first) map.text[map.length++] = ',';
          tmt_map_vlq(&map, (int64_t)generated - last_generated);
          last_generated = generated;
          first = false;
          mapped = false;
        }
        boundary = true;
      } else if (tmt_map_blank(to)) boundary = true;
      else if ((to & 0xC0) != 0x80) {
        const bool kind = tmt_map_word(to);
        if (boundary || kind != word) {
          if (!tmt_map_reserve(&map, 30)) goto mismatch;
          char *p = map.text + map.length;
          if (!first) *p++ = ',';
          p = tmt_map_vlq_ptr(p, (int64_t)generated - last_generated);
          *p++ = 'A';
          const int64_t dline = (int64_t)cursor.at.line - last_line;
          if (__builtin_expect(dline == 0, 1)) *p++ = 'A';
          else p = tmt_map_vlq_ptr(p, dline);
          p = tmt_map_vlq_ptr(p, (int64_t)cursor.at.column - last_original);
          map.length = (size_t)(p - map.text);
          last_generated = generated;
          last_line = cursor.at.line;
          last_original = cursor.at.column;
          first = false;
          mapped = true;
        }
        word = kind;
        boundary = false;
      }
      generated += tmt_map_units(to);
      cursor.at.column += tmt_map_units(from);
      cursor.at.offset++;
    }
    done += run.length;
  }
  free(cursor.marks);
  *written = map.length;
  return map.text;
mismatch:
  free(cursor.marks);
  free(map.text);
  return NULL;
}

/* A projection is one copy of the whole source. */
static TMT_MAP_COLD char *tmt_projection_mappings(const uint8_t *source, const uint8_t *code, size_t size, size_t length,
  size_t *written)
{
  if (length != size || size > UINT32_MAX) return NULL;
  const tmt_run whole = { 0, 0, (uint32_t)size };
  return tmt_run_mappings(source, size, code, length, &whole, 1, written);
}

#endif
