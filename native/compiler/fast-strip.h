#ifndef TMT_FAST_STRIP_H
#define TMT_FAST_STRIP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t out;
  uint32_t src;
  uint32_t length;
} fs_run_t;

typedef struct {
  char *data;
  size_t len;
  size_t cap;
  fs_run_t *runs;
  uint32_t run_count;
  uint32_t run_cap;
  bool record_runs;
  bool type_only;
  bool failed;
} fs_lower_buf_t;

/*
 * Single-pass, zero-allocation TypeScript type-eraser (and optional enum/namespace lowerer)
 * for non-JSX ES modules.
 *
 * When `lower_buf` is non-NULL, simple `enum`/`const enum` and `namespace` declarations are
 * lowered directly into `lower_buf` on demand with zero overhead for files without them.
 *
 * Returns a pointer to the emitted JS (either `source`, `out_buf`, or `lower_buf->data`),
 * or NULL if the input contains unsupported/ambiguous syntax and should fall back.
 */
char *tmt_fast_strip_module(const uint8_t *source, uint32_t size, uint32_t first_at, bool esm,
  char *out_buf, size_t *out_len, bool *edited);

char *tmt_fast_strip_module_ex(const uint8_t *source, uint32_t size, uint32_t first_at, bool esm,
  char *out_buf, size_t *out_len, bool *edited, fs_lower_buf_t *lower_buf);

char *tmt_fast_strip_tsx(const uint8_t *source, uint32_t size, uint32_t first_at,
  char *out_buf, size_t *out_len, bool *edited, fs_lower_buf_t *lower_buf);

#endif
