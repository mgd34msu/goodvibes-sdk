/*
 * gv-speex-preprocess.c — the WebAssembly entry points around speexdsp's
 * preprocessor, and nothing else.
 *
 * speexdsp's own API is C pointers and a heap; a WebAssembly module talks to its
 * host through integers and one linear memory. This file is that translation and
 * carries no signal processing of its own: it allocates a preprocessor state and
 * a fixed int16 block beside it, hands the host the block's address to write
 * samples into, and runs speex_preprocess_run over them in place.
 *
 * The preprocessor's other stages are turned OFF explicitly rather than left at
 * their defaults, because a default that moves upstream would silently change
 * what the setting means: denoise is what `voice.wake.noiseSuppression: speex`
 * promises, so automatic gain control (which would change the loudness the wake
 * classifier was trained against), the voice-activity gate and the dereverb
 * stage are all disabled here. Upstream emits a "the VAD has been replaced by a
 * hack" warning from the VAD control path whichever value it is given; it is
 * about the stage this build disables, and os_support_custom.h drops it because
 * a module with no console has nowhere to write it.
 */
#include <stdint.h>
#include <stdlib.h>
#include "speex/speex_preprocess.h"

typedef struct {
  SpeexPreprocessState *state;
  int16_t *block;
  int block_samples;
  int sample_rate;
} gv_speex_handle;

#define GV_EXPORT(name) __attribute__((export_name(#name))) name

/* Bumped only if the exported signatures below change shape. */
int GV_EXPORT(gv_speex_abi_version)(void) { return 1; }

/*
 * Create a preprocessor over `block_samples` samples at `sample_rate`.
 * Returns 0 when either argument is unusable or the heap is exhausted, so the
 * host reports a refusal instead of running an uninitialised filter.
 */
uint32_t GV_EXPORT(gv_speex_create)(int block_samples, int sample_rate) {
  if (block_samples <= 0 || (block_samples & 1) != 0 || sample_rate <= 0) return 0;
  gv_speex_handle *handle = (gv_speex_handle *)calloc(1, sizeof(gv_speex_handle));
  if (handle == NULL) return 0;
  handle->block = (int16_t *)calloc((size_t)block_samples, sizeof(int16_t));
  if (handle->block == NULL) {
    free(handle);
    return 0;
  }
  handle->state = speex_preprocess_state_init(block_samples, sample_rate);
  if (handle->state == NULL) {
    free(handle->block);
    free(handle);
    return 0;
  }
  handle->block_samples = block_samples;
  handle->sample_rate = sample_rate;
  int on = 1;
  int off = 0;
  speex_preprocess_ctl(handle->state, SPEEX_PREPROCESS_SET_DENOISE, &on);
  speex_preprocess_ctl(handle->state, SPEEX_PREPROCESS_SET_AGC, &off);
  speex_preprocess_ctl(handle->state, SPEEX_PREPROCESS_SET_VAD, &off);
  speex_preprocess_ctl(handle->state, SPEEX_PREPROCESS_SET_DEREVERB, &off);
  return (uint32_t)(uintptr_t)handle;
}

/* Address in linear memory of the int16 block the host writes samples into. */
uint32_t GV_EXPORT(gv_speex_block)(uint32_t handle_id) {
  gv_speex_handle *handle = (gv_speex_handle *)(uintptr_t)handle_id;
  if (handle == NULL) return 0;
  return (uint32_t)(uintptr_t)handle->block;
}

/* Samples the block holds, so the host cannot disagree with the state about it. */
int GV_EXPORT(gv_speex_block_samples)(uint32_t handle_id) {
  gv_speex_handle *handle = (gv_speex_handle *)(uintptr_t)handle_id;
  if (handle == NULL) return 0;
  return handle->block_samples;
}

/*
 * The suppression floor the state is actually running at, in dB, read back from
 * the library rather than restated from a constant here.
 */
int GV_EXPORT(gv_speex_noise_suppress_db)(uint32_t handle_id) {
  gv_speex_handle *handle = (gv_speex_handle *)(uintptr_t)handle_id;
  if (handle == NULL) return 0;
  int value = 0;
  speex_preprocess_ctl(handle->state, SPEEX_PREPROCESS_GET_NOISE_SUPPRESS, &value);
  return value;
}

/* Denoise the block in place. Returns 1, or 0 for an unusable handle. */
int GV_EXPORT(gv_speex_run)(uint32_t handle_id) {
  gv_speex_handle *handle = (gv_speex_handle *)(uintptr_t)handle_id;
  if (handle == NULL || handle->state == NULL) return 0;
  speex_preprocess_run(handle->state, handle->block);
  return 1;
}

void GV_EXPORT(gv_speex_destroy)(uint32_t handle_id) {
  gv_speex_handle *handle = (gv_speex_handle *)(uintptr_t)handle_id;
  if (handle == NULL) return;
  if (handle->state != NULL) speex_preprocess_state_destroy(handle->state);
  free(handle->block);
  free(handle);
}

/*
 * preprocess.c calls into the acoustic echo canceller when a caller has attached
 * an echo state through SPEEX_PREPROCESS_SET_ECHO_STATE. This module does not
 * contain the canceller (mdf.c is not compiled in) and exposes no way to attach
 * one, so the call is unreachable — but the symbol must still resolve. Trapping
 * is deliberate: reaching it would mean the module was built with an echo path
 * it cannot service, and denoising against an absent canceller's residual would
 * quietly corrupt the audio instead.
 */
void speex_echo_get_residual(void *st, float *residual_echo, int len);
void speex_echo_get_residual(void *st, float *residual_echo, int len) {
  (void)st; (void)residual_echo; (void)len;
  __builtin_trap();
}
