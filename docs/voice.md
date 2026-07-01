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

The SDK registers six built-in voice providers. Each advertises only the
capabilities it implements:

| Provider | `tts` | `tts-stream` | `stt` | `realtime` | `voice-list` |
|----------|:-----:|:------------:|:-----:|:----------:|:------------:|
| `elevenlabs` | yes | yes | yes | yes | yes |
| `openai` | yes | | yes | yes | yes |
| `microsoft` | yes | | | | yes |
| `google` | | | yes | | |
| `deepgram` | | | yes | | |
| `vydra` | yes | | | | yes |

ElevenLabs is currently the only built-in provider with `tts-stream` support.
The streaming surface is provider-agnostic: a provider opts in by implementing
`VoiceProvider.synthesizeStream()` and advertising `tts-stream`, and daemon
clients do not need ElevenLabs-specific code paths.

## Configuration

Spoken-output clients use these config keys:

| Config key | Default | Meaning |
|------------|---------|---------|
| `tts.provider` | `elevenlabs` | Default TTS provider when a request omits `providerId`; applies to both `POST /api/voice/tts` and `POST /api/voice/tts/stream`. |
| `tts.voice` | empty | Default voice id when a request omits `voiceId`; providers may still apply their own fallback. |
| `tts.llmProvider` | empty | Optional future override for spoken-output generation; empty means use the active chat provider. |
| `tts.llmModel` | empty | Optional future override for spoken-output generation; empty means use the active chat model. |
| `tts.speed` | `1.0` | Default speed multiplier applied when a request omits `speed`. |

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

The `POST /api/voice/tts/stream` byte stream is also browser-consumable: a web
UI can read the `fetch` response body as a `ReadableStream` and feed it to the
Web Audio API or `MediaSource` for low-latency playback. See
[Web UI Integration](./web-ui-integration.md) for a full browser playback
example; the TUI playback contract below covers local players such as `mpv`.

## Voice Discovery, STT, and Realtime Routes

Beyond TTS, the daemon exposes voice discovery, status, transcription, and
realtime-session routes. All use normal daemon authentication.

### `GET /api/voice`

Voice status. No request body. The response reports provider posture:

| Field | Type | Meaning |
|-------|------|---------|
| `enabled` | boolean | Whether the voice surface is active. |
| `providerCount` | number | Number of registered providers. |
| `providers` | array | Per-provider status: `id`, `label`, `state`, `capabilities`, `configured`, optional `detail`, and `metadata`. |
| `note` | string | Human-readable posture note. |

### `GET /api/voice/providers`

Returns registered voice providers. No request body. The response is
`{ "providers": [...] }`, where each entry has `id`, `label`, and the
`capabilities` array described above.

### `GET /api/voice/voices`

Returns selectable voices for a provider. Accepts an optional `providerId`
query parameter. The response is `{ "voices": [...] }`, where each entry has
`id`, `label`, optional `locale` and `gender`, and `metadata`.

### `POST /api/voice/stt`

Transcribes an audio artifact. Only `audio` is required; provide bytes via
`dataBase64` or a daemon-resolvable `uri`:

```json
{
  "providerId": "elevenlabs",
  "audio": {
    "mimeType": "audio/mpeg",
    "format": "mp3",
    "dataBase64": "..."
  },
  "language": "en",
  "modelId": "optional-provider-model-id",
  "prompt": "optional decoding hint"
}
```

The response returns `providerId`, `text`, optional `language`, optional
`segments` (each with `text` and optional `startMs`, `endMs`, `confidence`),
and `metadata`.

### `POST /api/voice/realtime/session`

Opens a realtime voice session. All request fields are optional:

```json
{
  "providerId": "openai",
  "modelId": "optional-provider-model-id",
  "voiceId": "optional-provider-voice-id",
  "inputFormat": "optional-provider-audio-format",
  "outputFormat": "optional-provider-audio-format",
  "instructions": "optional system instructions"
}
```

The response returns `providerId`, `sessionId`, `transport`, optional `url`,
optional `expiresAt`, optional `headers`, and `metadata`. Clients connect to
the provider's realtime endpoint using the returned transport details.

## TUI Contract

For a live `/tts <prompt>` command, the TUI should submit a normal chat turn
with spoken-output intent. Text should continue rendering through the normal
transcript path. The TUI should listen to assistant deltas for that marked turn,
chunk text at sentence or phrase boundaries, and call
`POST /api/voice/tts/stream` for each speakable chunk. Returned audio bytes can
then be piped to a streaming-capable local player such as `mpv` or `ffplay`.

TTS failures should be non-blocking status messages. They should not fail or
remove the text turn.

For streaming audio playback in a TUI context, pipe the byte stream to `mpv` (e.g. `mpv --no-cache --demuxer=rawaudio stdin://`) or `ffplay` (e.g. `ffplay -autoexit -f s16le -ar 24000 -`). Adjust format flags to match the TTS provider's output encoding.

## Next Reads

- [Web UI Integration](./web-ui-integration.md) for browser streaming-audio playback.
- [Observability](./observability.md)
- [Media, Multimodal, and Web Search](./media-and-search.md)
- [Public Surface Reference](./public-surface.md)
