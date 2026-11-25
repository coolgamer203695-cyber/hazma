/* HAZMA native runtime.
 *
 * Generated into every natively compiled HAZMA program ahead of the compiled
 * code. It provides:
 *   - HzValue: a tagged value (number, text, true/false, structure, list)
 *   - dynamic lists and structure instances
 *   - printing, equality, arithmetic and runtime diagnostics
 *   - the named-repeat machine: pause / resume / restart
 *
 * Windows fibers preserve the whole C stack, which is what makes HAZMA's
 * repeat.break / repeat.continue semantics work natively: a paused repeat
 * keeps its activation alive, including nested loops and function calls.
 *
 * Memory is intentionally not reclaimed yet. Programs that create values in a
 * loop grow the heap; this is documented as a native-backend limitation.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <math.h>
#include <time.h>
#include <setjmp.h>
#include <errno.h>
#include <sys/stat.h>

#ifdef _WIN32
#include <windows.h>
#include <direct.h>
#include <io.h>
#else
#include <dirent.h>
#include <unistd.h>
#endif

#define HZ_NONE   0
#define HZ_NUM    1
#define HZ_STR    2
#define HZ_BOOL   3
#define HZ_STRUCT 4
#define HZ_LIST   5

typedef struct HzValue HzValue;
typedef struct HzList HzList;
typedef struct HzStruct HzStruct;
typedef struct HzStructDef HzStructDef;

struct HzList {
  int len;
  int cap;
  HzValue *items;
};

struct HzStructDef {
  const char *name;
  int count;
  const char *const *names;
  const unsigned char *consts;
};

struct HzStruct {
  const HzStructDef *def;
  HzValue *props;
};

struct HzValue {
  int kind;
  union {
    double num;
    const char *str;
    int boolean;
    HzStruct *st;
    HzList *list;
  } as;
};

/* ------------------------------------------------------- error handler stack */
/*
 * `check.error` compiles to setjmp here. A runtime error longjmps to the
 * innermost handler on the current fiber instead of exiting. With no handler
 * the diagnostic is printed and the program exits, as before.
 */
typedef struct HzErrHandler {
  jmp_buf env;
  struct HzErrHandler *prev;
} HzErrHandler;

static HzErrHandler *hz_err_top = NULL;

/* ------------------------------------------------------------------ memory */

static void *hz_alloc(size_t n) {
  void *p = calloc(1, n ? n : 1);
  if (!p) {
    fprintf(stderr, "runtime error[H5000]: out of memory\n");
    exit(1);
  }
  return p;
}

static void hz_rt_error(const char *code, const char *file, int line,
                        const char *fmt, ...) {
  va_list ap;
  fflush(stdout);
  if (hz_err_top != NULL) {
    /* A check.error block is watching: unwind to it without printing. */
    longjmp(hz_err_top->env, 1);
  }
  fprintf(stderr, "runtime error[%s]: ", code);
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fprintf(stderr, "\n  --> %s:%d\n", file, line);
  fflush(stderr);
  exit(1);
}

/* -------------------------------------------------------------- constructors */

static HzValue hz_none(void) {
  HzValue v;
  v.kind = HZ_NONE;
  v.as.num = 0;
  return v;
}

static HzValue hz_num(double n) {
  HzValue v;
  v.kind = HZ_NUM;
  v.as.num = n;
  return v;
}

static HzValue hz_bool(int b) {
  HzValue v;
  v.kind = HZ_BOOL;
  v.as.boolean = b ? 1 : 0;
  return v;
}

static HzValue hz_str(const char *s) {
  HzValue v;
  v.kind = HZ_STR;
  v.as.str = s ? s : "";
  return v;
}

/* --------------------------------------------------------------- formatting */

typedef struct {
  char *data;
  int len;
  int cap;
} HzBuf;

static void hz_buf_init(HzBuf *b) {
  b->cap = 64;
  b->len = 0;
  b->data = (char *)hz_alloc((size_t)b->cap);
  b->data[0] = '\0';
}

static void hz_buf_reserve(HzBuf *b, int extra) {
  int need = b->len + extra + 1;
  if (need <= b->cap) return;
  while (b->cap < need) b->cap *= 2;
  {
    char *p = (char *)realloc(b->data, (size_t)b->cap);
    if (!p) {
      fprintf(stderr, "runtime error[H5000]: out of memory\n");
      exit(1);
    }
    b->data = p;
  }
}

static void hz_buf_puts(HzBuf *b, const char *s) {
  int n = (int)strlen(s);
  hz_buf_reserve(b, n);
  memcpy(b->data + b->len, s, (size_t)n + 1);
  b->len += n;
}

static void hz_buf_putc(HzBuf *b, char c) {
  hz_buf_reserve(b, 1);
  b->data[b->len++] = c;
  b->data[b->len] = '\0';
}

/* Shortest decimal that round-trips, like JavaScript's Number#toString for
 * the values HAZMA can produce. */
