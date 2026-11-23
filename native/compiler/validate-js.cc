#include <climits>
#include <cstddef>

#include <v8.h>

#ifdef TMT_JAVASCRIPT_ADDON
#include <node.h>
#endif

#ifdef TMT_AUDIT_V8
#include <cstdio>
#include <cstring>

static void audit(const char *phase, const char *reason, int position = -1)
{
  std::fprintf(stderr, "TMT_V8_AUDIT\t%s\t%s\t%d\n", phase, reason, position);
}

extern "C" void tmt_audit_certification(const char *phase, bool certified)
{
  std::fprintf(stderr, "TMT_V8_CERTIFIED\t%s\t%d\n", phase, certified ? 1 : 0);
}

static const char *reason(v8::Isolate *isolate, v8::Local<v8::Message> message)
{
  if (message.IsEmpty()) return "no-diagnostic";
  const v8::String::Utf8Value diagnostic(isolate, message->Get());
  const char *text = *diagnostic;
  if (!text) return "no-diagnostic";
  // Classify the diagnostic without printing identifiers or bytes from the input.
  if (std::strstr(text, "is not defined") && std::strstr(text, "Export")) return "unbound-export";
  if (std::strstr(text, "already been declared")) return "redeclaration";
  if (std::strstr(text, "strict mode")) return "strict-mode";
  if (std::strstr(text, "Unexpected")) return "unexpected-token";
  return "syntax";
}
#endif

static bool valid_module(v8::Isolate *isolate, v8::Local<v8::String> text,
                         [[maybe_unused]] const char *phase)
{
  v8::TryCatch errors(isolate);
  const v8::ScriptOrigin origin(v8::String::Empty(isolate), 0, 0, false, -1, {}, false, false, true);
  v8::ScriptCompiler::Source source(text, origin);
  const bool accepted = !v8::ScriptCompiler::CompileModule(isolate, &source).IsEmpty();
#ifdef TMT_AUDIT_V8
  const auto message = errors.Message();
  audit(phase, accepted ? "accepted" : reason(isolate, message),
        message.IsEmpty() ? -1 : message->GetStartPosition());
#endif
  return accepted;
}

#ifdef TMT_JAVASCRIPT_ADDON
static void valid_module_text(const v8::FunctionCallbackInfo<v8::Value>& args)
{
  if (args.Length() != 1 || !args[0]->IsString()) return;
  args.GetReturnValue().Set(valid_module(args.GetIsolate(), args[0].As<v8::String>(), "javascript"));
}

NODE_MODULE_INIT()
{
  v8::Local<v8::Function> validate;
  if (!v8::Function::New(context, valid_module_text).ToLocal(&validate)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "validModule"), validate)
    .FromMaybe(false);
}
#else
#ifdef TMT_AUDIT_V8
extern "C" bool tmt_audit_javascript_module(const char *code, size_t length, const char *phase)
#else
extern "C" bool tmt_valid_javascript_module(const char *code, size_t length)
#endif
{
  auto *isolate = v8::Isolate::GetCurrent();
  if (!isolate || length > INT_MAX) {
#ifdef TMT_AUDIT_V8
    audit(phase, "unavailable");
#endif
    return false;
  }
  v8::HandleScope handles(isolate);
  v8::Local<v8::String> text;
  if (!v8::String::NewFromUtf8(isolate, code, v8::NewStringType::kNormal,
                              static_cast<int>(length)).ToLocal(&text)) {
#ifdef TMT_AUDIT_V8
    audit(phase, "string-allocation");
#endif
    return false;
  }
#ifndef TMT_AUDIT_V8
  constexpr const char *phase = nullptr;
#endif
  return valid_module(isolate, text, phase);
}
#endif
