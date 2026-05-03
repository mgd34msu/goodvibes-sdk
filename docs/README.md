# GoodVibes SDK Documentation

These documents describe the v0.30.0 SDK architecture. The SDK is a monorepo of
source-of-truth packages plus a main facade package; public imports are explicit
package entrypoints, not arbitrary repo folder paths. `CHANGELOG.md` remains the
release-history source.

## Start Here

- [Getting started](./getting-started.md)
- [Packages and entry points](./packages.md)
- [Public exports](./exports.md)
- [Runtime surface architecture](./runtime-surfaces.md)
- [Runtime surfaces](./surfaces.md)
- [Public surface reference](./public-surface.md)

## Client Integration

- [Authentication](./authentication.md)
- [Auth architecture](./auth.md)
- [Browser integration](./browser-integration.md)
- [Web UI integration](./web-ui-integration.md)
- [React Native integration](./react-native-integration.md)
- [Expo integration](./expo-integration.md)
- [Android integration](./android-integration.md)
- [iOS integration](./ios-integration.md)
- [Companion app patterns](./companion-app-patterns.md)
- [Companion message routing](./companion-message-routing.md)
- [Pairing](./pairing.md)
- [Realtime and telemetry](./realtime-and-telemetry.md)
- [Retries and reconnect](./retries-and-reconnect.md)

## Daemon and Runtime

- [Daemon embedding](./daemon-embedding.md)
- [Provider and model API](./provider-model-api.md)
- [Provider architecture](./providers.md)
- [Runtime orchestration](./runtime-orchestration.md)
- [Tool system](./tools.md)
- [Tool safety](./tool-safety.md)
- [WRFC constraint propagation](./wrfc-constraint-propagation.md)
- [Architecture](./architecture.md)
- [Platform architecture](./architecture-platform.md)

## Knowledge, Media, and Search

- [Knowledge system](./knowledge.md)
- [Knowledge refinement](./knowledge-refinement.md)
- [Generated knowledge pages](./knowledge-pages.md)
- [Browser knowledge ingestion](./knowledge-browser-history.md)
- [Project Planning](./project-planning.md)
- [Home Assistant Home Graph](./home-graph.md)
- [Voice and streaming TTS](./voice.md)
- [Media and multimodal runtime](./media-and-search.md)

## Surfaces and Automation

- [Channel surfaces](./surfaces.md)
- [Channel surface details](./channel-surfaces.md)
- [Home Assistant integration](./homeassistant-integration.md)
- [Daemon batch processing and Cloudflare](./daemon-batch-processing.md)
- [Automation and watchers](./automation.md)

## Configuration and Operations

- [Configuration defaults](./defaults.md)
- [Secret references](./secrets.md)
- [Feature flags](./feature-flags.md)
- [Security](./security.md)
- [Observability](./observability.md)
- [Performance and tuning](./performance.md)
- [Transport architecture](./transports.md)
- [Error architecture](./errors.md)
- [Error handling](./error-handling.md)
- [Error kinds reference](./error-kinds.md)
- [Troubleshooting](./troubleshooting.md)
- [Testing and validation](./testing-and-validation.md)
- [Testing architecture](./testing.md)
- [Release and publishing](./release-and-publishing.md)
- [Semver policy](./semver-policy.md)

## Generated References

- [Operator API reference](./reference-operator.md)
- [Peer API reference](./reference-peer.md)
- [Runtime events reference](./reference-runtime-events.md)
