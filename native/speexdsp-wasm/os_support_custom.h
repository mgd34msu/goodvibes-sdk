/* Keeps the stdio machinery (and its ~15 kB of formatting code) out of the
   WebAssembly module: speexdsp only uses fprintf for warnings, and a module
   with no console has nowhere to write them. */
#ifndef GV_OS_SUPPORT_CUSTOM_H
#define GV_OS_SUPPORT_CUSTOM_H

#define OVERRIDE_SPEEX_FATAL
static inline void _speex_fatal(const char *str, const char *file, int line) {
  (void)str; (void)file; (void)line;
  __builtin_trap();
}
#define OVERRIDE_SPEEX_WARNING
static inline void speex_warning(const char *str) { (void)str; }
#define OVERRIDE_SPEEX_WARNING_INT
static inline void speex_warning_int(const char *str, int val) { (void)str; (void)val; }
#define OVERRIDE_SPEEX_NOTIFY
static inline void speex_notify(const char *str) { (void)str; }
#define OVERRIDE_SPEEX_PUTC
static inline void _speex_putc(int ch, void *file) { (void)ch; (void)file; }

#endif