static void hz_fmt_num(HzBuf *b, double n) {
  char tmp[64];
  int prec;
  if (n == 0) {
    hz_buf_puts(b, "0");
    return;
  }
  if (n == floor(n) && fabs(n) < 1e21) {
    snprintf(tmp, sizeof tmp, "%.0f", n);
    hz_buf_puts(b, tmp);
    return;
  }
  for (prec = 15; prec <= 17; prec++) {
    snprintf(tmp, sizeof tmp, "%.*g", prec, n);
    if (strtod(tmp, NULL) == n) break;
  }
  {
    /* JavaScript writes exponents without leading zeros: 1e-7, not 1e-07. */
    char *e = strchr(tmp, 'e');
    if (e) {
      char *digits = e + 1;
      char sign = '+';
      char out[64];
      int oi = 0;
      if (*digits == '+' || *digits == '-') sign = *digits++;
      while (*digits == '0' && digits[1] != '\0') digits++;
      while (tmp[oi] != 'e' && tmp[oi] != '\0' && oi < 60) {
        out[oi] = tmp[oi];
        oi++;
      }
      out[oi++] = 'e';
      out[oi++] = sign;
      while (*digits && oi < 62) out[oi++] = *digits++;
      out[oi] = '\0';
      hz_buf_puts(b, out);
      return;
    }
  }
  hz_buf_puts(b, tmp);
}

static void hz_fmt_value(HzBuf *b, HzValue v);

static void hz_fmt_struct(HzBuf *b, HzStruct *s) {
  int i;
  hz_buf_puts(b, s->def->name);
  hz_buf_puts(b, "{ ");
  for (i = 0; i < s->def->count; i++) {
    if (i > 0) hz_buf_puts(b, ", ");
    hz_buf_puts(b, s->def->names[i]);
    hz_buf_puts(b, ": ");
    hz_fmt_value(b, s->props[i]);
  }
  hz_buf_puts(b, " }");
}

static void hz_fmt_list(HzBuf *b, HzList *l) {
  int i;
  hz_buf_putc(b, '[');
  for (i = 0; i < l->len; i++) {
    if (i > 0) hz_buf_puts(b, ", ");
    hz_fmt_value(b, l->items[i]);
  }
  hz_buf_putc(b, ']');
}

static void hz_fmt_value(HzBuf *b, HzValue v) {
  switch (v.kind) {
    case HZ_NUM:
      hz_fmt_num(b, v.as.num);
      break;
    case HZ_STR:
      hz_buf_puts(b, v.as.str);
      break;
    case HZ_BOOL:
      hz_buf_puts(b, v.as.boolean ? "true" : "false");
      break;
    case HZ_STRUCT:
      hz_fmt_struct(b, v.as.st);
      break;
    case HZ_LIST:
      hz_fmt_list(b, v.as.list);
      break;
    default:
      hz_buf_puts(b, "nothing");
      break;
  }
}

static char *hz_to_string(HzValue v) {
  HzBuf b;
  hz_buf_init(&b);
  hz_fmt_value(&b, v);
  return b.data;
}

static void hz_print(HzValue v) {
  char *s = hz_to_string(v);
  fputs(s, stdout);
  fputc('\n', stdout);
  free(s);
}

/* "a number", "a string", ... used by runtime diagnostics. */
static char *hz_type_name(HzValue v) {
  HzBuf b;
  hz_buf_init(&b);
  switch (v.kind) {
    case HZ_NUM: hz_buf_puts(&b, "a number"); break;
    case HZ_STR: hz_buf_puts(&b, "a string"); break;
    case HZ_BOOL: hz_buf_puts(&b, "true or false"); break;
    case HZ_LIST: hz_buf_puts(&b, "a list"); break;
    case HZ_STRUCT:
      hz_buf_puts(&b, "a ");
      hz_buf_puts(&b, v.as.st->def->name);
      hz_buf_puts(&b, " instance");
      break;
    default: hz_buf_puts(&b, "nothing"); break;
  }
  return b.data;
}

/* ------------------------------------------------------------------ equality */

static int hz_same_type(HzValue a, HzValue b) {
  if (a.kind == HZ_NONE || b.kind == HZ_NONE) return 1;
  if (a.kind != b.kind) return 0;
  if (a.kind == HZ_STRUCT) return a.as.st->def == b.as.st->def;
  return 1;
}

static int hz_eq(HzValue a, HzValue b) {
  if (a.kind != b.kind) return 0;
  switch (a.kind) {
    case HZ_NUM:
      return a.as.num == b.as.num;
    case HZ_STR:
      return strcmp(a.as.str, b.as.str) == 0;
    case HZ_BOOL:
      return a.as.boolean == b.as.boolean;
    case HZ_STRUCT:
      return a.as.st == b.as.st;
    case HZ_LIST:
      return a.as.list == b.as.list;
    case HZ_NONE:
      return 1;
    default:
      return 0;
  }
}

/* ---------------------------------------------------------------- arithmetic */

static void hz_need_num(HzValue v, const char *op, const char *file, int line) {
  if (v.kind != HZ_NUM) {
    char *s = hz_type_name(v);
    hz_rt_error("H4029", file, line, "%s works with numbers, but this is %s", op, s);
  }
}

static HzValue hz_add(HzValue a, HzValue b, const char *file, int line) {
  if (a.kind == HZ_NUM && b.kind == HZ_NUM) return hz_num(a.as.num + b.as.num);
  if (a.kind == HZ_STR || b.kind == HZ_STR) {
    HzBuf out;
    hz_buf_init(&out);
    hz_fmt_value(&out, a);
    hz_fmt_value(&out, b);
    return hz_str(out.data);
  }
  {
    char *ta = hz_type_name(a);
    char *tb = hz_type_name(b);
    hz_rt_error("H4029", file, line,
                "+ works with numbers or text, but this is %s + %s", ta, tb);
  }
  return hz_none();
}

static HzValue hz_sub(HzValue a, HzValue b, const char *file, int line) {
  hz_need_num(a, "-", file, line);
  hz_need_num(b, "-", file, line);
  return hz_num(a.as.num - b.as.num);
}

