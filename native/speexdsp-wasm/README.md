# `speexdsp` noise suppression, compiled to WebAssembly

`voice.wake.noiseSuppression: "speex"` runs SpeexDSP's preprocessor over every
captured frame. This directory holds everything needed to rebuild the module the
SDK ships, and `scripts/build-speexdsp-wasm.ts` is the build.

## Why WebAssembly and not a native binding

The same reason the wake engine runs `onnxruntime-web` on a WASM backend. The
filter has to run in a daemon child process under Bun **and** in a browser tab,
and a native binding cannot run in the tab at all. One artifact that both hosts
load is the only shape where the setting means the same thing on both. The
module also imports nothing, no WASI syscalls, no JavaScript glue, so
instantiating it needs a `WebAssembly` implementation and nothing else.

The cost of that choice is measured, not assumed. It runs at **0.24 ms per
80 ms frame** on the reference machine (see `docs/wake-word-model.md`),
against the 3.46 ms the wake engine itself spends on the same frame.

## What is compiled in

Four SpeexDSP files are compiled in, `preprocess.c`, `filterbank.c`,
`fftwrap.c` (with `USE_SMALLFT`), and `smallft.c`, plus `gv-speex-preprocess.c`,
the entry points. Nothing else from the library is present, no echo canceller,
no resampler, no jitter buffer, no codec.

`preprocess.c` references the echo canceller's `speex_echo_get_residual`, which
is only reached when a caller attaches an echo state. Nothing here exposes a way
to attach one, so the symbol is satisfied by a stub that traps. Reaching it would
mean the module was built with an echo path it cannot service, and denoising
against an absent canceller's residual would corrupt the audio quietly instead.

Automatic gain control, the voice-activity gate and the dereverb stage are turned
**off explicitly** rather than left at their upstream defaults, so a default that
moves upstream cannot silently change what the setting does. Denoise is the only
stage enabled, at SpeexDSP's own `-15 dB` suppression floor, which the module can
be asked to read back (`gv_speex_noise_suppress_db`) rather than restating it.

## Toolchain, pinned

| Component | Version |
| --- | --- |
| Upstream source | SpeexDSP 1.2.1, sha256 `d17ca363654556a4ff1d02cc13d9eb1fc5a8642c90b40bd54ce266c3807b91a7` |
| Compiler | clang 22.1.8 (`--target=wasm32-wasip1`) |
| Linker | LLD 22.1.8 (`wasm-ld`) |
| Sysroot | wasi-libc `1:0+592+161b3195-1` at `/usr/share/wasi-sysroot` |
| Builtins | wasi-compiler-rt `22.1.0-2` |

On Arch the two sysroot packages are `pacman -S wasi-libc wasi-compiler-rt`;
elsewhere point `--wasi-sysroot` at a WASI sysroot of your own.

## Rebuilding

```sh
bun scripts/build-speexdsp-wasm.ts            # downloads, verifies, builds, regenerates
bun scripts/build-speexdsp-wasm.ts --check    # verifies the committed artifact, no toolchain needed
```

The build downloads the pinned tarball, refuses to continue unless its sha256
matches, compiles, and rewrites
`packages/sdk/src/platform/voice/capture/vendor/speexdsp-wasm.ts`, writing the
base64 of the module, its byte count, its sha256, and the pins above. `--check`
recomputes the sha256 of the committed base64 and compares it with the recorded
one, which is also asserted by `test/voice-noise-suppression.test.ts` on every
test run.

The module is embedded in the source rather than downloaded at runtime like the
wake models. At 53 kB it is small enough that provisioning it would cost more
than it saves, and embedding is what makes the setting honest. There is no state
in which the filter is configured, unprovisioned, and therefore not running.

## Attribution

SpeexDSP is BSD 3-clause, which requires its copyright notice, condition list
and disclaimer to be reproduced with any redistribution, including the base64
copy inside the published package. `NOTICE.txt` is that reproduction and
`SpeexDSP-1.2.1-COPYING.txt` is the upstream license verbatim.
