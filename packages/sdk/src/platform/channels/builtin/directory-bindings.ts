/**
 * Directory entries for the conversations a surface has ALREADY talked to.
 *
 * Every channel adapter upserts a route binding on ingress carrying the
 * originating channel/thread, so an entry exists here for any conversation
 * that has ever sent a message — with no configuration whatsoever. The
 * optional per-surface config fields (`defaultChatId`, `botUsername`, and
 * their equivalents) exist to INITIATE contact with somewhere nobody has
 * written from; gating the whole provider directory on them is what let a
 * fresh install receive messages and offer no target to answer them with.
 *
 * Kept beside targets.ts rather than inside it so the per-surface directory
 * lookups stay readable: this is one rule, applied identically fourteen times.
 */
import type { RouteBindingManager } from '../route-manager.js';
import type { ChannelDirectoryEntry, ChannelSurface } from '../types.js';

export interface DirectoryBindingSource {
  readonly deps: { readonly routeBindings: Pick<RouteBindingManager, 'listBindings'> };
}

export function directoryEntriesFromBindings(
  context: DirectoryBindingSource,
  surface: ChannelSurface,
  provider: string,
): ChannelDirectoryEntry[] {
  return context.deps.routeBindings
    .listBindings()
    .filter((binding) => binding.surfaceKind === surface)
    .map((binding) => {
      const id = binding.channelId ?? binding.externalId;
      return {
        id,
        surface,
        kind: binding.threadId ? 'thread' as const : 'channel' as const,
        label: binding.title ?? id,
        handle: id,
        groupId: binding.channelId ?? id,
        ...(binding.threadId ? { threadId: binding.threadId } : {}),
        isGroupConversation: !binding.threadId,
        searchText: [id, binding.title, binding.externalId, binding.threadId].filter(Boolean).join(' '),
        metadata: { provider, source: 'route-binding', bindingId: binding.id },
      };
    });
}
