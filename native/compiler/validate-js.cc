#include <climits>
#include <cstddef>
#include <cstdlib>

#include <v8.h>

#ifdef TMT_JAVASCRIPT_ADDON
#include <node.h>
#include <vector>
extern "C" {
#include "fast-strip.h"
#include "tmt_simd_scan.h"
}
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

#ifndef TMT_AUDIT_V8
/* Fast ASCII VLQ encoder for 1:1 byte-preserving projections (matches source-map.h). */
static inline char *fast_vlq(char *p, int64_t value)
{
  static const char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  uint64_t encoded = value < 0 ? (static_cast<uint64_t>(-value) << 1) | 1ULL : (static_cast<uint64_t>(value) << 1);
  if (__builtin_expect(encoded < 32U, 1)) {
    *p++ = digits[encoded];
    return p;
  }
  do {
    uint8_t digit = static_cast<uint8_t>(encoded & 31U);
    encoded >>= 5;
    if (encoded) digit |= 32U;
    *p++ = digits[digit];
  } while (encoded);
  return p;
}

static inline bool fast_map_word(uint8_t b)
{
  return (tmt_id_lut[b] & 2U) != 0U;
}

/* Generates V3 source map `mappings` for an ASCII projection `source[0..size)` -> `code[0..length)`. */
static size_t build_ascii_projection_map(const uint8_t *source, size_t size, const char *code, size_t length,
                                         std::vector<char> &out, uint32_t init_col = 0)
{
  if (length < size) return 0;
  const size_t need = size * 6 + 64;
  if (out.size() < need) out.resize(need < 65536 ? 65536 : need);
  char *p = out.data();
  const uint8_t *to_bytes = reinterpret_cast<const uint8_t *>(code);
  uint32_t line = 0, col = init_col, gen = 0, last_gen = 0, last_line = 0, last_orig = 0;
  bool first = true, boundary = true, mapped = false, word = false;

  for (size_t i = 0; i < size; i++) {
    const uint8_t from = source[i];
    const uint8_t to = to_bytes[i];
    if (to == from) {
      if (to == ' ' || to == '\t') {
#if !defined(TMT_SCALAR_SCANS) && (defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__)))
        if (size - i >= 16) {
          const unsigned run = tmt_map_blank_count(source + i, to_bytes + i);
          if (run > 1) {
            boundary = true;
            gen += run;
            col += run;
            i += run - 1;
            continue;
          }
        }
#endif
        boundary = true;
        gen++;
        col++;
        continue;
      }
      if (from == '\n' || from == '\r') {
        if (from == '\r' && i + 1 < size && source[i + 1] == '\n') i++;
        *p++ = ';';
        line++;
        col = 0;
        gen = last_gen = 0;
        first = boundary = true;
        continue;
      }
      const bool kind = fast_map_word(to);
      if (boundary || kind != word) {
        if (!first) *p++ = ',';
        p = fast_vlq(p, static_cast<int64_t>(gen) - last_gen);
        *p++ = 'A';
        const int64_t dline = static_cast<int64_t>(line) - last_line;
        if (__builtin_expect(dline == 0, 1)) *p++ = 'A';
        else p = fast_vlq(p, dline);
        p = fast_vlq(p, static_cast<int64_t>(col) - last_orig);
        last_gen = gen;
        last_line = line;
        last_orig = col;
        first = false;
        mapped = true;
      }
      word = kind;
      boundary = false;
#if !defined(TMT_SCALAR_SCANS) && (defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__)))
      if (kind && size - i >= 16) {
        const unsigned run = tmt_map_word_count(source + i, to_bytes + i);
        if (run > 1) {
          gen += run;
          col += run;
          i += run - 1;
          continue;
        }
      }
#endif
      gen++;
      col++;
      continue;
    }
    if (to == ' ' || to == '\t') {
      boundary = true;
    } else {
      if (mapped) {
        if (!first) *p++ = ',';
        p = fast_vlq(p, static_cast<int64_t>(gen) - last_gen);
        last_gen = gen;
        first = false;
        mapped = false;
      }
      boundary = true;
    }
    gen++;
    col++;
  }
  return static_cast<size_t>(p - out.data());
}

