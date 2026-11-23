#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#include "Custard.h"
#include "lowering.h"

#define NAPI(call) do { if ((call) != napi_ok) goto error; } while (0)
enum { source_limit = 1048576, binding_capacity = 2367 };

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

#ifndef TMT_DIRECT
/* The restricted export plan. Returns false when the plan declines, and sets failed on allocation failure. */
static bool direct_plan(uint8_t *source, size_t size, uint8_t **output, bool *failed) {
  *output = NULL;
  *failed = false;
  if (size > source_limit) return false;
  const uint32_t width = (uint32_t)size;
  const TmtPulseMemory_tape input = { .source = source, .size = width };
  const TmtPulseCompiler_edit_plan plan = TmtPulseCompiler_read_plan(input, 0);
  uint32_t previous = 0;
  const TmtGrammar_span edits[] = { plan.binding, plan.parameter, plan.result_type };
  if (plan.valid && plan.stop == width && ordered(edits[0], width, &previous) &&
      ordered(edits[1], width, &previous) && ordered(edits[2], width, &previous)) {
    if (previous != 0) {
      *output = malloc(size);
      if (!*output) return !(*failed = true);
      memcpy(*output, source, size);
      if (!blank_edits(*output, width, plan)) return !(*failed = true);
    }
    return true;
  }
  if (plan.valid && plan.stop < width) {
    *output = malloc(size);
    if (!*output) return !(*failed = true);
    memcpy(*output, source, size);
    if (blank_declarations(input, *output, plan)) return true;
    free(*output);
    *output = NULL;
  }
  return false;
}

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

static bool unshared_buffer(napi_env env, napi_value value) {
  napi_value backing;
  bool ordinary;
  return napi_get_typedarray_info(env, value, NULL, NULL, NULL, &backing, NULL) == napi_ok &&
    napi_is_arraybuffer(env, backing, &ordinary) == napi_ok && ordinary;
}

#ifdef TMT_DIRECT
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

/* Length of the leading ASCII run, tested 32 bytes at a time. */
static size_t ascii_prefix(const uint8_t *text, size_t size) {
  size_t at = 0;
  for (; size - at >= 32; at += 32) {
    uint64_t words[4];
    memcpy(words, text + at, sizeof(words));
    if ((words[0] | words[1] | words[2] | words[3]) & UINT64_C(0x8080808080808080)) break;
  }
  while (at < size && text[at] < 0x80) at++;
  return at;
}

static bool ascii_text(const char *text, size_t size) {
  return ascii_prefix((const uint8_t *)text, size) == size;
}

/*
 * Widens well-formed UTF-8 whose ASCII runs dominate. Returns the number of code units, or
 * SIZE_MAX for a sequence this decoder does not accept.
 */
static size_t widen_utf8(const uint8_t *text, size_t size, uint16_t *wide) {
  size_t at = 0, units = 0;
  while (at < size) {
    const size_t run = ascii_prefix(text + at, size - at);
    for (size_t index = 0; index < run; index++) wide[units + index] = text[at + index];
    at += run;
    units += run;
    if (at == size) break;
    const uint8_t lead = text[at];
    const size_t width = lead >= 0xc2 && lead <= 0xdf ? 2 : (lead & 0xf0) == 0xe0 ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (!width || size - at < width) return SIZE_MAX;
    uint32_t scalar = lead & (0xffU >> (width + 1));
    for (size_t tail = 1; tail < width; tail++) {
      if ((text[at + tail] & 0xc0) != 0x80) return SIZE_MAX;
      scalar = (scalar << 6) | (text[at + tail] & 0x3fU);
    }
    const uint32_t least = width == 2 ? 0x80 : width == 3 ? 0x800 : 0x10000;
    if (scalar < least || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) return SIZE_MAX;
    if (scalar < 0x10000) wide[units++] = (uint16_t)scalar;
    else {
      wide[units++] = (uint16_t)(0xd800 + ((scalar - 0x10000) >> 10));
      wide[units++] = (uint16_t)(0xdc00 + ((scalar - 0x10000) & 0x3ff));
    }
    at += width;
  }
  return units;
}

