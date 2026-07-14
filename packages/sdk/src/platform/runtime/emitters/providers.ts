/**
 * Provider emitters — typed emission wrappers for provider events.
 */
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';

export function emitProvidersChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { added: string[]; removed: string[]; updated: string[] }
): void {
  bus.emit('providers', createEventEnvelope('PROVIDERS_CHANGED', { type: 'PROVIDERS_CHANGED', ...data }, ctx));
}

export function emitProviderWarning(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { message: string }
): void {
  bus.emit('providers', createEventEnvelope('PROVIDER_WARNING', { type: 'PROVIDER_WARNING', ...data }, ctx));
}

/** Emit PROVIDER_VOICE_USAGE for one billable voice call on a metered provider. */
export function emitProviderVoiceUsage(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { provider: string; modelId?: string | undefined; kind: 'tts' | 'stt'; billableUnits: number; unit: 'characters' | 'seconds' }
): void {
  bus.emit('providers', createEventEnvelope('PROVIDER_VOICE_USAGE', { type: 'PROVIDER_VOICE_USAGE', ...data }, ctx));
}

export function emitModelFallback(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { from: string; to: string; provider: string }
): void {
  bus.emit('providers', createEventEnvelope('MODEL_FALLBACK', { type: 'MODEL_FALLBACK', ...data }, ctx));
}

export function emitModelChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { registryKey: string; provider: string; previous?: { registryKey: string; provider: string } }
): void {
  bus.emit('providers', createEventEnvelope('MODEL_CHANGED', { type: 'MODEL_CHANGED', ...data }, ctx));
}
