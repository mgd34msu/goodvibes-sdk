# Web UI Integration

This is the **companion surface** for web UI applications (browser runtime). See [Runtime Surfaces](./surfaces.md).

Web UI apps cannot run the full agentic surface (tool execution, LSP, MCP, workflows, daemon HTTP) — those require Bun. This guide covers web-UI-specific patterns: entrypoint selection, companion chat, attachments, and voice playback. The shared browser foundation — auth, transport, realtime, error handling, and observability — lives in [Browser Integration](./browser-integration.md).

Use the narrowest browser entrypoint that matches the app. A normal GoodVibes
WebUI that presents the base knowledge/wiki system should use
`@pellux/goodvibes-sdk/browser/knowledge`; it contains base knowledge routes,
shared session/auth/provider routes, and realtime domains without loading Home
Assistant Home Graph route metadata. Use `@pellux/goodvibes-sdk/browser` only
when the app intentionally needs the complete operator route contract.

```ts
import { createBrowserKnowledgeSdk } from '@pellux/goodvibes-sdk/browser/knowledge';

const sdk = createBrowserKnowledgeSdk({
  baseUrl: 'https://goodvibes.example.com',
});
```

## Recommended model

For a browser-based web UI:
- use the narrowest scoped browser entrypoint
- prefer same-origin cookie-backed auth when hosting the UI with the daemon
- use `sdk.realtime.viaSse()` for dashboards and live status panes
- use `sdk.knowledge.*` or `sdk.operator.invoke(...)` for the base knowledge/wiki methods exposed by the scoped entrypoint
- use `sdk.chat.*` for standalone companion chat sessions
- use `sdk.operator.invoke('control.snapshot', {})` for shared control-plane state
- treat realtime as live update flow, not as the only source of truth

## Choosing browser entrypoints

`@pellux/goodvibes-sdk/browser/knowledge` is the default for the base GoodVibes
WebUI. `@pellux/goodvibes-sdk/browser/homeassistant` is for Home Assistant
panels and includes Home Graph routes without pulling the base knowledge/wiki
route table. `@pellux/goodvibes-sdk/browser/agent` (via `createBrowserAgentSdk`)
scopes to the GoodVibes Agent surface — the agent's own knowledge/wiki space
served under `/api/goodvibes-agent/knowledge`, plus work-plan, artifact, and
companion-chat routes. `@pellux/goodvibes-sdk/browser` and
`@pellux/goodvibes-sdk/web` remain full all-method browser clients for
applications that need the entire operator contract.

See [public-surface.md](./public-surface.md) for the full entry-point reference.

## Typical web UI pattern

1. Load an initial snapshot with operator APIs.
2. Subscribe to runtime events or telemetry streams.
3. Refresh affected read models when key events arrive.
4. Keep mutation calls on HTTP even when realtime is enabled.

## Companion Chat

Use `sdk.chat` from `@pellux/goodvibes-sdk/browser/knowledge` for standalone
browser chat. These sessions are separate from operator task sessions and do
not call `sessions.followUp`.

```ts
const created = await sdk.chat.sessions.create({
  title: 'WebUI chat',
  provider: 'openai-subscriber',
  model: 'gpt-5.5',
});

await sdk.chat.events.stream(created.sessionId, {
  onEvent(eventName, payload) {
    // companion-chat.turn.delta / companion-chat.turn.completed / companion-chat.turn.error
  },
});

await sdk.chat.messages.create(created.sessionId, {
  body: 'Hello',
});
```

`provider` is the selected runtime provider row id from the model catalog, for
example `openai-subscriber`. `model` is the selected model id for that provider
row, for example `gpt-5.5`. When a runtime provider is an alias for a catalog
provider, the daemon also accepts the provider-qualified registry key as
`model`, such as `openai:gpt-5.5`, as long as `provider` remains the selected
runtime provider row id.

Use `sdk.chat.sessions.list()` for the chat sidebar and
`sdk.chat.sessions.update(sessionId, { provider, model })` when a user changes
the model for an existing companion-chat session. Do not send provider/model on
`messages.create`; message creation uses the session's stored route.

### Chat attachments

Companion chat attachments are artifact-backed. Upload the file to the daemon
artifact store first, then reference the returned artifact id when creating the
chat message. Do not encode files in message metadata and do not create local
attachment-only state in the WebUI.

```ts
const uploaded = await sdk.artifacts.create({
  filename: file.name,
  mimeType: file.type || 'application/octet-stream',
  dataBase64: await fileToBase64(file),
  metadata: { surface: 'webui' },
});

await sdk.chat.messages.create(created.sessionId, {
  body: 'Use this file in your answer.',
  attachments: [
    {
      artifactId: uploaded.artifact.id,
      label: file.name,
    },
  ],
});
```

`messages.create` accepts text-only, attachment-only, and text-plus-attachment
messages. Message history and `companion-chat.turn.started` events include the
resolved attachment descriptors. Small text artifacts are inlined into the
provider prompt, supported image artifacts are passed as multimodal content, and
other artifact types remain durable references visible to the model as an
attachment summary.

## Voice playback (streaming TTS)

`POST /api/voice/tts/stream` returns raw audio bytes as a stream (see
[Voice and Streaming TTS](./voice.md)). A web UI owns local playback: read the
`fetch` response body as a `ReadableStream` and feed it to the Web Audio API or
a `MediaSource` so audio starts before the full clip arrives.

```ts
const controller = new AbortController();
const res = await fetch(`${baseUrl}/api/voice/tts/stream`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ providerId: 'elevenlabs', text: 'Read this aloud' }),
  signal: controller.signal,
});

if (!res.ok || !res.body) {
  throw new Error(`tts/stream failed: ${res.status}`);
}

const mediaSource = new MediaSource();
const audio = new Audio();
audio.src = URL.createObjectURL(mediaSource);

mediaSource.addEventListener('sourceopen', async () => {
  const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
  const sourceBuffer = mediaSource.addSourceBuffer(contentType);
  const reader = res.body!.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise((resolve) => {
      sourceBuffer.addEventListener('updateend', resolve, { once: true });
      sourceBuffer.appendBuffer(value);
    });
  }
  mediaSource.endOfStream();
});

await audio.play();
```

The `Content-Type` and `X-GoodVibes-Audio-Format` response headers describe the
audio encoding; use them to pick the `MediaSource` MIME type or Web Audio decode
path. Call `controller.abort()` when the user stops playback so the daemon
cancels the upstream provider stream.

## Error handling

All SDK errors extend `GoodVibesSdkError` and expose the same `kind` taxonomy
across every browser surface. See
[Browser Integration → Error handling](./browser-integration.md#error-handling)
for the handling pattern and [Error Kinds](./error-kinds.md) for the full
taxonomy.

## Observability

Observability works from web UI contexts exactly as on the full surface. Import
observer helpers from `@pellux/goodvibes-sdk/observer` so scoped browser bundles
stay narrow, and pass `createConsoleObserver()` as the `observer` option when
creating the SDK. See
[Browser Integration → Observability](./browser-integration.md#observability) for
the shared example and [Observability](./observability.md) for the full observer
API.
