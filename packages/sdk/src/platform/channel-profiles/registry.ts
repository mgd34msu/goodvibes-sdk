/**
 * channel-profiles/registry.ts
 *
 * The channel→profile binding registry: CRUD over the bindings plus the one
 * operation intake depends on — resolve(surfaceKind, channelId?), which returns
 * the MOST SPECIFIC binding for an inbound message (a channel-scoped binding
 * wins over the surface-wide default), so a session originated from that channel
 * inherits the right model/permission defaults.
 *
 * `set` is an upsert keyed on (surfaceKind, channelId?): binding the same
 * channel again replaces the previous binding rather than accumulating rows.
 */
import type { ChannelProfileStore } from './store.js';
import {
  CHANNEL_PERMISSION_MODES,
  ChannelProfileError,
  channelProfileBindingId,
  type ChannelPermissionMode,
  type ChannelProfileBinding,
  type ChannelProfileDefaults,
} from './types.js';

export interface SetChannelProfileInput {
  readonly surfaceKind: string;
  readonly channelId?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly permissionMode?: ChannelPermissionMode | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

function requireSurfaceKind(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ChannelProfileError('surfaceKind is required', 'INVALID_ARGUMENT');
  }
  return value.trim().toLowerCase();
}

function normalizePermissionMode(value: unknown): ChannelPermissionMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !CHANNEL_PERMISSION_MODES.includes(value as ChannelPermissionMode)) {
    throw new ChannelProfileError(
      `permissionMode must be one of ${CHANNEL_PERMISSION_MODES.join(', ')}`,
      'INVALID_ARGUMENT',
    );
  }
  return value as ChannelPermissionMode;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ChannelProfileError(`${field} must be a string`, 'INVALID_ARGUMENT');
  return value.trim() || undefined;
}

export class ChannelProfileRegistry {
  private bindings: ChannelProfileBinding[] | null = null;

  constructor(private readonly store: ChannelProfileStore) {}

  private async all(): Promise<ChannelProfileBinding[]> {
    if (this.bindings === null) this.bindings = await this.store.load();
    return this.bindings;
  }

  async list(): Promise<ChannelProfileBinding[]> {
    return [...(await this.all())];
  }

  async get(surfaceKind: string, channelId?: string): Promise<ChannelProfileBinding> {
    const id = channelProfileBindingId(requireSurfaceKind(surfaceKind), channelId);
    const binding = (await this.all()).find((b) => b.id === id);
    if (!binding) throw new ChannelProfileError(`No channel profile binding for ${id}`, 'NOT_FOUND');
    return binding;
  }

  async set(input: SetChannelProfileInput): Promise<ChannelProfileBinding> {
    const surfaceKind = requireSurfaceKind(input.surfaceKind);
    const channelId = optionalString(input.channelId, 'channelId');
    const id = channelProfileBindingId(surfaceKind, channelId);
    const binding: ChannelProfileBinding = {
      id,
      surfaceKind,
      ...(channelId ? { channelId } : {}),
      ...(optionalString(input.model, 'model') ? { model: optionalString(input.model, 'model') } : {}),
      ...(optionalString(input.provider, 'provider') ? { provider: optionalString(input.provider, 'provider') } : {}),
      ...(normalizePermissionMode(input.permissionMode) ? { permissionMode: normalizePermissionMode(input.permissionMode) } : {}),
      updatedAt: Date.now(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const bindings = await this.all();
    const index = bindings.findIndex((b) => b.id === id);
    if (index === -1) bindings.push(binding);
    else bindings[index] = binding;
    await this.store.save(bindings);
    return binding;
  }

  async delete(surfaceKind: string, channelId?: string): Promise<boolean> {
    const id = channelProfileBindingId(requireSurfaceKind(surfaceKind), channelId);
    const bindings = await this.all();
    const index = bindings.findIndex((b) => b.id === id);
    if (index === -1) return false;
    bindings.splice(index, 1);
    await this.store.save(bindings);
    return true;
  }

  /**
   * Resolve the effective profile defaults for a channel-originated session: a
   * channel-scoped binding (surfaceKind + channelId) wins over the surface-wide
   * default (surfaceKind only). Returns null when no binding applies — intake
   * then falls back to the host defaults, unchanged.
   */
  async resolve(surfaceKind: string, channelId?: string): Promise<ChannelProfileDefaults | null> {
    const surface = requireSurfaceKind(surfaceKind);
    const bindings = await this.all();
    const channel = (channelId ?? '').trim();
    const specific = channel
      ? bindings.find((b) => b.id === channelProfileBindingId(surface, channel))
      : undefined;
    const chosen = specific ?? bindings.find((b) => b.id === channelProfileBindingId(surface));
    if (!chosen) return null;
    return {
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.provider ? { provider: chosen.provider } : {}),
      ...(chosen.permissionMode ? { permissionMode: chosen.permissionMode } : {}),
    };
  }
}
