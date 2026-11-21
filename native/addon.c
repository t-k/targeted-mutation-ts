#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#include "parser.h"
#ifdef TMT_WITH_OXC
#include "syntax.h"
#include "TmtScan.h"
#endif

#define NAPI(call) do { if ((call) != napi_ok) goto error; } while (0)

static napi_value parse(napi_env env, napi_callback_info info) {
  napi_value args[3];
  size_t argc = 3;
  void *source;
  size_t size;
  bool tsx, module;
  TmtGrammar_candidate initial[16];
  TmtGrammar_candidate *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 3) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_bool(env, args[1], &tsx));
  NAPI(napi_get_value_bool(env, args[2], &module));
  uint32_t capacity = (uint32_t)(sizeof(initial) / sizeof(*initial));
  uint32_t heap_bytes = 0;
  tmt_result result = size > TMT_SOURCE_MAX ? (tmt_result){ TMT_SOURCE_LIMIT, 0, 0 } :
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

  napi_value array, value;
  NAPI(napi_create_array_with_length(env, (size_t)result.count + 4, &array));
  const uint32_t metrics[] = {
    result.status, result.max_depth, 0, heap_bytes,
  };
  for (uint32_t index = 0; index < 4; index++) {
    NAPI(napi_create_uint32(env, metrics[index], &value));
    NAPI(napi_set_element(env, array, index, value));
  }
  for (uint32_t index = 0; index < result.count; index++) {
    TmtGrammar_candidate candidate = records[index];
    const uint32_t fields[] = {
      candidate.original, candidate.replacement, candidate.edit.first, candidate.edit.last,
      candidate.left.first, candidate.left.last, candidate.right.first, candidate.right.last,
    };
    napi_value row;
    NAPI(napi_create_array_with_length(env, 8, &row));
    for (uint32_t col = 0; col < 8; col++) {
      NAPI(napi_create_uint32(env, fields[col], &value));
      NAPI(napi_set_element(env, row, col, value));
    }
    NAPI(napi_set_element(env, array, index + 4, row));
  }
  free(output);
  return array;
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

#ifdef TMT_WITH_OXC
static bool syntax_candidate_valid(const uint8_t *source, uint32_t size, const tmt_syntax_candidate *candidate) {
  const uint32_t start = candidate->edit[0];
  const uint32_t end = candidate->edit[1];
  const uint32_t op = candidate->operator;
  if (op < 1 || op > 5 || candidate->left[0] > candidate->left[1] ||
      candidate->right[0] > candidate->right[1] || candidate->left[1] > start ||
      start >= end || end > candidate->right[0] || candidate->right[1] > size) return false;
  if (op == 5) {
    return end - start == 2 && source[start] == '|' && source[start + 1] == '|' &&
      candidate->expression[0] == candidate->left[0] && candidate->expression[1] == candidate->right[1];
  }
  return TmtScan_source_boundary(source, size, start) == op && end - start == (op % 2 == 0 ? 2u : 1u);
}

static napi_value syntax(napi_env env, napi_callback_info info) {
  enum { COLUMNS = 9, METRICS = 2 };
  _Static_assert(sizeof(tmt_syntax_candidate) == COLUMNS * sizeof(uint32_t), "Unexpected Rust candidate layout");
  napi_value args[3], backing, result;
  size_t argc = 3, size;
  void *source, *data;
  bool tsx, logical;
  tmt_syntax_result parsed = {0};
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 3) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_bool(env, args[1], &tsx));
  NAPI(napi_get_value_bool(env, args[2], &logical));
  if (size > TMT_SOURCE_MAX || !tmt_syntax_parse(source, size, tsx, logical, &parsed)) {
    NAPI(napi_get_null(env, &result));
    return result;
  }
  if (parsed.len > (SIZE_MAX / sizeof(uint32_t) - METRICS) / COLUMNS) goto error;
  for (size_t i = 0; i < parsed.len; i++) {
    if (!syntax_candidate_valid(source, (uint32_t)size, &parsed.rows[i])) {
      tmt_syntax_free(parsed.rows, parsed.len);
      parsed.rows = NULL;
      NAPI(napi_get_null(env, &result));
      return result;
    }
  }
  const size_t length = METRICS + COLUMNS * parsed.len;
  NAPI(napi_create_arraybuffer(env, length * sizeof(uint32_t), &data, &backing));
  uint32_t *values = data;
  values[0] = parsed.ast_nodes;
  values[1] = parsed.max_depth;
  if (parsed.len) memcpy(values + METRICS, parsed.rows, sizeof(*parsed.rows) * parsed.len);
  NAPI(napi_create_typedarray(env, napi_uint32_array, length, backing, 0, &result));
  tmt_syntax_free(parsed.rows, parsed.len);
  return result;
error:
  if (parsed.rows) tmt_syntax_free(parsed.rows, parsed.len);
  napi_throw_error(env, NULL, "Native syntax extractor arguments or allocation failed");
  return NULL;
}
#endif

static napi_value init(napi_env env, napi_value exports) {
  napi_value entry;
  if (napi_create_function(env, "parse", NAPI_AUTO_LENGTH, parse, NULL, &entry) != napi_ok ||
      napi_set_named_property(env, exports, "parse", entry) != napi_ok ||
      napi_create_function(env, "locations", NAPI_AUTO_LENGTH, locations, NULL, &entry) != napi_ok ||
      napi_set_named_property(env, exports, "locations", entry) != napi_ok ||
#ifdef TMT_WITH_OXC
      napi_create_function(env, "syntax", NAPI_AUTO_LENGTH, syntax, NULL, &entry) != napi_ok ||
      napi_set_named_property(env, exports, "syntax", entry) != napi_ok) {
#else
      napi_get_boolean(env, true, &entry) != napi_ok ||
      napi_set_named_property(env, exports, "standalone", entry) != napi_ok) {
#endif
    napi_throw_error(env, NULL, "Unable to register the native parser");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
