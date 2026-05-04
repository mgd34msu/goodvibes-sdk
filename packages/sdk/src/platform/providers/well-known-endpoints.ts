/**
 * Well-known local LLM service endpoints and ports.
 *
 * These are **fallback defaults** used for zero-config local LLM discovery when
 * no explicit base URL has been provided by the user. They represent the
 * conventional ports that popular local inference servers listen on out of the box.
 *
 * Usage:
 * - Import the base URL when building a default `baseURL` string literal.
 * - Import the port when doing port-based fingerprinting in the scanner.
 * - Never use these to override a user-supplied config value.
 *
 * @module well-known-endpoints
 */

/**
 * Frozen map of well-known local LLM service base URLs.
 *
 * Keys correspond to the canonical service identifier used across the codebase.
 * Values are the bare origin (scheme + host + port, **no trailing slash**).
 * Append a path suffix (e.g. `/v1`) at the call site where the full URL is built.
 *
 * @remarks These are development/local defaults only. Production deployments
 * must configure explicit provider base URLs via the `providers` config key.
 * These constants are never used when a user-supplied value is present.
 */
export const WELL_KNOWN_LOCAL_ENDPOINTS = Object.freeze({
  /** Ollama — default listen address (loopback) */
  ollama: 'http://127.0.0.1:11434',
  /** LM Studio — default OpenAI-compat server */
  lmStudio: 'http://127.0.0.1:1234',
  /** llama.cpp — default HTTP server */
  llamaCpp: 'http://localhost:8080',
  /** LiteLLM — default proxy gateway */
  liteLLM: 'http://localhost:4000',
  /** Copilot Proxy — operator-managed local gateway */
  copilotProxy: 'http://localhost:3000',
} as const);

/**
 * Frozen map of well-known local LLM service port numbers.
 *
 * Used by the scanner when fingerprinting discovered servers by port. The full
 * `KNOWN_PORTS` scan list is derived from this plus additional ports for less
 * common services.
 */
export const WELL_KNOWN_LOCAL_PORTS = Object.freeze({
  ollama: 11434,
  lmStudio: 1234,
  llamaCpp: 8080,
  liteLLM: 4000,
  copilotProxy: 3000,
  /** Oobabooga / Text Generation WebUI (common alt port) */
  jan: 1337,
  gpt4all: 4891,
  koboldCpp: 5001,
  aphrodite: 2242,
} as const);
