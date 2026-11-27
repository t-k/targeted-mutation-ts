#include "fast-strip.h"
#include "tmt_simd_scan.h"

#include <string.h>

/*
 * Single-pass, zero-allocation ASCII TypeScript type-eraser for non-JSX ES modules.
 *
 * Soundness contract (fpOnTsErr == 0):
 * - Every erased TypeScript span is parsed by a strict recursive-descent type grammar.
 * - Any unrecognized, ambiguous, or complex construct (non-ASCII, unicode escapes in
 *   identifiers, decorators, enums, namespaces, parameter properties, `export =`,
 *   `import =`, `import source/defer`, `new import`, `?.#`, `for ([...] in ...)`,
 *   angle-bracket assertions, `accessor`, `using`, HTML comments, directives,
 *   scripts without runtime module markers) declines cleanly (returns NULL) so the
 *   verified Pulse parser / compatibility router decides it.
 * - Every accepted output is validated by V8 CompileModule in the caller.
 */

enum {
  TOK_EOF = 0,
  TOK_ID,
  TOK_NUM,
  TOK_STR,
  TOK_TPL_FULL,   /* `...` without ${ */
  TOK_TPL_HEAD,   /* `...${ */
  TOK_REGEX,
  TOK_PUNC,       /* single-char punctuator: tok.ch */
  TOK_ARROW,      /* => */
  TOK_DOTDOTDOT,  /* ... */
  TOK_QDOT,       /* ?. */
  TOK_OP2,        /* 2-3 char operator (==, !=, <=, >=, &&, ||, ??, ++, --, **, <<, >>, >>>, +=, etc.) */
};

enum {
  KW_NONE = 0,
  KW_AS, KW_DO, KW_IF, KW_IN, KW_IS, KW_OF,
  KW_FOR, KW_GET, KW_LET, KW_NEW, KW_OUT, KW_SET, KW_TRY, KW_VAR,
  KW_CASE, KW_ELSE, KW_ENUM, KW_FROM, KW_NULL, KW_THIS, KW_TRUE, KW_TYPE, KW_VOID, KW_WITH,
  KW_ASYNC, KW_AWAIT, KW_BREAK, KW_CATCH, KW_CLASS, KW_CONST, KW_FALSE, KW_INFER, KW_KEYOF,
  KW_SUPER, KW_THROW, KW_USING, KW_WHILE, KW_YIELD,
  KW_ASSERT, KW_DELETE, KW_EXPORT, KW_IMPORT, KW_MODULE, KW_PUBLIC, KW_RETURN, KW_STATIC,
  KW_SWITCH, KW_TYPEOF, KW_UNIQUE,
  KW_ASSERTS, KW_DECLARE, KW_DEFAULT, KW_EXTENDS, KW_FINALLY, KW_PRIVATE,
  KW_ABSTRACT, KW_ACCESSOR, KW_CONTINUE, KW_DEBUGGER, KW_FUNCTION, KW_OVERRIDE, KW_READONLY,
  KW_INTERFACE, KW_NAMESPACE, KW_PROTECTED, KW_SATISFIES,
  KW_IMPLEMENTS, KW_INSTANCEOF,
  KW_CONSTRUCTOR,
  KW_COUNT
};

/* Keywords after which `/` begins a regex literal */
static const uint8_t kw_allow_regex[KW_COUNT] = {
  [KW_IN] = 1, [KW_DO] = 1, [KW_OF] = 1, [KW_NEW] = 1, [KW_CASE] = 1,
  [KW_ELSE] = 1, [KW_VOID] = 1, [KW_THROW] = 1, [KW_YIELD] = 1, [KW_AWAIT] = 1,
  [KW_RETURN] = 1, [KW_TYPEOF] = 1, [KW_DELETE] = 1, [KW_DEFAULT] = 1, [KW_INSTANCEOF] = 1,
};

/* Keywords that cannot be a type alias / interface / type-parameter name */
static const uint8_t kw_reserved_type_name[KW_COUNT] = {
  [KW_IF] = 1, [KW_IN] = 1, [KW_DO] = 1, [KW_FOR] = 1, [KW_VAR] = 1, [KW_NEW] = 1, [KW_TRY] = 1,
  [KW_ELSE] = 1, [KW_CASE] = 1, [KW_THIS] = 1, [KW_VOID] = 1, [KW_WITH] = 1, [KW_ENUM] = 1,
  [KW_TRUE] = 1, [KW_NULL] = 1, [KW_CLASS] = 1, [KW_CONST] = 1, [KW_WHILE] = 1, [KW_BREAK] = 1,
  [KW_CATCH] = 1, [KW_SUPER] = 1, [KW_THROW] = 1, [KW_FALSE] = 1, [KW_RETURN] = 1, [KW_EXPORT] = 1,
  [KW_IMPORT] = 1, [KW_SWITCH] = 1, [KW_TYPEOF] = 1, [KW_DELETE] = 1, [KW_DEFAULT] = 1,
  [KW_EXTENDS] = 1, [KW_FINALLY] = 1, [KW_FUNCTION] = 1, [KW_CONTINUE] = 1, [KW_DEBUGGER] = 1,
  [KW_INSTANCEOF] = 1,
};

/* Keywords that cannot start a type reference in parse_type_primary */
static const uint8_t kw_bad_type_start[KW_COUNT] = {
  [KW_IF] = 1, [KW_IN] = 1, [KW_DO] = 1, [KW_FOR] = 1, [KW_VAR] = 1, [KW_TRY] = 1,
  [KW_ELSE] = 1, [KW_CASE] = 1, [KW_WITH] = 1, [KW_ENUM] = 1, [KW_CLASS] = 1, [KW_CONST] = 1,
  [KW_WHILE] = 1, [KW_BREAK] = 1, [KW_CATCH] = 1, [KW_SUPER] = 1, [KW_THROW] = 1,
  [KW_RETURN] = 1, [KW_EXPORT] = 1, [KW_SWITCH] = 1, [KW_DELETE] = 1, [KW_DEFAULT] = 1,
  [KW_EXTENDS] = 1, [KW_FINALLY] = 1, [KW_FUNCTION] = 1, [KW_CONTINUE] = 1, [KW_DEBUGGER] = 1,
  [KW_INSTANCEOF] = 1,
};

/* Keywords that can start a new statement after an ASI newline */
static const uint8_t kw_asi_stmt_start[KW_COUNT] = {
  [KW_TYPE] = 1, [KW_INTERFACE] = 1, [KW_DECLARE] = 1, [KW_EXPORT] = 1, [KW_IMPORT] = 1,
  [KW_CONST] = 1, [KW_LET] = 1, [KW_VAR] = 1, [KW_FUNCTION] = 1, [KW_ASYNC] = 1,
  [KW_CLASS] = 1, [KW_ENUM] = 1, [KW_NAMESPACE] = 1, [KW_ABSTRACT] = 1, [KW_USING] = 1,
};

static inline uint8_t classify_kw(const uint8_t *s, uint32_t len) {
  const uint8_t c = s[0];
  if (len < 2 || len > 11 || c < 'a' || c > 'y') return KW_NONE;
  switch (len) {
    case 2:
      if (c == 'a' && s[1] == 's') return KW_AS;
      if (c == 'i') {
        if (s[1] == 'n') return KW_IN;
        if (s[1] == 'f') return KW_IF;
        if (s[1] == 's') return KW_IS;
      }
      if (c == 'd' && s[1] == 'o') return KW_DO;
      if (c == 'o' && s[1] == 'f') return KW_OF;
      return KW_NONE;
    case 3:
      switch (c) {
        case 'f': return (s[1] == 'o' && s[2] == 'r') ? KW_FOR : KW_NONE;
        case 'g': return (s[1] == 'e' && s[2] == 't') ? KW_GET : KW_NONE;
        case 'l': return (s[1] == 'e' && s[2] == 't') ? KW_LET : KW_NONE;
        case 'n': return (s[1] == 'e' && s[2] == 'w') ? KW_NEW : KW_NONE;
        case 'o': return (s[1] == 'u' && s[2] == 't') ? KW_OUT : KW_NONE;
        case 's': return (s[1] == 'e' && s[2] == 't') ? KW_SET : KW_NONE;
        case 't': return (s[1] == 'r' && s[2] == 'y') ? KW_TRY : KW_NONE;
        case 'v': return (s[1] == 'a' && s[2] == 'r') ? KW_VAR : KW_NONE;
        default: return KW_NONE;
      }
    case 4:
      switch (c) {
        case 'c': return !memcmp(s + 1, "ase", 3) ? KW_CASE : KW_NONE;
        case 'e':
          if (!memcmp(s + 1, "lse", 3)) return KW_ELSE;
          if (!memcmp(s + 1, "num", 3)) return KW_ENUM;
          return KW_NONE;
        case 'f': return !memcmp(s + 1, "rom", 3) ? KW_FROM : KW_NONE;
        case 'n': return !memcmp(s + 1, "ull", 3) ? KW_NULL : KW_NONE;
        case 't':
          if (!memcmp(s + 1, "ype", 3)) return KW_TYPE;
          if (!memcmp(s + 1, "his", 3)) return KW_THIS;
          if (!memcmp(s + 1, "rue", 3)) return KW_TRUE;
          return KW_NONE;
        case 'v': return !memcmp(s + 1, "oid", 3) ? KW_VOID : KW_NONE;
        case 'w': return !memcmp(s + 1, "ith", 3) ? KW_WITH : KW_NONE;
        default: return KW_NONE;
      }
    case 5:
      switch (c) {
        case 'a':
          if (!memcmp(s + 1, "sync", 4)) return KW_ASYNC;
          if (!memcmp(s + 1, "wait", 4)) return KW_AWAIT;
          return KW_NONE;
        case 'b': return !memcmp(s + 1, "reak", 4) ? KW_BREAK : KW_NONE;
        case 'c':
          if (!memcmp(s + 1, "onst", 4)) return KW_CONST;
          if (!memcmp(s + 1, "lass", 4)) return KW_CLASS;
          if (!memcmp(s + 1, "atch", 4)) return KW_CATCH;
          return KW_NONE;
        case 'f': return !memcmp(s + 1, "alse", 4) ? KW_FALSE : KW_NONE;
        case 'i': return !memcmp(s + 1, "nfer", 4) ? KW_INFER : KW_NONE;
        case 'k': return !memcmp(s + 1, "eyof", 4) ? KW_KEYOF : KW_NONE;
        case 's': return !memcmp(s + 1, "uper", 4) ? KW_SUPER : KW_NONE;
        case 't': return !memcmp(s + 1, "hrow", 4) ? KW_THROW : KW_NONE;
        case 'u': return !memcmp(s + 1, "sing", 4) ? KW_USING : KW_NONE;
        case 'w': return !memcmp(s + 1, "hile", 4) ? KW_WHILE : KW_NONE;
        case 'y': return !memcmp(s + 1, "ield", 4) ? KW_YIELD : KW_NONE;
        default: return KW_NONE;
      }
    case 6:
      switch (c) {
        case 'a': return !memcmp(s + 1, "ssert", 5) ? KW_ASSERT : KW_NONE;
        case 'd': return !memcmp(s + 1, "elete", 5) ? KW_DELETE : KW_NONE;
        case 'e': return !memcmp(s + 1, "xport", 5) ? KW_EXPORT : KW_NONE;
        case 'i': return !memcmp(s + 1, "mport", 5) ? KW_IMPORT : KW_NONE;
        case 'm': return !memcmp(s + 1, "odule", 5) ? KW_MODULE : KW_NONE;
        case 'p': return !memcmp(s + 1, "ublic", 5) ? KW_PUBLIC : KW_NONE;
        case 'r': return !memcmp(s + 1, "eturn", 5) ? KW_RETURN : KW_NONE;
        case 's':
          if (!memcmp(s + 1, "tatic", 5)) return KW_STATIC;
          if (!memcmp(s + 1, "witch", 5)) return KW_SWITCH;
          return KW_NONE;
        case 't': return !memcmp(s + 1, "ypeof", 5) ? KW_TYPEOF : KW_NONE;
        case 'u': return !memcmp(s + 1, "nique", 5) ? KW_UNIQUE : KW_NONE;
        default: return KW_NONE;
      }
    case 7:
      switch (c) {
        case 'a': return !memcmp(s + 1, "sserts", 6) ? KW_ASSERTS : KW_NONE;
        case 'd':
          if (!memcmp(s + 1, "eclare", 6)) return KW_DECLARE;
          if (!memcmp(s + 1, "efault", 6)) return KW_DEFAULT;
          return KW_NONE;
        case 'e': return !memcmp(s + 1, "xtends", 6) ? KW_EXTENDS : KW_NONE;
        case 'f': return !memcmp(s + 1, "inally", 6) ? KW_FINALLY : KW_NONE;
        case 'p': return !memcmp(s + 1, "rivate", 6) ? KW_PRIVATE : KW_NONE;
        default: return KW_NONE;
      }
    case 8:
      switch (c) {
        case 'a':
          if (!memcmp(s + 1, "bstract", 7)) return KW_ABSTRACT;
          if (!memcmp(s + 1, "ccessor", 7)) return KW_ACCESSOR;
          return KW_NONE;
        case 'c': return !memcmp(s + 1, "ontinue", 7) ? KW_CONTINUE : KW_NONE;
        case 'd': return !memcmp(s + 1, "ebugger", 7) ? KW_DEBUGGER : KW_NONE;
        case 'f': return !memcmp(s + 1, "unction", 7) ? KW_FUNCTION : KW_NONE;
        case 'o': return !memcmp(s + 1, "verride", 7) ? KW_OVERRIDE : KW_NONE;
        case 'r': return !memcmp(s + 1, "eadonly", 7) ? KW_READONLY : KW_NONE;
        default: return KW_NONE;
      }
    case 9:
      switch (c) {
        case 'i': return !memcmp(s + 1, "nterface", 8) ? KW_INTERFACE : KW_NONE;
        case 'n': return !memcmp(s + 1, "amespace", 8) ? KW_NAMESPACE : KW_NONE;
        case 'p': return !memcmp(s + 1, "rotected", 8) ? KW_PROTECTED : KW_NONE;
        case 's': return !memcmp(s + 1, "atisfies", 8) ? KW_SATISFIES : KW_NONE;
        default: return KW_NONE;
      }
    case 10:
      if (c == 'i') {
        if (!memcmp(s + 1, "mplements", 9)) return KW_IMPLEMENTS;
        if (!memcmp(s + 1, "nstanceof", 9)) return KW_INSTANCEOF;
      }
      return KW_NONE;
    case 11:
      return (c == 'c' && !memcmp(s + 1, "onstructor", 10)) ? KW_CONSTRUCTOR : KW_NONE;
    default:
      return KW_NONE;
  }
}