static HzValue hz_mul(HzValue a, HzValue b, const char *file, int line) {
  hz_need_num(a, "*", file, line);
  hz_need_num(b, "*", file, line);
  return hz_num(a.as.num * b.as.num);
}

static HzValue hz_div(HzValue a, HzValue b, const char *file, int line) {
  hz_need_num(a, "/", file, line);
  hz_need_num(b, "/", file, line);
  if (b.as.num == 0) hz_rt_error("H4031", file, line, "division by zero");
  return hz_num(a.as.num / b.as.num);
}

static HzValue hz_neg(HzValue a, const char *file, int line) {
  hz_need_num(a, "a minus sign", file, line);
  return hz_num(-a.as.num);
}

static HzValue hz_round(HzValue a, const char *file, int line) {
  if (a.kind != HZ_NUM) {
    char *s = hz_type_name(a);
    hz_rt_error("H4027", file, line, "price.r rounds numbers, but this is %s", s);
  }
  return hz_num(floor(a.as.num + 0.5));
}

/* ------------------------------------------------------------------- math */

static double hz_math_num(HzValue v, const char *op, const char *file, int line) {
  if (v.kind != HZ_NUM) {
    char *s = hz_type_name(v);
    hz_rt_error("H4065", file, line, "%s works on numbers, but this is %s", op, s);
  }
  return v.as.num;
}

static HzValue hz_math_abs(HzValue a, const char *file, int line) {
  return hz_num(fabs(hz_math_num(a, ".abs", file, line)));
}

static HzValue hz_math_sqrt(HzValue a, const char *file, int line) {
  return hz_num(sqrt(hz_math_num(a, ".sqrt", file, line)));
}

static HzValue hz_math_floor(HzValue a, const char *file, int line) {
  return hz_num(floor(hz_math_num(a, ".floor", file, line)));
}

static HzValue hz_math_ceil(HzValue a, const char *file, int line) {
  return hz_num(ceil(hz_math_num(a, ".ceil", file, line)));
}

static HzValue hz_math_round(HzValue a, const char *file, int line) {
  return hz_num(floor(hz_math_num(a, ".round", file, line) + 0.5));
}

static HzValue hz_math_pow(HzValue a, HzValue b, const char *file, int line) {
  double base = hz_math_num(a, ".pow", file, line);
  double exp = hz_math_num(b, ".pow", file, line);
  return hz_num(pow(base, exp));
}

static HzValue hz_math_min(HzValue a, HzValue b, const char *file, int line) {
  double x = hz_math_num(a, "math.min", file, line);
  double y = hz_math_num(b, "math.min", file, line);
  return hz_num(x < y ? x : y);
}

static HzValue hz_math_max(HzValue a, HzValue b, const char *file, int line) {
  double x = hz_math_num(a, "math.max", file, line);
  double y = hz_math_num(b, "math.max", file, line);
  return hz_num(x > y ? x : y);
}

static HzValue hz_math_clamp(HzValue v, HzValue lo, HzValue hi, const char *file, int line) {
  double x = hz_math_num(v, "math.clamp", file, line);
  double l = hz_math_num(lo, "math.clamp", file, line);
  double h = hz_math_num(hi, "math.clamp", file, line);
  if (x < l) return hz_num(l);
  if (x > h) return hz_num(h);
  return hz_num(x);
}

static HzValue hz_math_sin(HzValue a, const char *file, int line) {
  return hz_num(sin(hz_math_num(a, "math.sin", file, line) * 3.14159265358979323846 / 180.0));
}

static HzValue hz_math_cos(HzValue a, const char *file, int line) {
  return hz_num(cos(hz_math_num(a, "math.cos", file, line) * 3.14159265358979323846 / 180.0));
}

static HzValue hz_math_tan(HzValue a, const char *file, int line) {
  return hz_num(tan(hz_math_num(a, "math.tan", file, line) * 3.14159265358979323846 / 180.0));
}

static HzValue hz_math_random(HzValue a, HzValue b, const char *file, int line) {
  double lo = hz_math_num(a, "math.random", file, line);
  double hi = hz_math_num(b, "math.random", file, line);
  if (lo > hi) {
    hz_rt_error("H4066", file, line,
      "math.random needs the first number to be no larger than the second, but got %g and %g", lo, hi);
  }
  long lo_i = (long)ceil(lo);
  long hi_i = (long)floor(hi);
  if (lo_i > hi_i) return hz_num((double)lo_i);
  static int seeded = 0;
  if (!seeded) {
    seeded = 1;
    srand((unsigned)time(NULL));
  }
  long span = hi_i - lo_i + 1;
  return hz_num((double)(lo_i + (long)(rand() % span)));
}

static int hz_truth(HzValue v, const char *what, const char *file, int line) {
  if (v.kind != HZ_BOOL) {
    char *s = hz_type_name(v);
    hz_rt_error("H4033", file, line, "%s must be true or false, but this is %s", what, s);
  }
  return v.as.boolean;
}

static HzValue hz_not(HzValue v, const char *file, int line) {
  if (v.kind != HZ_BOOL) {
    char *s = hz_type_name(v);
    hz_rt_error("H4033", file, line, "not works on true or false, but this is %s", s);
  }
  return hz_bool(!v.as.boolean);
}

static int hz_cmp(HzValue a, HzValue b, const char *op, const char *file, int line) {
  hz_need_num(a, op, file, line);
  hz_need_num(b, op, file, line);
  if (a.as.num < b.as.num) return -1;
  if (a.as.num > b.as.num) return 1;
  return 0;
}

/* ------------------------------------------------------------------- files */

