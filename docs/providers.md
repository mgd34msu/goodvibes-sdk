# Providers

Provider integrations are runtime capabilities. The SDK keeps provider support
available while avoiding provider-heavy imports from client-safe entrypoints.

Provider docs should distinguish provider registry metadata, model catalog
discovery, credentials and secret references, daemon/runtime provider execution,
and client calls that only inspect or select provider state.

Provider-specific SDKs or native/runtime-only dependencies belong behind
runtime-heavy entrypoints or dynamic imports.
