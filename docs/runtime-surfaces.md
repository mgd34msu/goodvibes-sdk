# Runtime Boundary Model

> Internal source map. For consumer import guidance see [Published surface matrix](./surfaces.md).

The SDK keeps all capabilities available while keeping runtime requirements
explicit.

## Client-Safe Surfaces

Client-safe surfaces avoid filesystem, process, native database, language
server, and local tool execution dependencies:

- browser and web UI code
- Workers
- React Native
- Expo

Use these surfaces when code may run in a browser-like or mobile runtime.

## Runtime-Heavy Surfaces

Runtime-heavy surfaces are explicit and intentional. They may use Node/Bun
capabilities such as filesystem access, subprocesses, local databases, language
servers, provider SDKs, and daemon internals.

Use runtime-heavy surfaces for daemon hosts, CLIs, local automation, knowledge
ingestion, and tool execution.

## Dependency Rule

Capabilities are not removed to make client bundles smaller. Instead,
capabilities are placed behind entrypoints that make their runtime assumptions
clear. A client-safe user can avoid runtime-heavy imports; a daemon/runtime user
can still access the full system.