/*
 * Direct V8 fast-path for default-option `.mts` modules: runs single-pass zero-alloc
 * `tmt_fast_strip_module`, creates the V8 string ONCE (or reuses the input string when unedited),
 * validates it with V8 `CompileModule`, and returns it directly with zero N-API overhead.
 * Supports UTF-8 bytes inside comments and string literals.
 */
/* Generates V3 source map `mappings` for lowered ASCII runs `runs[0..run_count)`. */
static size_t build_ascii_runs_map(const uint8_t *source, size_t size, const char *code, size_t length,
                                   const fs_run_t *runs, uint32_t run_count, std::vector<char> &out, uint32_t init_col = 0)
{
  const size_t need = (length > size ? length : size) * 6 + 64;
  if (out.size() < need) out.resize(need < 65536 ? 65536 : need);
  char *p = out.data();
  const uint8_t *to_bytes = reinterpret_cast<const uint8_t *>(code);
  uint32_t src_line = 0, src_col = init_col, src_off = 0;
  uint32_t gen = 0, last_gen = 0, last_line = 0, last_orig = 0;
  size_t out_at = 0;
  bool first = true, mapped = false;

  for (uint32_t ri = 0; ri < run_count; ri++) {
    const fs_run_t run = runs[ri];
    if (run.out < out_at || run.out + run.length > length || run.src + run.length > size) return 0;
    /* Advance generated text between previous run and this run */
    if (run.out > out_at) {
      if (mapped) {
        if (!first) *p++ = ',';
        p = fast_vlq(p, static_cast<int64_t>(gen) - last_gen);
        last_gen = gen;
        first = false;
        mapped = false;
      }
      for (; out_at < run.out; out_at++) {
        const uint8_t c = to_bytes[out_at];
        if (c == '\n' || c == '\r') {
          if (c == '\r' && out_at + 1 < run.out && to_bytes[out_at + 1] == '\n') out_at++;
          *p++ = ';';
          gen = last_gen = 0;
          first = true;
          mapped = false;
        } else {
          gen++;
        }
      }
    }
    /* Advance source cursor to run.src */
    while (src_off < run.src) {
      const uint8_t c = source[src_off++];
      if (c == '\n' || c == '\r') {
        if (c == '\r' && src_off < run.src && source[src_off] == '\n') src_off++;
        src_line++;
        src_col = 0;
      } else {
        src_col++;
      }
    }
    bool boundary = true, word = false;
    for (uint32_t at = 0; at < run.length; at++) {
      const uint8_t from = source[run.src + at];
      const uint8_t to = to_bytes[run.out + at];
      if (from == '\n' || from == '\r') {
        if (from == '\r' && at + 1 < run.length && source[run.src + at + 1] == '\n') { at++; src_off++; }
        *p++ = ';';
        src_line++;
        src_col = 0;
        src_off++;
        gen = last_gen = 0;
        first = boundary = true;
        mapped = false;
        continue;
      }
      if (to != from && to != ' ' && to != '\t') {
        if (mapped) {
          if (!first) *p++ = ',';
          p = fast_vlq(p, static_cast<int64_t>(gen) - last_gen);
          last_gen = gen;
          first = false;
          mapped = false;
        }
        boundary = true;
      } else if (to == ' ' || to == '\t') {
        boundary = true;
      } else {
        const bool kind = fast_map_word(to);
        if (boundary || kind != word) {
          if (!first) *p++ = ',';
          p = fast_vlq(p, static_cast<int64_t>(gen) - last_gen);
          *p++ = 'A';
          const int64_t dline = static_cast<int64_t>(src_line) - last_line;
          if (__builtin_expect(dline == 0, 1)) *p++ = 'A';
          else p = fast_vlq(p, dline);
          p = fast_vlq(p, static_cast<int64_t>(src_col) - last_orig);
          last_gen = gen;
          last_line = src_line;
          last_orig = src_col;
          first = false;
          mapped = true;
        }
        word = kind;
        boundary = false;
      }
      gen++;
      src_col++;
      src_off++;
    }
    out_at = run.out + run.length;
  }
  /* Emit unmapped boundary and line breaks for any trailing generated bytes after the last run */
  if (out_at < length) {
    if (mapped) {
      if (!first) *p++ = ',';
      p = fast_vlq(p, static_cast<int64_t>(gen) - last_gen);
      last_gen = gen;
      first = false;
      mapped = false;
    }
    for (; out_at < length; out_at++) {
      const uint8_t c = to_bytes[out_at];
      if (c == '\n' || c == '\r') {
        if (c == '\r' && out_at + 1 < length && to_bytes[out_at + 1] == '\n') out_at++;
        *p++ = ';';
        gen = last_gen = 0;
        first = true;
        mapped = false;
      } else {
        gen++;
      }
    }
  }
  return static_cast<size_t>(p - out.data());
}

