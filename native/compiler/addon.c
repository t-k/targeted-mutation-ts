#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#include "generated/Custard.h"

#define NAPI(call) do { if ((call) != napi_ok) goto error; } while (0)
enum { source_limit = 1048576 };

static bool ordered(TmtGrammar_span span, uint32_t size, uint32_t *previous) {
  if (span.first == span.last) return span.last <= size;
  if (span.first < *previous || span.first > span.last || span.last > size) return false;
  *previous = span.last;
  return true;
}

static napi_value compile_source(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t argc = 1, size;
  void *source;
  uint8_t *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
  if (argc != 1) goto error;
  NAPI(napi_get_buffer_info(env, arg, &source, &size));
  if (size <= source_limit) {
    const uint32_t width = (uint32_t)size;
    const TmtPulseMemory_tape input = { .source = source, .size = width };
    const TmtPulseCompiler_edit_plan plan = TmtPulseCompiler_read_plan(input);
    uint32_t previous = 0;
    const TmtGrammar_span edits[] = { plan.binding, plan.parameter, plan.result_type };
    if (plan.valid && ordered(edits[0], width, &previous) &&
        ordered(edits[1], width, &previous) && ordered(edits[2], width, &previous)) {
      if (previous != 0) {
        output = malloc(size);
        if (!output) goto error;
        memcpy(output, source, size);
        for (size_t index = 0; index < sizeof(edits) / sizeof(edits[0]); index++) {
          if (!TmtPulseCompiler_blank_range(output, width, edits[index].first, edits[index].last)) goto error;
        }
      }
      NAPI(napi_create_string_utf8(env, output ? (char *)output : (char *)source, size, &result));
      free(output);
      return result;
    }
  }
  NAPI(napi_get_null(env, &result));
  return result;
error:
  free(output);
  napi_throw_error(env, NULL, "Native compilation arguments or allocation failed");
  return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value entry;
  NAPI(napi_create_function(env, "compile", NAPI_AUTO_LENGTH, compile_source, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "compile", entry));
  return exports;
error:
  napi_throw_error(env, NULL, "Unable to register the native compiler");
  return NULL;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
