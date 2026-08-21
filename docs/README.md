# GoodVibes SDK documentation

These documents describe the SDK architecture. The SDK is a monorepo of
source-of-truth packages plus a main facade package. Public imports are explicit
package entrypoints, not arbitrary repo folder paths. [`CHANGELOG.md`](../CHANGELOG.md) remains the
release-history source.

## Start here

- [Getting started](./getting-started.md)
- [Packages and entry points](./packages.md)
- [Public exports](./exports.md)
- [Runtime surface architecture](./runtime-surfaces.md): capability and runtime boundary model.
- [Published surface matrix](./surfaces.md): package export entrypoints and supported import surfaces.
- [Public surface reference](./public-surface.md)

## Client integration

- [Authentication](./authentication.md): consumer token and session guidance.
- [Auth architecture](./auth.md): internal auth plumbing and daemon enforcement.
- [Browser integration](./browser-integration.md)
- [Web UI integration](./web-ui-integration.md)
- [React Native integration](./react-native-integration.md)
- [Expo integration](./expo-integration.md)
- [Android integration](./android-integration.md)
- [iOS integration](./ios-integration.md)
- [Companion app patterns](./companion-app-patterns.md)
- [Companion message routing](./companion-message-routing.md)
- [Companion wire protocol](./companion-wire-protocol.md)
- [Pairing](./pairing.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Retries and reconnect](./retries-and-reconnect.md)
- [Zero-knowledge relay](./relay-zero-knowledge.md): reaching a home daemon from outside without trusting the relay operator.
- [ACP agent](./acp-agent.md): driving GoodVibes from ACP-capable editors through the agent-side adapter.

## Daemon and runtime

- [Daemon embedding](./daemon-embedding.md)
- [SDK embedding API](./embedding-api.md): the stability-marked `/embed` surface for hosting the runtime in another app.
- [Provider and model API](./provider-model-api.md)
- [Provider architecture](./providers.md)
- [Runtime orchestration](./runtime-orchestration.md)
- [Tool system](./tools.md)
- [Tool safety](./tool-safety.md)
- [WRFC constraint propagation](./wrfc-constraint-propagation.md)
- [Architecture](./architecture.md)
- [Platform architecture](./architecture-platform.md)

## Knowledge, media, and search

- [Owner profile](./owner-profile.md)
- [Knowledge system](./knowledge.md)
- [Knowledge refinement](./knowledge-refinement.md)
- [Generated knowledge pages](./knowledge-pages.md)
- [Browser knowledge ingestion](./knowledge-browser-history.md)
- [Project Planning](./project-planning.md)
- [Occasions and plans](./occasions.md): durable facts about the owner's life and the plans built around them.
- [Home Assistant Home Graph](./home-graph.md)
- [Voice and streaming TTS](./voice.md)
- [Local voice engines](./voice-local.md): fully offline speech-to-text and text-to-speech through the `local` provider.
- [Wake-word model](./wake-word-model.md): the pinned `hey goodvibes` classifier, its measured behavior, and attribution.
- [Media and multimodal runtime](./media-and-search.md)

## Surfaces and automation

- [Channel surface details](./channel-surfaces.md)
- [Home Assistant integration](./homeassistant-integration.md)
- [Telegram integration](./telegram-integration.md)
- [Daemon batch processing and Cloudflare](./daemon-batch-processing.md)
- [Automation and watchers](./automation.md)
- [Inbound email](./inbound-email.md): the design of record for receiving, classifying, and acting on owner email.
- [Capability bundles](./plugin-bundles.md): SHA-pinned distribution for plugins, skills, and hook packs.
- [Calendar OAuth setup](./calendar-oauth-setup.md): registering your own Google or Microsoft OAuth app; GoodVibes ships no client id.
- [Google setup runbook](./google-setup-runbook.md): the generated manual route through Gmail and Calendar connection steps.

## Configuration and operations

- [Configuration defaults](./defaults.md)
- [Secret references](./secrets.md)
- [Feature settings](./feature-settings.md)
- [Security](./security.md)
- [Payments](./payments.md): design for the daemon's payment capability, covering budgets, the approval/veto windows, and the taint boundary around spending.
- [Observability](./observability.md)
- [Performance and tuning](./performance.md)
- [Transport architecture](./transports.md)
- [Error architecture](./errors.md): internal error model and category sources.
- [Error handling](./error-handling.md): consumer patterns for catching structured errors.
- [Error kinds reference](./error-kinds.md): public `SDKErrorKind` reference table.
- [Troubleshooting](./troubleshooting.md)
- [Testing and validation](./testing-and-validation.md): commands and CI gates.
- [Testing architecture](./testing.md): suite structure and intent.
- [Release policy](./release-and-publishing.md)
- [Semver policy](./semver-policy.md)
- [OpenAPI operator contract](./openapi-contract.md): the published OpenAPI 3.1 document and how it is generated.
- [Contract regeneration recipe](./contract-regeneration-recipe.md): the end-to-end procedure for adding an operator method or namespace.

## Generated references

- [Operator API reference](./reference-operator.md)
- [Peer API reference](./reference-peer.md)
- [Runtime events reference](./reference-runtime-events.md)

## Decision records

Dated records of design decisions live in [decisions/](./decisions/). Each one
captures a choice, its alternatives, and the reasoning at the time it was made.
Where the code has since moved, a dated correction note appears inside the
record rather than a silent rewrite. Review findings that shaped the code are
kept the same way in [reviews/](./reviews/).

## Project and repository docs

Operational docs in the repository root, one level up from `docs/`:

- [Project README](../README.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)
- [Test coverage](../COVERAGE.md)
