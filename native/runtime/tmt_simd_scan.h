#ifndef TMT_SIMD_SCAN_H
#define TMT_SIMD_SCAN_H

#include <stdbool.h>
#include <stdint.h>

#if defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))
/* Letters index these tables relative to 'a'. Followers sharing a bit have the same heads. */
static const uint8_t tmt_projection_heads[32] = {
  2, 0, 0, 4, 16, 0, 0, 0, 48, 0, 0, 0, 0, 1, 128, 64,
  0, 4, 1, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
};
static const uint8_t tmt_projection_followers[32] = {
  1, 2, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 32, 16, 0, 0,
  0, 64, 2, 0, 64, 128, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0
};
/* Each low nibble maps to the high-nibble bits of the lexical sentinels. */
static const uint8_t tmt_projection_lexical[16] = {
  64, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 40, 0, 0, 4
};
#endif

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

static inline bool tmt_erase_type_run(uint8_t *output, const uint8_t *source) {
  const uint8x16_t bytes = vld1q_u8(source);
  if (vmaxvq_u8(bytes) >= 128) return false;
  const uint8x16_t endings = vorrq_u8(vceqq_u8(bytes, vdupq_n_u8('\n')), vceqq_u8(bytes, vdupq_n_u8('\r')));
  vst1q_u8(output, vbslq_u8(endings, bytes, vdupq_n_u8(' ')));
  return true;
}

#define TMT_PROJECTION_LANE_SHIFT 2

static inline unsigned tmt_projection_width(void) { return 16; }

/* The caller supplies sixteen candidate starts and one following byte. */
static inline uint64_t tmt_projection_mask(const uint8_t *source, unsigned width) {
  (void)width;
  const uint8x16x2_t heads = vld1q_u8_x2(tmt_projection_heads);
  const uint8x16x2_t followers = vld1q_u8_x2(tmt_projection_followers);
  const uint8x16_t lexical = vld1q_u8(tmt_projection_lexical);
  const uint8x16_t first = vld1q_u8(source);
  const uint8x16_t second = vld1q_u8(source + 1);
  const uint8x16_t head = vqtbl2q_u8(heads, vsubq_u8(first, vdupq_n_u8('a')));
  const uint8x16_t follower = vqtbl2q_u8(followers, vsubq_u8(second, vdupq_n_u8('a')));
  const uint8x16_t high = vshlq_u8(vdupq_n_u8(1), vreinterpretq_s8_u8(vshrq_n_u8(first, 4)));
  const uint8x16_t low = vqtbl1q_u8(lexical, vandq_u8(first, vdupq_n_u8(15)));
  const uint8x16_t blocked = vorrq_u8(vandq_u8(head, follower), vandq_u8(high, low));
  const uint8x16_t hits = vcgtq_u8(blocked, vdupq_n_u8(0));
  return vget_lane_u64(vreinterpret_u64_u8(vshrn_n_u16(vreinterpretq_u16_u8(hits), 4)), 0);
}
#elif defined(__x86_64__) && defined(__SSE2__)
#include <immintrin.h>

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

static inline bool tmt_erase_type_run(uint8_t *output, const uint8_t *source) {
  const __m128i bytes = _mm_loadu_si128((const __m128i *)source);
  if (_mm_movemask_epi8(bytes)) return false;
  const __m128i endings = _mm_or_si128(_mm_cmpeq_epi8(bytes, _mm_set1_epi8('\n')), _mm_cmpeq_epi8(bytes, _mm_set1_epi8('\r')));
  const __m128i masked = _mm_or_si128(_mm_and_si128(endings, bytes), _mm_andnot_si128(endings, _mm_set1_epi8(' ')));
  _mm_storeu_si128((__m128i *)output, masked);
  return true;
}

#define TMT_PROJECTION_LANE_SHIFT 0

static inline unsigned tmt_projection_width(void) {
  if (__builtin_cpu_supports("avx2")) return 32;
  if (__builtin_cpu_supports("ssse3")) return 16;
  return 0;
}

static const uint8_t tmt_projection_high_bits[16] = {1, 2, 4, 8, 16, 32, 64, 128};

