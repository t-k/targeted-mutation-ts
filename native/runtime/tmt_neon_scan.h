#ifndef TMT_NEON_SCAN_H
#define TMT_NEON_SCAN_H

#include <arm_neon.h>

/* The caller supplies 16 bytes. The first sentinel, or 16, is the scalar resume point. */
static inline unsigned tmt_neon_scan(const uint8_t *source, uint8_t delimiter, uint8_t extra) {
  const uint8x16_t bytes = vld1q_u8(source);
  const uint8x16_t lanes = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
  uint8x16_t hits = vorrq_u8(vceqq_u8(bytes, vdupq_n_u8(13)), vceqq_u8(bytes, vdupq_n_u8(10)));
  hits = vorrq_u8(hits, vceqq_u8(bytes, vdupq_n_u8(226)));
  hits = vorrq_u8(hits, vceqq_u8(bytes, vdupq_n_u8(delimiter)));
  hits = vorrq_u8(hits, vceqq_u8(bytes, vdupq_n_u8(extra)));
  return vminvq_u8(vbslq_u8(hits, lanes, vdupq_n_u8(16)));
}

#endif
