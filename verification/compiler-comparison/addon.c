#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>

extern uint8_t *swc_next_compile(const uint8_t *, size_t, const uint8_t *, size_t, size_t *);
extern void swc_next_release(uint8_t *, size_t);

static napi_value compile(napi_env env, napi_callback_info info) {
  napi_value args[2], output;
  size_t argc = 2, size, filename_size, output_size;
  void *source;
  char filename[4096];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_buffer_info(env, args[0], &source, &size) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &filename_size) != napi_ok ||
      filename_size >= sizeof(filename) ||
      napi_get_value_string_utf8(env, args[1], filename, sizeof(filename), &filename_size) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected a valid buffer and filename");
    return NULL;
  }
  const uint8_t empty = 0;
  uint8_t *code = swc_next_compile(source ? source : &empty, size,
                                  (uint8_t *)filename, filename_size, &output_size);
  if (!code) return napi_get_null(env, &output) == napi_ok ? output : NULL;
  napi_status status = napi_create_string_utf8(env, (char *)code, output_size, &output);
  swc_next_release(code, output_size);
  return status == napi_ok ? output : NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value entry;
  if (napi_create_function(env, "compile", NAPI_AUTO_LENGTH, compile, NULL, &entry) != napi_ok ||
      napi_set_named_property(env, exports, "compile", entry) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
