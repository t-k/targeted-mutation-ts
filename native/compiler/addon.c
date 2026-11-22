#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#include "generated/Custard.h"
#include "lowering.h"

#define NAPI(call) do { if ((call) != napi_ok) goto error; } while (0)
enum { source_limit = 1048576, binding_capacity = 2367 };

static bool ordered(TmtGrammar_span span, uint32_t size, uint32_t *previous) {
  if (span.first == span.last) return span.last <= size;
  if (span.first < *previous || span.first > span.last || span.last > size) return false;
  *previous = span.last;
  return true;
}

static bool contains_comment_marker(const uint8_t *source, uint32_t size) {
  for (uint32_t index = 0; index + 1 < size; index++) {
    if (source[index] == '/' && (source[index + 1] == '/' || source[index + 1] == '*')) return true;
  }
  return false;
}

static bool type_only_module(uint8_t *source, uint32_t size) {
  TmtPulseMemory_binding_name bindings[binding_capacity] = {0};
  TmtGrammar_candidate output;
  uint8_t mark;
  const TmtPulseMemory_tape input = {
    .source = source, .size = size, .output = &output, .bindings = bindings, .marks = &mark,
  };
  return TmtPulseCompiler_type_only_module(input);
}

static napi_value compile_source(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2, size;
  uint32_t type_only_output;
  void *source;
  uint8_t *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_uint32(env, args[1], &type_only_output));
  if (type_only_output > 2) goto error;
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
    if (type_only_output != 0 && type_only_module(source, width) && !contains_comment_marker(source, width)) {
      const char *code = type_only_output == 2 ? "export {};\n" : "";
      NAPI(napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &result));
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

static napi_value lower_source(napi_env env, napi_callback_info info) {
  napi_value args[5], result;
  size_t argc = 5, size, length;
  bool jsx, typescript, classic, mixed;
  void *source;
  char *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 5) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_bool(env, args[1], &jsx));
  NAPI(napi_get_value_bool(env, args[2], &typescript));
  NAPI(napi_get_value_bool(env, args[3], &classic));
  NAPI(napi_get_value_bool(env, args[4], &mixed));
  if (size <= source_limit) output = tmt_lower_runtime(source, (uint32_t)size, jsx, typescript, classic, mixed, &length);
  if (output) {
    NAPI(napi_create_string_utf8(env, output, length, &result));
    free(output);
  } else {
    NAPI(napi_get_null(env, &result));
  }
  return result;
error:
  free(output);
  napi_throw_error(env, NULL, "Native runtime lowering arguments or allocation failed");
  return NULL;
}

static bool validate_erasable(uint8_t *source, uint32_t size) {
  TmtPulseMemory_binding_name bindings[binding_capacity] = {0};
  TmtGrammar_candidate candidates[128];
  uint8_t marks[128] = {0};
  const TmtPulseMemory_tape input = {
    .source = source, .size = size, .private_possible = memchr(source, '#', size) != NULL,
    .output = candidates, .capacity = sizeof(candidates) / sizeof(*candidates),
    .bindings = bindings, .marks = marks,
  };
  return TmtPulseCompiler_erasable_module(input, false);
}

static napi_value module_marker(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2, size;
  bool validate;
  void *source;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_bool(env, args[1], &validate));
  bool accepted = false;
  if (size && size <= source_limit) {
    if (validate) accepted = validate_erasable(source, (uint32_t)size);
    else {
      const TmtPulseMemory_tape input = { .source = source, .size = (uint32_t)size };
      accepted = TmtPulseCompiler_runtime_module_marker(input);
    }
  }
  NAPI(napi_get_boolean(env, accepted, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer and validation flag");
  return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value entry;
  NAPI(napi_create_function(env, "compile", NAPI_AUTO_LENGTH, compile_source, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "compile", entry));
  NAPI(napi_create_function(env, "lower", NAPI_AUTO_LENGTH, lower_source, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "lower", entry));
  NAPI(napi_create_function(env, "moduleMarker", NAPI_AUTO_LENGTH, module_marker, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "moduleMarker", entry));
  return exports;
error:
  napi_throw_error(env, NULL, "Unable to register the native compiler");
  return NULL;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
