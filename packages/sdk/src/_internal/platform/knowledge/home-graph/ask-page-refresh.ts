import type { ArtifactStore } from '../../artifacts/index.js';
import type { KnowledgeStore } from '../store.js';
import { readRecord } from './helpers.js';
import { refreshHomeGraphDevicePassport } from './generated-pages.js';
import type { HomeGraphAskResult } from './types.js';

export async function refreshDevicePagesForHomeGraphAsk(input: {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly answer: HomeGraphAskResult;
}): Promise<{ readonly requested: boolean; readonly refreshed: number }> {
  if ((input.answer.answer.facts?.length ?? 0) === 0 && input.answer.answer.sources.length === 0) return { requested: false, refreshed: 0 };
  const devices = input.answer.answer.linkedObjects.filter((node) => node.kind === 'ha_device').slice(0, 2);
  let refreshed = 0;
  for (const device of devices) {
    const deviceId = readHomeAssistantObjectId(device) ?? device.id;
    try {
      await refreshHomeGraphDevicePassport({
        store: input.store,
        artifactStore: input.artifactStore,
        spaceId: input.spaceId,
        installationId: input.installationId,
        input: {
          knowledgeSpaceId: input.spaceId,
          deviceId,
          metadata: { automation: 'ask-refresh' },
        },
      });
      refreshed += 1;
    } catch {
      // Ask should never fail solely because a generated page refresh failed.
    }
  }
  return { requested: devices.length > 0, refreshed };
}

function readHomeAssistantObjectId(node: { readonly id: string; readonly metadata: Record<string, unknown> }): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const value = homeAssistant.objectId ?? homeAssistant.deviceId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
