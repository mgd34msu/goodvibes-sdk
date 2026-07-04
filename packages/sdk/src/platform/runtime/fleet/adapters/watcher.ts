/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { WatcherRecord } from '../../store/domains/watchers.js';
import type { ProcessNode, ProcessState } from '../types.js';

/**
 * WatcherRecord → ProcessNode. WatcherRegistry.list() already normalizes each
 * record through its sourceStatusFor derivation (healthy/lagging/stale/
 * failed), so the mapping here reads the post-derivation state:
 * running → 'idle' (alive, armed between checks), starting → 'queued',
 * degraded → 'stalled' (heartbeat lagging/stale is the watcher-shaped stall),
 * failed → 'failed', stopped → 'killed'.
 */
export function adaptWatcher(record: WatcherRecord, now: number): ProcessNode {
  let state: ProcessState;
  switch (record.state) {
    case 'running':
      state = 'idle';
      break;
    case 'starting':
      state = 'queued';
      break;
    case 'degraded':
      state = 'stalled';
      break;
    case 'failed':
      state = 'failed';
      break;
    case 'stopped':
      state = 'killed';
      break;
  }
  const alive = record.state === 'running' || record.state === 'starting' || record.state === 'degraded';
  const statusText = record.degradedReason ?? record.sourceStatus;
  return {
    id: record.id,
    kind: 'watcher',
    parentId: undefined,
    label: record.label,
    state,
    startedAt: record.source.createdAt,
    elapsedMs: alive ? Math.max(0, now - record.source.createdAt) : 0,
    costUsd: null,
    costState: 'unpriced',
    currentActivity: statusText
      ? { kind: 'phase', text: statusText, at: record.lastHeartbeatAt ?? record.source.createdAt }
      : undefined,
    capabilities: { interruptible: false, killable: alive, pausable: false, resumable: false, steerable: false },
    raw: record,
  };
}
