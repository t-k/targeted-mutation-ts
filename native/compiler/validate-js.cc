#include <climits>
#include <cstddef>

#include <v8.h>

#ifdef TMT_JAVASCRIPT_ADDON
#include <node.h>
#endif

#include <cstdint>
#include <cstring>

#ifdef TMT_AUDIT_V8
#include <cstdio>

static void audit(const char *phase, const char *reason, int position = -1)
{
  std::fprintf(stderr, "TMT_V8_AUDIT\t%s\t%s\t%d\n", phase, reason, position);
}

extern "C" void tmt_audit_guard(const char *phase, bool accepts)
{
  std::fprintf(stderr, "TMT_V8_GUARD\t%s\t%d\n", phase, accepts ? 1 : 0);
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

// The syntax check that vm.Script performs, without Node's error decoration.
static bool valid_script(v8::Isolate *isolate, v8::Local<v8::String> code)
{
  v8::TryCatch errors(isolate);
  v8::ScriptCompiler::Source source(code);
  return !v8::ScriptCompiler::CompileUnboundScript(isolate, &source).IsEmpty();
}

static void valid_script_text(const v8::FunctionCallbackInfo<v8::Value>& args)
{
  if (args.Length() != 1 || !args[0]->IsString()) return;
  args.GetReturnValue().Set(valid_script(args.GetIsolate(), args[0].As<v8::String>()));
}

// Length of the leading ASCII run, tested 32 bytes at a time.
static size_t ascii_prefix(const uint8_t *text, size_t size)
{
  size_t at = 0;
  for (; size - at >= 32; at += 32) {
    uint64_t words[4];
    std::memcpy(words, text + at, sizeof(words));
    if ((words[0] | words[1] | words[2] | words[3]) & UINT64_C(0x8080808080808080)) break;
  }
  while (at < size && text[at] < 0x80) at++;
  return at;
}

// Well-formed UTF-8 as defined by the Unicode standard, table 3-7.
static bool valid_utf8(const uint8_t *text, size_t size, bool *ascii)
{
  size_t at = ascii_prefix(text, size);
  *ascii = at == size;
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

static bool contains(const uint8_t *text, size_t size, const char *needle)
{
  const size_t width = std::strlen(needle);
  for (size_t at = 0; size >= width && size - at >= width; at++) {
    const void *found = std::memchr(text + at, needle[0], size - at - width + 1);
    if (!found) return false;
    at = static_cast<size_t>(static_cast<const uint8_t *>(found) - text);
    if (!std::memcmp(text + at, needle, width)) return true;
  }
  return false;
}

static bool ascii_space(uint8_t byte) { return byte == ' ' || (byte >= 9 && byte <= 13); }

// ASCII whitespace and comments from a position. Sets certain to false where the router's Unicode
// whitespace and line terminator rules could decide differently.
static size_t trivia_end(const uint8_t *text, size_t size, size_t at, bool *certain)
{
  while (at < size) {
    const uint8_t byte = text[at];
    if (ascii_space(byte)) {
      at++;
    } else if (byte == '/' && size - at >= 2 && text[at + 1] == '/') {
      at += 2;
      while (at < size && text[at] != '\n' && text[at] != '\r') {
        if (text[at] == 0xe2) *certain = false;
        at++;
      }
    } else if (byte == '/' && size - at >= 2 && text[at + 1] == '*') {
      size_t close = at + 2;
      while (size - close >= 2 && !(text[close] == '*' && text[close + 1] == '/')) close++;
      if (size - close < 2) return at;
      at = close + 2;
    } else {
      if (byte >= 0x80) *certain = false;
      return at;
    }
  }
  return at;
}

static bool one_of(uint8_t byte, const char *set) { return byte && std::strchr(set, byte); }

// A static import or export at the start of the module, as the router's startsStaticModule reads it.
static bool static_module_head(const uint8_t *text, size_t size, size_t start, bool *certain)
{
  if (size - start < 6) return false;
  const uint8_t follower = size - start > 6 ? text[start + 6] : 0;
  if (follower >= 0x80) *certain = false;
  if (!std::memcmp(text + start, "export", 6)) return ascii_space(follower) || one_of(follower, "{/*");
  if (std::memcmp(text + start, "import", 6) || !(ascii_space(follower) || one_of(follower, "/'\"{*"))) return false;
  const size_t at = trivia_end(text, size, start + 6, certain);
  const uint8_t specifier = at < size ? text[at] : 0;
  return (specifier >= 'A' && specifier <= 'Z') || (specifier >= 'a' && specifier <= 'z') || one_of(specifier, "_$'\"{*");
}

enum { emit_module_file = 1 };

/*
 * The default-option JavaScript route in one call. It mirrors modernJavaScript and strictScript in
 * src/compiler-routes.cjs for ASCII trivia and returns undefined wherever the router's directive,
 * hashbang, HTML comment or Unicode rules apply, and for every source V8 rejects.
 */
static void emit_javascript(const v8::FunctionCallbackInfo<v8::Value>& args)
{
  if (args.Length() != 2 || !args[0]->IsUint8Array() || !args[1]->IsUint32()) return;
  v8::Isolate *isolate = args.GetIsolate();
  const auto view = args[0].As<v8::Uint8Array>();
  const auto buffer = view->Buffer();
  const size_t size = view->ByteLength();
  if (buffer->IsSharedArrayBuffer() || size > static_cast<size_t>(v8::String::kMaxLength)) return;
  const uint8_t *text = static_cast<const uint8_t *>(buffer->Data()) + view->ByteOffset();
  bool ascii;
  if (!valid_utf8(text, size, &ascii) || contains(text, size, "///")) return;
  const bool module_file = args[1].As<v8::Uint32>()->Value() & emit_module_file;
  bool certain = true, script = false, strict = false;
  if (!module_file) {
    if (size >= 2 && text[0] == '#' && text[1] == '!') return;
    const size_t start = trivia_end(text, size, 0, &certain);
    script = !static_module_head(text, size, start, &certain);
    if (!certain) return;
    if (script) {
      if (contains(text, size, "<!--") || contains(text, size, "-->")) return;
      const uint8_t quote = start < size ? text[start] : 0;
      if (quote == '"' || quote == '\'') {
        size_t at = start + 11;
        if (size - start < 13 || std::memcmp(text + start + 1, "use strict", 10) || text[at] != quote) return;
        for (at++; at < size && (text[at] == ' ' || text[at] == '\t'); at++) {}
        if (at == size || text[at] != ';') return;
        strict = true;
      }
    }
  }
  v8::Local<v8::String> source;
  const int length = static_cast<int>(size);
  if (ascii ? !v8::String::NewFromOneByte(isolate, text, v8::NewStringType::kNormal, length).ToLocal(&source) :
      !v8::String::NewFromUtf8(isolate, reinterpret_cast<const char *>(text), v8::NewStringType::kNormal, length)
        .ToLocal(&source)) return;
  if (!script) {
    if (valid_module(isolate, source, "javascript")) args.GetReturnValue().Set(source);
    return;
  }
  const v8::Local<v8::String> code = strict ? source :
    v8::String::Concat(isolate, v8::String::NewFromUtf8Literal(isolate, "\"use strict\";\n"), source);
  if (valid_script(isolate, code)) args.GetReturnValue().Set(code);
}

NODE_MODULE_INIT()
{
  v8::Isolate *isolate = v8::Isolate::GetCurrent();
  if (!isolate) return;
  v8::Local<v8::Function> validate;
  if (!v8::Function::New(context, valid_module_text).ToLocal(&validate)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(isolate, "validModule"), validate)
    .FromMaybe(false);
  v8::Local<v8::Function> script;
  if (!v8::Function::New(context, valid_script_text).ToLocal(&script)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(isolate, "validScript"), script)
    .FromMaybe(false);
  v8::Local<v8::Function> emit;
  if (!v8::Function::New(context, emit_javascript).ToLocal(&emit)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(isolate, "emitJavaScript"), emit)
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
