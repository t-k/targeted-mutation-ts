#ifndef TMT_COMPILER_FAST_STRIP_H
#define TMT_COMPILER_FAST_STRIP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Single-pass, zero-allocation ASCII TypeScript type-eraser for non-JSX ES modules.
 * Strictly parses every erased TypeScript construct and declines to the verified Pulse
 * parser on any unsupported, ambiguous, or malformed syntax. Caller must validate the
 * resulting JavaScript module with V8 before publishing.
 *
 * Returns a pointer into `source` (when unedited, `*edited = false`) or into `out_buf`
 * (when edited, `*edited = true`), or NULL when declining. `out_buf` must have capacity
 * at least `size + 16`.
 */
char *tmt_fast_strip_module(const uint8_t *source, uint32_t size, uint32_t first_at, bool esm,
  char *out_buf, size_t *out_len, bool *edited);

#endif
