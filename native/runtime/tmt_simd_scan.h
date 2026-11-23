#ifndef TMT_SIMD_SCAN_H
#define TMT_SIMD_SCAN_H

#include <stdbool.h>
#include <stdint.h>

/* The caller supplies 16 bytes. The first sentinel, or 16, is the scalar resume point. */
#if defined(__aarch64__)
#include <arm_neon.h>

static inline unsigned tmt_simd_scan(const uint8_t *source, uint8_t delimiter, uint8_t extra) {
  const uint8x16_t bytes = vld1q_u8(source);
  const uint8x16_t lanes = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
  uint8x16_t hits = vorrq_u8(vceqq_u8(bytes, vdupq_n_u8(13)), vceqq_u8(bytes, vdupq_n_u8(10)));
  hits = vorrq_u8(hits, vceqq_u8(bytes, vdupq_n_u8(226)));
  hits = vorrq_u8(hits, vceqq_u8(bytes, vdupq_n_u8(delimiter)));
  hits = vorrq_u8(hits, vceqq_u8(bytes, vdupq_n_u8(extra)));
  return vminvq_u8(vbslq_u8(hits, lanes, vdupq_n_u8(16)));
}

/* Blocked lanes require the ordinary JSX scanner transition. */
static inline bool tmt_jsx_quote_run(const uint8_t *source, bool decode) {
  const uint8x16_t bytes = vld1q_u8(source);
  uint8x16_t blocked = vorrq_u8(vcltq_u8(bytes, vdupq_n_u8(32)), vceqq_u8(bytes, vdupq_n_u8('"')));
  blocked = vorrq_u8(blocked, vceqq_u8(bytes, vdupq_n_u8('\\')));
  if (decode) blocked = vorrq_u8(blocked, vorrq_u8(vceqq_u8(bytes, vdupq_n_u8('&')), vceqq_u8(bytes, vdupq_n_u8(0xe2))));
  return vmaxvq_u8(blocked) == 0;
}

static inline bool tmt_jsx_text_run(const uint8_t *source) {
  const uint8x16_t bytes = vld1q_u8(source);
  uint8x16_t blocked = vorrq_u8(vcleq_u8(bytes, vdupq_n_u8(32)), vcgeq_u8(bytes, vdupq_n_u8(128)));
  blocked = vorrq_u8(blocked, vceqq_u8(bytes, vdupq_n_u8('<')));
  blocked = vorrq_u8(blocked, vceqq_u8(bytes, vdupq_n_u8('>')));
  blocked = vorrq_u8(blocked, vceqq_u8(bytes, vdupq_n_u8('{')));
  blocked = vorrq_u8(blocked, vceqq_u8(bytes, vdupq_n_u8('}')));
  return vmaxvq_u8(blocked) == 0;
}
#elif defined(__x86_64__) && defined(__SSE2__)
#include <emmintrin.h>

static inline unsigned tmt_simd_scan(const uint8_t *source, uint8_t delimiter, uint8_t extra) {
  const __m128i bytes = _mm_loadu_si128((const __m128i *)source);
  __m128i hits = _mm_or_si128(_mm_cmpeq_epi8(bytes, _mm_set1_epi8(13)), _mm_cmpeq_epi8(bytes, _mm_set1_epi8(10)));
  hits = _mm_or_si128(hits, _mm_cmpeq_epi8(bytes, _mm_set1_epi8((char)226)));
  hits = _mm_or_si128(hits, _mm_cmpeq_epi8(bytes, _mm_set1_epi8((char)delimiter)));
  hits = _mm_or_si128(hits, _mm_cmpeq_epi8(bytes, _mm_set1_epi8((char)extra)));
  const unsigned mask = (unsigned)_mm_movemask_epi8(hits);
  return mask ? (unsigned)__builtin_ctz(mask) : 16U;
}

static inline __m128i tmt_sse_u8_le(__m128i bytes, uint8_t limit) {
  return _mm_cmpeq_epi8(_mm_subs_epu8(bytes, _mm_set1_epi8((char)limit)), _mm_setzero_si128());
}

static inline bool tmt_jsx_quote_run(const uint8_t *source, bool decode) {
  const __m128i bytes = _mm_loadu_si128((const __m128i *)source);
  __m128i blocked = _mm_or_si128(tmt_sse_u8_le(bytes, 31), _mm_cmpeq_epi8(bytes, _mm_set1_epi8('"')));
  blocked = _mm_or_si128(blocked, _mm_cmpeq_epi8(bytes, _mm_set1_epi8('\\')));
  if (decode) blocked = _mm_or_si128(blocked, _mm_or_si128(_mm_cmpeq_epi8(bytes, _mm_set1_epi8('&')),
    _mm_cmpeq_epi8(bytes, _mm_set1_epi8((char)0xe2))));
  return _mm_movemask_epi8(blocked) == 0;
}

static inline bool tmt_jsx_text_run(const uint8_t *source) {
  const __m128i bytes = _mm_loadu_si128((const __m128i *)source);
  __m128i blocked = _mm_or_si128(tmt_sse_u8_le(bytes, 32), bytes);
  blocked = _mm_or_si128(blocked, _mm_cmpeq_epi8(bytes, _mm_set1_epi8('<')));
  blocked = _mm_or_si128(blocked, _mm_cmpeq_epi8(bytes, _mm_set1_epi8('>')));
  blocked = _mm_or_si128(blocked, _mm_cmpeq_epi8(bytes, _mm_set1_epi8('{')));
  blocked = _mm_or_si128(blocked, _mm_cmpeq_epi8(bytes, _mm_set1_epi8('}')));
  return _mm_movemask_epi8(blocked) == 0;
}
#endif

#endif