static const char *hz_need_text(HzValue v, const char *op, const char *file, int line) {
  if (v.kind != HZ_STR) {
    char *s = hz_type_name(v);
    hz_rt_error("H6003", file, line, "%s needs a text path, but this is %s", op, s);
  }
  return v.as.str;
}

static int hz_path_exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0;
}

static int hz_path_is_file(const char *path) {
  struct stat st;
  if (stat(path, &st) != 0) return 0;
#ifdef _WIN32
  return (st.st_mode & _S_IFREG) != 0;
#else
  return S_ISREG(st.st_mode);
#endif
}

static int hz_path_is_dir(const char *path) {
  struct stat st;
  if (stat(path, &st) != 0) return 0;
#ifdef _WIN32
  return (st.st_mode & _S_IFDIR) != 0;
#else
  return S_ISDIR(st.st_mode);
#endif
}

/* Windows antivirus scanners briefly lock a file right after it is written.
 * Sharing violations surface as a plain failure, so retry for a few hundred
 * milliseconds before reporting an error. */
static void hz_sleep_ms(int ms) {
#ifdef _WIN32
  Sleep((DWORD)ms);
#else
  usleep((useconds_t)(ms * 1000));
#endif
}

static FILE *hz_fopen_retry(const char *path, const char *mode) {
  int attempt;
  for (attempt = 0; attempt < 8; attempt++) {
    FILE *f = fopen(path, mode);
    if (f) return f;
    if (attempt < 7) hz_sleep_ms(20);
  }
  return NULL;
}

static int hz_remove_retry(const char *path) {
  int attempt;
  for (attempt = 0; attempt < 8; attempt++) {
    if (remove(path) == 0) return 0;
    if (attempt < 7) hz_sleep_ms(20);
  }
  return -1;
}

static void hz_file_create(HzValue pathv, const char *file, int line) {
  const char *p = hz_need_text(pathv, "file.create", file, line);
  FILE *f;
  if (hz_path_exists(p)) {
    if (!hz_path_is_file(p)) {
      hz_rt_error("H6006", file, line, "\"%s\" is a folder, not a file", p);
    }
    return; /* creating an existing file does nothing */
  }
  errno = 0;
  f = hz_fopen_retry(p, "wb");
  if (!f) {
    if (errno == ENOENT) {
      hz_rt_error("H6002", file, line,
                  "cannot create \"%s\" because its parent folder does not exist", p);
    }
    hz_rt_error("H6004", file, line, "could not create \"%s\"", p);
  }
  fclose(f);
}

static void hz_file_write(HzValue pathv, HzValue textv, int append,
                          const char *file, int line) {
  const char *op = append ? "file.add" : "file.write";
  const char *p = hz_need_text(pathv, op, file, line);
  const char *text = hz_need_text(textv, op, file, line);
  FILE *f;
  if (!hz_path_exists(p)) {
    hz_rt_error("H6001", file, line, "%s cannot find \"%s\"", op, p);
  }
  if (!hz_path_is_file(p)) {
    hz_rt_error("H6006", file, line, "\"%s\" is a folder, not a file", p);
  }
  f = hz_fopen_retry(p, append ? "ab" : "wb");
  if (!f) hz_rt_error("H6004", file, line, "could not write \"%s\"", p);
  fwrite(text, 1, strlen(text), f);
  fclose(f);
}

static void hz_file_delete(HzValue pathv, const char *file, int line) {
  const char *p = hz_need_text(pathv, "file.delete", file, line);
  if (!hz_path_exists(p)) {
    hz_rt_error("H6001", file, line, "file.delete cannot find \"%s\"", p);
  }
  if (!hz_path_is_file(p)) {
    hz_rt_error("H6006", file, line, "\"%s\" is a folder, not a file", p);
  }
  if (hz_remove_retry(p) != 0) hz_rt_error("H6007", file, line, "could not delete \"%s\"", p);
}

static HzValue hz_file_read(HzValue pathv, const char *file, int line) {
  const char *p = hz_need_text(pathv, "file.read", file, line);
  FILE *f;
  long size;
  char *buf;
  size_t got;
  if (!hz_path_exists(p)) {
    hz_rt_error("H6001", file, line, "file.read cannot find \"%s\"", p);
  }
  if (!hz_path_is_file(p)) {
    hz_rt_error("H6006", file, line, "\"%s\" is a folder, not a file", p);
  }
  f = hz_fopen_retry(p, "rb");
  if (!f) hz_rt_error("H6008", file, line, "could not read \"%s\"", p);
  fseek(f, 0, SEEK_END);
  size = ftell(f);
  if (size < 0) {
    fclose(f);
    hz_rt_error("H6008", file, line, "could not read \"%s\"", p);
  }
  fseek(f, 0, SEEK_SET);
  buf = (char *)hz_alloc((size_t)size + 1);
  got = fread(buf, 1, (size_t)size, f);
  fclose(f);
  buf[got] = '\0';
  return hz_str(buf);
}

static HzValue hz_file_exists(HzValue pathv, const char *file, int line) {
  const char *p = hz_need_text(pathv, "file.exists", file, line);
  return hz_bool(hz_path_is_file(p));
}

