#include <node_api.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#include "parser.h"

#define NAPI(call) do { if ((call) != napi_ok) goto error; } while (0)

static napi_value parse(napi_env env, napi_callback_info info) {
  napi_value args[3];
  size_t argc = 3;
  void *source;
  size_t size;
  bool tsx, module;
  TmtGrammar_candidate initial[64];
  TmtGrammar_candidate *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 3) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_bool(env, args[1], &tsx));
  NAPI(napi_get_value_bool(env, args[2], &module));
  uint32_t capacity = (uint32_t)(sizeof(initial) / sizeof(*initial));
  uint32_t heap_bytes = 0;
  tmt_result result = size > TMT_SOURCE_MAX ? (tmt_result){ .status = TMT_SOURCE_LIMIT } :
    tmt_parse(source, (uint32_t)size, tsx, module, initial, capacity);
  if (result.status == TMT_CANDIDATE_LIMIT) {
    capacity = (uint32_t)(size / 3);
    if (capacity > TMT_CANDIDATES_MAX) capacity = TMT_CANDIDATES_MAX;
    heap_bytes = capacity * (uint32_t)sizeof(*output);
    output = malloc(heap_bytes);
    if (!output) goto error;
    result = tmt_parse(source, (uint32_t)size, tsx, module, output, capacity);
  }
  const TmtGrammar_candidate *records = output ? output : initial;

  enum { METRICS = 4, COLUMNS = 8 };
  _Static_assert(sizeof(TmtGrammar_candidate) == COLUMNS * sizeof(uint32_t) &&
    offsetof(TmtGrammar_candidate, original) == 0 &&
    offsetof(TmtGrammar_candidate, replacement) == sizeof(uint32_t) &&
    offsetof(TmtGrammar_candidate, edit) == 2 * sizeof(uint32_t) &&
    offsetof(TmtGrammar_candidate, left) == 4 * sizeof(uint32_t) &&
    offsetof(TmtGrammar_candidate, right) == 6 * sizeof(uint32_t) &&
    offsetof(TmtGrammar_span, first) == 0 && offsetof(TmtGrammar_span, last) == sizeof(uint32_t),
    "Unexpected candidate layout");
  const bool duplicate = result.status == TMT_DUPLICATE_LEXICAL;
  const size_t length = METRICS + (duplicate ? 4 : (size_t)result.count * COLUMNS);
  napi_value backing, packed;
  void *data;
  NAPI(napi_create_arraybuffer(env, length * sizeof(uint32_t), &data, &backing));
  uint32_t *cells = data;
  cells[0] = result.status;
  cells[1] = result.max_depth;
  cells[2] = 0;
  cells[3] = heap_bytes;
  if (duplicate) {
    cells[4] = result.first_name.first;
    cells[5] = result.first_name.last;
    cells[6] = result.repeated_name.first;
    cells[7] = result.repeated_name.last;
  } else if (result.count) {
    memcpy(cells + METRICS, records, (size_t)result.count * sizeof(*records));
  }
  NAPI(napi_create_typedarray(env, napi_uint32_array, length, backing, 0, &packed));
  free(output);
  return packed;
error:
  free(output);
  napi_throw_error(env, NULL, "Native parser arguments or allocation failed");
  return NULL;
}

static napi_value locations(napi_env env, napi_callback_info info) {
  napi_value args[2], backing, result;
  size_t argc = 2, size, count;
  napi_typedarray_type type;
  void *source, *offsets, *positions;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_typedarray_info(env, args[1], &type, &count, &offsets, NULL, NULL));
  if (type != napi_uint32_array || size >= UINT32_MAX || count > SIZE_MAX / (2 * sizeof(uint32_t))) goto error;
  NAPI(napi_create_arraybuffer(env, count * 2 * sizeof(uint32_t), &positions, &backing));
  if (!tmt_locate_positions(source, (uint32_t)size, offsets, count, positions)) goto error;
  NAPI(napi_create_typedarray(env, napi_uint32_array, count * 2, backing, 0, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer and ordered UTF-8 byte boundaries");
  return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value entry;
  if (napi_create_function(env, "parse", NAPI_AUTO_LENGTH, parse, NULL, &entry) != napi_ok ||
      napi_set_named_property(env, exports, "parse", entry) != napi_ok ||
      napi_create_function(env, "locations", NAPI_AUTO_LENGTH, locations, NULL, &entry) != napi_ok ||
      napi_set_named_property(env, exports, "locations", entry) != napi_ok) {
    napi_throw_error(env, NULL, "Unable to register the native parser");
    return NULL;
  }
#ifdef TMT_LOW_ONLY
  if (napi_get_boolean(env, true, &entry) != napi_ok ||
      napi_set_named_property(env, exports, "standalone", entry) != napi_ok) {
    napi_throw_error(env, NULL, "Unable to register the standalone parser");
    return NULL;
  }
#endif
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
