import type {
  VoiceProvider,
  VoiceProviderCapability,
  VoiceProviderStatus,
} from './types.js';

export interface VoiceProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly VoiceProviderCapability[];
}

export class VoiceProviderRegistry {
  private readonly providers = new Map<string, VoiceProvider>();

  register(provider: VoiceProvider, options: { readonly replace?: boolean } = {}): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error('Voice provider id is required');
    if (this.providers.has(id) && !options.replace) {
      throw new Error(`Voice provider already registered: ${id}`);
    }
    const registered = { ...provider, id };
    this.providers.set(id, registered);
    return () => {
      const current = this.providers.get(id);
      if (current === registered) this.unregister(id);
    };
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): VoiceProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): VoiceProviderDescriptor[] {
    return [...this.providers.values()]
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        capabilities: [...provider.capabilities],
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  findProvider(capability: VoiceProviderCapability, providerId?: string): VoiceProvider | null {
    if (providerId) {
      const provider = this.get(providerId);
      return provider?.capabilities.includes(capability) ? provider : null;
    }
    return [...this.providers.values()].find((provider) => provider.capabilities.includes(capability)) ?? null;
  }

  /**
   * Resolve the provider an UNNAMED request should use.
   *
   * Registration order is an implementation detail, not a preference, picking
   * the first registrant handed every unnamed request to a cloud provider that
   * merely lacked its key while a fully provisioned local engine sat last in
   * the map ("OpenAI API key missing" on a host whose whisper worked). So the
   * default consults each candidate's own `configured` state: a configured
   * 'local' provider wins first (provisioned engines exist precisely so
   * unnamed requests use them, free, offline, no key), then any other
   * configured provider in registration order. Only when nothing reports
   * configured does the old first-registered fallback apply, so the resulting
   * error still names one concrete provider instead of "none".
   *
   * A named providerId keeps exact findProvider semantics.
   */
  async resolveProvider(capability: VoiceProviderCapability, providerId?: string): Promise<VoiceProvider | null> {
    if (providerId) return this.findProvider(capability, providerId);
    const candidates = [...this.providers.values()].filter((provider) => provider.capabilities.includes(capability));
    if (candidates.length === 0) return null;
    const configured: VoiceProvider[] = [];
    for (const candidate of candidates) {
      if (!candidate.status) {
        // No status hook = treated as configured, matching status()'s own default.
        configured.push(candidate);
        continue;
      }
      try {
        if ((await candidate.status()).configured) configured.push(candidate);
      } catch {
        // A provider whose status probe throws is not a sane default choice.
      }
    }
    if (configured.length > 0) {
      return configured.find((provider) => provider.id === 'local') ?? configured[0] ?? null;
    }
    // Nothing configured: plain first-registered, exactly the old behavior,
    // the point is a concrete provider name in the resulting error, not a
    // preference among options that are all equally unusable.
    return candidates[0] ?? null;
  }

  async status(): Promise<VoiceProviderStatus[]> {
    const statuses: VoiceProviderStatus[] = [];
    for (const provider of this.providers.values()) {
      if (provider.status) {
        statuses.push(await provider.status());
        continue;
      }
      statuses.push({
        id: provider.id,
        label: provider.label,
        state: 'healthy',
        capabilities: [...provider.capabilities],
        configured: true,
        metadata: {},
      });
    }
    return statuses.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }
}