static void hz_folder_create(HzValue pathv, const char *file, int line) {
  const char *p = hz_need_text(pathv, "folder.create", file, line);
  int rc;
  int attempt;
  if (hz_path_exists(p)) {
    if (!hz_path_is_dir(p)) {
      hz_rt_error("H6006", file, line, "\"%s\" is a file, not a folder", p);
    }
    return;
  }
  errno = 0;
  for (rc = -1, attempt = 0; rc != 0 && attempt < 8; attempt++) {
    if (attempt > 0) hz_sleep_ms(20);
#ifdef _WIN32
    rc = _mkdir(p);
#else
    rc = mkdir(p, 0777);
#endif
  }
  if (rc != 0) {
    if (errno == ENOENT) {
      hz_rt_error("H6002", file, line,
                  "cannot create \"%s\" because its parent folder does not exist", p);
    }
    hz_rt_error("H6004", file, line, "could not create the folder \"%s\"", p);
  }
}

#ifdef _WIN32
static int hz_delete_file_retry(const char *path) {
  int attempt;
  for (attempt = 0; attempt < 8; attempt++) {
    if (DeleteFileA(path)) return 0;
    if (attempt < 7) hz_sleep_ms(20);
  }
  return -1;
}

static int hz_remove_dir_retry(const char *path) {
  int attempt;
  for (attempt = 0; attempt < 8; attempt++) {
    if (RemoveDirectoryA(path)) return 0;
    if (attempt < 7) hz_sleep_ms(20);
  }
  return -1;
}

static void hz_delete_tree(const char *path, const char *file, int line) {
  char pattern[MAX_PATH];
  WIN32_FIND_DATAA data;
  HANDLE h;
  snprintf(pattern, sizeof(pattern), "%s\\*", path);
  h = FindFirstFileA(pattern, &data);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      char child[MAX_PATH];
      if (strcmp(data.cFileName, ".") == 0 || strcmp(data.cFileName, "..") == 0) continue;
      snprintf(child, sizeof(child), "%s\\%s", path, data.cFileName);
      if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
        hz_delete_tree(child, file, line);
      } else if (hz_delete_file_retry(child) != 0) {
        hz_rt_error("H6005", file, line, "could not delete \"%s\"", child);
      }
    } while (FindNextFileA(h, &data));
    FindClose(h);
  }
  if (hz_remove_dir_retry(path) != 0) {
    hz_rt_error("H6005", file, line, "could not delete the folder \"%s\"", path);
  }
}
#else
static void hz_delete_tree(const char *path, const char *file, int line) {
  DIR *d = opendir(path);
  if (d) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      char child[4096];
      struct stat st;
      if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
      snprintf(child, sizeof(child), "%s/%s", path, e->d_name);
      if (stat(child, &st) == 0 && S_ISDIR(st.st_mode)) {
        hz_delete_tree(child, file, line);
      } else if (hz_remove_retry(child) != 0) {
        hz_rt_error("H6005", file, line, "could not delete \"%s\"", child);
      }
    }
    closedir(d);
  }
  if (rmdir(path) != 0) {
    hz_rt_error("H6005", file, line, "could not delete the folder \"%s\"", path);
  }
}
#endif

static void hz_folder_delete(HzValue pathv, const char *file, int line) {
  const char *p = hz_need_text(pathv, "folder.delete", file, line);
  if (!hz_path_exists(p)) {
    hz_rt_error("H6001", file, line, "folder.delete cannot find \"%s\"", p);
  }
  if (!hz_path_is_dir(p)) {
    hz_rt_error("H6006", file, line, "\"%s\" is a file, not a folder", p);
  }
  hz_delete_tree(p, file, line);
}

/* ------------------------------------------------------------------- lists */

static HzValue hz_list_value(HzList *l) {
  HzValue v;
  v.kind = HZ_LIST;
  v.as.list = l;
  return v;
}

static HzList *hz_list_new(void) {
  HzList *l = (HzList *)hz_alloc(sizeof(HzList));
  l->len = 0;
  l->cap = 4;
  l->items = (HzValue *)hz_alloc(sizeof(HzValue) * (size_t)l->cap);
  return l;
}

static void hz_list_push(HzList *l, HzValue v) {
  if (l->len >= l->cap) {
    int cap = l->cap * 2;
    HzValue *items = (HzValue *)realloc(l->items, sizeof(HzValue) * (size_t)cap);
    if (!items) {
      fprintf(stderr, "runtime error[H5000]: out of memory\n");
      exit(1);
    }
    l->items = items;
    l->cap = cap;
  }
  l->items[l->len++] = v;
}

static HzValue hz_list_lit(int n, ...) {
  HzList *l = hz_list_new();
  va_list ap;
  int i;
  va_start(ap, n);
  for (i = 0; i < n; i++) hz_list_push(l, va_arg(ap, HzValue));
  va_end(ap);
  return hz_list_value(l);
}

static HzList *hz_need_list_expr(HzValue v, const char *op,
                                 const char *file, int line) {
  if (v.kind != HZ_LIST) {
    char *s = hz_type_name(v);
    hz_rt_error("H4064", file, line, "%s needs a list, but this is %s", op, s);
  }
  return v.as.list;
}

/* A list statement target that is not a list. Mirrors hz_need_list_expr
 * with a target name for clearer diagnostics. */
static HzList *hz_list_assert(HzValue v, const char *op, const char *target,
                              const char *file, int line) {
  if (v.kind != HZ_LIST) {
    char *s = hz_type_name(v);
    hz_rt_error("H4064", file, line, "%s needs a list, but \"%s\" is %s",
                op, target, s);
  }
  return v.as.list;
}

/* Returned for unknown variables: dereferencing it produces an H4001-style
 * failure in hz_set_var before anything is written. */
static HzValue *hz_missing_slot(const char *name, const char *file, int line) {
  (void)name;
  hz_rt_error("H4001", file, line, "unknown variable \"%s\"", name);
  return 0;
}

