/**
 * optional-openai.ts, the one place the `openai` package is reached.
 *
 * `openai` is declared under `optionalDependencies` in
 * packages/sdk/package.json. Three modules used to import it statically,
 * providers/openai.ts, providers/openai-compat.ts and
 * providers/lm-studio-helpers.ts, and the daemon's module graph reaches all
 * three through the provider registry. A static import of an absent optional
 * package does not degrade a feature, it removes the process: see
 * utils/optional-dependency.ts for the measured failure (no binary at compile
 * time, death at module init at run time).
 *
 * The specifier below is written out literally so a bundler still sees it and
 * bundles `openai` when it IS installed; only the moment of evaluation moves
 * from module init to the first client construction.
 */

import type OpenAI from 'openai';
import { loadOptionalDependency } from '../utils/optional-dependency.js';

type OpenAIModule = typeof import('openai');

/** Constructor options accepted by the `openai` client, without importing it. */
export type OpenAIClientOptions = ConstructorParameters<OpenAIModule['default']>[0];

/** Whether the `openai`-backed providers can run here, and why not. */
export interface OpenAIAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

async function loadOpenAIModule(): Promise<OpenAIModule> {
  const loaded = await loadOptionalDependency('openai', () => import('openai'));
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module;
}

/**
 * Build an `openai` client, or throw an error whose message states that the
 * package is missing and that it is an optional dependency. Every caller here
 * builds its client inside an already-async request path, so the throw lands
 * on the caller's existing provider-error path rather than at boot.
 */
export async function createOpenAIClient(options: OpenAIClientOptions): Promise<OpenAI> {
  const module = await loadOpenAIModule();
  return new module.default(options);
}

/**
 * The package's `toFile` helper, used to hand a Blob to the files endpoint
 * when submitting a batch.
 */
export async function openAIToFile(...args: Parameters<OpenAIModule['toFile']>): ReturnType<OpenAIModule['toFile']> {
  const module = await loadOpenAIModule();
  return module.toFile(...args);
}

/**
 * Report whether the `openai` package is installed without building a client.
 * The outcome is cached per process by utils/optional-dependency.ts, so this
 * costs one resolution attempt.
 */
export async function describeOpenAIAvailability(): Promise<OpenAIAvailability> {
  const loaded = await loadOptionalDependency('openai', () => import('openai'));
  return loaded.available ? { available: true } : { available: false, reason: loaded.reason };
}
