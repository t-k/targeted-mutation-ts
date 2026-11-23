#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#include "Custard.h"
#include "lowering.h"

#define NAPI(call) do { if ((call) != napi_ok) goto error; } while (0)
enum { source_limit = 1048576, binding_capacity = 2367 };

#ifdef TMT_DIRECT

static bool ordered(TmtGrammar_span span, uint32_t size, uint32_t *previous) {
  if (span.first == span.last) return span.last <= size;
  if (span.first < *previous || span.first > span.last || span.last > size) return false;
  *previous = span.last;
  return true;
}

static bool blank_edits(uint8_t *output, uint32_t size, TmtPulseCompiler_edit_plan plan) {
  return TmtPulseCompiler_blank_range(output, size, plan.binding.first, plan.binding.last) &&
    TmtPulseCompiler_blank_range(output, size, plan.parameter.first, plan.parameter.last) &&
    TmtPulseCompiler_blank_range(output, size, plan.result_type.first, plan.result_type.last);
}

enum { declaration_limit = 512, declaration_slots = 1024 };

static bool new_binding(const uint8_t *source, TmtGrammar_span name, TmtGrammar_span *seen) {
  uint32_t hash = 2166136261U;
  for (uint32_t at = name.first; at < name.last; at++) hash = (hash ^ source[at]) * 16777619U;
  unsigned slot = hash % declaration_slots;
  const uint32_t size = name.last - name.first;
  while (seen[slot].last) {
    const TmtGrammar_span entry = seen[slot];
    if (entry.last - entry.first == size && !memcmp(source + entry.first, source + name.first, size)) return false;
    slot = (slot + 1) % declaration_slots;
  }
  seen[slot] = name;
  return true;
}

static bool blank_declarations(TmtPulseMemory_tape input, uint8_t *output, TmtPulseCompiler_edit_plan plan) {
  TmtGrammar_span seen[declaration_slots] = {0};
  uint32_t start = 0;
  for (unsigned count = 0; count < declaration_limit; count++) {
    uint32_t previous = start;
    if (!plan.valid || plan.stop <= start || plan.stop > input.size ||
        plan.name_span.first < start || plan.name_span.first >= plan.name_span.last ||
        plan.name_span.last > plan.stop ||
        !ordered(plan.binding, plan.stop, &previous) ||
        !ordered(plan.parameter, plan.stop, &previous) ||
        !ordered(plan.result_type, plan.stop, &previous) ||
        !new_binding(input.source, plan.name_span, seen) || !blank_edits(output, input.size, plan)) return false;
    if (plan.stop == input.size) return true;
    start = plan.stop;
    plan = TmtPulseCompiler_read_plan(input, start);
  }
  return false;
}

#else
static bool contains_comment_marker(const uint8_t *source, uint32_t size) {
  for (uint32_t index = 0; index + 1 < size; index++) {
    if (source[index] == '/' && (source[index + 1] == '/' || source[index + 1] == '*')) return true;
  }
  return false;
}

static uint8_t *copy_type_only_trivia(TmtPulseMemory_tape input, bool esm, size_t *length) {
  enum { capacity = 512 };
  TmtGrammar_candidate spans[capacity];
  uint8_t marks[capacity] = {0};
  input.capture_jsx = true;
  input.output = spans;
  input.capacity = capacity;
  input.marks = marks;
  const TmtPulseParser_parser_state parsed = TmtPulseCompiler_type_only_module(input);
  if (parsed.status != 0 || parsed.count > capacity) return NULL;
  const char suffix[] = "\nexport {};\n";
  uint8_t *code = malloc((size_t)input.size + sizeof(suffix));
  if (!code) return NULL;
  uint32_t previous = 0;
  size_t written = 0;
  for (uint32_t index = 0; index < parsed.count; index++) {
    const TmtGrammar_span span = spans[index].left;
    if (spans[index].original != 6 || span.first < previous || span.first >= span.last || span.last > input.size) {
      free(code);
      return NULL;
    }
    const uint32_t gap = span.first - previous;
    memcpy(code + written, input.source + previous, gap);
    written += gap;
    previous = span.last;
  }
  memcpy(code + written, input.source + previous, input.size - previous);
  written += input.size - previous;
  if (esm) {
    memcpy(code + written, suffix, sizeof(suffix) - 1);
    written += sizeof(suffix) - 1;
  }
  *length = written;
  return code;
}