/* A list statement (l.add / l.remove / l.change) target is not a list. */
static HzList *hz_need_list_target(HzValue v, const char *op, const char *target,
                                   const char *file, int line) {
  if (v.kind != HZ_LIST) {
    char *s = hz_type_name(v);
    hz_rt_error("H4064", file, line, "%s needs a list, but \"%s\" is %s",
                op, target, s);
  }
  return v.as.list;
}

static int hz_index_of(HzValue idx, int len, const char *file, int line) {
  if (idx.kind != HZ_NUM || idx.as.num != floor(idx.as.num) || idx.as.num < 1) {
    char *s = hz_to_string(idx);
    hz_rt_error("H4061", file, line,
                "list indexes are whole numbers starting at 1, but the index is %s", s);
  }
  if (idx.as.num > (double)len) {
    hz_rt_error("H4062", file, line,
                "index %d is out of range - the list has %d element%s",
                (int)idx.as.num, len, len == 1 ? "" : "s");
  }
  return (int)idx.as.num - 1;
}

static HzValue hz_index(HzValue list, HzValue idx, const char *file, int line) {
  HzList *l;
  if (list.kind != HZ_LIST) {
    char *s = hz_type_name(list);
    hz_rt_error("H4060", file, line,
                "%s cannot be indexed - only lists are indexed, like weapons[1]", s);
  }
  l = list.as.list;
  return l->items[hz_index_of(idx, l->len, file, line)];
}

static HzValue hz_list_count(HzValue list, const char *file, int line) {
  return hz_num((double)hz_need_list_expr(list, "l.count", file, line)->len);
}

static HzValue hz_list_find(HzValue list, HzValue value, const char *file, int line) {
  HzList *l = hz_need_list_expr(list, "l.find", file, line);
  int i;
  for (i = 0; i < l->len; i++) {
    if (hz_eq(l->items[i], value)) return hz_bool(1);
  }
  return hz_bool(0);
}

static HzValue hz_list_find_index(HzValue list, HzValue value,
                                  const char *file, int line) {
  HzList *l = hz_need_list_expr(list, "l.find.index", file, line);
  int i;
  for (i = 0; i < l->len; i++) {
    if (hz_eq(l->items[i], value)) return hz_num((double)(i + 1));
  }
  return hz_num(0);
}

static void hz_list_add(HzValue list, HzValue value, const char *target,
                        const char *file, int line) {
  hz_list_push(hz_need_list_target(list, "l.add", target, file, line), value);
}

static void hz_list_remove(HzValue list, HzValue value, const char *target,
                           const char *file, int line) {
  HzList *l = hz_need_list_target(list, "l.remove", target, file, line);
  int i;
  for (i = 0; i < l->len; i++) {
    if (hz_eq(l->items[i], value)) {
      int j;
      for (j = i; j + 1 < l->len; j++) l->items[j] = l->items[j + 1];
      l->len--;
      return;
    }
  }
  {
    char *s = hz_to_string(value);
    hz_rt_error("H4063", file, line,
                "%s is not in \"%s\", so it cannot be removed", s, target);
  }
}

static int hz_list_index_checked(HzValue list, HzValue idx, const char *target,
                                 const char *file, int line) {
  HzList *l = hz_need_list_target(list, "l.change", target, file, line);
  return hz_index_of(idx, l->len, file, line);
}

static void hz_list_set_at(HzValue list, int at, HzValue value) {
  list.as.list->items[at] = value;
}

/* ------------------------------------------------------------------ structs */

static HzValue hz_struct_value(HzStruct *s) {
  HzValue v;
  v.kind = HZ_STRUCT;
  v.as.st = s;
  return v;
}

static HzValue hz_struct_make(const HzStructDef *def) {
  HzStruct *s = (HzStruct *)hz_alloc(sizeof(HzStruct));
  int i;
  s->def = def;
  s->props = (HzValue *)hz_alloc(sizeof(HzValue) * (size_t)def->count);
  for (i = 0; i < def->count; i++) s->props[i] = hz_none();
  return hz_struct_value(s);
}

static HzValue hz_struct_put(HzValue s, int index, HzValue v) {
  if (s.kind != HZ_STRUCT) return v;
  s.as.st->props[index] = v;
  return s;
}

static int hz_struct_find(HzValue s, const char *prop, const char *prefix,
                          const char *file, int line) {
  int i;
  if (s.kind != HZ_STRUCT) {
    char *t = hz_type_name(s);
    hz_rt_error("H4009", file, line, "\"%s\" is %s and has no properties", prefix, t);
  }
  for (i = 0; i < s.as.st->def->count; i++) {
    if (strcmp(s.as.st->def->names[i], prop) == 0) return i;
  }
  hz_rt_error("H4013", file, line, "the structure \"%s\" has no property \"%s\"",
              s.as.st->def->name, prop);
  return 0;
}

static HzValue hz_prop_get(HzValue s, const char *prop, const char *prefix,
                           const char *file, int line) {
  int at = hz_struct_find(s, prop, prefix, file, line);
  return s.as.st->props[at];
}

static HzValue *hz_prop_slot(HzValue s, const char *prop, const char *prefix,
                             int check_const, const char *file, int line) {
  int at = hz_struct_find(s, prop, prefix, file, line);
  if (check_const && s.as.st->def->consts && s.as.st->def->consts[at]) {
    hz_rt_error("H4011", file, line,
                "\"%s\" is a const property and can never be changed", prop);
  }
  return &s.as.st->props[at];
}

