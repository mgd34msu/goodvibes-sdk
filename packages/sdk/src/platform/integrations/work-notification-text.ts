/**
 * work-notification-text.ts, the words the outbound channels (webhook, Slack,
 * Discord) use for an agent or workstream that ended.
 *
 * Naming rule (owner ruling 2026-09-29): a notification names the work it is
 * about. The opening events (AGENT_SPAWNING, WORKFLOW_CHAIN_CREATED) carry the
 * task text and the terminal ones carry only the id, so WorkNameMemory keeps
 * the name for the length of the work.
 *
 * Privacy rule (behavior.notificationsMetadataOnly, default off): when on, the
 * text carries ids and outcomes only, never the task, a failure reason or
 * model output. The reader is called at send time, so a settings change
 * applies to the next notice without a restart, and a reader that throws
 * fails toward metadata only.
 */
import { trimAtWordBoundary } from '../runtime/turn-notification.js';
import { workstreamLabel } from '../channels/workstream-labels.js';

/** Most names kept at once; a process that never sees terminal events cannot grow the maps unbounded. */
const MAX_REMEMBERED_NAMES = 256;

function rememberBounded(map: Map<string, string>, id: string, task: string): void {
  const name = trimAtWordBoundary(task, 80);
  if (!name) return;
  map.delete(id);
  map.set(id, name);
  while (map.size > MAX_REMEMBERED_NAMES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function takeName(map: Map<string, string>, id: string): string | null {
  const name = map.get(id) ?? null;
  map.delete(id);
  return name;
}

/** The shared workstream label registry's name (channels/workstream-labels.ts), or null when it has none. */
function registeredWorkstreamName(chainId: string): string | null {
  const label = workstreamLabel(chainId);
  return label === 'The workstream' ? null : label;
}

/** Task names per agent id and workstream id, from the opening event to the terminal one. */
export class WorkNameMemory {
  private readonly agents = new Map<string, string>();
  private readonly workstreams = new Map<string, string>();

  rememberAgent(agentId: string, task: string): void {
    rememberBounded(this.agents, agentId, task);
  }

  /** The agent's task name, forgotten on read (the terminal event is the last use). */
  takeAgent(agentId: string): string | null {
    return takeName(this.agents, agentId);
  }

  rememberWorkstream(chainId: string, task: string): void {
    rememberBounded(this.workstreams, chainId, task);
  }

  /** The workstream's task name, else the shared label registry's; forgotten on read. */
  takeWorkstream(chainId: string): string | null {
    return takeName(this.workstreams, chainId) ?? registeredWorkstreamName(chainId);
  }
}

/** A behavior.notificationsMetadataOnly reader. */
export type MetadataOnlyReader = () => boolean;

/** The metadata-only text when the privacy setting is on or nothing names the work, else the named text. */
export function namedOrMetadata(metadataText: string, namedText: string | null, metadataOnly: MetadataOnlyReader): string {
  if (namedText === null) return metadataText;
  let only = false;
  try {
    only = metadataOnly();
  } catch {
    // A reader that throws must not turn into sending names: fail toward metadata.
    only = true;
  }
  return only ? metadataText : namedText;
}

export function agentCompletedText(agentId: string, task: string | null, metadataOnly: MetadataOnlyReader): string {
  return namedOrMetadata(`Agent completed: ${agentId}`, task ? `Agent finished: ${task}` : null, metadataOnly);
}

export function agentFailedText(agentId: string, task: string | null, error: string, metadataOnly: MetadataOnlyReader): string {
  return namedOrMetadata(
    `Agent failed: ${agentId}`,
    `Agent failed: ${task ?? agentId}\n${trimAtWordBoundary(error, 300)}`,
    metadataOnly,
  );
}

export function workstreamPassedText(task: string | null, metadataOnly: MetadataOnlyReader): string {
  return namedOrMetadata(
    'A workstream passed all its checks.',
    task ? `Workstream passed all its checks: ${task}` : null,
    metadataOnly,
  );
}

export function workstreamFailedText(task: string | null, reason: string, metadataOnly: MetadataOnlyReader): string {
  return namedOrMetadata(
    'A workstream could not be finished.',
    `Workstream could not be finished${task ? `: ${task}` : ''}\n${trimAtWordBoundary(reason, 300)}`,
    metadataOnly,
  );
}
