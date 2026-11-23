#include <climits>
#include <cstddef>

#include <v8.h>

extern "C" bool tmt_valid_javascript_module(const char *code, size_t length)
{
  auto *isolate = v8::Isolate::GetCurrent();
  if (!isolate || length > INT_MAX) return false;
  v8::HandleScope handles(isolate);
  v8::TryCatch errors(isolate);
  v8::Local<v8::String> text;
  if (!v8::String::NewFromUtf8(isolate, code, v8::NewStringType::kNormal,
                              static_cast<int>(length)).ToLocal(&text)) return false;
  const v8::ScriptOrigin origin(v8::String::Empty(isolate), 0, 0, false, -1, {}, false, false, true);
  v8::ScriptCompiler::Source source(text, origin);
  return !v8::ScriptCompiler::CompileModule(isolate, &source).IsEmpty();
}
