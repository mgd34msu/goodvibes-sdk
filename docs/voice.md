# Voice and Streaming TTS

The SDK owns voice provider registration, provider and voice discovery, durable
TTS defaults, and daemon HTTP routes. UI clients own command syntax, transcript
rendering, local playback, and playback controls.

## Provider Model

Voice providers advertise capabilities through the voice registry:

| Capability | Meaning |
|------------|---------|
| `tts` | Non-streaming text-to-speech that returns a complete audio artifact. |
| `tts-stream` | Streaming text-to-speech that returns audio bytes incrementally. |
| `stt` | Speech-to-text transcription. |
| `realtime` | Realtime voice session setup. |
| `voice-list` | Voice discovery for provider-backed voice selection. |

ElevenLabs is the first built-in provider with `tts-stream` support. The
streaming surface is provider-agnostic: future providers should implement
`VoiceProvider.synthesizeStream()` and advertise `tts-stream`; daemon clients do
not need ElevenLabs-specific code paths.

## Configuration

Spoken-output clients use these config keys:

| Config key | Default | Meaning |
|------------|---------|---------|
| `tts.provider` | `elevenlabs` | Default streaming TTS provider when a request omits `providerId`. |
| `tts.voice` | empty | Default voice id when a request omits `voiceId`; providers may still apply their own fallback. |
| `tts.llmProvider` | empty | Optional future override for spoken-output generation; empty means use the active chat provider. |
| `tts.llmModel` | empty | Optional future override for spoken-output generation; empty means use the active chat model. |

The config keys are defaults, not locks. Clients can pass `providerId`,
`voiceId`, `modelId`, `format`, and `speed` on individual requests.

## Daemon Routes

`POST /api/voice/tts` is unchanged. It still returns the existing JSON
`VoiceSynthesisResult` with a complete audio artifact.

`POST /api/voice/tts/stream` is additive and returns raw audio bytes as a
stream. The request body matches the existing synthesis body:

```json
{
  "providerId": "elevenlabs",
  "text": "Read this aloud",
  "voiceId": "optional-provider-voice-id",
  "modelId": "optional-provider-model-id",
  "format": "mp3",
  "speed": 1,
  "metadata": {}
}
```

If `providerId` is omitted, the daemon uses `tts.provider`. If `voiceId` is
omitted, the daemon uses `tts.voice` when configured. Empty config values are
ignored so the provider can apply its own fallback.

Successful streaming responses include:

| Header | Meaning |
|--------|---------|
| `Content-Type` | Audio MIME type selected by the provider. |
| `Cache-Control: no-store` | Audio streams should not be cached. |
| `X-GoodVibes-Voice-Provider` | Provider id that produced the audio. |
| `X-GoodVibes-Audio-Format` | SDK-normalized audio format, such as `mp3`. |

The streaming route passes the daemon request `AbortSignal` into the provider
request and cancels the upstream audio reader when the client cancels the
response body. TUI implementations should abort the request when a spoken turn
is cancelled or playback is stopped.

## TUI Contract

For a live `/tts <prompt>` command, the TUI should submit a normal chat turn
with spoken-output intent. Text should continue rendering through the normal
transcript path. The TUI should listen to assistant deltas for that marked turn,
chunk text at sentence or phrase boundaries, and call
`POST /api/voice/tts/stream` for each speakable chunk. Returned audio bytes can
then be piped to a streaming-capable local player such as `mpv` or `ffplay`.

TTS failures should be non-blocking status messages. They should not fail or
remove the text turn.
