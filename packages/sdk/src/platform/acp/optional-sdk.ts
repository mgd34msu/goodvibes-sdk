/**
 * optional-sdk.ts — the one place `@agentclientprotocol/sdk` is reached.
 *
 * The package is declared under `optionalDependencies` in
 * packages/sdk/package.json, and four modules imported its VALUES statically:
 * acp/agent.ts (`AgentSideConnection`, `ndJsonStream`, `PROTOCOL_VERSION`),
 * acp/connection.ts and acp/host.ts (`ClientSideConnection`, `ndJsonStream`),
 * and acp/protocol.ts, which RE-EXPORTED three of them. The daemon reaches
 * acp/host.ts, so an install without the package did not lose the ACP host —
 * it lost the daemon at module init, before anything could report why. See
 * utils/optional-dependency.ts for the measured failure.
 *
 * A re-export cannot be lazy, because `export { x } from 'pkg'` links the
 * specifier at module init exactly like an import does. So the re-export in
 * acp/protocol.ts is FOLDED INTO THIS MODULE: protocol.ts re-exports
 * `loadAcpSdk` from here (a local specifier, always resolvable), and the three
 * consumers plus the ACP test fixture take the values off the awaited module.
 * Every one of those call sites was already inside an async function, so no
 * signature changed except `serveAcpAgent`, which had to become async to build
 * its connection at all. The type re-exports in protocol.ts are untouched:
 * `export type` is erased and never reaches the module graph.
 *
 * The specifier below is written out literally so a bundler still sees it and
 * bundles the package when it IS installed.
 */

import { loadOptionalDependency } from '../utils/optional-dependency.js';

/** The ACP SDK's module surface, as declared in types/vendor-deps.d.ts. */
export type AcpSdkModule = typeof import('@agentclientprotocol/sdk');

/**
 * Load the ACP SDK, or throw an error whose message states that the package is
 * missing and that it is an optional dependency of the SDK. Every caller runs
 * inside an async connection path whose failures are already reported to the
 * operator, so the throw lands somewhere a person reads.
 */
export async function loadAcpSdk(): Promise<AcpSdkModule> {
  const loaded = await loadOptionalDependency(
    '@agentclientprotocol/sdk',
    () => import('@agentclientprotocol/sdk'),
  );
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module;
}

/** Whether ACP can run in this installation, and why not. */
export interface AcpAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * Report whether the ACP SDK is installed without opening a connection. The
 * outcome is cached per process by utils/optional-dependency.ts, so this costs
 * one resolution attempt.
 */
export async function describeAcpAvailability(): Promise<AcpAvailability> {
  const loaded = await loadOptionalDependency(
    '@agentclientprotocol/sdk',
    () => import('@agentclientprotocol/sdk'),
  );
  return loaded.available ? { available: true } : { available: false, reason: loaded.reason };
}