typedef struct {
  uint8_t kind;
  uint8_t ch;
  uint8_t kw;
  bool had_nl;
  uint32_t start;
  uint32_t end;
} tok_t;

typedef struct {
  const uint8_t *src;
  uint32_t size;
  uint32_t pos;
  uint32_t prev_end;
  char *out;
  bool edited;
  bool failed;
  bool allow_regex;
  bool has_runtime_mod;
  bool erased_any_stmt;
  bool has_runtime_stmt;
  uint32_t depth;
  uint32_t tpl_depth;
  uint32_t tpl_brace_depth[64];
  tok_t tok;
} fs_t;

static inline bool is_id_start(uint8_t c) { return (tmt_id_lut[c] & 1U) != 0U; }
static inline bool is_id_cont(uint8_t c) { return (tmt_id_lut[c] & 2U) != 0U; }

static inline bool tok_is_kw(const fs_t *p, uint8_t kw) {
  return p->tok.kw == kw;
}

static inline bool tok_is_punc(const fs_t *p, uint8_t ch) {
  return p->tok.kind == TOK_PUNC && p->tok.ch == ch;
}

static inline void ensure_out(fs_t *p) {
  if (!p->edited) {
    memcpy(p->out, p->src, p->size);
    p->edited = true;
  }
}

static void blank_span(fs_t *p, uint32_t first, uint32_t last, bool sep) {
  if (first >= last || last > p->size) return;
  ensure_out(p);
  uint32_t i = first;
#if defined(__aarch64__) || (defined(__x86_64__) && defined(__SSE2__))
  while (last - i >= 16U) {
    if (!tmt_erase_type_run((uint8_t *)p->out + i, p->src + i)) break;
    i += 16U;
  }
#endif
  while (i < last) {
    const uint8_t c = p->src[i];
    if (c != '\n' && c != '\r') p->out[i] = ' ';
    i++;
  }
  if (sep) p->out[first] = ';';
}

/* Scan template tail after closing `}` of `${...}` */
static bool scan_template_from(fs_t *p, uint32_t start, bool head) {
  uint32_t i = p->pos;
  while (i < p->size) {
    const uint8_t c = p->src[i];
    if (c >= 0x80U) return false;
    if (c == '\\') {
      i += 2;
      if (i > p->size) return false;
      continue;
    }
    if (c == '`') {
      p->pos = i + 1;
      p->tok.kind = TOK_TPL_FULL;
      p->tok.kw = KW_NONE;
      p->tok.start = start;
      p->tok.end = p->pos;
      p->allow_regex = false;
      return true;
    }
    if (c == '$' && i + 1 < p->size && p->src[i + 1] == '{') {
      if (p->tpl_depth >= 64U) return false;
      p->pos = i + 2;
      p->tpl_brace_depth[p->tpl_depth++] = p->depth;
      p->tok.kind = TOK_TPL_HEAD;
      p->tok.kw = KW_NONE;
      p->tok.start = start;
      p->tok.end = p->pos;
      p->allow_regex = true;
      (void)head;
      return true;
    }
    i++;
  }
  return false;
}

static bool next_tok(fs_t *p) {
  if (p->failed) return false;
  p->prev_end = p->tok.end;
  const uint8_t *src = p->src;
  const uint32_t size = p->size;
  uint32_t i = p->pos;
  bool nl = false;

  /* Skip ASCII whitespace and comments */
  for (;;) {
    while (i < size) {
      const uint8_t c = src[i];
      if (c > ' ') break;
      if (c == ' ' || c == '\t') { i++; continue; }
      if (c == '\n' || c == '\r') { nl = true; i++; continue; }
      break;
    }
    if (i >= size) {
      p->pos = i;
      p->tok = (tok_t){ .kind = TOK_EOF, .ch = 0, .kw = KW_NONE, .had_nl = nl, .start = i, .end = i };
      return true;
    }
    if (src[i] == '/' && i + 1 < size) {
      if (src[i + 1] == '/') {
        const uint8_t *eol = memchr(src + i + 2, '\n', size - (i + 2));
        if (!eol) { i = size; continue; }
        i = (uint32_t)(eol - src);
        continue;
      }
      if (src[i + 1] == '*') {
        uint32_t j = i + 2;
        bool closed = false;
        while (j + 1 < size) {
          if (src[j] == '\n' || src[j] == '\r') nl = true;
          if (src[j] == '*' && src[j + 1] == '/') { i = j + 2; closed = true; break; }
          j++;
        }
        if (!closed) { p->failed = true; return false; }
        continue;
      }
    }
    break;
  }

  const uint32_t start = i;
  const uint8_t c = src[i];

  /* Identifier / keyword (most frequent token) */
  if (is_id_start(c)) {
    i++;
    while (i < size && is_id_cont(src[i])) i++;
    if (i < size && (src[i] == '\\' || src[i] >= 0x80U)) { p->failed = true; return false; }
    const uint8_t kw = classify_kw(src + start, i - start);
    p->pos = i;
    p->tok = (tok_t){ .kind = TOK_ID, .ch = c, .kw = kw, .had_nl = nl, .start = start, .end = i };
    p->allow_regex = kw_allow_regex[kw] != 0;
    return true;
  }

  if (c >= 0x80U || c == '@' || c == '\\') {
    p->failed = true;
    return false;
  }

  /* Fast switch on non-identifier lead byte */
  switch (c) {
    case '(': case '[': case '{': case ',': case ';': case ':': case '~': case '#':
      p->pos = i + 1;
      p->tok = (tok_t){ .kind = TOK_PUNC, .ch = c, .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 1 };
      p->allow_regex = true;
      return true;

    case ')': case ']': case '}':
      p->pos = i + 1;
      p->tok = (tok_t){ .kind = TOK_PUNC, .ch = c, .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 1 };
      p->allow_regex = false;
      return true;

    case '"': case '\'': {
      i++;
      while (i < size && src[i] != c) {
        if (src[i] == '\n' || src[i] == '\r') { p->failed = true; return false; }
        if (src[i] == '\\') {
          if (i + 1 >= size) { p->failed = true; return false; }
          const uint8_t esc = src[i + 1];
          /* Decline hex/unicode/octal escapes to Pulse so malformed escapes cannot be erased */
          if (esc == 'x' || esc == 'u' || (esc >= '0' && esc <= '9')) { p->failed = true; return false; }
          i += 2;
        } else {
          i++;
        }
      }
      if (i >= size) { p->failed = true; return false; }
      i++;
      p->pos = i;
      p->tok = (tok_t){ .kind = TOK_STR, .ch = c, .kw = KW_NONE, .had_nl = nl, .start = start, .end = i };
      p->allow_regex = false;
      return true;
    }

    case '`':
      p->pos = i + 1;
      p->tok.had_nl = nl;
      if (!scan_template_from(p, start, true)) { p->failed = true; return false; }
      return true;

    case '.':
      if (i + 1 < size && src[i + 1] >= '0' && src[i + 1] <= '9') goto scan_num;
      if (i + 2 < size && src[i + 1] == '.' && src[i + 2] == '.') {
        p->pos = i + 3;
        p->tok = (tok_t){ .kind = TOK_DOTDOTDOT, .ch = '.', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 3 };
        p->allow_regex = true;
        return true;
      }
      p->pos = i + 1;
      p->tok = (tok_t){ .kind = TOK_PUNC, .ch = '.', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 1 };
      p->allow_regex = true;
      return true;

    case '0': case '1': case '2': case '3': case '4':
    case '5': case '6': case '7': case '8': case '9':
    scan_num: {
      /* Strict numeric literal validation (declines malformed literals like 0x, 1.2.3, 1e+ to Pulse) */
      if (c == '0' && i + 1 < size && (src[i + 1] == 'x' || src[i + 1] == 'X' ||
          src[i + 1] == 'b' || src[i + 1] == 'B' || src[i + 1] == 'o' || src[i + 1] == 'O')) {
        const uint8_t base = src[i + 1] | 32;
        i += 2;
        uint32_t digits = 0;
        while (i < size) {
          const uint8_t d = src[i];
          if (d == '_') { i++; continue; }
          if (base == 'x' && ((d >= '0' && d <= '9') || (d >= 'a' && d <= 'f') || (d >= 'A' && d <= 'F'))) { digits++; i++; continue; }
          if (base == 'b' && (d == '0' || d == '1')) { digits++; i++; continue; }
          if (base == 'o' && (d >= '0' && d <= '7')) { digits++; i++; continue; }
          break;
        }
        if (digits == 0) { p->failed = true; return false; }
        if (i < size && src[i] == 'n') i++;
        if (i < size && (is_id_cont(src[i]) || src[i] == '.')) { p->failed = true; return false; }
      } else {
        bool has_dot = (c == '.');
        bool has_exp = false;
        if (c == '0' && i + 1 < size && src[i + 1] >= '0' && src[i + 1] <= '9') {
          p->failed = true; return false; /* Legacy octal / leading-zero decimal */
        }
        i++;
        while (i < size && ((src[i] >= '0' && src[i] <= '9') || src[i] == '_')) i++;
        if (!has_dot && i < size && src[i] == '.') {
          has_dot = true;
          i++;
          while (i < size && ((src[i] >= '0' && src[i] <= '9') || src[i] == '_')) i++;
        }
        if (i < size && (src[i] == 'e' || src[i] == 'E')) {
          has_exp = true;
          i++;
          if (i < size && (src[i] == '+' || src[i] == '-')) i++;
          uint32_t edigits = 0;
          while (i < size && ((src[i] >= '0' && src[i] <= '9') || src[i] == '_')) {
            if (src[i] != '_') edigits++;
            i++;
          }
          if (edigits == 0) { p->failed = true; return false; }
        }
        if (!has_dot && !has_exp && i < size && src[i] == 'n') i++;
        if (i < size && (is_id_cont(src[i]) || src[i] == '.')) { p->failed = true; return false; }
      }
      p->pos = i;
      p->tok = (tok_t){ .kind = TOK_NUM, .ch = c, .kw = KW_NONE, .had_nl = nl, .start = start, .end = i };
      p->allow_regex = false;
      return true;
    }

    case '/':
      if (p->allow_regex) {
        i++;
        bool in_class = false;
        while (i < size) {
          const uint8_t r = src[i];
          if (r == '\n' || r == '\r') { p->failed = true; return false; }
          if (r == '\\') { i += 2; continue; }
          if (r == '[') { in_class = true; i++; continue; }
          if (r == ']') { in_class = false; i++; continue; }
          if (r == '/' && !in_class) { i++; break; }
          i++;
        }
        if (i > size || src[i - 1] != '/') { p->failed = true; return false; }
        while (i < size && is_id_cont(src[i])) {
          if (src[i] == 'v') { p->failed = true; return false; } /* Keep /v regexes on javascript route */
          i++;
        }
        p->pos = i;
        p->tok = (tok_t){ .kind = TOK_REGEX, .ch = '/', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i };
        p->allow_regex = false;
        return true;
      }
      if (i + 1 < size && src[i + 1] == '=') {
        p->pos = i + 2;
        p->tok = (tok_t){ .kind = TOK_OP2, .ch = '/', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 2 };
        p->allow_regex = true;
        return true;
      }
      p->pos = i + 1;
      p->tok = (tok_t){ .kind = TOK_PUNC, .ch = '/', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 1 };
      p->allow_regex = true;
      return true;

    case '=':
      if (i + 1 < size) {
        if (src[i + 1] == '>') {
          p->pos = i + 2;
          p->tok = (tok_t){ .kind = TOK_ARROW, .ch = '=', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 2 };
          p->allow_regex = true;
          return true;
        }
        if (src[i + 1] == '=') {
          const uint32_t end = (i + 2 < size && src[i + 2] == '=') ? i + 3 : i + 2;
          p->pos = end;
          p->tok = (tok_t){ .kind = TOK_OP2, .ch = '=', .kw = KW_NONE, .had_nl = nl, .start = start, .end = end };
          p->allow_regex = true;
          return true;
        }
      }
      p->pos = i + 1;
      p->tok = (tok_t){ .kind = TOK_PUNC, .ch = '=', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 1 };
      p->allow_regex = true;
      return true;

    case '?':
      if (i + 1 < size) {
        if (src[i + 1] == '.' && !(i + 2 < size && src[i + 2] >= '0' && src[i + 2] <= '9')) {
          uint32_t k = i + 2;
          while (k < size && (src[k] == ' ' || src[k] == '\t' || src[k] == '\n' || src[k] == '\r')) k++;
          if (k < size && src[k] == '#') { p->failed = true; return false; }
          p->pos = i + 2;
          p->tok = (tok_t){ .kind = TOK_QDOT, .ch = '?', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 2 };
          p->allow_regex = false;
          return true;
        }
        if (src[i + 1] == '?') {
          const uint32_t end = (i + 2 < size && src[i + 2] == '=') ? i + 3 : i + 2;
          p->pos = end;
          p->tok = (tok_t){ .kind = TOK_OP2, .ch = '?', .kw = KW_NONE, .had_nl = nl, .start = start, .end = end };
          p->allow_regex = true;
          return true;
        }
      }
      p->pos = i + 1;
      p->tok = (tok_t){ .kind = TOK_PUNC, .ch = '?', .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 1 };
      p->allow_regex = true;
      return true;

    default:
      break;
  }

  /* Remaining multi-char operators: !, <, >, &, |, +, -, *, %, ^ */
  if (c == '<' && i + 3 < size && src[i + 1] == '!' && src[i + 2] == '-' && src[i + 3] == '-') {
    p->failed = true;
    return false;
  }
  if (c == '-' && i + 2 < size && src[i + 1] == '-' && src[i + 2] == '>') {
    p->failed = true;
    return false;
  }
  if (i + 1 < size) {
    const uint8_t c2 = src[i + 1];
    if ((c == '!' && c2 == '=') || (c == '<' && (c2 == '=' || c2 == '<')) ||
        (c == '>' && (c2 == '=' || c2 == '>')) || (c == '&' && (c2 == '&' || c2 == '=')) ||
        (c == '|' && (c2 == '|' || c2 == '=')) || (c == '+' && (c2 == '+' || c2 == '=')) ||
        (c == '-' && (c2 == '-' || c2 == '=')) || (c == '*' && (c2 == '*' || c2 == '=')) ||
        ((c == '%' || c == '^') && c2 == '=')) {
      uint32_t end = i + 2;
      if (end < size) {
        const uint8_t c3 = src[end];
        if ((c == '!' && c2 == '=' && c3 == '=') ||
            ((c == '&' && c2 == '&') && c3 == '=') ||
            ((c == '|' && c2 == '|') && c3 == '=') ||
            ((c == '*' && c2 == '*') && c3 == '=') ||
            ((c == '<' && c2 == '<') && c3 == '=') ||
            ((c == '>' && c2 == '>') && (c3 == '=' || c3 == '>'))) {
          end++;
          if (c == '>' && c2 == '>' && c3 == '>' && end < size && src[end] == '=') end++;
        }
      }
      p->pos = end;
      p->tok = (tok_t){ .kind = TOK_OP2, .ch = c, .kw = KW_NONE, .had_nl = nl, .start = start, .end = end };
      p->allow_regex = !((c == '+' && c2 == '+') || (c == '-' && c2 == '-'));
      return true;
    }
  }

  p->pos = i + 1;
  p->tok = (tok_t){ .kind = TOK_PUNC, .ch = c, .kw = KW_NONE, .had_nl = nl, .start = start, .end = i + 1 };
  p->allow_regex = true;
  return true;
}

