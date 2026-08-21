/**
 * optional-bedrock.ts, the one place `@anthropic-ai/bedrock-sdk` is reached.
 *
 * The package is declared under `optionalDependencies` in
 * packages/sdk/package.json, and providers/amazon-bedrock.ts and
 * providers/amazon-bedrock-mantle.ts imported it statically, the package
 * itself for the two client classes, and its `core/auth.js` subpath for the
 * SigV4 signer the control-plane model listing reuses. Both modules are on the
 * daemon's graph through the provider registry, so an install without the
 * package did not lose Bedrock, it lost the daemon: see
 * utils/optional-dependency.ts for the measured failure.
 *
 * The specifiers below are written out literally so a bundler still sees them
 * and bundles the package when it IS installed; only the moment of evaluation
 * moves from module init to the call that needs a client or a signature.
 */

import { loadOptionalDependency } from '../utils/optional-dependency.js';

type BedrockModule = typeof import('@anthropic-ai/bedrock-sdk');
type BedrockAuthModule = typeof import('@anthropic-ai/bedrock-sdk/core/auth.js');

/**
 * Load the package, or throw an error whose message states that it is missing
 * and that it is an optional dependency. Every caller is inside an async
 * request or refresh path, so the throw lands where that provider's errors
 * are already handled.
 */
export async function loadBedrockSdk(): Promise<BedrockModule> {
  const loaded = await loadOptionalDependency(
    '@anthropic-ai/bedrock-sdk',
    () => import('@anthropic-ai/bedrock-sdk'),
  );
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module;
}

/**
 * The SigV4 signer `AnthropicBedrock` itself calls internally. A deep subpath
 * of the same optional package gets the same treatment as the package.
 */
export async function loadBedrockAuth(): Promise<BedrockAuthModule> {
  const loaded = await loadOptionalDependency(
    '@anthropic-ai/bedrock-sdk/core/auth.js',
    () => import('@anthropic-ai/bedrock-sdk/core/auth.js'),
  );
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module;
}

/** Whether the Bedrock providers can run in this installation, and why not. */
export async function describeBedrockAvailability(): Promise<{ available: boolean; reason?: string }> {
  const loaded = await loadOptionalDependency(
    '@anthropic-ai/bedrock-sdk',
    () => import('@anthropic-ai/bedrock-sdk'),
  );
  return loaded.available ? { available: true } : { available: false, reason: loaded.reason };
}