static uint8_t *type_only_module(uint8_t *source, uint32_t size, bool esm, size_t *length) {
  TmtPulseMemory_binding_name bindings[binding_capacity] = {0};
  TmtGrammar_candidate output;
  uint8_t mark;
  const TmtPulseMemory_tape input = {
    .source = source, .size = size, .output = &output, .bindings = bindings, .marks = &mark,
  };
  if (TmtPulseCompiler_type_only_module(input).status != 0) return NULL;
  if ((size >= 2 && source[0] == '#' && source[1] == '!') || contains_comment_marker(source, size)) {
    return copy_type_only_trivia(input, esm, length);
  }
  const char marker[] = "export {};\n";
  uint8_t *code = malloc(sizeof(marker));
  if (!code) return NULL;
  memcpy(code, marker, sizeof(marker));
  *length = esm ? sizeof(marker) - 1 : 0;
  return code;
}

static napi_value erase_type_module(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2, size, length;
  bool esm;
  void *source;
  uint8_t *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_bool(env, args[1], &esm));
  if (size <= source_limit) output = type_only_module(source, (uint32_t)size, esm, &length);
  if (output) {
    NAPI(napi_create_string_utf8(env, (char *)output, length, &result));
    free(output);
  } else {
    NAPI(napi_get_null(env, &result));
  }
  return result;
error:
  free(output);
  napi_throw_type_error(env, NULL, "Expected a source buffer and an ESM flag");
  return NULL;
}

#endif

#ifdef TMT_DIRECT
static bool unshared_buffer(napi_env env, napi_value value) {
  napi_value backing;
  bool ordinary;
  return napi_get_typedarray_info(env, value, NULL, NULL, NULL, &backing, NULL) == napi_ok &&
    napi_is_arraybuffer(env, backing, &ordinary) == napi_ok && ordinary;
}

static bool ascii_buffer(const uint8_t *source, size_t size) {
  while (size >= 8) {
    uint64_t word;
    memcpy(&word, source, sizeof(word));
    if (word & UINT64_C(0x8080808080808080)) return false;
    source += 8;
    size -= 8;
  }
  while (size) {
    if (*source++ >= 128) return false;
    size--;
  }
  return true;
}

static napi_value compile_direct(napi_env env, napi_callback_info info, bool ascii_export) {
  napi_value arg, result;
  size_t argc = 1, size;
  void *source;
  uint8_t *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
  if (argc != 1) goto error;
  NAPI(napi_get_buffer_info(env, arg, &source, &size));
  if (ascii_export && (!size || !unshared_buffer(env, arg) || ((const uint8_t *)source)[0] != 'e')) {
    NAPI(napi_get_undefined(env, &result));
    return result;
  }
  if (size <= source_limit) {
    const uint32_t width = (uint32_t)size;
    const TmtPulseMemory_tape input = { .source = source, .size = width };
    const TmtPulseCompiler_edit_plan plan = TmtPulseCompiler_read_plan(input, 0);
    /* Validate encoding only when the direct plan would publish source bytes. */
    if (ascii_export && plan.valid && !ascii_buffer(source, size)) {
      NAPI(napi_get_undefined(env, &result));
      return result;
    }
    uint32_t previous = 0;
    const TmtGrammar_span edits[] = { plan.binding, plan.parameter, plan.result_type };
    if (plan.valid && plan.stop == width && ordered(edits[0], width, &previous) &&
        ordered(edits[1], width, &previous) && ordered(edits[2], width, &previous)) {
      if (previous != 0) {
        output = malloc(size);
        if (!output) goto error;
        memcpy(output, source, size);
        if (!blank_edits(output, width, plan)) goto error;
      }
      NAPI(napi_create_string_utf8(env, output ? (char *)output : (char *)source, size, &result));
      free(output);
      return result;
    }
    if (plan.valid && plan.stop < width) {
      output = malloc(size);
      if (!output) goto error;
      memcpy(output, source, size);
      const bool valid = blank_declarations(input, output, plan);
      if (valid) NAPI(napi_create_string_utf8(env, (char *)output, size, &result));
      free(output);
      output = NULL;
      if (valid) return result;
    }
  }
  NAPI(napi_get_null(env, &result));
  return result;
error:
  free(output);
  napi_throw_error(env, NULL, "Native compilation arguments or allocation failed");
  return NULL;
}
static napi_value compile_source(napi_env env, napi_callback_info info) {
  return compile_direct(env, info, false);
}