/* Save/restore parser state for speculative lookahead */
typedef struct {
  uint32_t pos;
  uint32_t prev_end;
  bool allow_regex;
  uint32_t depth;
  uint32_t tpl_depth;
  tok_t tok;
} fs_mark_t;

static inline fs_mark_t save_mark(const fs_t *p) {
  return (fs_mark_t){ p->pos, p->prev_end, p->allow_regex, p->depth, p->tpl_depth, p->tok };
}

static inline void restore_mark(fs_t *p, fs_mark_t m) {
  p->pos = m.pos;
  p->prev_end = m.prev_end;
  p->allow_regex = m.allow_regex;
  p->depth = m.depth;
  p->tpl_depth = m.tpl_depth;
  p->tok = m.tok;
  p->failed = false;
}

/* Forward declarations for strict TypeScript type grammar */
static bool parse_type(fs_t *p, uint32_t depth);
static bool parse_return_type(fs_t *p, uint32_t depth);
static bool parse_type_args(fs_t *p, uint32_t depth);
static bool parse_type_params(fs_t *p, uint32_t depth);
static bool parse_type_object(fs_t *p, uint32_t depth, bool is_class);

static inline bool is_ts_reserved_type_name(const fs_t *p) {
  return p->tok.kind != TOK_ID || kw_reserved_type_name[p->tok.kw] != 0;
}

static bool parse_type_param_list_in_parens(fs_t *p, uint32_t depth) {
  if (!tok_is_punc(p, '(')) return false;
  if (!next_tok(p)) return false;
  uint32_t idx = 0;
  while (!tok_is_punc(p, ')')) {
    if (p->tok.kind == TOK_EOF) return false;
    bool is_rest = false;
    if (p->tok.kind == TOK_DOTDOTDOT) {
      is_rest = true;
      if (!next_tok(p)) return false;
    }
    if (tok_is_punc(p, '{') || tok_is_punc(p, '[')) return false;
    if (p->tok.kind != TOK_ID) return false;
    /* Reject JS reserved words as type-signature parameter names (allow `this` only as first non-rest param) */
    if (is_ts_reserved_type_name(p) && !(idx == 0 && !is_rest && tok_is_kw(p, KW_THIS))) return false;
    if (!next_tok(p)) return false;
    if (tok_is_punc(p, '?')) {
      if (!next_tok(p)) return false;
    }
    if (tok_is_punc(p, ':')) {
      if (!next_tok(p)) return false;
      if (!parse_type(p, depth + 1)) return false;
    }
    if (tok_is_punc(p, ',')) {
      if (!next_tok(p)) return false;
      if (tok_is_punc(p, ')')) break;
    } else if (!tok_is_punc(p, ')')) {
      return false;
    }
    idx++;
  }
  return next_tok(p);
}

/* Consume closing '>' of a type argument/parameter list, splitting '>>' / '>>>' / '>=' if needed */
static bool consume_gt(fs_t *p) {
  if (tok_is_punc(p, '>')) return next_tok(p);
  if (p->tok.kind == TOK_OP2 && p->tok.ch == '>') {
    p->pos = p->tok.start + 1;
    p->allow_regex = false;
    return next_tok(p);
  }
  return false;
}

static inline bool tok_starts_gt(const fs_t *p) {
  return tok_is_punc(p, '>') || (p->tok.kind == TOK_OP2 && p->tok.ch == '>');
}

static bool parse_type_params(fs_t *p, uint32_t depth) {
  if (depth > 48 || !tok_is_punc(p, '<')) return false;
  if (!next_tok(p)) return false;
  if (tok_starts_gt(p)) return false;
  for (;;) {
    while (tok_is_kw(p, KW_CONST) || tok_is_kw(p, KW_IN) || tok_is_kw(p, KW_OUT)) {
      if (!next_tok(p)) return false;
    }
    if (is_ts_reserved_type_name(p)) return false;
    if (!next_tok(p)) return false;
    if (tok_is_kw(p, KW_EXTENDS)) {
      if (!next_tok(p)) return false;
      if (!parse_type(p, depth + 1)) return false;
    }
    if (tok_is_punc(p, '=')) {
      if (!next_tok(p)) return false;
      if (!parse_type(p, depth + 1)) return false;
    }
    if (tok_is_punc(p, ',')) {
      if (!next_tok(p)) return false;
      if (tok_starts_gt(p)) break;
    } else {
      break;
    }
  }
  return consume_gt(p);
}

static bool parse_type_args(fs_t *p, uint32_t depth) {
  if (depth > 48 || !tok_is_punc(p, '<')) return false;
  if (!next_tok(p)) return false;
  if (tok_starts_gt(p)) return false;
  for (;;) {
    if (!parse_type(p, depth + 1)) return false;
    if (tok_is_punc(p, ',')) {
      if (!next_tok(p)) return false;
      if (tok_starts_gt(p)) break;
    } else {
      break;
    }
  }
  return consume_gt(p);
}

static bool parse_type_object(fs_t *p, uint32_t depth, bool is_class) {
  if (depth > 48 || !tok_is_punc(p, '{')) return false;
  if (!next_tok(p)) return false;
  while (!tok_is_punc(p, '}')) {
    if (p->tok.kind == TOK_EOF) return false;
    if (tok_is_punc(p, ';')) {
      if (!next_tok(p)) return false;
      continue;
    }
    bool has_pm_readonly = false;
    if (is_class) {
      for (;;) {
        const uint8_t mkw = p->tok.kw;
        if (mkw != KW_PUBLIC && mkw != KW_PRIVATE && mkw != KW_PROTECTED &&
            mkw != KW_STATIC && mkw != KW_ABSTRACT && mkw != KW_OVERRIDE && mkw != KW_READONLY) break;
        fs_mark_t m = save_mark(p);
        if (!next_tok(p)) return false;
        if (p->tok.had_nl || tok_is_punc(p, ':') || tok_is_punc(p, '?') || tok_is_punc(p, '(') ||
            tok_is_punc(p, '<') || tok_is_punc(p, ';') || tok_is_punc(p, ',') || tok_is_punc(p, '}')) {
          restore_mark(p, m);
          break;
        }
      }
    } else if (tok_is_punc(p, '+') || tok_is_punc(p, '-')) {
      if (!next_tok(p)) return false;
      if (!tok_is_kw(p, KW_READONLY)) return false;
      if (!next_tok(p)) return false;
      has_pm_readonly = true;
    } else if (tok_is_kw(p, KW_READONLY)) {
      fs_mark_t m = save_mark(p);
      if (!next_tok(p)) return false;
      if (tok_is_punc(p, ':') || tok_is_punc(p, '?') || tok_is_punc(p, '(') || tok_is_punc(p, ';') || tok_is_punc(p, ',') || tok_is_punc(p, '}')) {
        restore_mark(p, m);
      }
    }
    if (has_pm_readonly && !tok_is_punc(p, '[')) return false;
    if (tok_is_kw(p, KW_NEW)) {
      fs_mark_t m = save_mark(p);
      if (!next_tok(p)) return false;
      if (tok_is_punc(p, '<') || tok_is_punc(p, '(')) {
        if (tok_is_punc(p, '<') && !parse_type_params(p, depth + 1)) return false;
        if (!parse_type_param_list_in_parens(p, depth + 1)) return false;
        if (tok_is_punc(p, ':')) {
          if (!next_tok(p)) return false;
          if (!parse_return_type(p, depth + 1)) return false;
        }
        goto member_sep;
      }
      restore_mark(p, m);
    }
    if (tok_is_punc(p, '<') || tok_is_punc(p, '(')) {
      if (tok_is_punc(p, '<') && !parse_type_params(p, depth + 1)) return false;
      if (!parse_type_param_list_in_parens(p, depth + 1)) return false;
      if (tok_is_punc(p, ':')) {
        if (!next_tok(p)) return false;
        if (!parse_return_type(p, depth + 1)) return false;
      }
      goto member_sep;
    }
    if (tok_is_punc(p, '[')) {
      if (!next_tok(p)) return false;
      if (p->tok.kind == TOK_ID) {
        fs_mark_t m = save_mark(p);
        if (!next_tok(p)) return false;
        if (tok_is_kw(p, KW_IN)) {
          if (!next_tok(p)) return false;
          if (!parse_type(p, depth + 1)) return false;
          if (tok_is_kw(p, KW_AS)) {
            if (!next_tok(p)) return false;
            if (!parse_type(p, depth + 1)) return false;
          }
          if (!tok_is_punc(p, ']')) return false;
          if (!next_tok(p)) return false;
          if (tok_is_punc(p, '+') || tok_is_punc(p, '-')) {
            if (!next_tok(p)) return false;
            if (!tok_is_punc(p, '?')) return false;
            if (!next_tok(p)) return false;
          } else if (tok_is_punc(p, '?')) {
            if (!next_tok(p)) return false;
          }
          if (tok_is_punc(p, ':')) {
            if (!next_tok(p)) return false;
            if (!parse_type(p, depth + 1)) return false;
          }
          goto member_sep;
        }
        if (tok_is_punc(p, ':')) {
          if (has_pm_readonly) return false;
          if (!next_tok(p)) return false;
          if (!parse_type(p, depth + 1)) return false;
          if (!tok_is_punc(p, ']')) return false;
          if (!next_tok(p)) return false;
          if (tok_is_punc(p, ':')) {
            if (!next_tok(p)) return false;
            if (!parse_type(p, depth + 1)) return false;
          }
          goto member_sep;
        }
        restore_mark(p, m);
        if (has_pm_readonly) return false;
        /* Simple dotted computed property name `[Symbol.dispose](): void` or `[onInit]?: T` */
        if (!next_tok(p)) return false;
        while (tok_is_punc(p, '.')) {
          if (!next_tok(p) || p->tok.kind != TOK_ID) return false;
          if (!next_tok(p)) return false;
        }
        if (!tok_is_punc(p, ']')) return false;
        if (!next_tok(p)) return false;
        if (tok_is_punc(p, '?') && !next_tok(p)) return false;
        if (tok_is_punc(p, '<') || tok_is_punc(p, '(')) {
          if (tok_is_punc(p, '<') && !parse_type_params(p, depth + 1)) return false;
          if (!parse_type_param_list_in_parens(p, depth + 1)) return false;
          if (tok_is_punc(p, ':')) {
            if (!next_tok(p) || !parse_type(p, depth + 1)) return false;
          }
        } else if (tok_is_punc(p, ':')) {
          if (!next_tok(p) || !parse_type(p, depth + 1)) return false;
        }
        goto member_sep;
      }
      return false;
    }
    if (tok_is_kw(p, KW_GET) || tok_is_kw(p, KW_SET)) {
      fs_mark_t m = save_mark(p);
      if (!next_tok(p)) return false;
      if (p->tok.kind != TOK_ID && p->tok.kind != TOK_STR && p->tok.kind != TOK_NUM) {
        restore_mark(p, m);
      }
    }
    if (is_class && tok_is_punc(p, '#')) {
      if (!next_tok(p) || p->tok.kind != TOK_ID) return false;
      if (!next_tok(p)) return false;
    } else {
      if (p->tok.kind != TOK_ID && p->tok.kind != TOK_STR && p->tok.kind != TOK_NUM) return false;
      if (!next_tok(p)) return false;
    }
    if (tok_is_punc(p, '?') || (is_class && tok_is_punc(p, '!'))) {
      if (!next_tok(p)) return false;
    }
    if (tok_is_punc(p, '<') || tok_is_punc(p, '(')) {
      if (tok_is_punc(p, '<') && !parse_type_params(p, depth + 1)) return false;
      if (!parse_type_param_list_in_parens(p, depth + 1)) return false;
      if (tok_is_punc(p, ':')) {
        if (!next_tok(p)) return false;
        if (!parse_return_type(p, depth + 1)) return false;
      }
    } else if (tok_is_punc(p, ':')) {
      if (!next_tok(p)) return false;
      if (!parse_type(p, depth + 1)) return false;
    }
member_sep:
    if (tok_is_punc(p, ';') || tok_is_punc(p, ',')) {
      if (!next_tok(p)) return false;
    } else if (!tok_is_punc(p, '}') && !p->tok.had_nl) {
      return false;
    }
  }
  return next_tok(p);
}