/* change : a.b { ... } requires the target itself to be an instance. */
static HzValue hz_as_struct(HzValue v, const char *target,
                            const char *file, int line) {
  if (v.kind != HZ_STRUCT) {
    char *t = hz_type_name(v);
    hz_rt_error("H4014", file, line,
                "change : %s { ... } needs a structure instance, but it is %s",
                target, t);
  }
  return v;
}

/* -------------------------------------------------------------------- copy */

static HzValue hz_copy(HzValue v) {
  if (v.kind == HZ_STRUCT) {
    HzStruct *src = v.as.st;
    HzStruct *dst = (HzStruct *)hz_alloc(sizeof(HzStruct));
    int i;
    dst->def = src->def;
    dst->props = (HzValue *)hz_alloc(sizeof(HzValue) * (size_t)src->def->count);
    for (i = 0; i < src->def->count; i++) dst->props[i] = hz_copy(src->props[i]);
    return hz_struct_value(dst);
  }
  if (v.kind == HZ_LIST) {
    HzList *src = v.as.list;
    HzList *dst = hz_list_new();
    int i;
    for (i = 0; i < src->len; i++) hz_list_push(dst, hz_copy(src->items[i]));
    return hz_list_value(dst);
  }
  return v;
}

/* ------------------------------------------------------------ variable writes */

static void hz_set_var(HzValue *slot, HzValue v, const char *name, int is_is_name,
                       const char *file, int line, int retype) {
  if (is_is_name) {
    if (v.kind != HZ_BOOL) {
      char *s = hz_to_string(v);
      hz_rt_error("H4010", file, line,
                  "\"%s\" starts with is. so it holds true or false, but %s was saved",
                  name, s);
    }
  } else if (v.kind == HZ_BOOL) {
    char *s = hz_to_string(v);
    hz_rt_error("H4010", file, line,
                "booleans use the is. naming - save : is.%s = %s", name, s);
  }
  if (slot->kind != HZ_NONE && !retype && !hz_same_type(*slot, v)) {
    char *a = hz_type_name(*slot);
    char *b = hz_type_name(v);
    hz_rt_error("H4002", file, line,
                "\"%s\" holds %s and cannot be changed to %s", name, a, b);
  }
  *slot = v;
}

static void hz_check_param(HzValue v, const char *name,
                           const char *file, int line) {
  if (v.kind != HZ_BOOL) {
    char *s = hz_to_string(v);
    hz_rt_error("H4010", file, line, "%s holds true or false, but %s was passed",
                name, s);
  }
}

/* ---------------------------------------------------------- named repeats */

#define HZ_LOOP_FRESH    0
#define HZ_LOOP_RUNNING  1
#define HZ_LOOP_PAUSED   2
#define HZ_LOOP_FROZEN   3
#define HZ_LOOP_FINISHED 4

typedef struct HzLoop HzLoop;
typedef void (*HzBody)(HzLoop *loop, void *ctx);

struct HzLoop {
  int state;
  int uses_fiber;
  const char *name;
  void *fiber;
  void *started_from;
  void *paused_fiber;
  HzLoop *paused_loop;
  HzLoop *parent;
  HzLoop *frozen_by;
  HzBody body;
  void *ctx;
  HzErrHandler *err_top;
};

typedef struct HzThread {
  void *fiber;
  HzLoop *loop;
} HzThread;

static HzThread hz_thread;
static int hz_rt_ready = 0;

static void hz_rt_init(void) {
#ifdef _WIN32
  hz_thread.fiber = ConvertThreadToFiber(NULL);
  if (!hz_thread.fiber) hz_thread.fiber = GetCurrentFiber();
#endif
  hz_thread.loop = NULL;
  hz_rt_ready = 1;
}

static void hz_switch_to(void *fiber) {
#ifdef _WIN32
  SwitchToFiber(fiber);
#else
  (void)fiber;
  fprintf(stderr, "runtime error[H5000]: native repeats need Windows fibers\n");
  exit(1);
#endif
}

static void hz_loop_finish(HzLoop *loop) {
  HzLoop *target_loop;
  void *target;
  loop->state = HZ_LOOP_FINISHED;
  target_loop = loop->parent;
  target = loop->started_from;
  hz_thread.loop = target_loop;
  hz_thread.fiber = target;
  hz_switch_to(target);
}

#ifdef _WIN32
static void CALLBACK hz_fiber_entry(void *param) {
  HzLoop *loop = (HzLoop *)param;
  hz_thread.fiber = GetCurrentFiber();
  hz_thread.loop = loop;
  hz_err_top = NULL; /* error handlers belong to the fiber's own C stack */
  loop->body(loop, loop->ctx);
  if (loop->state != HZ_LOOP_FINISHED) hz_loop_finish(loop);
}
#endif

static void hz_loop_start(HzLoop *loop, HzBody body, void *ctx, int use_fiber,
                          const char *name, const char *file, int line) {
  HzLoop *caller_loop = hz_thread.loop;
  void *caller_fiber = hz_thread.fiber;
  HzErrHandler *caller_err = hz_err_top;

  loop->name = name;
  loop->state = HZ_LOOP_RUNNING;
  loop->uses_fiber = use_fiber;
  loop->started_from = caller_fiber;
  loop->parent = caller_loop;
  loop->frozen_by = NULL;
  loop->paused_fiber = NULL;
  loop->paused_loop = NULL;
  loop->body = body;
  loop->ctx = ctx;
  loop->err_top = NULL;

  hz_thread.loop = loop;

  if (use_fiber) {
#ifdef _WIN32
    if (loop->fiber == NULL) loop->fiber = CreateFiber(0, hz_fiber_entry, loop);
    if (!loop->fiber) {
      hz_rt_error("H5000", file, line, "could not create a fiber for repeat \"%s\"", name);
    }
    hz_err_top = NULL;
    hz_thread.fiber = loop->fiber;
    hz_switch_to(loop->fiber);
    hz_err_top = caller_err;
#else
    hz_rt_error("H5000", file, line,
                "named repeats need Windows fibers on this target");
#endif
  } else {
    body(loop, ctx);
    if (loop->state == HZ_LOOP_RUNNING) loop->state = HZ_LOOP_FINISHED;
  }

  hz_thread.loop = caller_loop;
  hz_thread.fiber = caller_fiber;
}