struct LowerBufGuard {
  fs_lower_buf_t lb{nullptr, 0, 0, nullptr, 0, 0, false, false};
  ~LowerBufGuard() { std::free(lb.data); std::free(lb.runs); }
};

static void emit_fast_module_impl(const v8::FunctionCallbackInfo<v8::Value>& args, bool mapped, bool esm, bool jsx,
                                  size_t min_size, size_t max_size)
{
  if (args.Length() != 1) return;
  v8::Isolate *isolate = args.GetIsolate();
  static thread_local std::vector<uint8_t> in_buf;
  static thread_local std::vector<char> out_buf;
  static thread_local std::vector<char> map_buf;
  static thread_local LowerBufGuard lower_guard;

  const uint8_t *text = nullptr;
  size_t size = 0;
  v8::Local<v8::String> input_str;
  bool from_str = false;
  bool ascii = true;

  if (args[0]->IsString()) {
    input_str = args[0].As<v8::String>();
    const size_t chars = static_cast<size_t>(input_str->Length());
    if (chars < min_size || chars > max_size) return;
    if (input_str->IsOneByte()) {
      size = chars;
      if (in_buf.size() < size) in_buf.resize(size < 65536 ? 65536 : size);
      input_str->WriteOneByteV2(isolate, 0, static_cast<uint32_t>(size), in_buf.data(), 0);
      if (ascii_prefix(in_buf.data(), size) != size) {
        if (mapped) return;
        const size_t utf8_len = input_str->Utf8LengthV2(isolate);
        if (utf8_len < min_size || utf8_len > max_size) return;
        if (in_buf.size() < utf8_len) in_buf.resize(utf8_len < 65536 ? 65536 : utf8_len);
        input_str->WriteUtf8V2(isolate, reinterpret_cast<char *>(in_buf.data()), utf8_len, 0);
        size = utf8_len;
        ascii = false;
      }
    } else {
      const size_t utf8_len = input_str->Utf8LengthV2(isolate);
      if (utf8_len < min_size || utf8_len > max_size) return;
      if (in_buf.size() < utf8_len) in_buf.resize(utf8_len < 65536 ? 65536 : utf8_len);
      input_str->WriteUtf8V2(isolate, reinterpret_cast<char *>(in_buf.data()), utf8_len,
                             v8::String::WriteFlags::kReplaceInvalidUtf8);
      /* Decline lone surrogates (replaced with U+FFFD) and JS Unicode line terminators U+2028/U+2029 */
      if (contains(in_buf.data(), utf8_len, "\xef\xbf\xbd") ||
          contains(in_buf.data(), utf8_len, "\xe2\x80\xa8") ||
          contains(in_buf.data(), utf8_len, "\xe2\x80\xa9")) return;
      /* Allow UTF-8 BOM on `.mts` even in mapped mode if the rest of the file is ASCII */
      const bool has_bom = esm && utf8_len >= 3 && in_buf[0] == 0xef && in_buf[1] == 0xbb && in_buf[2] == 0xbf;
      if (mapped && !(has_bom && ascii_prefix(in_buf.data() + 3, utf8_len - 3) == utf8_len - 3)) return;
      size = utf8_len;
      ascii = has_bom && ascii_prefix(in_buf.data() + 3, utf8_len - 3) == utf8_len - 3;
    }
    text = in_buf.data();
    from_str = true;
  } else if (args[0]->IsUint8Array()) {
    const auto view = args[0].As<v8::Uint8Array>();
    size = view->ByteLength();
    if (size < min_size || size > max_size) return;
    const auto buffer = view->Buffer();
    if (buffer->IsSharedArrayBuffer()) return;
    text = static_cast<const uint8_t *>(buffer->Data()) + view->ByteOffset();
    if (!valid_utf8(text, size, &ascii)) return;
    const bool has_bom = esm && !ascii && size >= 3 && text[0] == 0xef && text[1] == 0xbb && text[2] == 0xbf;
    if (has_bom && ascii_prefix(text + 3, size - 3) == size - 3) ascii = true;
    if (!ascii && (mapped || contains(text, size, "\xe2\x80\xa8") || contains(text, size, "\xe2\x80\xa9"))) return;
  } else {
    return;
  }

  /* Strip UTF-8 BOM on `.mts` modules; decline hashbangs, BOM on `.ts`/`.tsx`, and leading triple-slash directives. */
  bool had_bom = false;
  if (esm && size >= 3 && text[0] == 0xef && text[1] == 0xbb && text[2] == 0xbf) {
    text += 3;
    size -= 3;
    if (!size) return;
    had_bom = true;
    from_str = false;
  }
  if (text[0] == '#' || text[0] == 0xef) return;
  size_t first_at = 0;
  if (!(text[0] >= 'a' && text[0] <= 'z') && !(text[0] >= 'A' && text[0] <= 'Z')) {
    bool certain = true;
    first_at = trivia_end(text, size, 0, &certain);
    if (!certain || first_at >= size) return;
    if (first_at >= 3 && contains(text, first_at, "///")) return;
  }

  if (out_buf.size() < size + 16) out_buf.resize(size + 16 < 65536 ? 65536 : size + 16);
  size_t out_len = 0;
  bool edited = false;
  lower_guard.lb.record_runs = mapped;
  char *out = nullptr;
  if (jsx) {
    out = tmt_fast_strip_tsx(text, static_cast<uint32_t>(size), static_cast<uint32_t>(first_at),
                             out_buf.data(), &out_len, &edited, &lower_guard.lb);
  } else {
    out = tmt_fast_strip_module_ex(text, static_cast<uint32_t>(size),
                                   static_cast<uint32_t>(first_at), esm,
                                   out_buf.data(), &out_len, &edited,
                                   &lower_guard.lb);
  }
  if (!out) return;

  v8::Local<v8::String> result;
  if (!edited && from_str && out_len == size) {
    result = input_str;
  } else if (ascii ?
      !v8::String::NewFromOneByte(isolate, reinterpret_cast<const uint8_t *>(out),
                                  v8::NewStringType::kNormal, static_cast<int>(out_len)).ToLocal(&result) :
      !v8::String::NewFromUtf8(isolate, out, v8::NewStringType::kNormal, static_cast<int>(out_len)).ToLocal(&result)) {
    return;
  }
  if (!valid_module(isolate, result, "ts")) return;

  if (!mapped) {
    args.GetReturnValue().Set(result);
    return;
  }
  v8::Local<v8::String> map_str;
  if (out != lower_guard.lb.data && out_len < size) {
    /* Compacted type-only `.mts` module (`export {};\n`) has empty mappings. */
    map_str = v8::String::Empty(isolate);
  } else {
    const uint32_t init_col = had_bom ? 1U : 0U;
    const size_t map_len = (out == lower_guard.lb.data)
      ? build_ascii_runs_map(text, size, out, out_len, lower_guard.lb.runs, lower_guard.lb.run_count, map_buf, init_col)
      : build_ascii_projection_map(text, size, out, out_len, map_buf, init_col);
    if (!v8::String::NewFromOneByte(isolate, reinterpret_cast<const uint8_t *>(map_buf.data()),
                                    v8::NewStringType::kNormal, static_cast<int>(map_len)).ToLocal(&map_str)) {
      return;
    }
  }
  v8::Local<v8::Value> elems[2] = { result, map_str };
  args.GetReturnValue().Set(v8::Array::New(isolate, elems, 2));
}