static bool parse_import_type(fs_t *p, uint32_t depth) {
  /* Current token is `import`: parses `import("...")[.Foo.Bar][<T>]` */
  if (!next_tok(p) || !tok_is_punc(p, '(')) return false;
  if (!next_tok(p) || p->tok.kind != TOK_STR) return false;
  if (!next_tok(p) || !tok_is_punc(p, ')')) return false;
  if (!next_tok(p)) return false;
  while (tok_is_punc(p, '.')) {
    if (!next_tok(p) || p->tok.kind != TOK_ID) return false;
    if (!next_tok(p)) return false;
  }
  if (tok_is_punc(p, '<') && !parse_type_args(p, depth + 1)) return false;
  return true;
}

static bool parse_type_primary(fs_t *p, uint32_t depth) {
  if (depth > 48) return false;
  while (tok_is_kw(p, KW_READONLY) || tok_is_kw(p, KW_KEYOF) || tok_is_kw(p, KW_UNIQUE)) {
    if (!next_tok(p)) return false;
  }
  if (tok_is_kw(p, KW_INFER)) {
    if (!next_tok(p)) return false;
    if (is_ts_reserved_type_name(p)) return false;
    if (!next_tok(p)) return false;
    if (tok_is_kw(p, KW_EXTENDS)) {
      if (!next_tok(p)) return false;
      if (!parse_type(p, depth + 1)) return false;
    }
    return true;
  }
  if (tok_is_kw(p, KW_TYPEOF)) {
    if (!next_tok(p)) return false;
    if (tok_is_kw(p, KW_IMPORT)) {
      if (!parse_import_type(p, depth)) return false;
      goto postfix;
    }
    if (p->tok.kind != TOK_ID) return false;
    if (!next_tok(p)) return false;
    while (tok_is_punc(p, '.')) {
      if (!next_tok(p) || p->tok.kind != TOK_ID) return false;
      if (!next_tok(p)) return false;
    }
    if (tok_is_punc(p, '<') && !parse_type_args(p, depth + 1)) return false;
    goto postfix;
  }
  if (tok_is_punc(p, '(')) {
    if (!next_tok(p)) return false;
    if (!parse_type(p, depth + 1)) return false;
    if (!tok_is_punc(p, ')')) return false;
    if (!next_tok(p)) return false;
    goto postfix;
  }
  if (tok_is_punc(p, '[')) {
    if (!next_tok(p)) return false;
    while (!tok_is_punc(p, ']')) {
      if (p->tok.kind == TOK_EOF) return false;
      if (p->tok.kind == TOK_DOTDOTDOT && !next_tok(p)) return false;
      if (p->tok.kind == TOK_ID) {
        fs_mark_t m = save_mark(p);
        if (!next_tok(p)) return false;
        if (tok_is_punc(p, '?')) {
          if (!next_tok(p)) return false;
          if (!tok_is_punc(p, ':')) restore_mark(p, m);
          else if (!next_tok(p)) return false;
        } else if (tok_is_punc(p, ':')) {
          if (!next_tok(p)) return false;
        } else {
          restore_mark(p, m);
        }
      }
      if (!parse_type(p, depth + 1)) return false;
      if (tok_is_punc(p, '?') && !next_tok(p)) return false;
      if (tok_is_punc(p, ',')) {
        if (!next_tok(p)) return false;
        if (tok_is_punc(p, ']')) break;
      } else if (!tok_is_punc(p, ']')) {
        return false;
      }
    }
    if (!next_tok(p)) return false;
    goto postfix;
  }
  if (tok_is_punc(p, '{')) {
    if (!parse_type_object(p, depth + 1, false)) return false;
    goto postfix;
  }
  if (p->tok.kind == TOK_STR || p->tok.kind == TOK_NUM || p->tok.kind == TOK_TPL_FULL) {
    if (!next_tok(p)) return false;
    goto postfix;
  }
  if (p->tok.kind == TOK_TPL_HEAD) {
    for (;;) {
      if (!next_tok(p)) return false;
      if (!parse_type(p, depth + 1)) return false;
      if (!tok_is_punc(p, '}') || p->tpl_depth == 0) return false;
      p->tpl_depth--;
      if (!scan_template_from(p, p->tok.start, false)) return false;
      if (p->tok.kind == TOK_TPL_FULL) {
        if (!next_tok(p)) return false;
        break;
      }
    }
    goto postfix;
  }
  if (tok_is_punc(p, '-')) {
    if (!next_tok(p) || p->tok.kind != TOK_NUM) return false;
    if (!next_tok(p)) return false;
    goto postfix;
  }
  if (p->tok.kind == TOK_ID) {
    if (tok_is_kw(p, KW_IMPORT)) {
      if (!parse_import_type(p, depth)) return false;
      goto postfix;
    }
    if (kw_bad_type_start[p->tok.kw]) return false;
    if (!next_tok(p)) return false;
    while (tok_is_punc(p, '.')) {
      if (!next_tok(p) || p->tok.kind != TOK_ID) return false;
      if (!next_tok(p)) return false;
    }
    if (tok_is_punc(p, '<') && !parse_type_args(p, depth + 1)) return false;
    goto postfix;
  }
  return false;

postfix:
  while (tok_is_punc(p, '[')) {
    /* Decline newline-preceded `[` (e.g. `type T = number\n[foo];`) to Pulse so ASI isn't swallowed */
    if (p->tok.had_nl) return false;
    if (!next_tok(p)) return false;
    if (tok_is_punc(p, ']')) {
      if (!next_tok(p)) return false;
    } else {
      if (!parse_type(p, depth + 1)) return false;
      if (!tok_is_punc(p, ']')) return false;
      if (!next_tok(p)) return false;
    }
  }
  return true;
}

static bool parse_type_non_cond(fs_t *p, uint32_t depth) {
  if (tok_is_punc(p, '|') || tok_is_punc(p, '&')) {
    if (!next_tok(p)) return false;
  }
  if (!parse_type_primary(p, depth)) return false;
  while (tok_is_punc(p, '|') || tok_is_punc(p, '&')) {
    if (!next_tok(p)) return false;
    if (!parse_type_primary(p, depth)) return false;
  }
  return true;
}

static bool parse_return_type(fs_t *p, uint32_t depth) {
  /* Type predicates (`asserts x [is T]`, `x is T`, `this is T`) are only valid in return-type positions. */
  if (depth > 48) return false;
  if (tok_is_kw(p, KW_ASSERTS)) {
    fs_mark_t m = save_mark(p);
    if (next_tok(p) && !p->tok.had_nl && p->tok.kind == TOK_ID) {
      if (!next_tok(p)) return false;
      if (!p->tok.had_nl && tok_is_kw(p, KW_IS)) {
        if (!next_tok(p)) return false;
        return parse_type(p, depth + 1);
      }
      return true;
    }
    restore_mark(p, m);
  }
  if (p->tok.kind == TOK_ID) {
    fs_mark_t m = save_mark(p);
    if (next_tok(p) && !p->tok.had_nl && tok_is_kw(p, KW_IS)) {
      if (!next_tok(p)) return false;
      return parse_type(p, depth + 1);
    }
    restore_mark(p, m);
  }
  return parse_type(p, depth);
}

static bool parse_type(fs_t *p, uint32_t depth) {
  if (depth > 48) return false;
  /* Unparenthesized function / constructor types are only valid at top-level of parse_type
   * (never as direct operands of `|` or `&`, which TypeScript rejects as a syntax error). */
  if (tok_is_kw(p, KW_ABSTRACT)) {
    if (!next_tok(p) || !tok_is_kw(p, KW_NEW)) return false;
    if (!next_tok(p)) return false;
    if (tok_is_punc(p, '<') && !parse_type_params(p, depth + 1)) return false;
    if (!parse_type_param_list_in_parens(p, depth + 1)) return false;
    if (p->tok.kind != TOK_ARROW) return false;
    if (!next_tok(p)) return false;
    return parse_return_type(p, depth + 1);
  }
  if (tok_is_kw(p, KW_NEW)) {
    if (!next_tok(p)) return false;
    if (tok_is_punc(p, '<') && !parse_type_params(p, depth + 1)) return false;
    if (!parse_type_param_list_in_parens(p, depth + 1)) return false;
    if (p->tok.kind != TOK_ARROW) return false;
    if (!next_tok(p)) return false;
    return parse_return_type(p, depth + 1);
  }
  if (tok_is_punc(p, '<')) {
    if (!parse_type_params(p, depth + 1)) return false;
    if (!parse_type_param_list_in_parens(p, depth + 1)) return false;
    if (p->tok.kind != TOK_ARROW) return false;
    if (!next_tok(p)) return false;
    return parse_return_type(p, depth + 1);
  }
  if (tok_is_punc(p, '(')) {
    fs_mark_t m = save_mark(p);
    if (parse_type_param_list_in_parens(p, depth + 1) && p->tok.kind == TOK_ARROW) {
      if (!next_tok(p)) return false;
      return parse_return_type(p, depth + 1);
    }
    restore_mark(p, m);
  }
  if (!parse_type_non_cond(p, depth)) return false;
  if (!p->tok.had_nl && tok_is_kw(p, KW_EXTENDS)) {
    if (!next_tok(p)) return false;
    if (!parse_type_non_cond(p, depth + 1)) return false;
    if (!tok_is_punc(p, '?')) return false;
    if (!next_tok(p)) return false;
    if (!parse_type(p, depth + 1)) return false;
    if (!tok_is_punc(p, ':')) return false;
    if (!next_tok(p)) return false;
    if (!parse_type(p, depth + 1)) return false;
  }
  return true;
}

static bool parse_type_alias(fs_t *p, uint32_t erase_start, bool sep) {
  if (!next_tok(p)) return false;
  if (p->tok.had_nl || is_ts_reserved_type_name(p)) return false;
  if (!next_tok(p)) return false;
  if (tok_is_punc(p, '<') && !parse_type_params(p, 0)) return false;
  if (!tok_is_punc(p, '=')) return false;
  if (!next_tok(p)) return false;
  if (!parse_type(p, 0)) return false;
  uint32_t erase_end = p->prev_end;
  if (tok_is_punc(p, ';')) {
    erase_end = p->tok.end;
    if (!next_tok(p)) return false;
  } else if (p->tok.kind != TOK_EOF && !p->tok.had_nl && !tok_is_punc(p, '}')) {
    return false;
  }
  blank_span(p, erase_start, erase_end, sep);
  p->erased_any_stmt = true;
  return true;
}

static bool parse_interface_decl(fs_t *p, uint32_t erase_start, bool sep) {
  if (!next_tok(p)) return false;
  if (p->tok.had_nl || is_ts_reserved_type_name(p)) return false;
  if (!next_tok(p)) return false;
  if (tok_is_punc(p, '<') && !parse_type_params(p, 0)) return false;
  if (tok_is_kw(p, KW_EXTENDS)) {
    if (!next_tok(p)) return false;
    for (;;) {
      if (!parse_type_primary(p, 0)) return false;
      if (tok_is_punc(p, ',')) {
        if (!next_tok(p)) return false;
      } else {
        break;
      }
    }
  }
  if (!tok_is_punc(p, '{')) return false;
  if (!parse_type_object(p, 0, false)) return false;
  uint32_t erase_end = p->prev_end;
  if (tok_is_punc(p, ';')) {
    erase_end = p->tok.end;
    if (!next_tok(p)) return false;
  }
  blank_span(p, erase_start, erase_end, sep);
  p->erased_any_stmt = true;
  return true;
}

