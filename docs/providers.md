# Providers

Provider integrations are runtime capabilities. The SDK keeps provider support
available while avoiding provider-heavy imports from client-safe entrypoints:
provider-specific SDKs and native/runtime-only dependencies live behind
runtime-heavy entrypoints or dynamic imports.

This page is the entry point for the provider surfaces. It distinguishes
provider registry metadata, model-catalog discovery, credentials and secret
references, daemon/runtime provider execution, and client calls that only
inspect or select provider state.

## Surfaces

- **Registry & catalog metadata** — Built-in providers, their brand labels, and
  the environment variables that configure them are declared in the SDK provider
  registry and catalog. `inferFallbackContextWindow` and
  `FALLBACK_CONTEXT_WINDOW` (a family-aware, pre-catalog context-window
  fallback) are exported from `@pellux/goodvibes-sdk/platform/providers`.
- **Model & selection API** — `GET /api/models`, `GET`/`PATCH`
  `/api/models/current`, and the `providers`-domain SSE events. See
  [Provider & Model API Reference](./provider-model-api.md).
- **Batch execution** — Opt-in, asynchronous provider Batch API queuing through
  the daemon. See [Daemon Batch Processing](./daemon-batch-processing.md).
- **Daemon embedding** — Hosting provider-backed daemon routes in another server
  process. See [Daemon Embedding](./daemon-embedding.md).

Client integrations should only inspect or select provider state through the
model/selection API. Provider execution — live turns and batch jobs — is a
daemon/runtime concern.

## Default provider catalog

The values below are stable: provider ids, brand labels, and the environment
variables that configure each provider. Model ids are intentionally omitted
because they version frequently — call `GET /api/models` for the live set of
models and `registryKey` values.

Labels come from the SDK provider label map and env vars from the built-in
provider env-key map. A provider is reported as `configured` when any of its
environment variables is set, or when credentials are supplied through the
`SecretsManager` or an OAuth/subscription route.

| Provider id | Label | Primary env var(s) |
|-------------|-------|--------------------|
| `openai` | OpenAI | `OPENAI_API_KEY` (or `OPENAI_KEY`) |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) |
| `gemini` | Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`, `GOOGLE_GEMINI_API_KEY`) |
| `inceptionlabs` | Inception Labs | `INCEPTION_API_KEY` |
| `groq` | Groq | `GROQ_API_KEY` |
| `cerebras` | Cerebras | `CEREBRAS_API_KEY` |
| `mistral` | Mistral | `MISTRAL_API_KEY` |
| `ollama-cloud` | Ollama Cloud | `OLLAMA_CLOUD_API_KEY` (or `OLLAMA_API_KEY`) |
| `huggingface` | Hugging Face | `HF_API_KEY` (or `HUGGINGFACE_API_KEY`, `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`) |
| `nvidia` | NVIDIA | `NVIDIA_API_KEY` (or `NIM_API_KEY`) |
| `llm7` | LLM7 | `LLM7_API_KEY` |
| `perplexity` | Perplexity | `PERPLEXITY_API_KEY` |
| `deepgram` | Deepgram | `DEEPGRAM_API_KEY` |
| `elevenlabs` | ElevenLabs | `ELEVENLABS_API_KEY` (or `XI_API_KEY`) |
| `amazon-bedrock` | Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` (or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) |
| `amazon-bedrock-mantle` | Amazon Bedrock (Mantle) | `AWS_BEARER_TOKEN_BEDROCK` (or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) |
| `anthropic-vertex` | Anthropic (Vertex) | `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`) |
| `github-copilot` | GitHub Copilot | `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN`, `GITHUB_TOKEN`) |
| `byteplus` | BytePlus | `BYTEPLUS_API_KEY` |
| `fal` | fal.ai | `FAL_KEY` (or `FAL_API_KEY`) |
| `comfy` | ComfyUI | `COMFY_API_KEY` |
| `runway` | Runway | `RUNWAYML_API_SECRET` (or `RUNWAY_API_KEY`) |
| `alibaba` | Alibaba Cloud | `MODELSTUDIO_API_KEY` (or `DASHSCOPE_API_KEY`, `QWEN_API_KEY`) |
| `vydra` | Vydra | `VYDRA_API_KEY` |

Many additional OpenAI-compatible providers ship through the built-in compat
catalog (for example `stepfun`, `together`, `deepseek`, `fireworks`,
`moonshot`, `qwen`, `xai`, and `venice`); their ids, labels, and env vars are
likewise reported by `GET /api/models`. The `synthetic` provider is local and
needs no API key. A few native voice and media providers (such as the `microsoft` voice provider) are also enumerated by the same endpoint. Treat `GET /api/models` as the authoritative, live source.

## Related

- [Provider & Model API Reference](./provider-model-api.md)
- [Daemon Batch Processing](./daemon-batch-processing.md)
- [Daemon Embedding](./daemon-embedding.md)
