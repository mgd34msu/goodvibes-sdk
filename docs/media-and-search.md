# Media, Multimodal, And Web Search

GoodVibes exposes media, voice, multimodal analysis, artifact, and web-search
features through the daemon control plane and SDK platform modules.

Sources:

- `packages/sdk/src/_internal/platform/artifacts/`
- `packages/sdk/src/_internal/platform/media/`
- `packages/sdk/src/_internal/platform/multimodal/`
- `packages/sdk/src/_internal/platform/voice/`
- `packages/sdk/src/_internal/platform/web-search/`

## Artifacts

The artifact store persists typed blobs and file attachments for later delivery,
analysis, transformation, or knowledge ingest.

Operator methods:

- `artifacts.list`
- `artifacts.create`
- `artifacts.get`
- `artifacts.content.get`

Artifacts are used by knowledge extraction, multimodal writeback, media
providers, session export, and channel delivery.

## Media Providers

Media providers expose normalized capabilities for:

- image understanding
- local/built-in image inspection
- provider-backed image analysis
- media transformation
- media generation

Built-in media registration wires OpenAI, Gemini, Anthropic, local image
understanding, built-in image understanding, and generation providers into a
single registry.

Operator methods:

- `media.providers.list`
- `media.analyze`
- `media.transform`
- `media.generate`

## Multimodal Service

The multimodal service provides a higher-level interface over image, audio,
video, and document analysis. It can build token-efficient packets from
analysis results and persist analysis back into artifacts and knowledge.

Operator methods:

- `multimodal.status`
- `multimodal.providers.list`
- `multimodal.analyze`
- `multimodal.packet`
- `multimodal.writeback`

## Voice Providers

Voice providers support provider-specific combinations of:

- `tts`
- `tts-stream`
- `stt`
- `realtime`
- `voice-list`

Built-in providers:

- OpenAI
- Deepgram
- Google
- ElevenLabs
- Microsoft
- Vydra

Operator methods:

- `voice.status`
- `voice.providers.list`
- `voice.voices.list`
- `voice.tts`
- `voice.tts.stream`
- `voice.stt`
- `voice.realtime.session`

See [Voice and streaming TTS](./voice.md) for the spoken-output contract.

## Web Search

The web-search service normalizes provider-backed search into ranked results
with optional evidence fetching and safe-search posture.

Built-in providers:

- DuckDuckGo
- SearxNG
- Brave
- Exa
- Firecrawl
- Tavily
- Perplexity

Operator methods:

- `web_search.providers.list`
- `web_search.query`

The `web_search` tool exposes search to agents when a `WebSearchService` is
registered with the tool runtime.
