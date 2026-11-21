#include <stddef.h>

#include "parser.h"
#include "TmtScan.h"

#if !defined(TMT_DISABLE_SIMD) && defined(__aarch64__)
#include <arm_neon.h>
#elif !defined(TMT_DISABLE_SIMD) && defined(__SSE2__)
#include <emmintrin.h>
#endif

static bool plain_ascii_block(const uint8_t *source) {
#if !defined(TMT_DISABLE_SIMD) && defined(__aarch64__)
  const uint8x16_t bytes = vld1q_u8(source);
  const uint8x16_t endings = vorrq_u8(vceqq_u8(bytes, vdupq_n_u8(13)), vceqq_u8(bytes, vdupq_n_u8(10)));
  return vmaxvq_u8(vorrq_u8(bytes, endings)) < 128;
#elif !defined(TMT_DISABLE_SIMD) && defined(__SSE2__)
  const __m128i bytes = _mm_loadu_si128((const __m128i_u *)source);
  const __m128i endings = _mm_or_si128(_mm_cmpeq_epi8(bytes, _mm_set1_epi8(13)), _mm_cmpeq_epi8(bytes, _mm_set1_epi8(10)));
  return _mm_movemask_epi8(_mm_or_si128(bytes, endings)) == 0;
#else
  (void)source;
  return false;
#endif
}

bool tmt_locate_positions(const uint8_t *source, uint32_t size, const uint32_t *offsets, size_t count, uint32_t *locations) {
  uint32_t at = 0;
  uint32_t line = 1;
  uint32_t column = 1;
  for (size_t index = 0; index < count; index++) {
    const uint32_t target = offsets[index];
    if (target < at || target > size || (target < size && (source[target] & 0xc0) == 0x80)) return false;

    while (at < target) {
      if (target - at >= 16 && plain_ascii_block(source + at)) {
        at += 16;
        column += 16;
        continue;
      }
      const uint8_t byte = source[at];
      if (byte == 13 || byte == 10) {
        if (byte == 13 || at == 0 || source[at - 1] != 13) line++;
        column = 1;
      } else if (byte == 226 && TmtScan_unicode_line_separator(source, target, at)) {
        at += 2;
        line++;
        column = 1;
      } else if (byte < 128 || byte >= 192) {
        // An already validated UTF-8 lead byte contributes one or two UTF-16 code units.
        column += byte >= 240 ? 2 : 1;
      }
      at++;
    }
    locations[2 * index] = line;
    locations[2 * index + 1] = column;
  }
  return true;
}