static void emit_fast_module(const v8::FunctionCallbackInfo<v8::Value>& args)
{
  emit_fast_module_impl(args, false, true, false, 1, 8 * 1024 * 1024);
}

static void emit_fast_module_mapped(const v8::FunctionCallbackInfo<v8::Value>& args)
{
  emit_fast_module_impl(args, true, true, false, 1, 8 * 1024 * 1024);
}

static void emit_fast_ts(const v8::FunctionCallbackInfo<v8::Value>& args)
{
  emit_fast_module_impl(args, false, false, false, 8192, 8 * 1024 * 1024);
}

static void emit_fast_tsx(const v8::FunctionCallbackInfo<v8::Value>& args)
{
  emit_fast_module_impl(args, false, false, true, 2048, 131072);
}
#endif

NODE_MODULE_INIT()
{
  v8::Local<v8::Function> validate;
  if (!v8::Function::New(context, valid_module_text).ToLocal(&validate)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "validModule"), validate)
    .FromMaybe(false);
  v8::Local<v8::Function> script;
  if (!v8::Function::New(context, valid_script_text).ToLocal(&script)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "validScript"), script)
    .FromMaybe(false);
  v8::Local<v8::Function> emit;
  if (!v8::Function::New(context, emit_javascript).ToLocal(&emit)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "emitJavaScript"), emit)
    .FromMaybe(false);