/* ASCII output needs no UTF-8 decoding, and other output is widened here in one pass. */
static napi_status create_source_string(napi_env env, const char *text, size_t size, napi_value *result) {
  if (ascii_text(text, size)) return napi_create_string_latin1(env, text, size, result);
  uint16_t *wide = malloc(size * sizeof(*wide));
  const size_t units = wide ? widen_utf8((const uint8_t *)text, size, wide) : SIZE_MAX;
  const napi_status created = units == SIZE_MAX ? napi_create_string_utf8(env, text, size, result) :
    napi_create_string_utf16(env, (const char16_t *)wide, units, result);
  free(wide);
  return created;
}

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
    NAPI(create_source_string(env, output, length, &result));
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
  napi_value args[4], result;
  size_t argc = 4, size, length;
  bool enums = false, esm, allow_script = false, checked = false, complete = false, script = false;
  napi_valuetype hint;
  tmt_parameter_route property = TMT_PARAMETER_NONE;
  void *source;
  char *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 3 && argc != 4) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &source, &size));
  /* An undefined hint lets the emitter look for the word only where the route depends on it. */
  NAPI(napi_typeof(env, args[1], &hint));
  if (hint != napi_undefined) NAPI(napi_get_value_bool(env, args[1], &enums));
  NAPI(napi_get_value_bool(env, args[2], &esm));
  if (argc == 4) NAPI(napi_get_value_bool(env, args[3], &allow_script));
  if (size <= source_limit) {
    output = tmt_emit_annotated_module(source, (uint32_t)size,
      hint == napi_undefined ? TMT_ENUMS_UNKNOWN : enums ? TMT_ENUMS_PRESENT : TMT_ENUMS_ABSENT, esm, allow_script,
      &length, &checked, &complete, &script, &property);
  }
  if (output) {
    NAPI(create_source_string(env, output, length, &result));
    if (!complete || script) {
      napi_value code = result;
      NAPI(napi_create_object(env, &result));
      NAPI(napi_set_named_property(env, result, script ? "script" : "code", code));
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

/* Well-formed UTF-8 as defined by the Unicode standard, table 3-7. */
static bool valid_utf8(const uint8_t *text, size_t size) {
  size_t at = 0;
  while (at < size) {
    const uint8_t lead = text[at];
    if (lead < 0x80) {
      at += ascii_prefix(text + at, size - at);
      continue;
    }
    const size_t width = lead >= 0xc2 && lead <= 0xdf ? 2 : (lead & 0xf0) == 0xe0 ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (!width || size - at < width) return false;
    const uint8_t second = text[at + 1];
    const uint8_t low = lead == 0xe0 ? 0xa0 : lead == 0xf0 ? 0x90 : 0x80;
    const uint8_t high = lead == 0xed ? 0x9f : lead == 0xf4 ? 0x8f : 0xbf;
    if (second < low || second > high) return false;
    for (size_t tail = 2; tail < width; tail++) {
      if ((text[at + tail] & 0xc0) != 0x80) return false;
    }
    at += width;
  }
  return true;
}

static bool contains(const uint8_t *text, size_t size, const char *needle, bool fold) {
  const size_t width = strlen(needle);
  for (size_t at = 0; size - at >= width && size >= width; at++) {
    const uint8_t *found = memchr(text + at, needle[0], size - at - width + 1);
    if (!found) return false;
    at = (size_t)(found - text);
    size_t match = 1;
    while (match < width && (fold ? (text[at + match] | 0x20) : text[at + match]) == (uint8_t)needle[match]) match++;
    if (match == width) return true;
  }
  return false;
}

enum { emit_tsx = 1, emit_esm = 2, emit_classic = 4 };

/*
 * The default-option TypeScript route in one call. The steps and their order mirror compile() in
 * src/compiler-routes.cjs, which also decides every input this entry returns undefined for.
 */
static napi_value emit_typescript(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2, size, length = 0;
  uint32_t flags;
  void *bytes;
  char *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &bytes, &size));
  NAPI(napi_get_value_uint32(env, args[1], &flags));
  uint8_t *source = bytes;
  const bool jsx = flags & emit_tsx, esm = flags & emit_esm, classic = flags & emit_classic;
  if (!size || size > source_limit || !unshared_buffer(env, args[0]) || !valid_utf8(source, size)) goto decline;
  const uint32_t width = (uint32_t)size;
  /* The restricted grammars start at an export after trivia. An import cannot use them. */
  const bool restricted = source[0] != 'i';
  if (restricted && tmt_leading_triple_slash(source, width)) goto decline;
  if (restricted && !jsx) {
    uint8_t *planned;
    bool failed;
    if (direct_plan(source, size, &planned, &failed)) {
      const napi_status created = create_source_string(env, planned ? (char *)planned : (char *)source, size, &result);
      free(planned);
      NAPI(created);
      return result;
    }
    free(planned);
    if (failed) goto error;
  }
  const bool runtime = jsx && !(memchr(source, '@', size) && contains(source, size, "@jsx", true)) &&
    !contains(source, size, "_tmt", false);
  bool complete;
  if (restricted && (!jsx || runtime)) {
    output = tmt_lower_runtime(source, width, jsx, true, classic, false, &length, &complete);
    if (output) goto publish;
  }
  if (!jsx || !memchr(source, '<', size)) {
    output = (char *)type_only_module(source, width, esm, &length);
    if (output) goto publish;
    bool checked, script;
    tmt_parameter_route property;
    output = tmt_emit_annotated_module(source, width,
      !jsx ? TMT_ENUMS_UNKNOWN : runtime ? TMT_ENUMS_PRESENT : TMT_ENUMS_ABSENT, esm, !esm && !jsx,
      &length, &checked, &complete, &script, &property);
    if (output && complete && !script) goto publish;
    /* Scripts, partial projections and compatibility hints continue in JavaScript. */
    goto decline;
  }
  if (runtime && !contains(source, size, "\\u", false)) {
    output = tmt_lower_runtime(source, width, true, true, classic, true, &length, &complete);
    if (output && complete) goto publish;
  }
decline:
  free(output);
  NAPI(napi_get_undefined(env, &result));
  return result;
publish:
  {
    const napi_status created = create_source_string(env, output, length, &result);
    free(output);
    output = NULL;
    NAPI(created);
  }
  return result;
error:
  free(output);
  napi_throw_error(env, NULL, "Native TypeScript emission arguments or allocation failed");
  return NULL;
}

