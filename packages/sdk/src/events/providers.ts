/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * ProviderEvent — discriminated union for provider registry and fallback events.
 */
export type ProviderEvent =
  | { type: 'PROVIDERS_CHANGED'; added: string[]; removed: string[]; updated: string[] }
  | { type: 'PROVIDER_WARNING'; message: string }
  | { type: 'MODEL_FALLBACK'; from: string; to: string; provider: string }
  /** One billable voice call on a METERED provider (local engines emit nothing). */
  | {
      type: 'PROVIDER_VOICE_USAGE';
      provider: string;
      modelId?: string | undefined;
      kind: 'tts' | 'stt';
      billableUnits: number;
      unit: 'characters' | 'seconds';
    }
  | { type: 'MODEL_CHANGED'; registryKey: string; provider: string; previous?: { registryKey: string; provider: string } };

export type ProviderEventType = ProviderEvent['type'];