#ifndef TMT_AUDIT_V8
  v8::Local<v8::Function> fast_mod;
  if (!v8::Function::New(context, emit_fast_module).ToLocal(&fast_mod)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "emitFastModule"), fast_mod)
    .FromMaybe(false);
  v8::Local<v8::Function> fast_mod_mapped;
  if (!v8::Function::New(context, emit_fast_module_mapped).ToLocal(&fast_mod_mapped)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "emitFastModuleMapped"), fast_mod_mapped)
    .FromMaybe(false);
  v8::Local<v8::Function> fast_ts;
  if (!v8::Function::New(context, emit_fast_ts).ToLocal(&fast_ts)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "emitFastTs"), fast_ts)
    .FromMaybe(false);
  v8::Local<v8::Function> fast_tsx;
  if (!v8::Function::New(context, emit_fast_tsx).ToLocal(&fast_tsx)) return;
  exports->Set(context, v8::String::NewFromUtf8Literal(context->GetIsolate(), "emitFastTsx"), fast_tsx)
    .FromMaybe(false);
#endif
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

#ifndef TMT_AUDIT_V8
extern "C" bool tmt_valid_javascript_module_latin1(const char *code, size_t length)
{
  auto *isolate = v8::Isolate::GetCurrent();
  if (!isolate || length > INT_MAX) return false;
  v8::HandleScope handles(isolate);
  v8::Local<v8::String> text;
  if (!v8::String::NewFromOneByte(isolate, reinterpret_cast<const uint8_t *>(code),
                                  v8::NewStringType::kNormal, static_cast<int>(length)).ToLocal(&text)) {
    return false;
  }
  return valid_module(isolate, text, nullptr);
}
#endif
#endif