static void hz_loop_resume(HzLoop *loop) {
  HzLoop *caller_loop = hz_thread.loop;
  void *caller_fiber = hz_thread.fiber;
  HzErrHandler *caller_err = hz_err_top;
  HzLoop *inner = loop->paused_loop;
  HzLoop *target_loop = inner ? inner : loop;
  void *target = loop->paused_fiber ? loop->paused_fiber : loop->fiber;
  HzLoop *c;

  for (c = inner; c && c != loop; c = c->parent) {
    if (c->frozen_by == loop) {
      c->state = HZ_LOOP_RUNNING;
      c->frozen_by = NULL;
    }
  }

  loop->state = HZ_LOOP_RUNNING;
  loop->frozen_by = NULL;
  /* Whoever resumes the repeat becomes the place it returns to. */
  loop->started_from = caller_fiber;
  loop->parent = caller_loop;

  hz_thread.loop = target_loop;
  hz_thread.fiber = target;
  hz_err_top = loop->err_top;
  hz_switch_to(target);

  hz_thread.loop = caller_loop;
  hz_thread.fiber = caller_fiber;
  hz_err_top = caller_err;
}

static void hz_loop_enter(HzLoop *loop, HzBody body, void *ctx, int use_fiber,
                          const char *name, const char *file, int line) {
  loop->name = name;
  switch (loop->state) {
    case HZ_LOOP_FRESH:
      hz_loop_start(loop, body, ctx, use_fiber, name, file, line);
      return;
    case HZ_LOOP_PAUSED:
      hz_loop_resume(loop);
      return;
    case HZ_LOOP_RUNNING:
      hz_rt_error("H4020", file, line, "repeat \"%s\" is already running", name);
      return;
    case HZ_LOOP_FROZEN:
      hz_rt_error("H4021", file, line,
                  "repeat \"%s\" is frozen inside a paused repeat", name);
      return;
    default:
      hz_rt_error("H4022", file, line, "repeat \"%s\" has already finished", name);
      return;
  }
}

static void hz_loop_continue(HzLoop *loop, HzBody body, void *ctx, int use_fiber,
                             const char *name, const char *file, int line) {
  loop->name = name;
  switch (loop->state) {
    case HZ_LOOP_FRESH:
      hz_loop_start(loop, body, ctx, use_fiber, name, file, line);
      return;
    case HZ_LOOP_PAUSED:
      hz_loop_resume(loop);
      return;
    case HZ_LOOP_RUNNING:
      hz_rt_error("H4020", file, line, "repeat \"%s\" is already running", name);
      return;
    case HZ_LOOP_FROZEN:
      hz_rt_error("H4021", file, line,
                  "repeat \"%s\" is frozen inside a paused repeat", name);
      return;
    default:
      hz_rt_error("H4024", file, line, "repeat \"%s\" has already finished", name);
      return;
  }
}

static void hz_loop_new(HzLoop *loop, HzBody body, void *ctx, int use_fiber,
                        const char *name, const char *file, int line) {
  switch (loop->state) {
    case HZ_LOOP_FRESH:
      hz_loop_start(loop, body, ctx, use_fiber, name, file, line);
      return;
    case HZ_LOOP_PAUSED:
    case HZ_LOOP_FINISHED:
#ifdef _WIN32
      if (loop->fiber != NULL) {
        DeleteFiber(loop->fiber);
        loop->fiber = NULL;
      }
#endif
      loop->paused_fiber = NULL;
      loop->paused_loop = NULL;
      loop->state = HZ_LOOP_FRESH;
      hz_loop_start(loop, body, ctx, use_fiber, name, file, line);
      return;
    case HZ_LOOP_RUNNING:
      hz_rt_error("H4025", file, line,
                  "repeat \"%s\" is running and cannot be restarted from inside itself",
                  name);
      return;
    default:
      hz_rt_error("H4021", file, line,
                  "repeat \"%s\" is frozen inside a paused repeat", name);
      return;
  }
}

static void hz_loop_pause(HzLoop *loop, const char *file, int line) {
  HzLoop *c;
  if (loop->state != HZ_LOOP_RUNNING) {
    hz_rt_error("H4023", file, line, "repeat \"%s\" is not running right now",
                loop->name);
  }

  c = hz_thread.loop;
  while (c && c != loop) {
    if (c->state == HZ_LOOP_RUNNING) {
      c->state = HZ_LOOP_FROZEN;
      c->frozen_by = loop;
    }
    c = c->parent;
  }

  loop->state = HZ_LOOP_PAUSED;
  loop->paused_fiber = hz_thread.fiber;
  loop->paused_loop = hz_thread.loop;
  loop->err_top = hz_err_top;

  {
    HzLoop *target_loop = loop->parent;
    void *target = loop->started_from;
    hz_thread.loop = target_loop;
    hz_thread.fiber = target;
    hz_switch_to(target);
  }
  /* Resumed: the loop fiber's own handlers are live again. */
  hz_err_top = loop->err_top;
}