static napi_value compile_ascii_export(napi_env env, napi_callback_info info) {
  return compile_direct(env, info, true);
}
#endif

static napi_value lower_source(napi_env env, napi_callback_info info) {
  napi_value args[5], result;
  size_t argc = 5, size, length;
  bool jsx, typescript, classic, mixed, complete;
  void *source;
  char *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 5) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_bool(env, args[1], &jsx));
  NAPI(napi_get_value_bool(env, args[2], &typescript));
  NAPI(napi_get_value_bool(env, args[3], &classic));
  NAPI(napi_get_value_bool(env, args[4], &mixed));
  if (size <= source_limit) output = tmt_lower_runtime(source, (uint32_t)size, jsx, typescript, classic, mixed, &length, &complete);
  if (output) {
    NAPI(napi_create_string_utf8(env, output, length, &result));
    if (complete) {
      napi_value code = result;
      NAPI(napi_create_object(env, &result));
      NAPI(napi_set_named_property(env, result, "code", code));
    }
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

#ifndef TMT_DIRECT
static napi_value emit_annotated_module(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  size_t argc = 3, size, length;
  bool enums, esm, checked = false, complete = false;
  tmt_parameter_route property = TMT_PARAMETER_NONE;
  void *source;
  char *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 3) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  NAPI(napi_get_value_bool(env, args[1], &enums));
  NAPI(napi_get_value_bool(env, args[2], &esm));
  if (size <= source_limit) {
    output = tmt_emit_annotated_module(source, (uint32_t)size, enums, esm, &length, &checked, &complete, &property);
  }
  if (output) {
    NAPI(napi_create_string_utf8(env, output, length, &result));
    if (!complete) {
      napi_value code = result;
      NAPI(napi_create_object(env, &result));
      NAPI(napi_set_named_property(env, result, "code", code));
    }
    free(output);
  } else if (property != TMT_PARAMETER_NONE) {
    napi_value value;
    NAPI(napi_create_object(env, &result));
    NAPI(napi_get_boolean(env, true, &value));
    const char *key = property == TMT_PARAMETER_REFERENCE ? "reference" : "parameterProperty";
    NAPI(napi_set_named_property(env, result, key, value));
  } else if (checked) {
    NAPI(napi_get_boolean(env, true, &result));
  } else {
    NAPI(napi_get_null(env, &result));
  }
  return result;
error:
  free(output);
  napi_throw_type_error(env, NULL, "Expected a source buffer");
  return NULL;
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
  const bool accepted = size && size <= source_limit && tmt_module_marker(source, (uint32_t)size, validate);
  NAPI(napi_get_boolean(env, accepted, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer and validation flag");
  return NULL;
}

static napi_value unbound_export(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t argc = 1, size;
  void *source;
  NAPI(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
  if (argc != 1) goto error;
  NAPI(napi_get_buffer_info(env, arg, &source, &size));
  const bool accepted = size && size <= source_limit && tmt_unbound_export(source, (uint32_t)size);
  NAPI(napi_get_boolean(env, accepted, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer");
  return NULL;
}

static napi_value plain_script(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t argc = 1, size;
  void *source;
  NAPI(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
  if (argc != 1) goto error;
  NAPI(napi_get_buffer_info(env, arg, &source, &size));
  const bool accepted = size && size <= source_limit && tmt_plain_script(source, (uint32_t)size);
  NAPI(napi_get_boolean(env, accepted, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer");
  return NULL;
}

#ifdef TMT_V8_VALIDATOR
static napi_value valid_module(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t argc = 1, size;
  void *source;
  NAPI(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
  if (argc != 1) goto error;
  NAPI(napi_get_buffer_info(env, arg, &source, &size));
  const bool accepted = tmt_valid_module_source(size ? source : "", size);
  NAPI(napi_get_boolean(env, accepted, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer");
  return NULL;
}
#endif

static napi_value trivia_only(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t argc = 1, size;
  void *source;
  NAPI(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
  if (argc != 1) goto error;
  NAPI(napi_get_buffer_info(env, arg, &source, &size));
  bool empty = size == 0;
  if (size && size <= source_limit) {
    const TmtPulseMemory_tape input = { .source = source, .size = (uint32_t)size };
    const TmtPulseParser_cursor end = TmtPulseCompiler_runtime_source_start(input);
    empty = end.ok && end.at == size;
  }
  NAPI(napi_get_boolean(env, empty, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer");
  return NULL;
}

#endif

static napi_value leading_directive(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t argc = 1, size;
  void *source;
  NAPI(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
  if (argc != 1) goto error;
  NAPI(napi_get_buffer_info(env, arg, &source, &size));
  const bool directive = size > source_limit || tmt_leading_directive(source, (uint32_t)size);
  NAPI(napi_get_boolean(env, directive, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer");
  return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value entry;
#ifdef TMT_DIRECT
  NAPI(napi_create_function(env, "compile", NAPI_AUTO_LENGTH, compile_source, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "compile", entry));
  NAPI(napi_create_function(env, "compileAscii", NAPI_AUTO_LENGTH, compile_ascii_export, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "compileAscii", entry));
#endif
  NAPI(napi_create_function(env, "lower", NAPI_AUTO_LENGTH, lower_source, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "lower", entry));
#ifndef TMT_DIRECT
  NAPI(napi_create_function(env, "eraseTypeModule", NAPI_AUTO_LENGTH, erase_type_module, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "eraseTypeModule", entry));
  NAPI(napi_create_function(env, "emitAnnotatedModule", NAPI_AUTO_LENGTH, emit_annotated_module, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "emitAnnotatedModule", entry));
  NAPI(napi_create_function(env, "moduleMarker", NAPI_AUTO_LENGTH, module_marker, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "moduleMarker", entry));
  NAPI(napi_create_function(env, "unboundExport", NAPI_AUTO_LENGTH, unbound_export, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "unboundExport", entry));
  NAPI(napi_create_function(env, "plainScript", NAPI_AUTO_LENGTH, plain_script, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "plainScript", entry));
#ifdef TMT_V8_VALIDATOR
  NAPI(napi_create_function(env, "validModule", NAPI_AUTO_LENGTH, valid_module, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "validModule", entry));
#endif
  NAPI(napi_create_function(env, "triviaOnly", NAPI_AUTO_LENGTH, trivia_only, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "triviaOnly", entry));
#endif
  NAPI(napi_create_function(env, "leadingDirective", NAPI_AUTO_LENGTH, leading_directive, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "leadingDirective", entry));
  return exports;
error:
  napi_throw_error(env, NULL, "Unable to register the native compiler");
  return NULL;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