static __attribute__((target("ssse3"))) inline __m128i
tmt_projection_lookup16(const uint8_t *table, __m128i bytes) {
  const __m128i index = _mm_sub_epi8(bytes, _mm_set1_epi8('a'));
  const __m128i group = _mm_and_si128(index, _mm_set1_epi8((char)0xf0));
  const __m128i low = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)table), index);
  const __m128i high = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(table + 16)), index);
  return _mm_or_si128(_mm_and_si128(low, _mm_cmpeq_epi8(group, _mm_setzero_si128())),
    _mm_and_si128(high, _mm_cmpeq_epi8(group, _mm_set1_epi8(16))));
}

static __attribute__((target("ssse3"))) inline uint32_t tmt_projection_mask16(const uint8_t *source) {
  const __m128i first = _mm_loadu_si128((const __m128i *)source);
  const __m128i second = _mm_loadu_si128((const __m128i *)(source + 1));
  const __m128i keyword = _mm_and_si128(tmt_projection_lookup16(tmt_projection_heads, first),
    tmt_projection_lookup16(tmt_projection_followers, second));
  const __m128i low = _mm_and_si128(first, _mm_set1_epi8(15));
  const __m128i high = _mm_and_si128(_mm_srli_epi16(first, 4), _mm_set1_epi8(15));
  const __m128i lexical = _mm_and_si128(
    _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)tmt_projection_lexical), low),
    _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)tmt_projection_high_bits), high));
  const __m128i inactive = _mm_cmpeq_epi8(_mm_or_si128(keyword, lexical), _mm_setzero_si128());
  return (uint32_t)_mm_movemask_epi8(inactive) ^ 0xffffU;
}

static __attribute__((target("avx2"))) inline __m256i
tmt_projection_lookup32(const uint8_t *table, __m256i bytes) {
  const __m256i index = _mm256_sub_epi8(bytes, _mm256_set1_epi8('a'));
  const __m256i group = _mm256_and_si256(index, _mm256_set1_epi8((char)0xf0));
  const __m256i low = _mm256_shuffle_epi8(_mm256_broadcastsi128_si256(_mm_loadu_si128((const __m128i *)table)), index);
  const __m256i high = _mm256_shuffle_epi8(_mm256_broadcastsi128_si256(_mm_loadu_si128((const __m128i *)(table + 16))), index);
  return _mm256_or_si256(_mm256_and_si256(low, _mm256_cmpeq_epi8(group, _mm256_setzero_si256())),
    _mm256_and_si256(high, _mm256_cmpeq_epi8(group, _mm256_set1_epi8(16))));
}

static __attribute__((target("avx2"))) inline uint32_t tmt_projection_mask32(const uint8_t *source) {
  const __m256i first = _mm256_loadu_si256((const __m256i *)source);
  const __m256i second = _mm256_loadu_si256((const __m256i *)(source + 1));
  const __m256i keyword = _mm256_and_si256(tmt_projection_lookup32(tmt_projection_heads, first),
    tmt_projection_lookup32(tmt_projection_followers, second));
  const __m256i low = _mm256_and_si256(first, _mm256_set1_epi8(15));
  const __m256i high = _mm256_and_si256(_mm256_srli_epi16(first, 4), _mm256_set1_epi8(15));
  const __m256i lexical = _mm256_and_si256(
    _mm256_shuffle_epi8(_mm256_broadcastsi128_si256(_mm_loadu_si128((const __m128i *)tmt_projection_lexical)), low),
    _mm256_shuffle_epi8(_mm256_broadcastsi128_si256(_mm_loadu_si128((const __m128i *)tmt_projection_high_bits)), high));
  const __m256i inactive = _mm256_cmpeq_epi8(_mm256_or_si256(keyword, lexical), _mm256_setzero_si256());
  return ~(uint32_t)_mm256_movemask_epi8(inactive);
}

/* The selected width is supported by the CPU and has one following byte. */
static inline uint64_t tmt_projection_mask(const uint8_t *source, unsigned width) {
  return width == 32 ? tmt_projection_mask32(source) : tmt_projection_mask16(source);
}
#endif

#endif
