# Media, Multimodal, And Web Search

GoodVibes exposes media, voice, multimodal analysis, artifact, and web-search
features through the daemon control plane and SDK platform modules.

Sources:

- `packages/sdk/src/platform/artifacts/`
- `packages/sdk/src/platform/media/`
- `packages/sdk/src/platform/multimodal/`
- `packages/sdk/src/platform/voice/`
- `packages/sdk/src/platform/web-search/`

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

`POST /api/artifacts` supports three body families:

- JSON control bodies for small inline `text`/`dataBase64` payloads, daemon-local
  `path` references, or remote `uri` fetches.
- `multipart/form-data` with a `file` field plus optional text fields such as
  `filename`, `mimeType`, `kind`, `sourceUri`, `retentionMs`, `tags`, and
  JSON-encoded `metadata`.
- Raw binary bodies for large uploads. Use the request `Content-Type` as the
  artifact MIME type and pass metadata through query parameters, for example
  `?filename=manual.pdf&metadata=%7B%22source%22%3A%22homeassistant%22%7D`.

The old small-body JSON path is still supported, but it is not the right shape
for PDFs, photos, website snapshots, or other large artifacts. Large clients
should send multipart or raw binary uploads so the daemon can stream/spool the
payload outside the JSON parser. Raw binary is the most memory-stable option for
very large payloads; multipart is available for browser panels and form-based
clients.

Artifact storage defaults to `storage.artifacts.maxBytes = 536870912`
(`512 MiB`). Hosts can raise that setting up to the schema limit when they have
disk and memory budget for larger ingestion workflows. Local file paths and
remote URI fetches are also streamed into the artifact store and enforce the
same artifact cap.

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