static bool parse_declare_stmt(fs_t *p, uint32_t erase_start, bool sep) {
  if (!next_tok(p)) return false;
  if (p->tok.had_nl) return false;
  if (tok_is_kw(p, KW_TYPE)) return parse_type_alias(p, erase_start, sep);
  if (tok_is_kw(p, KW_INTERFACE)) return parse_interface_decl(p, erase_start, sep);
  if (tok_is_kw(p, KW_CONST) || tok_is_kw(p, KW_LET) || tok_is_kw(p, KW_VAR)) {
    if (!next_tok(p)) return false;
    if (tok_is_kw(p, KW_ENUM)) return false;
    for (;;) {
      if (p->tok.kind != TOK_ID) return false;
      if (!next_tok(p)) return false;
      if (tok_is_punc(p, ':')) {
        if (!next_tok(p)) return false;
        if (!parse_type(p, 0)) return false;
      }
      if (tok_is_punc(p, ',')) {
        if (!next_tok(p)) return false;
      } else {
        break;
      }
    }
    uint32_t erase_end = p->prev_end;
    if (tok_is_punc(p, ';')) {
      erase_end = p->tok.end;
      if (!next_tok(p)) return false;
    } else if (p->tok.kind != TOK_EOF && !p->tok.had_nl && !tok_is_punc(p, '}')) {
      return false;
    }
    blank_span(p, erase_start, erase_end, sep);
    p->erased_any_stmt = true;
    return true;
  }
  if (tok_is_kw(p, KW_FUNCTION)) {
    if (!next_tok(p) || p->tok.kind != TOK_ID) return false;
    if (!next_tok(p)) return false;
    if (tok_is_punc(p, '<') && !parse_type_params(p, 0)) return false;
    if (!parse_type_param_list_in_parens(p, 0)) return false;
    if (tok_is_punc(p, ':')) {
      if (!next_tok(p)) return false;
      if (!parse_return_type(p, 0)) return false;
    }
    uint32_t erase_end = p->prev_end;
    if (tok_is_punc(p, ';')) {
      erase_end = p->tok.end;
      if (!next_tok(p)) return false;
    } else if (p->tok.kind != TOK_EOF && !p->tok.had_nl && !tok_is_punc(p, '}')) {
      return false;
    }
    blank_span(p, erase_start, erase_end, sep);
    p->erased_any_stmt = true;
    return true;
  }
  if (tok_is_kw(p, KW_ABSTRACT)) {
    if (!next_tok(p) || p->tok.had_nl || !tok_is_kw(p, KW_CLASS)) return false;
  }
  if (tok_is_kw(p, KW_CLASS)) {
    if (!next_tok(p) || p->tok.had_nl || is_ts_reserved_type_name(p)) return false;
    if (!next_tok(p)) return false;
    if (tok_is_punc(p, '<') && !parse_type_params(p, 0)) return false;
    if (tok_is_kw(p, KW_EXTENDS)) {
      if (!next_tok(p) || !parse_type_primary(p, 0)) return false;
    }
    if (tok_is_kw(p, KW_IMPLEMENTS)) {
      if (!next_tok(p)) return false;
      for (;;) {
        if (!parse_type_primary(p, 0)) return false;
        if (tok_is_punc(p, ',')) { if (!next_tok(p)) return false; }
        else break;
      }
    }
    if (!tok_is_punc(p, '{') || !parse_type_object(p, 0, true)) return false;
    uint32_t erase_end = p->prev_end;
    if (tok_is_punc(p, ';')) {
      erase_end = p->tok.end;
      if (!next_tok(p)) return false;
    }
    blank_span(p, erase_start, erase_end, sep);
    p->erased_any_stmt = true;
    return true;
  }
  return false;
}

static bool parse_runtime_params(fs_t *p, bool is_constructor) {
  if (!tok_is_punc(p, '(')) return false;
  if (!next_tok(p)) return false;
  uint32_t idx = 0;
  while (!tok_is_punc(p, ')')) {
    if (p->tok.kind == TOK_EOF) return false;
    if (is_constructor && (tok_is_kw(p, KW_PUBLIC) || tok_is_kw(p, KW_PRIVATE) ||
        tok_is_kw(p, KW_PROTECTED) || tok_is_kw(p, KW_READONLY) || tok_is_kw(p, KW_OVERRIDE))) {
      return false;
    }
    if (idx == 0 && tok_is_kw(p, KW_THIS)) {
      const uint32_t this_start = p->tok.start;
      if (!next_tok(p) || !tok_is_punc(p, ':')) return false;
      if (!next_tok(p) || !parse_type(p, 0)) return false;
      uint32_t this_end = p->tok.start;
      if (tok_is_punc(p, ',')) {
        this_end = p->tok.end;
        if (!next_tok(p)) return false;
      }
      blank_span(p, this_start, this_end, false);
      idx++;
      continue;
    }
    if (p->tok.kind == TOK_DOTDOTDOT && !next_tok(p)) return false;
    if (tok_is_punc(p, '{') || tok_is_punc(p, '[')) {
      uint32_t d = 1;
      if (!next_tok(p)) return false;
      while (d > 0 && p->tok.kind != TOK_EOF) {
        if (tok_is_punc(p, '{') || tok_is_punc(p, '[')) d++;
        else if (tok_is_punc(p, '}') || tok_is_punc(p, ']')) d--;
        else if (tok_is_kw(p, KW_AS) || tok_is_kw(p, KW_SATISFIES)) return false;
        if (!next_tok(p)) return false;
      }
      if (d != 0) return false;
    } else if (p->tok.kind == TOK_ID) {
      if (!next_tok(p)) return false;
    } else {
      return false;
    }
    if (tok_is_punc(p, '?') || tok_is_punc(p, ':')) {
      const uint32_t ann_start = p->tok.start;
      if (tok_is_punc(p, '?') && !next_tok(p)) return false;
      if (tok_is_punc(p, ':')) {
        if (!next_tok(p) || !parse_type(p, 0)) return false;
      }
      blank_span(p, ann_start, p->prev_end, false);
    }
    if (tok_is_punc(p, '=')) {
      if (!next_tok(p)) return false;
      uint32_t d = 0;
      while (p->tok.kind != TOK_EOF) {
        if (d == 0 && (tok_is_punc(p, ',') || tok_is_punc(p, ')'))) break;
        if (tok_is_punc(p, '(') || tok_is_punc(p, '[') || tok_is_punc(p, '{')) d++;
        else if (tok_is_punc(p, ')') || tok_is_punc(p, ']') || tok_is_punc(p, '}')) {
          if (d == 0) break;
          d--;
        } else if (tok_is_kw(p, KW_AS) || tok_is_kw(p, KW_SATISFIES) || tok_is_punc(p, '<')) {
          return false;
        }
        if (!next_tok(p)) return false;
      }
    }
    if (tok_is_punc(p, ',')) {
      if (!next_tok(p)) return false;
      if (tok_is_punc(p, ')')) break;
    } else if (!tok_is_punc(p, ')')) {
      return false;
    }
    idx++;
  }
  return next_tok(p);
}

/* Parse class header after `class` keyword up to `{` (consumes `{`). */
static bool parse_class_header(fs_t *p) {
  if (!next_tok(p)) return false;
  if (p->tok.kind == TOK_ID && !tok_is_kw(p, KW_EXTENDS) && !tok_is_kw(p, KW_IMPLEMENTS)) {
    if (!next_tok(p)) return false;
  }
  if (tok_is_punc(p, '<')) {
    const uint32_t tp_start = p->tok.start;
    if (!parse_type_params(p, 0)) return false;
    blank_span(p, tp_start, p->prev_end, false);
  }
  if (tok_is_kw(p, KW_EXTENDS)) {
    if (!next_tok(p)) return false;
    /* Parse simple member/call heritage expression up to `{` or `implements`, erasing trailing `<TypeArgs>` */
    uint32_t d = 0;
    while (p->tok.kind != TOK_EOF) {
      if (d == 0 && (tok_is_punc(p, '{') || tok_is_kw(p, KW_IMPLEMENTS))) break;
      if (d == 0 && tok_is_punc(p, '<')) {
        const uint32_t ta_start = p->tok.start;
        if (!parse_type_args(p, 0)) return false;
        blank_span(p, ta_start, p->prev_end, false);
        continue;
      }
      if (tok_is_punc(p, '(') || tok_is_punc(p, '[')) d++;
      else if (tok_is_punc(p, ')') || tok_is_punc(p, ']')) {
        if (d == 0) return false;
        d--;
      } else if (tok_is_punc(p, '{') || tok_is_kw(p, KW_AS) || tok_is_kw(p, KW_SATISFIES)) {
        return false;
      }
      if (!next_tok(p)) return false;
    }
    if (d != 0) return false;
  }
  if (tok_is_kw(p, KW_IMPLEMENTS)) {
    const uint32_t imp_start = p->tok.start;
    if (!next_tok(p)) return false;
    for (;;) {
      if (!parse_type_primary(p, 0)) return false;
      if (tok_is_punc(p, ',')) {
        if (!next_tok(p)) return false;
      } else {
        break;
      }
    }
    blank_span(p, imp_start, p->prev_end, false);
  }
  return tok_is_punc(p, '{');
}

/* Parse `{ [type] a [as b], ... }` in `import` or `export`, erasing inline `type` specifiers.
 * Declines (returns false) if ALL specifiers are type-only so Pulse/elision decides it. */
static bool parse_named_specifiers(fs_t *p) {
  if (!tok_is_punc(p, '{')) return false;
  if (!next_tok(p)) return false;
  uint32_t erased = 0, kept = 0;
  uint32_t spans[32][2];
  while (!tok_is_punc(p, '}')) {
    if (p->tok.kind == TOK_EOF) return false;
    const uint32_t spec_start = p->tok.start;
    bool is_type_spec = false;
    if (tok_is_kw(p, KW_TYPE)) {
      fs_mark_t m = save_mark(p);
      if (!next_tok(p)) return false;
      /* `type` is a modifier unless followed by `,`, `}`, or `as` (without another id after `as`) */
      if (p->tok.kind == TOK_ID || p->tok.kind == TOK_STR) {
        if (tok_is_kw(p, KW_AS)) {
          fs_mark_t m2 = save_mark(p);
          if (!next_tok(p)) return false;
          if (tok_is_kw(p, KW_AS)) {
            /* `type as as foo` -> `type` is modifier, name is `as` */
            restore_mark(p, m2);
            is_type_spec = true;
          } else {
            /* `type as foo` -> value named `type` aliased to `foo` */
            restore_mark(p, m);
          }
        } else {
          is_type_spec = true;
        }
      } else {
        restore_mark(p, m);
      }
    }
    if (p->tok.kind != TOK_ID && p->tok.kind != TOK_STR) return false;
    if (!next_tok(p)) return false;
    if (tok_is_kw(p, KW_AS)) {
      if (!next_tok(p)) return false;
      if (p->tok.kind != TOK_ID && p->tok.kind != TOK_STR) return false;
      if (!next_tok(p)) return false;
    }
    uint32_t spec_end = p->prev_end;
    if (tok_is_punc(p, ',')) {
      spec_end = p->tok.end;
      if (!next_tok(p)) return false;
    } else if (!tok_is_punc(p, '}')) {
      return false;
    }
    if (is_type_spec) {
      if (erased >= 32) return false;
      spans[erased][0] = spec_start;
      spans[erased][1] = spec_end;
      erased++;
    } else {
      kept++;
    }
  }
  if (erased > 0) {
    if (kept == 0) return false; /* All-type `{ type a }` -> let Pulse handle elision */
    for (uint32_t i = 0; i < erased; i++) blank_span(p, spans[i][0], spans[i][1], false);
  }
  return next_tok(p);
}

static bool skip_import_attrs(fs_t *p) {
  if (!p->tok.had_nl && (tok_is_kw(p, KW_WITH) || tok_is_kw(p, KW_ASSERT))) {
    if (!next_tok(p) || !tok_is_punc(p, '{')) return false;
    if (!next_tok(p)) return false;
    while (!tok_is_punc(p, '}')) {
      if (p->tok.kind != TOK_ID && p->tok.kind != TOK_STR) return false;
      if (!next_tok(p) || !tok_is_punc(p, ':')) return false;
      if (!next_tok(p) || p->tok.kind != TOK_STR) return false;
      if (!next_tok(p)) return false;
      if (tok_is_punc(p, ',')) {
        if (!next_tok(p)) return false;
        if (tok_is_punc(p, '}')) break;
      } else if (!tok_is_punc(p, '}')) return false;
    }
    if (!next_tok(p)) return false;
  }
  return true;
}