/*
 * A JavaScript module whose certified parse commits no edit is its own output. The call returns
 * undefined for scripts, for TypeScript syntax, for sources the parse does not accept and for
 * directives, and the V8 route then decides them. For a .js name the module must begin with a
 * static import or export, so scripts are declined without walking the source.
 */
static napi_value emit_javascript_module(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2, size, length = 0;
  bool module_file;
  void *bytes;
  char *output = NULL;
  NAPI(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc != 2) goto error;
  NAPI(napi_get_buffer_info(env, args[0], &bytes, &size));
  NAPI(napi_get_value_bool(env, args[1], &module_file));
  uint8_t *source = bytes;
  if (!size || size > source_limit || !unshared_buffer(env, args[0]) || !valid_utf8(source, size) ||
      contains(source, size, "///", false)) goto decline;
  const uint32_t width = (uint32_t)size;
  if (!module_file) {
    const TmtPulseMemory_tape head = { .source = source, .size = width };
    const TmtPulseParser_cursor first = TmtPulseCompiler_runtime_source_start(head);
    if (!first.ok || first.at == width || !TmtPulseCompiler_runtime_module_marker(head, first.at)) goto decline;
  }
  bool checked, complete, script;
  tmt_parameter_route property;
  output = tmt_emit_annotated_module(source, width, TMT_ENUMS_ABSENT, false, false,
    &length, &checked, &complete, &script, &property);
  if (!output || !complete || script || length != size || memcmp(output, source, size)) goto decline;
  {
    const napi_status created = create_source_string(env, output, length, &result);
    free(output);
    output = NULL;
    NAPI(created);
  }
  return result;
decline:
  free(output);
  NAPI(napi_get_undefined(env, &result));
  return result;
error:
  free(output);
  napi_throw_error(env, NULL, "Native JavaScript emission arguments or allocation failed");
  return NULL;
}

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

static napi_value leading_triple_slash(napi_env env, napi_callback_info info) {
  napi_value arg, result;
  size_t argc = 1, size;
  void *source;
  NAPI(napi_get_cb_info(env, info, &argc, &arg, NULL, NULL));
  if (argc != 1) goto error;
  NAPI(napi_get_buffer_info(env, arg, &source, &size));
  bool directive;
  if (size > source_limit) {
    /* Oversized input never reaches the emitters. Report any triple slash as the caller's scan did. */
    directive = false;
    for (size_t index = 0; index + 2 < size && !directive; index++) {
      directive = !memcmp((const char *)source + index, "///", 3);
    }
  } else directive = tmt_leading_triple_slash(source, (uint32_t)size);
  NAPI(napi_get_boolean(env, directive, &result));
  return result;
error:
  napi_throw_type_error(env, NULL, "Expected a source buffer");
  return NULL;
}

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
  NAPI(napi_create_function(env, "emitJavaScriptModule", NAPI_AUTO_LENGTH, emit_javascript_module, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "emitJavaScriptModule", entry));
  NAPI(napi_create_function(env, "emitTypeScript", NAPI_AUTO_LENGTH, emit_typescript, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "emitTypeScript", entry));
  NAPI(napi_create_function(env, "triviaOnly", NAPI_AUTO_LENGTH, trivia_only, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "triviaOnly", entry));
#endif
  NAPI(napi_create_function(env, "leadingTripleSlash", NAPI_AUTO_LENGTH, leading_triple_slash, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "leadingTripleSlash", entry));
  NAPI(napi_create_function(env, "leadingDirective", NAPI_AUTO_LENGTH, leading_directive, NULL, &entry));
  NAPI(napi_set_named_property(env, exports, "leadingDirective", entry));
  return exports;
error:
  napi_throw_error(env, NULL, "Unable to register the native compiler");
  return NULL;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