/* Main single-pass scan over module tokens */
char *tmt_fast_strip_module(const uint8_t *source, uint32_t size, uint32_t first_at, bool esm,
  char *out_buf, size_t *out_len, bool *edited)
{
  *edited = false;
  if (!source || !size || !out_buf) return NULL;

  fs_t p = {
    .src = source,
    .size = size,
    .pos = first_at <= size ? first_at : 0U,
    .out = out_buf,
    .edited = false,
    .failed = false,
    .allow_regex = true,
    .has_runtime_mod = false,
    .erased_any_stmt = false,
    .has_runtime_stmt = false,
    .depth = 0,
    .tpl_depth = 0,
  };

  if (!next_tok(&p)) return NULL;
  if (p.tok.kind == TOK_EOF) return NULL;

  enum { SCOPE_BLOCK = 0, SCOPE_CLASS = 1 };
  uint8_t scope_kind[64];
  uint8_t paren_stmt_hdr[64];
  bool stmt_start = true;
  uint32_t ternary_depth = 0;
  uint32_t paren_depth = 0;
  uint32_t bracket_depth = 0;
  uint8_t prev_kind = TOK_EOF;
  uint8_t prev_ch = 0;
  uint8_t prev_kw = KW_NONE;
  bool prev_can_precede_arrow = true;
  bool has_pending_export = false;
  uint32_t pending_export_start = 0;

  while (p.tok.kind != TOK_EOF) {
    /* Template interpolation closing `}` */
    if (p.tpl_depth > 0 && tok_is_punc(&p, '}') && p.depth == p.tpl_brace_depth[p.tpl_depth - 1]) {
      p.tpl_depth--;
      if (!scan_template_from(&p, p.tok.start, false)) return NULL;
      prev_kind = p.tok.kind;
      prev_ch = p.tok.ch;
      if (!next_tok(&p)) return NULL;
      stmt_start = false;
      continue;
    }

    /* Class body member handling */
    if (stmt_start && p.depth > 0 && scope_kind[p.depth - 1] == SCOPE_CLASS &&
        paren_depth == 0 && bracket_depth == 0 && ternary_depth == 0) {
      if (tok_is_punc(&p, ';')) {
        prev_kind = TOK_PUNC;
        prev_ch = ';';
        if (!next_tok(&p)) return NULL;
        continue;
      }
      if (tok_is_punc(&p, '}')) {
        p.depth--;
        prev_kind = TOK_PUNC;
        prev_ch = '}';
        if (!next_tok(&p)) return NULL;
        stmt_start = true;
        continue;
      }
      const uint32_t member_start = p.tok.start;
      bool is_declare = false, is_abstract = false;
      uint32_t ts_mod_spans[8][2];
      unsigned ts_mod_count = 0;
      for (;;) {
        const uint8_t kw = p.tok.kw;
        const bool ts_mod = (kw == KW_PUBLIC || kw == KW_PRIVATE || kw == KW_PROTECTED ||
                             kw == KW_READONLY || kw == KW_OVERRIDE);
        const bool decl_mod = (kw == KW_DECLARE);
        const bool abs_mod = (kw == KW_ABSTRACT);
        const bool js_mod = (kw == KW_STATIC || kw == KW_ASYNC || kw == KW_GET || kw == KW_SET);
        if (kw == KW_ACCESSOR) return NULL;
        if (!ts_mod && !decl_mod && !abs_mod && !js_mod) break;
        fs_mark_t m = save_mark(&p);
        const uint32_t ms = p.tok.start, me = p.tok.end;
        if (!next_tok(&p)) return NULL;
        if (p.tok.had_nl || tok_is_punc(&p, '(') || tok_is_punc(&p, ':') || tok_is_punc(&p, '=') ||
            tok_is_punc(&p, ';') || tok_is_punc(&p, '?') || tok_is_punc(&p, '!') ||
            tok_is_punc(&p, '}') || tok_is_punc(&p, '<') || tok_is_punc(&p, '{')) {
          if (js_mod && tok_is_punc(&p, '{')) return NULL;
          restore_mark(&p, m);
          break;
        }
        if (ts_mod) {
          if (ts_mod_count >= 8) return NULL;
          ts_mod_spans[ts_mod_count][0] = ms;
          ts_mod_spans[ts_mod_count][1] = me;
          ts_mod_count++;
        } else if (decl_mod) {
          is_declare = true;
        } else if (abs_mod) {
          is_abstract = true;
        }
      }
      /* Index signature `[k: K]: V;` */
      if (tok_is_punc(&p, '[')) {
        fs_mark_t m = save_mark(&p);
        if (!next_tok(&p)) return NULL;
        if (p.tok.kind == TOK_ID && next_tok(&p) && tok_is_punc(&p, ':')) {
          if (!next_tok(&p) || !parse_type(&p, 0) || !tok_is_punc(&p, ']')) return NULL;
          if (!next_tok(&p)) return NULL;
          if (tok_is_punc(&p, ':')) {
            if (!next_tok(&p) || !parse_type(&p, 0)) return NULL;
          }
          uint32_t end = p.prev_end;
          if (tok_is_punc(&p, ';')) { end = p.tok.end; if (!next_tok(&p)) return NULL; }
          else if (!tok_is_punc(&p, '}') && !p.tok.had_nl) return NULL;
          blank_span(&p, member_start, end, true);
          prev_kind = TOK_PUNC;
          prev_ch = ';';
          continue;
        }
        restore_mark(&p, m);
        return NULL;
      }
      if (tok_is_punc(&p, '*') && !next_tok(&p)) return NULL;
      bool is_ctor = false;
      if (tok_is_punc(&p, '#')) {
        if (!next_tok(&p) || p.tok.kind != TOK_ID) return NULL;
        if (!next_tok(&p)) return NULL;
      } else if (p.tok.kind == TOK_ID || p.tok.kind == TOK_STR || p.tok.kind == TOK_NUM) {
        is_ctor = tok_is_kw(&p, KW_CONSTRUCTOR);
        if (!next_tok(&p)) return NULL;
      } else {
        return NULL;
      }
      uint32_t opt_start = 0, opt_end = 0;
      if (tok_is_punc(&p, '?') || tok_is_punc(&p, '!')) {
        opt_start = p.tok.start;
        opt_end = p.tok.end;
        if (!next_tok(&p)) return NULL;
      }
      if (tok_is_punc(&p, '<') || tok_is_punc(&p, '(')) {
        uint32_t tp_start = 0, tp_end = 0;
        if (tok_is_punc(&p, '<')) {
          tp_start = p.tok.start;
          if (!parse_type_params(&p, 0)) return NULL;
          tp_end = p.prev_end;
        }
        if (!tok_is_punc(&p, '(')) return NULL;
        if (is_declare || is_abstract) {
          if (!parse_type_param_list_in_parens(&p, 0)) return NULL;
        } else {
          if (!parse_runtime_params(&p, is_ctor)) return NULL;
        }
        uint32_t rt_start = 0, rt_end = 0;
        if (tok_is_punc(&p, ':')) {
          rt_start = p.tok.start;
          if (!next_tok(&p) || !parse_return_type(&p, 0)) return NULL;
          rt_end = p.prev_end;
        }
        if (!tok_is_punc(&p, '{')) {
          uint32_t end = p.prev_end;
          if (tok_is_punc(&p, ';')) { end = p.tok.end; if (!next_tok(&p)) return NULL; }
          else if (!tok_is_punc(&p, '}') && !p.tok.had_nl) return NULL;
          blank_span(&p, member_start, end, true);
          prev_kind = TOK_PUNC;
          prev_ch = ';';
          continue;
        }
        if (is_declare || is_abstract) return NULL;
        for (unsigned mi = 0; mi < ts_mod_count; mi++) {
          blank_span(&p, ts_mod_spans[mi][0], ts_mod_spans[mi][1], false);
        }
        if (opt_start < opt_end) blank_span(&p, opt_start, opt_end, false);
        if (tp_start < tp_end) blank_span(&p, tp_start, tp_end, false);
        if (rt_start < rt_end) blank_span(&p, rt_start, rt_end, false);
        if (p.depth >= 64) return NULL;
        scope_kind[p.depth++] = SCOPE_BLOCK;
        prev_kind = TOK_PUNC;
        prev_ch = '{';
        if (!next_tok(&p)) return NULL;
        stmt_start = true;
        continue;
      }
      uint32_t ann_start = 0, ann_end = 0;
      if (tok_is_punc(&p, ':')) {
        ann_start = p.tok.start;
        if (!next_tok(&p) || !parse_type(&p, 0)) return NULL;
        ann_end = p.prev_end;
      }
      if (is_declare || is_abstract) {
        if (tok_is_punc(&p, '=')) return NULL;
        uint32_t end = p.prev_end;
        if (tok_is_punc(&p, ';')) { end = p.tok.end; if (!next_tok(&p)) return NULL; }
        else if (!tok_is_punc(&p, '}') && !p.tok.had_nl) return NULL;
        blank_span(&p, member_start, end, true);
        prev_kind = TOK_PUNC;
        prev_ch = ';';
        continue;
      }
      for (unsigned mi = 0; mi < ts_mod_count; mi++) {
        blank_span(&p, ts_mod_spans[mi][0], ts_mod_spans[mi][1], false);
      }
      if (opt_start < opt_end) blank_span(&p, opt_start, opt_end, false);
      if (ann_start < ann_end) blank_span(&p, ann_start, ann_end, false);
      if (tok_is_punc(&p, '=')) {
        prev_kind = TOK_PUNC;
        prev_ch = '=';
        prev_can_precede_arrow = true;
        if (!next_tok(&p)) return NULL;
        stmt_start = false;
        continue;
      }
      if (tok_is_punc(&p, ';')) {
        prev_kind = TOK_PUNC;
        prev_ch = ';';
        if (!next_tok(&p)) return NULL;
        stmt_start = true;
        continue;
      }
      if (tok_is_punc(&p, '}') || p.tok.had_nl) {
        stmt_start = true;
        continue;
      }
      return NULL;
    }

    /* Statement-start constructs (top-level or block-level) */
    if (stmt_start && paren_depth == 0 && bracket_depth == 0 && ternary_depth == 0) {
      const uint8_t kw = p.tok.kw;
      const bool need_sep = p.has_runtime_stmt && prev_kind != TOK_EOF &&
        !(prev_kind == TOK_PUNC && (prev_ch == ';' || prev_ch == '}' || prev_ch == '{'));
      if (kw == KW_ENUM || kw == KW_NAMESPACE || kw == KW_USING) return NULL;
      if (kw == KW_MODULE) {
        fs_mark_t m = save_mark(&p);
        if (!next_tok(&p)) return NULL;
        if (!p.tok.had_nl && (p.tok.kind == TOK_ID || p.tok.kind == TOK_STR)) return NULL;
        restore_mark(&p, m);
      }
      if (kw == KW_TYPE) {
        fs_mark_t m = save_mark(&p);
        if (parse_type_alias(&p, m.tok.start, need_sep)) {
          has_pending_export = false;
          stmt_start = true;
          prev_kind = TOK_PUNC;
          prev_ch = ';';
          continue;
        }
        restore_mark(&p, m);
      }
      if (kw == KW_INTERFACE) {
        fs_mark_t m = save_mark(&p);
        if (parse_interface_decl(&p, m.tok.start, need_sep)) {
          has_pending_export = false;
          stmt_start = true;
          prev_kind = TOK_PUNC;
          prev_ch = ';';
          continue;
        }
        restore_mark(&p, m);
      }
      if (kw == KW_DECLARE) {
        fs_mark_t m = save_mark(&p);
        if (parse_declare_stmt(&p, m.tok.start, need_sep)) {
          has_pending_export = false;
          stmt_start = true;
          prev_kind = TOK_PUNC;
          prev_ch = ';';
          continue;
        }
        return NULL;
      }
      if (kw == KW_ABSTRACT) {
        fs_mark_t m = save_mark(&p);
        const uint32_t abs_start = p.tok.start, abs_end = p.tok.end;
        if (!next_tok(&p)) return NULL;
        if (!p.tok.had_nl && tok_is_kw(&p, KW_CLASS)) {
          blank_span(&p, abs_start, abs_end, false);
          /* Fall through directly to `class` below */
        } else {
          restore_mark(&p, m);
          return NULL;
        }
      }
      if (p.depth == 0 && p.tok.kw == KW_EXPORT) {
        const uint32_t exp_start = p.tok.start;
        if (!next_tok(&p)) return NULL;
        if (tok_is_punc(&p, '=')) return NULL;
        if (tok_is_kw(&p, KW_ENUM) || tok_is_kw(&p, KW_NAMESPACE)) return NULL;
        if (tok_is_kw(&p, KW_ABSTRACT)) {
          fs_mark_t m = save_mark(&p);
          const uint32_t abs_start = p.tok.start, abs_end = p.tok.end;
          if (!next_tok(&p)) return NULL;
          if (!p.tok.had_nl && tok_is_kw(&p, KW_CLASS)) {
            blank_span(&p, abs_start, abs_end, false);
            p.has_runtime_mod = true;
            p.has_runtime_stmt = true;
            has_pending_export = false;
            prev_kind = TOK_ID;
            prev_ch = 'e';
            continue;
          }
          restore_mark(&p, m);
          return NULL;
        }
        if (tok_is_kw(&p, KW_DECLARE)) {
          if (!parse_declare_stmt(&p, exp_start, need_sep)) return NULL;
          has_pending_export = false;
          stmt_start = true;
          continue;
        }
        if (tok_is_kw(&p, KW_INTERFACE)) {
          if (!parse_interface_decl(&p, exp_start, need_sep)) return NULL;
          has_pending_export = false;
          stmt_start = true;
          continue;
        }
        if (tok_is_kw(&p, KW_TYPE)) {
          fs_mark_t m = save_mark(&p);
          if (!next_tok(&p)) return NULL;
          if (tok_is_punc(&p, '{')) {
            if (!next_tok(&p)) return NULL;
            while (!tok_is_punc(&p, '}')) {
              if (p.tok.kind != TOK_ID && p.tok.kind != TOK_STR) return NULL;
              if (!next_tok(&p)) return NULL;
              if (tok_is_kw(&p, KW_AS)) {
                if (!next_tok(&p)) return NULL;
                if (p.tok.kind != TOK_ID && p.tok.kind != TOK_STR) return NULL;
                if (!next_tok(&p)) return NULL;
              }
              if (tok_is_punc(&p, ',')) {
                if (!next_tok(&p)) return NULL;
                if (tok_is_punc(&p, '}')) break;
              } else if (!tok_is_punc(&p, '}')) {
                return NULL;
              }
            }
            if (!next_tok(&p)) return NULL;
            if (tok_is_kw(&p, KW_FROM)) {
              if (!next_tok(&p) || p.tok.kind != TOK_STR) return NULL;
              if (!next_tok(&p)) return NULL;
              if (!skip_import_attrs(&p)) return NULL;
            }
            uint32_t exp_end = p.prev_end;
            if (tok_is_punc(&p, ';')) { exp_end = p.tok.end; if (!next_tok(&p)) return NULL; }
            else if (p.tok.kind != TOK_EOF && !p.tok.had_nl) return NULL;
            blank_span(&p, exp_start, exp_end, need_sep);
            p.erased_any_stmt = true;
            has_pending_export = false;
            stmt_start = true;
            continue;
          }
          if (tok_is_punc(&p, '*')) {
            /* `export type * [as ns] from "...";` */
            if (!next_tok(&p)) return NULL;
            if (tok_is_kw(&p, KW_AS)) {
              if (!next_tok(&p) || (p.tok.kind != TOK_ID && p.tok.kind != TOK_STR)) return NULL;
              if (!next_tok(&p)) return NULL;
            }
            if (!tok_is_kw(&p, KW_FROM)) return NULL;
            if (!next_tok(&p) || p.tok.kind != TOK_STR) return NULL;
            if (!next_tok(&p)) return NULL;
            if (!skip_import_attrs(&p)) return NULL;
            uint32_t exp_end = p.prev_end;
            if (tok_is_punc(&p, ';')) { exp_end = p.tok.end; if (!next_tok(&p)) return NULL; }
            else if (p.tok.kind != TOK_EOF && !p.tok.had_nl) return NULL;
            blank_span(&p, exp_start, exp_end, need_sep);
            p.erased_any_stmt = true;
            has_pending_export = false;
            stmt_start = true;
            continue;
          }
          restore_mark(&p, m);
          if (!parse_type_alias(&p, exp_start, need_sep)) return NULL;
          has_pending_export = false;
          stmt_start = true;
          continue;
        }
        if (tok_is_kw(&p, KW_DEFAULT)) {
          if (!next_tok(&p)) return NULL;
          if (tok_is_kw(&p, KW_INTERFACE)) {
            if (!parse_interface_decl(&p, exp_start, need_sep)) return NULL;
            has_pending_export = false;
            stmt_start = true;
            continue;
          }
          if (tok_is_kw(&p, KW_ABSTRACT)) {
            fs_mark_t m2 = save_mark(&p);
            const uint32_t abs_s = p.tok.start, abs_e = p.tok.end;
            if (!next_tok(&p)) return NULL;
            if (!p.tok.had_nl && tok_is_kw(&p, KW_CLASS)) {
              blank_span(&p, abs_s, abs_e, false);
            } else {
              restore_mark(&p, m2);
              return NULL;
            }
          }
          if (tok_is_kw(&p, KW_FUNCTION) || tok_is_kw(&p, KW_ASYNC)) {
            has_pending_export = true;
            pending_export_start = exp_start;
          } else {
            p.has_runtime_mod = true;
            p.has_runtime_stmt = true;
            has_pending_export = false;
          }
          prev_kind = TOK_ID;
          prev_ch = 'd';
          prev_can_precede_arrow = true;
          continue;
        }
        if (tok_is_punc(&p, '{')) {
          if (!parse_named_specifiers(&p)) return NULL;
          p.has_runtime_mod = true;
          p.has_runtime_stmt = true;
          has_pending_export = false;
          stmt_start = false;
          prev_kind = TOK_PUNC;
          prev_ch = '}';
          continue;
        }
        if (tok_is_kw(&p, KW_FUNCTION) || tok_is_kw(&p, KW_ASYNC)) {
          has_pending_export = true;
          pending_export_start = exp_start;
        } else {
          p.has_runtime_mod = true;
          p.has_runtime_stmt = true;
          has_pending_export = false;
        }
        prev_kind = TOK_ID;
        prev_ch = 'e';
        continue;
      }
      if (p.depth == 0 && kw == KW_IMPORT) {
        const uint32_t imp_start = p.tok.start;
        if (!next_tok(&p)) return NULL;
        if (tok_is_punc(&p, '(') || tok_is_punc(&p, '.')) {
          p.has_runtime_stmt = true;
          stmt_start = false;
          prev_kind = TOK_ID;
          prev_ch = 'i';
          continue;
        }
        if (p.tok.kind == TOK_ID &&
            ((p.tok.end - p.tok.start == 6 && !memcmp(source + p.tok.start, "source", 6)) ||
             (p.tok.end - p.tok.start == 5 && !memcmp(source + p.tok.start, "defer", 5)))) {
          return NULL;
        }
        if (tok_is_kw(&p, KW_TYPE)) {
          /* Strictly parse `import type` clause:
           *   import type id from "s"
           *   import type * as id from "s"
           *   import type { ... } from "s"
           *   import type id, { ... } from "s"
           *   import type id, * as ns from "s"
           * with optional `with { ... }` / `assert { ... }` import attributes. */
          if (!next_tok(&p)) return NULL;
          if (tok_is_punc(&p, '=')) return NULL;
          if (tok_is_punc(&p, '*')) {
            if (!next_tok(&p) || !tok_is_kw(&p, KW_AS)) return NULL;
            if (!next_tok(&p) || p.tok.kind != TOK_ID) return NULL;
            if (!next_tok(&p)) return NULL;
          } else if (tok_is_punc(&p, '{')) {
            if (!next_tok(&p)) return NULL;
            while (!tok_is_punc(&p, '}')) {
              if (p.tok.kind != TOK_ID && p.tok.kind != TOK_STR) return NULL;
              if (!next_tok(&p)) return NULL;
              if (tok_is_kw(&p, KW_AS)) {
                if (!next_tok(&p) || (p.tok.kind != TOK_ID && p.tok.kind != TOK_STR)) return NULL;
                if (!next_tok(&p)) return NULL;
              }
              if (tok_is_punc(&p, ',')) {
                if (!next_tok(&p)) return NULL;
                if (tok_is_punc(&p, '}')) break;
              } else if (!tok_is_punc(&p, '}')) return NULL;
            }
            if (!next_tok(&p)) return NULL;
          } else if (p.tok.kind == TOK_ID) {
            if (!next_tok(&p)) return NULL;
            if (tok_is_punc(&p, ',')) {
              if (!next_tok(&p)) return NULL;
              if (tok_is_punc(&p, '*')) {
                if (!next_tok(&p) || !tok_is_kw(&p, KW_AS)) return NULL;
                if (!next_tok(&p) || p.tok.kind != TOK_ID) return NULL;
                if (!next_tok(&p)) return NULL;
              } else if (tok_is_punc(&p, '{')) {
                if (!next_tok(&p)) return NULL;
                while (!tok_is_punc(&p, '}')) {
                  if (p.tok.kind != TOK_ID && p.tok.kind != TOK_STR) return NULL;
                  if (!next_tok(&p)) return NULL;
                  if (tok_is_kw(&p, KW_AS)) {
                    if (!next_tok(&p) || (p.tok.kind != TOK_ID && p.tok.kind != TOK_STR)) return NULL;
                    if (!next_tok(&p)) return NULL;
                  }
                  if (tok_is_punc(&p, ',')) {
                    if (!next_tok(&p)) return NULL;
                    if (tok_is_punc(&p, '}')) break;
                  } else if (!tok_is_punc(&p, '}')) return NULL;
                }
                if (!next_tok(&p)) return NULL;
              } else {
                return NULL;
              }
            }
          } else {
            return NULL;
          }
          if (!tok_is_kw(&p, KW_FROM)) return NULL;
          if (!next_tok(&p) || p.tok.kind != TOK_STR) return NULL;
          if (!next_tok(&p)) return NULL;
          if (!skip_import_attrs(&p)) return NULL;
          uint32_t imp_end = p.prev_end;
          if (tok_is_punc(&p, ';')) {
            imp_end = p.tok.end;
            if (!next_tok(&p)) return NULL;
          } else if (p.tok.kind != TOK_EOF && !p.tok.had_nl) {
            return NULL;
          }
          blank_span(&p, imp_start, imp_end, need_sep);
          p.erased_any_stmt = true;
          stmt_start = true;
          goto next_iter;
        }
        /* Check `import x = ...` and handle inline `import [def,] { type a, b } from "..."` */
        if (p.tok.kind == TOK_ID) {
          fs_mark_t m = save_mark(&p);
          if (!next_tok(&p)) return NULL;
          if (tok_is_punc(&p, '=')) return NULL;
          if (tok_is_punc(&p, ',')) {
            if (!next_tok(&p)) return NULL;
            if (tok_is_punc(&p, '{')) {
              if (!parse_named_specifiers(&p)) return NULL;
              p.has_runtime_mod = true;
              p.has_runtime_stmt = true;
              stmt_start = false;
              prev_kind = TOK_PUNC;
              prev_ch = '}';
              continue;
            }
          }
          restore_mark(&p, m);
        } else if (tok_is_punc(&p, '{')) {
          if (!parse_named_specifiers(&p)) return NULL;
          p.has_runtime_mod = true;
          p.has_runtime_stmt = true;
          stmt_start = false;
          prev_kind = TOK_PUNC;
          prev_ch = '}';
          continue;
        }
        p.has_runtime_mod = true;
        p.has_runtime_stmt = true;
        stmt_start = false;
        prev_kind = TOK_ID;
        prev_ch = 'i';
        continue;
      }
      if (kw == KW_FOR) {
        fs_mark_t m = save_mark(&p);
        if (!next_tok(&p)) return NULL;
        if (tok_is_kw(&p, KW_AWAIT) && !next_tok(&p)) return NULL;
        if (tok_is_punc(&p, '(')) {
          if (!next_tok(&p)) return NULL;
          if (tok_is_punc(&p, '[') || tok_is_punc(&p, '{')) return NULL;
        }
        restore_mark(&p, m);
      }
      if (kw == KW_CONST || kw == KW_LET || kw == KW_VAR) {
        const bool is_const = (kw == KW_CONST);
        p.has_runtime_stmt = true;
        has_pending_export = false;
        if (!next_tok(&p)) return NULL;
        if (is_const && tok_is_kw(&p, KW_ENUM)) return NULL;
        if (p.tok.kind == TOK_ID) {
          for (;;) {
            if (!next_tok(&p)) return NULL;
            if (tok_is_punc(&p, '!') || tok_is_punc(&p, ':')) {
              const uint32_t ann_start = p.tok.start;
              if (tok_is_punc(&p, '!')) {
                if (!next_tok(&p) || !tok_is_punc(&p, ':')) return NULL;
              }
              if (!next_tok(&p) || !parse_type(&p, 0)) return NULL;
              blank_span(&p, ann_start, p.prev_end, false);
            }
            if (tok_is_punc(&p, ',')) {
              if (!next_tok(&p)) return NULL;
              if (p.tok.kind == TOK_ID) continue;
            }
            break;
          }
        } else if (tok_is_punc(&p, '{') || tok_is_punc(&p, '[')) {
          uint32_t d = 1;
          if (!next_tok(&p)) return NULL;
          while (d > 0 && p.tok.kind != TOK_EOF) {
            if (tok_is_punc(&p, '{') || tok_is_punc(&p, '[')) d++;
            else if (tok_is_punc(&p, '}') || tok_is_punc(&p, ']')) d--;
            else if (tok_is_kw(&p, KW_AS) || tok_is_kw(&p, KW_SATISFIES)) return NULL;
            if (!next_tok(&p)) return NULL;
          }
          if (d != 0) return NULL;
          if (tok_is_punc(&p, ':')) {
            const uint32_t ann_start = p.tok.start;
            if (!next_tok(&p) || !parse_type(&p, 0)) return NULL;
            blank_span(&p, ann_start, p.prev_end, false);
          }
        }
        stmt_start = false;
        prev_kind = TOK_ID;
        prev_ch = 'v';
        continue;
      }
      if (p.tok.kw == KW_CLASS) {
        has_pending_export = false;
        if (!parse_class_header(&p) || p.depth >= 64) return NULL;
        p.has_runtime_stmt = true;
        scope_kind[p.depth++] = SCOPE_CLASS;
        prev_kind = TOK_PUNC;
        prev_ch = '{';
        if (!next_tok(&p)) return NULL;
        stmt_start = true;
        continue;
      }
      if (kw == KW_FUNCTION || kw == KW_ASYNC) {
        fs_mark_t m = save_mark(&p);
        const uint32_t fn_start = has_pending_export ? pending_export_start : p.tok.start;
        if (kw == KW_ASYNC) {
          if (!next_tok(&p)) return NULL;
          if (p.tok.had_nl || !tok_is_kw(&p, KW_FUNCTION)) {
            restore_mark(&p, m);
            if (has_pending_export) {
              p.has_runtime_mod = true;
              p.has_runtime_stmt = true;
              has_pending_export = false;
            }
            goto normal_tok;
          }
        }
        if (!next_tok(&p)) return NULL;
        if (tok_is_punc(&p, '*') && !next_tok(&p)) return NULL;
        if (p.tok.kind == TOK_ID && !next_tok(&p)) return NULL;
        if (tok_is_punc(&p, '<')) {
          const uint32_t tp_start = p.tok.start;
          if (!parse_type_params(&p, 0)) return NULL;
          blank_span(&p, tp_start, p.prev_end, false);
        }
        if (!tok_is_punc(&p, '(') || !parse_runtime_params(&p, false)) return NULL;
        if (tok_is_punc(&p, ':')) {
          const uint32_t rt_start = p.tok.start;
          if (!next_tok(&p) || !parse_return_type(&p, 0)) return NULL;
          blank_span(&p, rt_start, p.prev_end, false);
        }
        if (!tok_is_punc(&p, '{')) {
          uint32_t ov_end = p.prev_end;
          if (tok_is_punc(&p, ';')) { ov_end = p.tok.end; if (!next_tok(&p)) return NULL; }
          else if (p.tok.kind != TOK_EOF && !p.tok.had_nl && !tok_is_punc(&p, '}')) return NULL;
          blank_span(&p, fn_start, ov_end, need_sep);
          p.erased_any_stmt = true;
          has_pending_export = false;
          stmt_start = true;
          prev_kind = TOK_PUNC;
          prev_ch = ';';
          continue;
        }
        if (p.depth >= 64) return NULL;
        if (has_pending_export) {
          p.has_runtime_mod = true;
          has_pending_export = false;
        }
        p.has_runtime_stmt = true;
        scope_kind[p.depth++] = SCOPE_BLOCK;
        if (!next_tok(&p)) return NULL;
        stmt_start = true;
        prev_kind = TOK_PUNC;
        prev_ch = '{';
        continue;
      }
      if (!tok_is_punc(&p, ';') && !tok_is_punc(&p, '}')) {
        if (p.tok.kind == TOK_STR && (!esm || p.erased_any_stmt)) return NULL;
        if (has_pending_export) { p.has_runtime_mod = true; has_pending_export = false; }
        p.has_runtime_stmt = true;
      }
    }

normal_tok:
    if (p.tok.kw != KW_NONE) {
      if (p.tok.kw == KW_NEW) {
        fs_mark_t m = save_mark(&p);
        if (!next_tok(&p)) return NULL;
        if (tok_is_kw(&p, KW_IMPORT)) return NULL;
        restore_mark(&p, m);
      } else if (!p.tok.had_nl && (p.tok.kw == KW_AS || p.tok.kw == KW_SATISFIES) &&
                 !prev_can_precede_arrow && prev_kind != TOK_EOF) {
        const bool is_as = (p.tok.kw == KW_AS);
        const uint32_t as_start = p.tok.start;
        if (!next_tok(&p)) return NULL;
        if (is_as && tok_is_kw(&p, KW_CONST)) {
          if (!next_tok(&p)) return NULL;
        } else if (!parse_type(&p, 0)) {
          return NULL;
        }
        if (tok_is_punc(&p, '=') || p.tok.kind == TOK_OP2 ||
            tok_is_punc(&p, '(') || tok_is_punc(&p, '[') || tok_is_punc(&p, '.') ||
            p.tok.kind == TOK_TPL_FULL || p.tok.kind == TOK_TPL_HEAD) return NULL;
        blank_span(&p, as_start, p.prev_end, false);
        stmt_start = false;
        continue;
      } else if (p.tok.kw == KW_CLASS) {
        if (!parse_class_header(&p) || p.depth >= 64) return NULL;
        scope_kind[p.depth++] = SCOPE_CLASS;
        prev_kind = TOK_PUNC;
        prev_ch = '{';
        prev_can_precede_arrow = true;
        if (!next_tok(&p)) return NULL;
        stmt_start = true;
        continue;
      } else if (p.tok.kw == KW_FUNCTION) {
        if (!next_tok(&p)) return NULL;
        if (tok_is_punc(&p, '*') && !next_tok(&p)) return NULL;
        if (p.tok.kind == TOK_ID && !next_tok(&p)) return NULL;
        if (tok_is_punc(&p, '<')) {
          const uint32_t tp_start = p.tok.start;
          if (!parse_type_params(&p, 0)) return NULL;
          blank_span(&p, tp_start, p.prev_end, false);
        }
        if (!tok_is_punc(&p, '(') || !parse_runtime_params(&p, false)) return NULL;
        if (tok_is_punc(&p, ':')) {
          const uint32_t rt_start = p.tok.start;
          if (!next_tok(&p) || !parse_return_type(&p, 0)) return NULL;
          blank_span(&p, rt_start, p.prev_end, false);
        }
        if (!tok_is_punc(&p, '{') || p.depth >= 64) return NULL;
        scope_kind[p.depth++] = SCOPE_BLOCK;
        if (!next_tok(&p)) return NULL;
        stmt_start = true;
        prev_kind = TOK_PUNC;
        prev_ch = '{';
        continue;
      }
    }

    /* Postfix non-null assertion `x!` */
    if (tok_is_punc(&p, '!') && !p.tok.had_nl &&
        (prev_kind == TOK_ID || prev_kind == TOK_NUM || prev_kind == TOK_STR ||
         prev_kind == TOK_TPL_FULL || (prev_kind == TOK_PUNC && (prev_ch == ')' || prev_ch == ']')))) {
      const uint32_t bang_start = p.tok.start, bang_end = p.tok.end;
      if (!next_tok(&p)) return NULL;
      if (tok_is_punc(&p, '=')) return NULL;
      blank_span(&p, bang_start, bang_end, false);
      stmt_start = false;
      continue;
    }

    /* `<` in expression position: generic arrow `<T>(...) =>` OR generic call `f<T>(...)` */
    if (tok_is_punc(&p, '<')) {
      if (prev_can_precede_arrow) {
        /* Try generic arrow `<T>(...) [: R] =>` (declines `<T>expr` angle-bracket assertions!) */
        fs_mark_t m = save_mark(&p);
        if (parse_type_params(&p, 0) && tok_is_punc(&p, '(')) {
          const uint32_t tp_end = p.prev_end;
          uint32_t d = 1;
          bool ok = true;
          if (!next_tok(&p)) return NULL;
          while (d > 0 && p.tok.kind != TOK_EOF) {
            if (tok_is_punc(&p, '(')) d++;
            else if (tok_is_punc(&p, ')')) d--;
            else if (d == 1 && tok_is_punc(&p, ';')) { ok = false; break; }
            if (d > 0 && !next_tok(&p)) return NULL;
          }
          if (ok && d == 0 && next_tok(&p)) {
            bool is_arrow = (p.tok.kind == TOK_ARROW);
            if (!is_arrow && tok_is_punc(&p, ':')) {
              if (next_tok(&p) && parse_type(&p, 0) && p.tok.kind == TOK_ARROW) is_arrow = true;
            }
            if (is_arrow) {
              restore_mark(&p, m);
              const uint32_t tp_start = p.tok.start;
              if (!parse_type_params(&p, 0)) return NULL;
              blank_span(&p, tp_start, tp_end, false);
              /* Now at `(` with prev_can_precede_arrow == true -> fall through to `(` arrow handler! */
              goto check_arrow_paren;
            }
          }
        }
        restore_mark(&p, m);
        return NULL;
      }
      if (prev_kind == TOK_ID || (prev_kind == TOK_PUNC && (prev_ch == ')' || prev_ch == ']'))) {
        fs_mark_t m = save_mark(&p);
        if (parse_type_args(&p, 0) &&
            (tok_is_punc(&p, '(') || p.tok.kind == TOK_TPL_FULL || p.tok.kind == TOK_TPL_HEAD)) {
          /* Decline multiline `f<T>\n(1)` or comma-ambiguous `f(a < b, c > (d))` to Pulse */
          if (p.tok.had_nl) return NULL;
          if (paren_depth == 0 || !memchr(source + m.tok.start, ',', p.prev_end - m.tok.start)) {
            blank_span(&p, m.tok.start, p.prev_end, false);
            continue;
          }
          return NULL;
        }
        restore_mark(&p, m);
      }
    }

check_arrow_paren:
    /* Typed arrow function `(...): Type =>` or `(a: T) =>` */
    if (tok_is_punc(&p, '(') && prev_can_precede_arrow) {
      fs_mark_t m = save_mark(&p);
      uint32_t d = 1;
      uint32_t lookahead_steps = 0;
      bool has_ts_param = false;
      bool plausible_params = true;
      bool in_default = false;
      if (!next_tok(&p)) return NULL;
      if (!tok_is_punc(&p, ')') && p.tok.kind != TOK_ID && p.tok.kind != TOK_DOTDOTDOT &&
          !tok_is_punc(&p, '{') && !tok_is_punc(&p, '[')) {
        plausible_params = false;
      }
      while (plausible_params && d > 0 && p.tok.kind != TOK_EOF) {
        if (++lookahead_steps > 128 || d > 8) { plausible_params = false; break; }
        if (tok_is_punc(&p, '(')) d++;
        else if (tok_is_punc(&p, ')')) d--;
        else if (d == 1) {
          if (tok_is_punc(&p, ';')) { plausible_params = false; break; }
          if (tok_is_punc(&p, ',')) { in_default = false; }
          else if (tok_is_punc(&p, '=')) { in_default = true; }
          else if (!in_default && (tok_is_punc(&p, ':') || tok_is_punc(&p, '?'))) { has_ts_param = true; }
          else if (!in_default && !has_ts_param &&
                   (p.tok.kind == TOK_OP2 || tok_is_punc(&p, '+') || tok_is_punc(&p, '-') ||
                    tok_is_punc(&p, '*') || tok_is_punc(&p, '/') || tok_is_punc(&p, '<') ||
                    tok_is_punc(&p, '>') || tok_is_punc(&p, '&') || tok_is_punc(&p, '|'))) {
            /* Binary expression like `(a + b)` is not an arrow parameter list */
            plausible_params = false;
            break;
          }
        }
        if (d > 0 && !next_tok(&p)) return NULL;
      }
      if (plausible_params && d == 0 && next_tok(&p)) {
        if (p.tok.kind == TOK_ARROW && has_ts_param) {
          restore_mark(&p, m);
          if (!parse_runtime_params(&p, false)) return NULL;
          if (p.tok.kind != TOK_ARROW) return NULL;
          prev_kind = TOK_ARROW;
          prev_ch = '=';
          prev_can_precede_arrow = true;
          if (!next_tok(&p)) return NULL;
          stmt_start = false;
          continue;
        }
        if (tok_is_punc(&p, ':')) {
          fs_mark_t m2 = save_mark(&p);
          if (next_tok(&p) && parse_return_type(&p, 0) && p.tok.kind == TOK_ARROW) {
            restore_mark(&p, m);
            if (!parse_runtime_params(&p, false)) return NULL;
            if (!tok_is_punc(&p, ':')) return NULL;
            const uint32_t rt_start = p.tok.start;
            if (!next_tok(&p) || !parse_return_type(&p, 0)) return NULL;
            if (memchr(source + rt_start, '\n', p.prev_end - rt_start) ||
                memchr(source + rt_start, '\r', p.prev_end - rt_start)) return NULL;
            blank_span(&p, rt_start, p.prev_end, false);
            if (p.tok.kind != TOK_ARROW) return NULL;
            prev_kind = TOK_ARROW;
            prev_ch = '=';
            prev_can_precede_arrow = true;
            if (!next_tok(&p)) return NULL;
            stmt_start = false;
            continue;
          }
          restore_mark(&p, m2);
        }
      }
      restore_mark(&p, m);
    }

    /* Track delimiters & statement boundaries */
    if (p.tok.kind == TOK_PUNC) {
      switch (p.tok.ch) {
        case '{':
          if (p.depth >= 64) return NULL;
          scope_kind[p.depth++] = SCOPE_BLOCK;
          stmt_start = true;
          break;
        case '}':
          if (p.depth == 0) return NULL;
          p.depth--;
          stmt_start = (paren_depth == 0 && bracket_depth == 0 && ternary_depth == 0);
          break;
        case '(':
          if (paren_depth < 64) {
            paren_stmt_hdr[paren_depth] = (prev_kw == KW_IF || prev_kw == KW_WHILE ||
                                           prev_kw == KW_FOR || prev_kw == KW_WITH) ? 1 : 0;
          }
          paren_depth++;
          stmt_start = false;
          break;
        case ')':
          if (paren_depth == 0) return NULL;
          paren_depth--;
          if (paren_depth < 64 && paren_stmt_hdr[paren_depth]) {
            /* After `if (...)` / `while (...)` / `for (...)` / `with (...)`, `/` begins a regex literal */
            p.allow_regex = true;
            stmt_start = (paren_depth == 0 && bracket_depth == 0 && ternary_depth == 0);
          } else {
            stmt_start = false;
          }
          break;
        case '[': bracket_depth++; stmt_start = false; break;
        case ']': if (bracket_depth == 0) return NULL; bracket_depth--; stmt_start = false; break;
        case '?': ternary_depth++; stmt_start = false; break;
        case ':': if (ternary_depth > 0) ternary_depth--; stmt_start = false; break;
        case ';': stmt_start = (paren_depth == 0 && bracket_depth == 0 && ternary_depth == 0); break;
        default: stmt_start = false; break;
      }
    } else {
      stmt_start = false;
    }

    prev_kind = p.tok.kind;
    prev_ch = p.tok.ch;
    prev_kw = p.tok.kw;
    prev_can_precede_arrow = p.allow_regex || p.tok.kw == KW_ASYNC;
    if (!next_tok(&p)) return NULL;

    /* ASI newline at statement level can start a new statement (or next class member) */
    if (!stmt_start && p.tok.had_nl && paren_depth == 0 && bracket_depth == 0 && ternary_depth == 0 &&
        (prev_kind == TOK_ID || prev_kind == TOK_NUM || prev_kind == TOK_STR || prev_kind == TOK_TPL_FULL ||
         prev_kind == TOK_REGEX || (prev_kind == TOK_PUNC && (prev_ch == ')' || prev_ch == ']' || prev_ch == '}')))) {
      if (p.depth > 0 && p.depth <= 64 && scope_kind[p.depth - 1] == SCOPE_CLASS) {
        stmt_start = true;
      } else if (kw_asi_stmt_start[p.tok.kw]) {
        stmt_start = true;
      }
    }
next_iter:;
  }

  if (p.depth != 0 || paren_depth != 0 || bracket_depth != 0 || p.tpl_depth != 0 || has_pending_export) return NULL;
  if (!esm && !p.has_runtime_mod) return NULL;
  if (!p.has_runtime_stmt) {
    /* Type-only `.mts` module: emit `export {};\n` directly when comment-free;
     * otherwise decline so type_only_module compacts trivia and emits an empty source map. */
    if (!esm || !p.erased_any_stmt) return NULL;
    if (memchr(source, '/', size)) return NULL;
    static const char marker[] = "export {};\n";
    memcpy(p.out, marker, sizeof(marker) - 1);
    *out_len = sizeof(marker) - 1;
    *edited = true;
    return p.out;
  }

  size_t len = size;
  if (esm && !p.has_runtime_mod) {
    if (!p.erased_any_stmt) return NULL;
    static const char marker[] = "\nexport {};\n";
    ensure_out(&p);
    memcpy(p.out + len, marker, sizeof(marker) - 1);
    len += sizeof(marker) - 1;
  }

  *out_len = len;
  *edited = p.edited;
  return p.edited ? p.out : (char *)source;
}
